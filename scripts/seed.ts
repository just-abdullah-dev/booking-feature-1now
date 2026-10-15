import { initDb, db } from "../lib/db.ts";

async function seed() {
  console.log("Initializing database schema...");
  await initDb();

  console.log("Clearing existing data...");
  await db.exec("DELETE FROM bookings; DELETE FROM resources;");

  console.log("Seeding demo resources...");
  const resourceRes = await db.query<{ id: string; name: string }>(`
    INSERT INTO resources (name)
    VALUES ('Room A'), ('Room B')
    RETURNING id, name;
  `);

  const roomA = resourceRes.rows[0];
  const roomB = resourceRes.rows[1];
  console.log(`Created resource: ${roomA.name} (id: ${roomA.id})`);
  console.log(`Created resource: ${roomB.name} (id: ${roomB.id})`);

  console.log("Seeding booking to deliberately collide with...");
  const bookingRes = await db.query<{
    id: string;
    resource_id: string;
    guest_name: string;
    start_at: string;
    end_at: string;
    status: string;
  }>(`
    INSERT INTO bookings (resource_id, guest_name, start_at, end_at, status)
    VALUES ('${roomA.id}', 'Alice Smith', '2026-10-16 10:00:00+00', '2026-10-16 12:00:00+00', 'active')
    RETURNING id, resource_id, guest_name, start_at, end_at, status;
  `);

  const b = bookingRes.rows[0];
  console.log(`Created booking: [${b.status}] ${b.guest_name} (${b.start_at} – ${b.end_at})`);

  console.log("\n✓ Seed completed successfully!");
  console.log("Demo Setup:");
  console.log("  Resource: Room A");
  console.log("  Existing Booking: Alice Smith (10:00 – 12:00 UTC)");
  console.log("  Collision test slot: 10:30 – 11:30 UTC (deliberately conflicts with Alice)");
  console.log("  Free slot test: 13:00 – 14:00 UTC (saves successfully)\n");
}

seed().catch((err) => {
  console.error("Seed script failed:", err);
  process.exit(1);
});
