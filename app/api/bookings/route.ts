/**
 * POST /api/bookings
 * Body: { resourceId, guestName, startAt, endAt }
 *
 * Returns:
 *   201 { booking }          — created
 *   409 { error: "conflict", conflicting }  — exclusion violation
 *   400 { error, message }   — bad input
 *   500 { error, message }   — db error
 */

import { initDb } from "../../../lib/db.ts";
import { createBooking } from "../../../lib/bookings.ts";

export async function POST(request: Request) {
  let body: Record<string, unknown>;

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad_request", message: "Invalid JSON" }, { status: 400 });
  }

  const { resourceId, guestName, startAt, endAt } = body as {
    resourceId?: string;
    guestName?: string;
    startAt?: string;
    endAt?: string;
  };

  if (!resourceId || !guestName || !startAt || !endAt) {
    return Response.json(
      { error: "bad_request", message: "resourceId, guestName, startAt, endAt are required" },
      { status: 400 }
    );
  }

  const db = await initDb();
  const result = await createBooking(db, { resourceId, guestName, startAt, endAt });

  if (result.ok) {
    return Response.json({ booking: result.booking }, { status: 201 });
  }

  if (result.error === "conflict") {
    return Response.json(
      { error: "conflict", conflicting: result.conflicting },
      { status: 409 }
    );
  }

  return Response.json({ error: result.error, message: (result as { message?: string }).message }, { status: 500 });
}
