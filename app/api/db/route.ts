import { initDb } from "@/lib/db";

export async function GET(request: Request) {
  try {
    const db = await initDb();
    const url = new URL(request.url);
    const tableParam = url.searchParams.get("table");

    // Fetch user tables in public schema
    const tablesRes = await db.query<{ tablename: string }>(`
      SELECT tablename 
      FROM pg_catalog.pg_tables 
      WHERE schemaname = 'public' 
      ORDER BY tablename;
    `);

    const result: Record<string, unknown> = {};
    const tables = tablesRes.rows.map((r) => r.tablename);

    const tablesToInspect = tableParam ? [tableParam] : tables;

    for (const tableName of tablesToInspect) {
      // Get column schema
      const colRes = await db.query(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = '${tableName}'
        ORDER BY ordinal_position;
      `);

      // Get rows
      const dataRes = await db.query(`SELECT * FROM ${tableName} ORDER BY 1;`);

      result[tableName] = {
        columns: colRes.rows,
        total_rows: dataRes.rows.length,
        rows: dataRes.rows,
      };
    }

    return Response.json({
      success: true,
      tables,
      data: result,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}
