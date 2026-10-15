/**
 * lib/bookings.ts — core booking business logic.
 *
 * The database exclusion constraint is the single source of truth for overlap
 * detection. This module never does an app-level pre-check; it always attempts
 * the INSERT and lets Postgres reject it with SQLSTATE 23P01 if there is a
 * conflict.
 *
 * Timezone assumption: all timestamps are stored and returned as UTC
 * timestamptz. The caller is responsible for passing ISO-8601 strings with
 * explicit offsets; the database handles conversion to UTC internally.
 */

import type { PGlite } from "@electric-sql/pglite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Resource {
  id: string;
  name: string;
}

export interface Booking {
  id: string;
  resource_id: string;
  guest_name: string;
  /** ISO-8601 UTC string */
  start_at: string;
  /** ISO-8601 UTC string */
  end_at: string;
  status: "active" | "cancelled";
}

export interface TimeSlot {
  start: string; // ISO-8601
  end: string;   // ISO-8601
}

// ---------------------------------------------------------------------------
// Error shapes
// ---------------------------------------------------------------------------

export type BookingResult =
  | { ok: true; booking: Booking }
  | { ok: false; error: "conflict"; conflicting: Booking }
  | { ok: false; error: "not_found" }
  | { ok: false; error: "db_error"; message: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True when the error is an exclusion-constraint violation (SQLSTATE 23P01). */
function isExclusionViolation(err: unknown): boolean {
  // PGlite surfaces the SQLSTATE on err.fields?.code or in err.message
  const e = err as { code?: string; fields?: { code?: string }; message?: string };
  const code = e.code ?? e.fields?.code ?? "";
  if (code === "23P01") return true;
  // Fallback: inspect message text
  return (e.message ?? "").includes("exclusion constraint");
}

// ---------------------------------------------------------------------------
// createBooking
// ---------------------------------------------------------------------------

/**
 * Insert a new active booking. If the exclusion constraint fires, look up
 * the blocking booking and return a structured conflict error.
 */
export async function createBooking(
  db: PGlite,
  params: {
    resourceId: string;
    guestName: string;
    startAt: string;
    endAt: string;
  }
): Promise<BookingResult> {
  const { resourceId, guestName, startAt, endAt } = params;

  try {
    const result = await db.query<Booking>(
      `INSERT INTO bookings (resource_id, guest_name, start_at, end_at, status)
       VALUES ($1, $2, $3, $4, 'active')
       RETURNING id, resource_id, guest_name,
                 start_at::text, end_at::text, status`,
      [resourceId, guestName, startAt, endAt]
    );

    return { ok: true, booking: result.rows[0] };
  } catch (err) {
    if (isExclusionViolation(err)) {
      // Find the blocking booking: any active booking on the same resource
      // whose half-open range [start, end) overlaps [startAt, endAt).
      const blocking = await db.query<Booking>(
        `SELECT id, resource_id, guest_name,
                start_at::text, end_at::text, status
         FROM bookings
         WHERE resource_id = $1
           AND status = 'active'
           AND tstzrange(start_at, end_at, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')
         LIMIT 1`,
        [resourceId, startAt, endAt]
      );

      if (blocking.rows.length > 0) {
        return { ok: false, error: "conflict", conflicting: blocking.rows[0] };
      }

      // Constraint fired but we couldn't find the blocker (race — very rare).
      return {
        ok: false,
        error: "db_error",
        message: "Exclusion constraint violated but blocking booking not found.",
      };
    }

    const e = err as Error;
    return { ok: false, error: "db_error", message: e.message };
  }
}

// ---------------------------------------------------------------------------
// cancelBooking
// ---------------------------------------------------------------------------

/**
 * Mark a booking as cancelled. Cancelled bookings are excluded from the GIST
 * index predicate so they no longer hold the slot.
 */
export async function cancelBooking(
  db: PGlite,
  bookingId: string
): Promise<BookingResult> {
  const result = await db.query<Booking>(
    `UPDATE bookings
        SET status = 'cancelled'
      WHERE id = $1 AND status = 'active'
      RETURNING id, resource_id, guest_name,
                start_at::text, end_at::text, status`,
    [bookingId]
  );

  if (result.rows.length === 0) {
    return { ok: false, error: "not_found" };
  }
  return { ok: true, booking: result.rows[0] };
}

// ---------------------------------------------------------------------------
// suggestSlots
// ---------------------------------------------------------------------------

/**
 * Return the 3 nearest free slots of the same duration (durationMs) on the
 * given resource, ordered nearest-first (alternating before/after the
 * requested window).
 *
 * Algorithm (deterministic, no AI):
 *   1. Load all active bookings for the resource, sorted by start_at.
 *   2. Build a list of free gaps between bookings (also before the first
 *      booking and after the last).
 *   3. Split gaps into candidates of exactly `duration` ms aligned to the
 *      requested window boundaries (step = duration).
 *   4. Sort candidates by proximity to the requested start, nearest first.
 *   5. Return up to 3.
 */
export async function suggestSlots(
  db: PGlite,
  params: {
    resourceId: string;
    startAt: string;
    endAt: string;
  }
): Promise<TimeSlot[]> {
  const { resourceId, startAt, endAt } = params;

  const reqStart = new Date(startAt).getTime();
  const reqEnd = new Date(endAt).getTime();
  const duration = reqEnd - reqStart;

  if (duration <= 0) return [];

  // Fetch all active bookings, ordered chronologically.
  const res = await db.query<{ start_at: string; end_at: string }>(
    `SELECT start_at::text, end_at::text
       FROM bookings
      WHERE resource_id = $1
        AND status = 'active'
      ORDER BY start_at`,
    [resourceId]
  );

  const busy = res.rows.map((r) => ({
    start: new Date(r.start_at).getTime(),
    end: new Date(r.end_at).getTime(),
  }));

  // Build a list of free gap windows.
  // We search in a window of ±7 days around the request; adjust as needed.
  const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
  const searchStart = reqStart - WINDOW_MS;
  const searchEnd = reqEnd + WINDOW_MS;

  // Produce candidate slot starts by stepping forward in `duration`-sized
  // increments from `searchStart`, staying inside `searchEnd`.
  const candidates: TimeSlot[] = [];

  let cursor = searchStart;
  while (cursor + duration <= searchEnd) {
    const slotStart = cursor;
    const slotEnd = cursor + duration;

    // Skip the slot if it exactly matches the requested range (it was rejected).
    if (slotStart === reqStart && slotEnd === reqEnd) {
      cursor += duration;
      continue;
    }

    // Check whether [slotStart, slotEnd) overlaps any busy range [b.start, b.end)
    // Half-open: touching end-to-start is NOT an overlap.
    const overlaps = busy.some(
      (b) => slotStart < b.end && slotEnd > b.start
    );

    if (!overlaps) {
      candidates.push({
        start: new Date(slotStart).toISOString(),
        end: new Date(slotEnd).toISOString(),
      });
    }

    cursor += duration;
  }

  // Sort by absolute distance from the requested start, nearest first.
  candidates.sort(
    (a, b) =>
      Math.abs(new Date(a.start).getTime() - reqStart) -
      Math.abs(new Date(b.start).getTime() - reqStart)
  );

  return candidates.slice(0, 3);
}
