import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: process.env.NODE_ENV === "production" ? 20 : 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export const db = drizzle(pool, { schema });

process.on("SIGTERM", async () => {
  await pool.end();
  console.log("Database pool drained");
});
