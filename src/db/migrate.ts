import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { databaseSchema, db, pool } from "./index";

export async function runMigrations(): Promise<void> {
  const source = path.join(__dirname, "../../drizzle");
  if (databaseSchema === "public") {
    await migrate(db, { migrationsFolder: source });
    return;
  }

  // Keep committed migrations unchanged for existing public-schema installs.
  // The isolated copy also redirects the initial migration's qualified FKs.
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${databaseSchema}"`);
  const currentSchema = (await pool.query<{ schema: string | null }>("SELECT current_schema() AS schema")).rows[0]?.schema;
  if (currentSchema !== databaseSchema) {
    throw new Error(`Database search path resolved to ${currentSchema ?? "no schema"}; expected ${databaseSchema}`);
  }

  const folder = mkdtempSync(path.join(tmpdir(), "gatekeep-migrations-"));
  try {
    cpSync(source, folder, { recursive: true });
    for (const file of readdirSync(folder).filter((name) => name.endsWith(".sql"))) {
      const target = path.join(folder, file);
      writeFileSync(target, readFileSync(target, "utf8").replaceAll('"public".', `"${databaseSchema}".`));
    }
    await migrate(db, { migrationsFolder: folder, migrationsSchema: `${databaseSchema}_migrations` });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
