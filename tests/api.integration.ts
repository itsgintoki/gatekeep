import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { app } from "../src/app";
import { databaseSchema, db, pool } from "../src/db";
import { runMigrations } from "../src/db/migrate";
import { attachments, links, users, webhookDeliveries, webhooks } from "../src/db/schema";
import * as AuthService from "../src/modules/auth/auth.service";
import * as LinksService from "../src/modules/links/links.service";
import * as NotesService from "../src/modules/notes/notes.service";

process.env.JWT_ACCESS_SECRET ??= "integration-access-secret-at-least-32-bytes";
process.env.JWT_REFRESH_SECRET ??= "integration-refresh-secret-at-least-32-bytes";

let server: Server | undefined;
let baseUrl = "";
const createdUserIds: string[] = [];

before(async () => {
  await runMigrations();
  const { promise, resolve } = Promise.withResolvers<void>();
  server = app.listen(0, "127.0.0.1", resolve);
  await promise;
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Integration server did not expose a TCP address");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  for (const userId of createdUserIds) {
    await db.delete(users).where(eq(users.id, userId));
  }
  if (server) {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.close((error) => error ? reject(error) : resolve());
    await promise;
  }
  await pool.end();
});

describe("Database-backed security contracts", () => {
  it("keeps tables, foreign keys, and migration history in the configured schema", async () => {
    const current = await pool.query("SELECT current_schema() AS schema");
    assert.strictEqual(current.rows[0].schema, databaseSchema);
    const references = await pool.query("SELECT DISTINCT target_ns.nspname AS schema FROM pg_constraint c JOIN pg_class source ON source.oid = c.conrelid JOIN pg_namespace source_ns ON source_ns.oid = source.relnamespace JOIN pg_class target ON target.oid = c.confrelid JOIN pg_namespace target_ns ON target_ns.oid = target.relnamespace WHERE c.contype = 'f' AND source_ns.nspname = $1", [databaseSchema]);
    assert.deepStrictEqual(references.rows.map((row) => row.schema), [databaseSchema]);
    if (databaseSchema !== "public") {
      const journal = await pool.query("SELECT to_regclass($1) IS NOT NULL AS present", [`${databaseSchema}_migrations.__drizzle_migrations`]);
      assert.strictEqual(journal.rows[0].present, true);
    }
  });
  it("pins and searches notes across pages, serves owned QR codes, and releases attachments only after access", async () => {
    const account = await AuthService.signup(`parity-${crypto.randomUUID()}@example.com`, "integration-password", "Test", "Reader");
    createdUserIds.push(account.user.id);
    const original = await NotesService.createNote(account.user.id, { title: "100% private", content: "Attachment review", passphrase: "attachment-note-key" });
    const newer = await NotesService.createNote(account.user.id, { title: "Newest", content: "Another note" });
    const pinned = await NotesService.updateNote(original.id, account.user.id, { isPinned: true });
    assert.strictEqual(pinned.isPinned, true);
    assert.strictEqual(pinned.content, original.content);
    assert.strictEqual((await NotesService.listNotes(account.user.id, 1, 1))[0].id, original.id);
    assert.strictEqual((await NotesService.listNotes(account.user.id, 2, 1))[0].id, newer.id);
    assert.deepStrictEqual((await NotesService.listNotes(account.user.id, 1, 20, "%")).map((note) => note.id), [original.id]);
    await db.insert(attachments).values({ noteId: original.id, url: "https://res.cloudinary.com/demo/image/upload/sample.jpg", cloudinaryPublicId: "internal-storage-id", originalName: "design.jpg", mimeType: "image/jpeg", sizeBytes: 123 });
    const link = await LinksService.createLink(account.user.id, { noteId: original.id, passphrase: "link-key", maxReads: 1 });
    const inspection = await fetch(`${baseUrl}/${link.slug}`);
    assert.ok(!("attachments" in await inspection.json()));
    const headers = { Authorization: `Bearer ${account.accessToken}` };
    const qr = await fetch(`${baseUrl}/links/${link.id}/qr`, { headers });
    assert.strictEqual(qr.status, 200);
    assert.match(qr.headers.get("content-type") ?? "", /image\/svg\+xml/);
    assert.match(await qr.text(), /<svg/);
    assert.strictEqual((await fetch(`${baseUrl}/links/${link.id}/qr`)).status, 401);
    const opened = await fetch(`${baseUrl}/${link.slug}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passphrase: "link-key", notePassphrase: "attachment-note-key" }) });
    const body = await opened.json() as { attachments: Array<Record<string, unknown>> };
    assert.strictEqual(body.attachments[0].originalName, "design.jpg");
    assert.ok(!("cloudinaryPublicId" in body.attachments[0]));
    await AuthService.logoutAll(account.user.id);
    await assert.rejects(AuthService.refreshTokens_rotate(account.refreshToken));
  });
  it("does not consume a link on GET and persists POST delivery events", async () => {
    const account = await AuthService.signup(
      `reader-${crypto.randomUUID()}@example.com`,
      "integration-password"
    );
    createdUserIds.push(account.user.id);

    const note = await NotesService.createNote(account.user.id, {
      title: "Preview-safe note",
      content: "One explicit read",
    });
    const [webhook] = await db
      .insert(webhooks)
      .values({
        userId: account.user.id,
        url: "https://example.com/webhook",
        secret: "integration-webhook-secret",
      })
      .returning();
    const link = await LinksService.createLink(account.user.id, {
      noteId: note.id,
      webhookId: webhook.id,
      maxReads: 1,
    });

    const firstInspection = await fetch(`${baseUrl}/${link.slug}`);
    const secondInspection = await fetch(`${baseUrl}/${link.slug}`);
    const sharePage = await fetch(`${baseUrl}/share/${link.slug}`);
    assert.strictEqual(sharePage.status, 200);
    assert.match(sharePage.headers.get("content-type") ?? "", /text\/html/);
    assert.strictEqual(sharePage.headers.get("cache-control"), "no-store");
    assert.strictEqual(firstInspection.status, 200);
    assert.strictEqual(secondInspection.status, 200);
    assert.deepStrictEqual(await firstInspection.json(), {
      slug: link.slug,
      requiresPassphrase: false,
    });

    const beforeConsumption = await db.query.links.findFirst({
      where: eq(links.id, link.id),
    });
    assert.strictEqual(beforeConsumption?.readsCount, 0);
    assert.strictEqual(beforeConsumption?.isBurned, false);

    const consumption = await fetch(`${baseUrl}/${link.slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.strictEqual(consumption.status, 200);

    const afterConsumption = await db.query.links.findFirst({
      where: eq(links.id, link.id),
    });
    assert.strictEqual(afterConsumption?.readsCount, 1);
    assert.strictEqual(afterConsumption?.isBurned, true);

    const deliveries = await db.query.webhookDeliveries.findMany({
      where: eq(webhookDeliveries.webhookId, webhook.id),
    });
    assert.deepStrictEqual(
      deliveries.map((delivery) => delivery.event).sort(),
      ["link.accessed", "link.burned"]
    );
  });

  it("allows only one concurrent refresh-token rotation", async () => {
    const account = await AuthService.signup(
      `refresh-${crypto.randomUUID()}@example.com`,
      "integration-password"
    );
    createdUserIds.push(account.user.id);

    const results = await Promise.allSettled([
      AuthService.refreshTokens_rotate(account.refreshToken),
      AuthService.refreshTokens_rotate(account.refreshToken),
    ]);

    assert.strictEqual(
      results.filter((result) => result.status === "fulfilled").length,
      1
    );
    assert.strictEqual(
      results.filter((result) => result.status === "rejected").length,
      1
    );
  });

  it("rejects a webhook owned by another user", async () => {
    const owner = await AuthService.signup(
      `owner-${crypto.randomUUID()}@example.com`,
      "integration-password"
    );
    const other = await AuthService.signup(
      `other-${crypto.randomUUID()}@example.com`,
      "integration-password"
    );
    createdUserIds.push(owner.user.id, other.user.id);

    const note = await NotesService.createNote(owner.user.id, {
      title: "Owned note",
      content: "Private content",
    });
    const [foreignWebhook] = await db
      .insert(webhooks)
      .values({
        userId: other.user.id,
        url: "https://example.com/webhook",
        secret: "foreign-webhook-secret",
      })
      .returning();

    await assert.rejects(
      LinksService.createLink(owner.user.id, {
        noteId: note.id,
        webhookId: foreignWebhook.id,
      }),
      (error: unknown) =>
        error instanceof Error &&
        "status" in error &&
        error.status === 404
    );
  });

  it("serves the frontend and logs out cookie sessions on its own origin", async () => {
    const root = await fetch(baseUrl);
    assert.strictEqual(root.status, 200);
    assert.match(await root.text(), /GateKeep/i);
    const script = await fetch(`${baseUrl}/public/app.js`);
    assert.strictEqual(script.status, 200);
    assert.match(script.headers.get("content-type") ?? "", /javascript/);

    const signup = await fetch(`${baseUrl}/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({
        email: `browser-${crypto.randomUUID()}@example.com`,
        password: "integration-browser-password",
      }),
    });
    assert.strictEqual(signup.status, 201);
    const account = await signup.json() as { user: { id: string } };
    createdUserIds.push(account.user.id);
    const cookieHeaders = signup.headers.getSetCookie().filter((value) => !value.startsWith("refresh_token=;"));
    const refreshHeader = cookieHeaders.find((value) => value.startsWith("refresh_token="));
    assert.ok(refreshHeader);
    assert.match(refreshHeader, /Path=\/auth;/);
    assert.match(refreshHeader, /HttpOnly/);
    const cookies = cookieHeaders.map((value) => value.split(";")[0]).join("; ");
    const session = await fetch(`${baseUrl}/auth/me`, { headers: { Cookie: cookies } });
    assert.strictEqual(session.status, 200);
    assert.strictEqual(session.headers.get("cache-control"), "no-store");
    const logout = await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookies, Origin: baseUrl },
    });
    assert.strictEqual(logout.status, 200);
    const revoked = await fetch(`${baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { Cookie: refreshHeader.split(";")[0] },
    });
    assert.strictEqual(revoked.status, 401);
  });

  it("checks both shared-note passphrases before consuming the only read", async () => {
    const account = await AuthService.signup(
      `encrypted-reader-${crypto.randomUUID()}@example.com`,
      "integration-password"
    );
    createdUserIds.push(account.user.id);
    const note = await NotesService.createNote(account.user.id, {
      title: "Encrypted shared note",
      content: "<script>Text, never executable HTML</script>",
      passphrase: "note-encryption-key",
    });
    const link = await LinksService.createLink(account.user.id, {
      noteId: note.id,
      maxReads: 1,
      passphrase: "link-access-key",
    });
    const inspection = await fetch(`${baseUrl}/${link.slug}`);
    assert.deepStrictEqual(await inspection.json(), {
      slug: link.slug,
      requiresPassphrase: true,
      isEncrypted: true,
    });
    const consume = (passphrase: string, notePassphrase: string) => fetch(`${baseUrl}/${link.slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passphrase, notePassphrase }),
    });
    assert.strictEqual((await consume("wrong", "note-encryption-key")).status, 401);
    assert.strictEqual((await consume("link-access-key", "wrong")).status, 400);
    const untouched = await db.query.links.findFirst({ where: eq(links.id, link.id) });
    assert.strictEqual(untouched?.readsCount, 0);
    assert.strictEqual(untouched?.isBurned, false);
    const opened = await consume("link-access-key", "note-encryption-key");
    assert.strictEqual(opened.status, 200);
    assert.strictEqual(opened.headers.get("cache-control"), "no-store");
    const content = await opened.json() as Record<string, unknown>;
    assert.strictEqual(content.content, "<script>Text, never executable HTML</script>");
    assert.strictEqual(content.isEncrypted, false);
    assert.strictEqual(content.isBurned, true);
    assert.strictEqual(content.readsCount, 1);
    assert.strictEqual((await consume("link-access-key", "note-encryption-key")).status, 410);
  });
});
