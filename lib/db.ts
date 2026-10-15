import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import fs from "fs";
import path from "path";

if (typeof window !== "undefined") {
  throw new Error("lib/db.ts is server-only and cannot be imported in the browser.");
}

const dataDir = path.join(process.cwd(), "data", "pglite");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export const SCHEMA_SQL = `
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

declare global {
  // eslint-disable-next-line no-var
  var __pgliteInstance: PGlite | undefined;
}

export function getDb(): PGlite {
  if (!globalThis.__pgliteInstance) {
    const pidFile = path.join(dataDir, "postmaster.pid");
    if (fs.existsSync(pidFile)) {
      try {
        fs.unlinkSync(pidFile);
      } catch {
        // Ignore if currently locked by an active process
      }
    }

    globalThis.__pgliteInstance = new PGlite(dataDir, {
      extensions: {
        btree_gist,
      },
    });
  }
  return globalThis.__pgliteInstance;
}

export async function initDb(): Promise<PGlite> {
  try {
    const instance = getDb();
    await instance.exec(SCHEMA_SQL);
    try {
      await instance.exec(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conrelid = 'bookings'::regclass AND contype = 'x'
          ) THEN
            ALTER TABLE bookings
              ADD CONSTRAINT bookings_resource_id_tstzrange_excl
              EXCLUDE USING gist (
                resource_id WITH =,
                tstzrange(start_at, end_at, '[)') WITH &&
              ) WHERE (status = 'active');
          END IF;
        END $$;
      `);
    } catch {
      // Ignore if constraint already exists
    }
    return instance;
  } catch (err) {
    console.warn("PGlite database encountered an interrupted state, auto-recovering...", err);
    try {
      globalThis.__pgliteInstance = undefined;
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.mkdirSync(dataDir, { recursive: true });

      const freshInstance = getDb();
      await freshInstance.exec(SCHEMA_SQL);
      await freshInstance.query(`INSERT INTO resources (name) VALUES ('Room A'), ('Room B');`);
      return freshInstance;
    } catch (recoveryErr) {
      console.error("Auto-recovery failed:", recoveryErr);
      throw err;
    }
  }
}

export const db: PGlite = getDb();
