// ============================================================================
// [Phase 1 — Foundation] src/index.ts — APP ENTRY POINT (start here)
// See NAVIGATION.md Phase 1. WHAT: boot order migrations → health-check →
// poller → listen. WHY: fail fast before serving; worker never crashes boot.
// DESIGN: outbox pattern (INSERT in request, POST in background) + unref.
// ----------------------------------------------------------------------------
// Responsibility: boots the server in the right order:
//   1. validateRuntimeConfig() -> fail fast in production if secrets are weak
//   2. runMigrations()         -> ensure Postgres schema is up to date
//   3. health-check DB (SELECT 1) -> exit(1) if DB unreachable
//   4. start webhook background worker (poll every 1s)
//   5. app.listen(PORT)
//
// CONCEPT — Background polling worker: webhooks are NOT sent inline during
// a request. Instead resolve.service.ts only INSERTs a row into
// `webhook_deliveries`. This file polls that table via
// processWebhookDeliveries(). This "outbox pattern" makes link resolution
// fast and lets deliveries retry with backoff even if the target is down.
// `unref()` lets Node exit cleanly without waiting for the timer.
// ============================================================================
import "dotenv/config"; // Side-effect import: loads .env into process.env first.
import { app } from "./app"; // The configured Express app (see app.ts).
import { pool } from "./db/index"; // Raw pg Pool (used here only for health-check).
import { runMigrations } from "./db/migrate"; // Drizzle migrator wrapper.
import { processWebhookDeliveries } from "./lib/webhook"; // Outbox dispatcher.
import { validateRuntimeConfig } from "./lib/runtimeConfig"; // Prod secret checks.

// Fail fast before binding a port — no point serving with bad secrets.
validateRuntimeConfig();
const PORT = parseInt(process.env.PORT || "3000", 10);
// Guard flag: prevents overlapping polls if one batch takes > 1 second.
let webhookWorkerRunning = false;

// Single poll tick: claims due deliveries with SELECT ... FOR UPDATE
// SKIP LOCKED (see lib/webhook.ts) and POSTs them. Errors are logged,
// not thrown, so one bad webhook never crashes the server.
async function pollWebhookDeliveries(): Promise<void> {
  if (webhookWorkerRunning) {
    return; // Previous tick still running -> skip, don't pile up work.
  }
  webhookWorkerRunning = true;
  try {
    await processWebhookDeliveries();
  } catch (error) {
    console.error("Webhook worker failed:", error);
  } finally {
    webhookWorkerRunning = false;
  }
}

async function main() {
  try {
    await runMigrations();
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();
    console.log("Database migrations applied");
  } catch (err) {
    console.error("Database initialization failed:", err);
    process.exit(1);
  }
  const webhookTimer = setInterval(pollWebhookDeliveries, 1_000);
  webhookTimer.unref();
  void pollWebhookDeliveries();

  app.listen(PORT, () => {
    console.log(`GateKeep running on http://localhost:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  });
}

main();
