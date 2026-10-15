# Booking Conflict Guard (1Now Assignment)

A double-booking prevention engine built with **Next.js (App Router)** and **PostgreSQL (PGlite)**.

The database constraint is the **single source of truth** for conflict prevention. The application never relies on an app-level pre-check to guard against overlaps; every reservation attempts an `INSERT` directly, allowing PostgreSQL's exclusion constraint to atomically accept or reject concurrent requests.

---

## Technical Approach & Core Guard

1. **Exclusion Constraint**:
   ```sql
   EXCLUDE USING gist (
     resource_id WITH =,
     tstzrange(start_at, end_at, '[)') WITH &&
   ) WHERE (status = 'active')
   ```
2. **Half-Open Intervals (`[)`)**:
   A booking ending at 11:00 does not conflict with one starting at 11:00.
3. **Cancellation Semantics**:
   The GIST index predicate `WHERE (status = 'active')` ensures that cancelled bookings (`status = 'cancelled'`) immediately free the slot.
4. **Deterministic Slot Suggestions**:
   When a conflict is caught (`SQLSTATE 23P01`), the API returns the blocking booking, and the system scans the resource's schedule to return the 3 nearest free slots of the same duration (nearest-first, without AI).

---

## Setup & Running

### 1. Prerequisites
- **Node.js**: v22.6+ or v24+ (Node 24 recommended, as used during development)
- **npm**

### 2. Installation
```bash
npm install
```

### 3. Seed Database
Initializes the schema, loads the `btree_gist` extension, and seeds `Room A` with a booking for demo purposes:
```bash
npm run seed
```

### 4. Run Development Server
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

### 5. Run Unit & Edge-Case Tests (Vitest)
Executes the automated test suite testing full overlap, boundary touching, cancellations, suggestion calculation, and concurrency:
```bash
npm test
```

### 6. Run Concurrency Race Script
Fires two simultaneous booking requests for the exact same slot at the exact same millisecond:
```bash
npm run race
# or
npm run test:concurrency
```
*(Can be run standalone against PGlite or while `npm run dev` is running to test live HTTP endpoints).*

---

## 3-Minute Demo Walkthrough

1. **View Seeded State**:
   Open [http://localhost:3000](http://localhost:3000). You will see **Room A** with an existing active booking for **Alice Smith** (`10:00 – 12:00 UTC` on `2026-10-16`).
2. **Book a Free Slot**:
   - In the form (or via the `⚡ Test Free (13:00–14:00)` button), submit a booking for `13:00 – 14:00 UTC`.
   - The booking saves and appears on the timeline.
3. **Deliberate Collision**:
   - In the form (or via the `⚡ Test Conflict (10:30–11:30)` button), attempt to book `10:30 – 11:30 UTC`.
   - The booking is rejected with a clear message naming the blocking booking:
     `Blocked by active booking for Alice Smith (10:00 – 12:00 UTC)`.
4. **1-Click Alternative Booking**:
   - Below the conflict message, 3 nearest free slots of the same duration are displayed.
   - Click any suggested slot button (e.g. `12:00 – 13:00 UTC`). It books immediately in one click and appears on the timeline.
5. **Cancel a Booking**:
   - Click **Cancel** on any booking on the timeline.
   - The status updates to `cancelled`, and the slot is immediately freed.
6. **Concurrency Verification**:
   - In a terminal, run `npm run race`.
   - Observe two simultaneous requests fire at once: **exactly one succeeds (201)** and **the other is rejected (409 Conflict)** by the PostgreSQL exclusion constraint.

---

## Scope Cuts (Stated Honestly)

To stay focused on the core conflict-guard problem within the 20-hour assignment budget, the following were intentionally cut:

- **No authentication or user accounts**: Operators interact directly with the booking interface without logins or roles.
- **No payments, payouts, or fraud checks**: Reservations are saved immediately without a checkout step.
- **No calendar or channel sync**: No external iCal, Google Calendar, or OTA/channel manager integrations.
- **No notifications or emails**: Confirmation and cancellation emails are omitted.
- **One fixed timezone (UTC)**: All timestamps are stored, queried, and displayed in UTC to eliminate timezone drift.
- **PGlite local-only instead of hosted PostgreSQL**: Uses `@electric-sql/pglite` (WASM-based embedded Postgres) persisted to `./data/pglite`. Runs locally without requiring external Docker or cloud database setup.
- **Raw SQL instead of Prisma**: Postgres exclusion constraints with `btree_gist` and `tstzrange` intervals are native PostgreSQL DDL not fully modeled in Prisma's schema DSL. Raw SQL ensures 100% database-enforced integrity without ORM limitations.
