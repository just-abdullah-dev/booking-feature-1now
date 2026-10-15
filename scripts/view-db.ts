/**
 * CLI Tool to view database tables and their contents.
 *
 * It automatically checks if the dev server (http://localhost:3000) is running:
 *  - If running, it queries via the Next.js API (avoiding PGlite WASM lock conflict).
 *  - If not running, it initializes PGlite directly via lib/db.ts.
 */

async function isServerRunning(url = "http://localhost:3000/api/db"): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function inspectViaApi() {
  const res = await fetch("http://localhost:3000/api/db");
  const json = await res.json();

  if (!json.success) {
    throw new Error(json.error || "Failed to fetch DB data");
  }

  printReport(json.tables, json.data, "Connected via Running Next.js Server");
}

async function inspectDirectly() {
  const { initDb, db } = await import("../lib/db.ts");
  await initDb();

  const tablesRes = await db.query<{ tablename: string }>(`
    SELECT tablename 
    FROM pg_catalog.pg_tables 
    WHERE schemaname = 'public' 
    ORDER BY tablename;
  `);

  const tables = tablesRes.rows.map((r) => r.tablename);
  const data: Record<string, any> = {};

  for (const tableName of tables) {
    const colRes = await db.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = '${tableName}'
      ORDER BY ordinal_position;
    `);

    const dataRes = await db.query(`SELECT * FROM ${tableName} ORDER BY 1;`);
    data[tableName] = {
      columns: colRes.rows,
      total_rows: dataRes.rows.length,
      rows: dataRes.rows,
    };
  }

  printReport(tables, data, "Direct PGlite Connection (Offline Mode)");
}

function printReport(tables: string[], data: Record<string, any>, source: string) {
  console.log("\n=======================================================");
  console.log(` 🗄️  PGlite Database Inspector (${source})`);
  console.log("=======================================================\n");

  console.log(`Found ${tables.length} table(s): ${tables.join(", ")}\n`);

  for (const tableName of tables) {
    const tableInfo = data[tableName];
    console.log(`\n📌 TABLE: ${tableName.toUpperCase()} (${tableInfo.total_rows} rows)`);
    console.log("-------------------------------------------------------");

    console.log("Schema / Columns:");
    console.table(tableInfo.columns);

    console.log(`Data (${tableInfo.total_rows} rows):`);
    if (tableInfo.rows.length > 0) {
      console.table(tableInfo.rows);
    } else {
      console.log("(Table is empty)");
    }
    console.log("-------------------------------------------------------\n");
  }
}

async function main() {
  const running = await isServerRunning();
  if (running) {
    await inspectViaApi();
  } else {
    await inspectDirectly();
  }
}

main().catch((err) => {
  console.error("Inspector error:", err);
  process.exit(1);
});
