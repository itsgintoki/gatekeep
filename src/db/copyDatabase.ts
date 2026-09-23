import "dotenv/config";
import { Pool, type PoolClient } from "pg";

const tables = ["users", "refresh_tokens", "webhooks", "notes", "attachments", "links", "access_logs", "webhook_deliveries"];

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("Invalid database identifier");
  return `"${value}"`;
}

async function count(client: PoolClient, schema: string, table: string): Promise<number> {
  const result = await client.query(`SELECT count(*)::integer AS count FROM ${identifier(schema)}.${identifier(table)}`);
  return result.rows[0].count;
}

async function requireEmptyTarget(client: PoolClient, schema: string): Promise<void> {
  for (const table of tables) {
    if (await count(client, schema, table)) throw new Error(`Destination ${table} is not empty; refusing to overwrite data`);
  }
}

async function copyTable(source: PoolClient, target: PoolClient, from: string, to: string, table: string): Promise<number> {
  // ponytail: one demo-sized table in memory; use pg_dump/restore for large databases.
  const rows = await source.query(`SELECT row_to_json(t)::text AS record FROM ${identifier(from)}.${identifier(table)} t ORDER BY id`);
  for (const { record } of rows.rows) {
    const row = JSON.parse(record) as Record<string, unknown>;
    const keys = Object.keys(row);
    const fields = keys.map(identifier).join(", ");
    const placeholders = keys.map((_, index) => `$${index + 1}`).join(", ");
    await target.query(`INSERT INTO ${identifier(to)}.${identifier(table)} (${fields}) VALUES (${placeholders})`, keys.map(key => row[key]));
  }
  if (await count(target, to, table) !== rows.rowCount) throw new Error(`Row count mismatch for ${table}`);
  return rows.rowCount ?? 0;
}

export async function copyDatabase(sourcePool: Pool, targetPool: Pool, from: string, to: string): Promise<Record<string, number> | null> {
  identifier(from); identifier(to);
  if (from === "public") throw new Error("Refusing to import the shared public schema");
  const source = await sourcePool.connect();
  const target = await targetPool.connect();
  const history = `${identifier(`${to}_migrations`)}."__database_import"`;
  try {
    await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await target.query("BEGIN");
    await target.query(`CREATE TABLE IF NOT EXISTS ${history} (id integer PRIMARY KEY CHECK (id = 1), completed_at timestamptz NOT NULL DEFAULT now())`);
    if ((await target.query(`SELECT id FROM ${history}`)).rowCount) {
      await target.query("COMMIT");
      return null;
    }
    await requireEmptyTarget(target, to);
    if (await count(source, from, "attachments")) throw new Error("Source contains files; migrate storage objects before copying the database");
    const counts: Record<string, number> = {};
    for (const table of tables) counts[table] = await copyTable(source, target, from, to, table);
    await target.query(`INSERT INTO ${history} (id) VALUES (1)`);
    await target.query("COMMIT");
    return counts;
  } catch (error) {
    await target.query("ROLLBACK");
    throw error;
  } finally {
    await source.query("ROLLBACK");
    source.release(); target.release();
  }
}

async function main(): Promise<void> {
  if (!process.env.SOURCE_DATABASE_URL) throw new Error("SOURCE_DATABASE_URL is required");
  if (process.env.SOURCE_DATABASE_URL === process.env.DATABASE_URL) throw new Error("Source and target databases must differ");
  const { pool, databaseSchema } = await import("./index");
  const { runMigrations } = await import("./migrate");
  const source = new Pool({ connectionString: process.env.SOURCE_DATABASE_URL, max: 1, connectionTimeoutMillis: 15000 });
  try {
    await runMigrations();
    const counts = await copyDatabase(source, pool, process.env.SOURCE_DATABASE_SCHEMA || "gatekeep", databaseSchema);
    console.log(counts ? { message: "Database transfer completed", counts } : "Database transfer already completed");
  } finally { await source.end(); await pool.end(); }
}

if (require.main === module) void main().catch(error => { console.error("Database transfer failed:", error.message); process.exitCode = 1; });
