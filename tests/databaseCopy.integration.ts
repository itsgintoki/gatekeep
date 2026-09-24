import { it } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { copyDatabase } from "../src/db/copyDatabase";

it("copies a database once, preserves data, and rejects nonempty targets", async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const source = "copy_source_test";
  const target = "copy_target_test";
  const tables = ["users", "refresh_tokens", "webhooks", "notes", "attachments", "links", "access_logs", "webhook_deliveries"];
  try {
    for (const schema of [source, target, `${target}_migrations`]) await pool.query(`CREATE SCHEMA ${schema}`);
    for (const schema of [source, target]) {
      for (const table of tables) await pool.query(`CREATE TABLE ${schema}.${table} (id uuid PRIMARY KEY, content text, payload jsonb, created_at timestamp)`);
    }
    const noteId = crypto.randomUUID();
    await pool.query(`INSERT INTO ${source}.notes VALUES ($1, $2, $3, $4)`, [noteId, "ciphertext-not-plaintext", { test: true }, "2026-09-24 00:00:00.123456"]);
    const counts = await copyDatabase(pool, pool, source, target);
    assert.equal(counts?.notes, 1);
    const copied = await pool.query(`SELECT content,payload,created_at::text AS timestamp FROM ${target}.notes WHERE id=$1`, [noteId]);
    assert.deepEqual(copied.rows[0], { content: "ciphertext-not-plaintext", payload: { test: true }, timestamp: "2026-09-24 00:00:00.123456" });
    assert.equal(await copyDatabase(pool, pool, source, target), null);
    await pool.query(`DELETE FROM ${target}_migrations.__database_import`);
    await assert.rejects(copyDatabase(pool, pool, source, target), /not empty/);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${source}.notes`)).rows[0].count, 1);
  } finally {
    for (const schema of [source, target, `${target}_migrations`]) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  }
});
