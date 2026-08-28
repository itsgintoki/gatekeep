import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const connectionString =
  process.env.DATABASE_URL || "postgres://gatekeep:gatekeep_secret@localhost:5433/gatekeep";

export const pool = new Pool({
  connectionString,
  max: process.env.NODE_ENV === "production" ? 20 : 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export const db = drizzle(pool, { schema });

process.on("SIGTERM", async () => {
  await pool.end();
  console.log("Database pool drained");
});
