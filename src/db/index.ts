import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const connectionString =
  process.env.DATABASE_URL || "postgres://gatekeep:gatekeep_secret@localhost:5433/gatekeep";

export const databaseSchema = process.env.DATABASE_SCHEMA || "public";
if (!/^[a-z_][a-z0-9_]{0,39}$/.test(databaseSchema)) {
  throw new Error("DATABASE_SCHEMA must be a lowercase SQL identifier of at most 40 characters");
}

export const pool = new Pool({
  connectionString,
  options: `-c search_path=${databaseSchema}`,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export const db = drizzle(pool, { schema });

process.on("SIGTERM", async () => {
  await pool.end();
  console.log("Database pool drained");
});
