/**
 * scripts/race.ts
 *
 * Concurrency Verification Script:
 * Fires two simultaneous booking requests for the exact same slot on Room A.
 * Demonstrates that the PostgreSQL exclusion constraint (SQLSTATE 23P01)
 * enforces conflict prevention at the database level so exactly ONE booking
 * succeeds and the other is rejected with a conflict error.
 */

import { initDb, db } from "../lib/db.ts";
import { createBooking } from "../lib/bookings.ts";

async function main() {
  console.log("==================================================================");
  console.log("          CONCURRENT DOUBLE-BOOKING GUARD VERIFICATION           ");
  console.log("==================================================================");

  await initDb();

  // Find Room A
  const resourceRes = await db.query<{ id: string; name: string }>(
    "SELECT id, name FROM resources WHERE name = 'Room A' LIMIT 1"
  );

  let resource = resourceRes.rows[0];
  if (!resource) {
    // Fallback: take first resource or create Room A
    const all = await db.query<{ id: string; name: string }>("SELECT id, name FROM resources LIMIT 1");
    if (all.rows[0]) {
      resource = all.rows[0];
    } else {
      const ins = await db.query<{ id: string; name: string }>(
        "INSERT INTO resources (name) VALUES ('Room A') RETURNING id, name"
      );
      resource = ins.rows[0];
    }
  }

  // Clear any existing race slot
  const testSlotStart = "2026-10-16T15:00:00Z";
  const testSlotEnd = "2026-10-16T16:00:00Z";

  await db.query(
    "DELETE FROM bookings WHERE resource_id = $1 AND start_at = $2::timestamptz",
    [resource.id, testSlotStart]
  );

  console.log(`Resource:      ${resource.name} (${resource.id})`);
  console.log(`Target Slot:   ${testSlotStart} – ${testSlotEnd}`);
  console.log("Simulating two simultaneous booking requests for the same slot...\n");

  // Check if Next.js HTTP server is active
  let useHttp = false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    const probe = await fetch("http://localhost:3000/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (probe.status === 400 || probe.status === 200 || probe.status === 409) {
      useHttp = true;
    }
  } catch {
    useHttp = false;
  }

  type RequestOutcome = {
    client: string;
    success: boolean;
    status: string;
    details: string;
  };

  async function executeRequest(guestName: string): Promise<RequestOutcome> {
    if (useHttp) {
      const res = await fetch("http://localhost:3000/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resourceId: resource.id,
          guestName,
          startAt: testSlotStart,
          endAt: testSlotEnd,
        }),
      });

      const body = await res.json();
      if (res.status === 201) {
        return {
          client: guestName,
          success: true,
          status: "201 Created",
          details: `Booking ID: ${body.booking?.id}`,
        };
      } else if (res.status === 409) {
        return {
          client: guestName,
          success: false,
          status: "409 Conflict",
          details: `Blocked by: ${body.conflicting?.guest_name}`,
        };
      } else {
        return {
          client: guestName,
          success: false,
          status: `${res.status} Error`,
          details: body.message || "Unknown error",
        };
      }
    } else {
      const result = await createBooking(db, {
        resourceId: resource.id,
        guestName,
        startAt: testSlotStart,
        endAt: testSlotEnd,
      });

      if (result.ok) {
        return {
          client: guestName,
          success: true,
          status: "SUCCESS",
          details: `Booking ID: ${result.booking.id}`,
        };
      } else if (result.error === "conflict") {
        return {
          client: guestName,
          success: false,
          status: "REJECTED (23P01 Conflict)",
          details: `Blocked by: ${result.conflicting.guest_name}`,
        };
      } else {
        return {
          client: guestName,
          success: false,
          status: "ERROR",
          details: (result as { message?: string }).message || "DB error",
        };
      }
    }
  }

  console.log(`Execution Mode: ${useHttp ? "Live HTTP Server (http://localhost:3000)" : "Direct PGlite Engine"}`);
  console.log("Firing Request 1 (Racer A) & Request 2 (Racer B) at the same millisecond...\n");

  const [outcome1, outcome2] = await Promise.all([
    executeRequest("Racer A"),
    executeRequest("Racer B"),
  ]);

  console.log(`• Request 1 (${outcome1.client}): [${outcome1.status}] -> ${outcome1.details}`);
  console.log(`• Request 2 (${outcome2.client}): [${outcome2.status}] -> ${outcome2.details}`);

  const successes = [outcome1, outcome2].filter((o) => o.success).length;
  const failures = [outcome1, outcome2].filter((o) => !o.success).length;

  console.log("\n------------------------------------------------------------------");
  console.log(`Summary: ${successes} succeeded, ${failures} rejected.`);
  if (successes === 1 && failures === 1) {
    const winner = outcome1.success ? outcome1.client : outcome2.client;
    const loser = outcome1.success ? outcome2.client : outcome1.client;
    console.log(`✓ RESULT: Exactly ONE succeeded (${winner}) and the other was rejected (${loser}).`);
    console.log("✓ Double-booking guard holds under concurrency!");
  } else {
    console.error(`✕ FAILED: Expected exactly 1 success and 1 rejection, got ${successes} and ${failures}.`);
    process.exit(1);
  }
  console.log("==================================================================\n");
}

main().catch((err) => {
  console.error("Concurrency test failed:", err);
  process.exit(1);
});
