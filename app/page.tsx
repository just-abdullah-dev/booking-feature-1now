import { initDb } from "@/lib/db";
import { BookingsClient, Resource, Booking } from "./bookings-client";

export const instant = false;

export default async function BookingsPage() {
  const db = await initDb();

  // Fetch all resources
  let resourcesRes = await db.query<Resource>(
    "SELECT id, name FROM resources ORDER BY name ASC"
  );

  // If no resources found (e.g. database not seeded yet), seed standard Room A & Room B
  if (resourcesRes.rows.length === 0) {
    await db.query(`
      INSERT INTO resources (name)
      VALUES ('Room A')
    `);
    resourcesRes = await db.query<Resource>(
      "SELECT id, name FROM resources ORDER BY name ASC"
    );
  }

  // Fetch active bookings
  const bookingsRes = await db.query<Booking>(`
    SELECT id, resource_id, guest_name,
           start_at::text, end_at::text, status
      FROM bookings
     WHERE status = 'active'
     ORDER BY start_at ASC
  `);

  return (
    <BookingsClient
      initialResources={resourcesRes.rows}
      initialBookings={bookingsRes.rows}
    />
  );
}
