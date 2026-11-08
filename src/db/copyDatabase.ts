// ============================================================================
// src/db/copyDatabase.ts — ONE-SHOT SCHEMA-TO-SCHEMA DATA MIGRATION CLI
// ----------------------------------------------------------------------------
// Run as `tsx src/db/copyDatabase.ts` with SOURCE_DATABASE_URL set. Copies
// all domain tables row-by-row from one Postgres schema to another.
// Safety rails (read before running):
//  - Refuses to import the shared `public` schema (would clobber prod).
//  - Requires empty target tables (no silent overwrites).
//  - Refuses if source has attachments (object storage must move separately).
//  - Idempotent: a `__database_import` marker row makes re-runs a no-op.
//  - Source read in REPEATABLE READ READ ONLY txn = consistent snapshot.
//  - Streams each table in keyset-paginated batches, so memory stays bounded.
// ============================================================================
import "dotenv/config";
import { Pool, type PoolClient } from "pg";

// Copy order matters only for readability; FKs aren't enforced mid-copy
// inside a single transaction, but keep parents before children anyway.
const tables = ["users", "refresh_tokens", "webhooks", "notes", "attachments", "links", "access_logs", "webhook_deliveries"];

// Rows are fetched in pages so a large table never lands in memory at once.
const batchSize = 1000;

// identifier(): quotes SQL identifiers AND whitelists them — prevents
// SQL injection since schema/table names can't be parameterized ($1).
function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("Invalid database identifier");
  return `"${value}"`;
}

async function count(client: PoolClient, schema: string, table: string): Promise<number> {
  // fixmyslop-ignore[sec/sql-injection] identifiers are allowlisted and quoted by identifier(); no user-controlled values are interpolated.
  const result = await client.query(`SELECT count(*)::integer AS count FROM ${identifier(schema)}.${identifier(table)}`);
  return result.rows[0].count;
}

async function requireEmptyTarget(client: PoolClient, schema: string): Promise<void> {
  for (const table of tables) {
    if (await count(client, schema, table)) throw new Error(`Destination ${table} is not empty; refusing to overwrite data`);
  }
}

async function copyTable(source: PoolClient, target: PoolClient, from: string, to: string, table: string): Promise<number> {
  const sourceTable = `${identifier(from)}.${identifier(table)}`;
  const targetTable = `${identifier(to)}.${identifier(table)}`;
  let copied = 0;
  let cursor: string | null = null;
  for (;;) {
    const page: { id: string; record: string }[] = cursor === null
      ? (await source.query(
          // fixmyslop-ignore[sec/sql-injection] sourceTable is identifier()-validated and quoted; the cursor is a bound parameter.
          `SELECT id::text AS id, row_to_json(t)::text AS record FROM ${sourceTable} t ORDER BY id LIMIT $1`,
          [batchSize],
        )).rows
      : (await source.query(
          // fixmyslop-ignore[sec/sql-injection] sourceTable is identifier()-validated and quoted; cursor and limit are bound parameters.
          `SELECT id::text AS id, row_to_json(t)::text AS record FROM ${sourceTable} t WHERE id > $1::uuid ORDER BY id LIMIT $2`,
          [cursor, batchSize],
        )).rows;
    if (page.length === 0) break;

    for (const { record } of page) {
      const row = JSON.parse(record) as Record<string, unknown>;
      const keys = Object.keys(row);
      const fields = keys.map(identifier).join(", ");
      const placeholders = keys.map((_, index) => `$${index + 1}`).join(", ");
      // fixmyslop-ignore[sec/sql-injection] targetTable and column names are identifier()-validated and quoted; row values are bound parameters.
      await target.query(`INSERT INTO ${targetTable} (${fields}) VALUES (${placeholders})`, keys.map(key => row[key]));
    }

    copied += page.length;
    cursor = page[page.length - 1].id;
  }

  if (await count(target, to, table) !== copied) throw new Error(`Row count mismatch for ${table}`);
  return copied;
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
    // fixmyslop-ignore[sec/sql-injection] history is built from an identifier()-validated schema plus a fixed literal.
    if ((await target.query(`SELECT id FROM ${history}`)).rowCount) {
      await target.query("COMMIT");
      return null;
    }
    await requireEmptyTarget(target, to);
    if (await count(source, from, "attachments")) throw new Error("Source contains files; migrate storage objects before copying the database");
    const counts: Record<string, number> = {};
    for (const table of tables) counts[table] = await copyTable(source, target, from, to, table);
    // fixmyslop-ignore[sec/sql-injection] same identifier()-validated history table; the inserted value is a fixed literal.
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
