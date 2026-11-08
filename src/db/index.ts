// ============================================================================
// [Phase 1 — Foundation] src/db/index.ts — DATABASE CONNECTION SINGLETON
// See NAVIGATION.md Phase 1.3. WHAT: raw pg Pool + Drizzle wrapper.
// WHY search_path: isolated schemas per env; WHY max:5: fits small hosts.
// DESIGN: strict identifier regex (option-injection guard), SIGTERM drain.
// ----------------------------------------------------------------------------
// Exports:
//   pool -> raw node-postgres Pool (used for health checks, transactions,
//           custom SQL like the webhook claim query).
//   db   -> Drizzle ORM wrapper around the pool (typed queries everywhere).
//
// CONCEPT — search_path: Postgres resolves unqualified table names via this.
// We set `-c search_path=<DATABASE_SCHEMA>` so one DB can host isolated
// schemas (e.g. tests use a throwaway schema). DATABASE_SCHEMA must be a
// safe lowercase identifier to prevent SQL injection via connection options.
// Pool max:5 keeps connection count low for small hosts (Render free tier).
// ============================================================================
import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const connectionString =
  process.env.DATABASE_URL || "postgres://gatekeep:gatekeep_secret@localhost:5433/gatekeep";

// Validate schema name — interpolated into `options`, so whitelist it strictly.
export const databaseSchema = process.env.DATABASE_SCHEMA || "public";
if (!/^[a-z_][a-z0-9_]{0,39}$/.test(databaseSchema)) {
  throw new Error("DATABASE_SCHEMA must be a lowercase SQL identifier of at most 40 characters");
}

export const pool = new Pool({
  connectionString,
  options: `-c search_path=${databaseSchema}`, // All queries default to this schema.
  max: 5, // Small pool: suits low-concurrency app + serverless Postgres limits.
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// Drizzle gets the schema map so db.query.users / db.insert(notes) are typed.
export const db = drizzle(pool, { schema });

// Graceful shutdown: drain pool on SIGTERM (Docker/Render stop signal).
process.on("SIGTERM", async () => {
  await pool.end();
  console.log("Database pool drained");
});
