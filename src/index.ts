import "dotenv/config";
import { app } from "./app";
import { pool } from "./db/index";
import { runMigrations } from "./db/migrate";
import { processWebhookDeliveries } from "./lib/webhook";
import { validateRuntimeConfig } from "./lib/runtimeConfig";

validateRuntimeConfig();
const PORT = parseInt(process.env.PORT || "3000", 10);
let webhookWorkerRunning = false;

async function pollWebhookDeliveries(): Promise<void> {
  if (webhookWorkerRunning) {
    return;
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
