import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { app } from "../src/app";
import { db, pool } from "../src/db";
import { links, users, webhookDeliveries, webhooks } from "../src/db/schema";
import * as AuthService from "../src/modules/auth/auth.service";
import * as LinksService from "../src/modules/links/links.service";
import * as NotesService from "../src/modules/notes/notes.service";

process.env.JWT_ACCESS_SECRET ??= "integration-access-secret-at-least-32-bytes";
process.env.JWT_REFRESH_SECRET ??= "integration-refresh-secret-at-least-32-bytes";

let server: Server | undefined;
let baseUrl = "";
const createdUserIds: string[] = [];

before(async () => {
  await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
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
});
