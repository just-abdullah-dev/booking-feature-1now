/**
 * GET /api/bookings/[id]/suggest-slots?startAt=...&endAt=...
 * Returns up to 3 nearest free slots of the same duration, nearest-first.
 *
 * Query params: startAt (ISO-8601), endAt (ISO-8601)
 * Returns:
 *   200 { slots: TimeSlot[] }
 *   400 { error, message }
 */

import type { NextRequest } from "next/server";
import { initDb } from "../../../../../lib/db.ts";
import { suggestSlots } from "../../../../../lib/bookings.ts";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: resourceId } = await params;
  const startAt = request.nextUrl.searchParams.get("startAt");
  const endAt = request.nextUrl.searchParams.get("endAt");

  if (!startAt || !endAt) {
    return Response.json(
      { error: "bad_request", message: "startAt and endAt query params are required" },
      { status: 400 }
    );
  }

  const db = await initDb();
  const slots = await suggestSlots(db, { resourceId, startAt, endAt });

  return Response.json({ slots });
}
