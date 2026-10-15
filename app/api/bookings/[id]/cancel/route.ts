/**
 * PATCH /api/bookings/[id]/cancel
 * Sets a booking status to 'cancelled', freeing the slot.
 *
 * Returns:
 *   200 { booking }         — cancelled
 *   404 { error }           — not found / already cancelled
 *   500 { error, message }  — db error
 */

import { initDb } from "../../../../../lib/db.ts";
import { cancelBooking } from "../../../../../lib/bookings.ts";

export async function PATCH(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = await initDb();
  const result = await cancelBooking(db, id);

  if (result.ok) {
    return Response.json({ booking: result.booking });
  }

  if (result.error === "not_found") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  return Response.json(
    { error: result.error, message: (result as { message?: string }).message },
    { status: 500 }
  );
}
