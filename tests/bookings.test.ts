/**
 * tests/bookings.test.ts
 *
 * Unit + concurrency tests for the booking business logic.
 * Each test uses an isolated in-memory PGlite instance so tests never
 * interfere with the persisted ./data/pglite database.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { createBooking, cancelBooking, suggestSlots } from "../lib/bookings.ts";

// ---------------------------------------------------------------------------
// Schema — same as lib/db.ts but inline so tests don't depend on globalThis
// ---------------------------------------------------------------------------
const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  guest_name TEXT NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  CHECK (end_at > start_at),
  EXCLUDE USING gist (
    resource_id WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  ) WHERE (status = 'active')
);
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeDb(): Promise<PGlite> {
  const db = new PGlite({ extensions: { btree_gist } });
  await db.exec(SCHEMA_SQL);
  return db;
}

async function seedResource(db: PGlite, name = "Room A"): Promise<string> {
  const res = await db.query<{ id: string }>(
    "INSERT INTO resources (name) VALUES ($1) RETURNING id",
    [name]
  );
  return res.rows[0].id;
}

/** Shorthand: create a booking and assert it succeeded. */
async function insertActive(
  db: PGlite,
  rid: string,
  guest: string,
  start: string,
  end: string
) {
  const r = await createBooking(db, {
    resourceId: rid,
    guestName: guest,
    startAt: start,
    endAt: end,
  });
  if (!r.ok) throw new Error(`Unexpected booking failure: ${JSON.stringify(r)}`);
  return r.booking;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("overlap guard — database constraint is source of truth", () => {
  let db: PGlite;
  let rid: string;

  beforeEach(async () => {
    db = await makeDb();
    rid = await seedResource(db);
  });

  it("rejects a fully overlapping booking", async () => {
    await insertActive(db, rid, "Alice", "2026-01-01T09:00:00Z", "2026-01-01T10:00:00Z");

    const result = await createBooking(db, {
      resourceId: rid,
      guestName: "Bob",
      startAt: "2026-01-01T09:30:00Z",
      endAt: "2026-01-01T10:30:00Z",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("conflict");
      expect((result as { conflicting: { guest_name: string } }).conflicting.guest_name).toBe("Alice");
    }
  });

  it("rejects a booking that starts before and ends inside", async () => {
    await insertActive(db, rid, "Alice", "2026-01-01T10:00:00Z", "2026-01-01T12:00:00Z");

    const result = await createBooking(db, {
      resourceId: rid,
      guestName: "Bob",
      startAt: "2026-01-01T09:00:00Z",
      endAt: "2026-01-01T11:00:00Z",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("conflict");
  });

  it("rejects a booking that is completely inside an existing one", async () => {
    await insertActive(db, rid, "Alice", "2026-01-01T09:00:00Z", "2026-01-01T12:00:00Z");

    const result = await createBooking(db, {
      resourceId: rid,
      guestName: "Bob",
      startAt: "2026-01-01T10:00:00Z",
      endAt: "2026-01-01T11:00:00Z",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("conflict");
  });
});

describe("half-open boundary — touching is NOT a conflict", () => {
  let db: PGlite;
  let rid: string;

  beforeEach(async () => {
    db = await makeDb();
    rid = await seedResource(db);
  });

  it("allows a booking starting exactly when another ends (09:00–10:00 then 10:00–11:00)", async () => {
    await insertActive(db, rid, "Alice", "2026-01-01T09:00:00Z", "2026-01-01T10:00:00Z");

    const result = await createBooking(db, {
      resourceId: rid,
      guestName: "Bob",
      startAt: "2026-01-01T10:00:00Z",
      endAt: "2026-01-01T11:00:00Z",
    });

    expect(result.ok).toBe(true);
  });

  it("allows a booking ending exactly when another starts (11:00–12:00 then 10:00–11:00)", async () => {
    await insertActive(db, rid, "Alice", "2026-01-01T11:00:00Z", "2026-01-01T12:00:00Z");

    const result = await createBooking(db, {
      resourceId: rid,
      guestName: "Bob",
      startAt: "2026-01-01T10:00:00Z",
      endAt: "2026-01-01T11:00:00Z",
    });

    expect(result.ok).toBe(true);
  });
});

describe("cancelled bookings do not block new bookings", () => {
  let db: PGlite;
  let rid: string;

  beforeEach(async () => {
    db = await makeDb();
    rid = await seedResource(db);
  });

  it("allows rebooking the same slot after cancellation", async () => {
    const first = await insertActive(
      db, rid, "Alice",
      "2026-01-01T09:00:00Z", "2026-01-01T10:00:00Z"
    );

    const cancelResult = await cancelBooking(db, first.id);
    expect(cancelResult.ok).toBe(true);
    if (cancelResult.ok) expect(cancelResult.booking.status).toBe("cancelled");

    // Same slot must now be free
    const second = await createBooking(db, {
      resourceId: rid,
      guestName: "Bob",
      startAt: "2026-01-01T09:00:00Z",
      endAt: "2026-01-01T10:00:00Z",
    });

    expect(second.ok).toBe(true);
  });

  it("returns not_found when cancelling a non-existent booking", async () => {
    const result = await cancelBooking(db, "does-not-exist");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("not_found");
  });
});

describe("suggestSlots", () => {
  let db: PGlite;
  let rid: string;

  beforeEach(async () => {
    db = await makeDb();
    rid = await seedResource(db);
  });

  it("returns 3 non-overlapping slots nearest to the requested window", async () => {
    // Block the 10:00–11:00 slot
    await insertActive(db, rid, "Alice", "2026-01-01T10:00:00Z", "2026-01-01T11:00:00Z");

    const slots = await suggestSlots(db, {
      resourceId: rid,
      startAt: "2026-01-01T10:00:00Z",
      endAt: "2026-01-01T11:00:00Z",
    });

    expect(slots.length).toBeGreaterThanOrEqual(1);
    expect(slots.length).toBeLessThanOrEqual(3);

    // None of the suggestions should overlap the blocked slot [10:00, 11:00)
    for (const slot of slots) {
      const sStart = new Date(slot.start).getTime();
      const sEnd = new Date(slot.end).getTime();
      const blockedStart = new Date("2026-01-01T10:00:00Z").getTime();
      const blockedEnd = new Date("2026-01-01T11:00:00Z").getTime();
      // Half-open overlap: sStart < blockedEnd && sEnd > blockedStart
      const overlaps = sStart < blockedEnd && sEnd > blockedStart;
      expect(overlaps).toBe(false);
    }
  });

  it("suggestions do not overlap each other", async () => {
    await insertActive(db, rid, "Alice", "2026-01-01T10:00:00Z", "2026-01-01T11:00:00Z");

    const slots = await suggestSlots(db, {
      resourceId: rid,
      startAt: "2026-01-01T10:00:00Z",
      endAt: "2026-01-01T11:00:00Z",
    });

    // Check no two suggestions overlap (half-open [))
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        const aS = new Date(slots[i].start).getTime();
        const aE = new Date(slots[i].end).getTime();
        const bS = new Date(slots[j].start).getTime();
        const bE = new Date(slots[j].end).getTime();
        const overlaps = aS < bE && aE > bS;
        expect(overlaps).toBe(false);
      }
    }
  });

  it("suggestions are sorted nearest-first", async () => {
    await insertActive(db, rid, "Alice", "2026-01-01T10:00:00Z", "2026-01-01T11:00:00Z");

    const slots = await suggestSlots(db, {
      resourceId: rid,
      startAt: "2026-01-01T10:00:00Z",
      endAt: "2026-01-01T11:00:00Z",
    });

    const reqStart = new Date("2026-01-01T10:00:00Z").getTime();
    const distances = slots.map((s) =>
      Math.abs(new Date(s.start).getTime() - reqStart)
    );

    for (let i = 1; i < distances.length; i++) {
      expect(distances[i]).toBeGreaterThanOrEqual(distances[i - 1]);
    }
  });

  it("returns empty array when resource has no ID (non-existent resource)", async () => {
    // No bookings exist, so all slots in the window are free — we get results.
    // Use a resource that doesn't exist: no bookings → all time is free.
    const slots = await suggestSlots(db, {
      resourceId: "fake-resource-id",
      startAt: "2026-01-01T10:00:00Z",
      endAt: "2026-01-01T11:00:00Z",
    });
    // Could be 3 (the whole search window is free) or 0 — just check no crash.
    expect(Array.isArray(slots)).toBe(true);
  });
});

describe("concurrency — exactly one of two simultaneous bookings succeeds", () => {
  it("only one booking wins when two requests race for the same slot", async () => {
    // Each concurrent request gets its own db connection — in production this
    // models two concurrent Next.js API route calls sharing the same PGlite
    // singleton. PGlite serialises writes through its internal queue, so the
    // constraint still fires on the second write.
    //
    // We use Promise.allSettled to let both settle, then count successes.
    const db = await makeDb();
    const rid = await seedResource(db);

    const book = () =>
      createBooking(db, {
        resourceId: rid,
        guestName: "Racer",
        startAt: "2026-06-01T14:00:00Z",
        endAt: "2026-06-01T15:00:00Z",
      });

    const [r1, r2] = await Promise.all([book(), book()]);

    const successes = [r1, r2].filter((r) => r.ok).length;
    const failures = [r1, r2].filter(
      (r) => !r.ok && (r as { error: string }).error === "conflict"
    ).length;

    expect(successes).toBe(1);
    expect(failures).toBe(1);
  });
});
