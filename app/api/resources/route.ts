import { initDb } from "@/lib/db";

export async function GET() {
  try {
    const db = await initDb();
    const result = await db.query<{ id: string; name: string }>(
      "SELECT id, name FROM resources ORDER BY name ASC;"
    );
    return Response.json({ resources: result.rows });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let body: { name?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name) {
    return Response.json({ error: "Room name is required" }, { status: 400 });
  }

  try {
    const db = await initDb();
    const result = await db.query<{ id: string; name: string }>(
      "INSERT INTO resources (name) VALUES ($1) RETURNING id, name;",
      [name]
    );

    return Response.json({ resource: result.rows[0] }, { status: 201 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
