import "dotenv/config";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { app } from "./app";
import { db, pool } from "./db/index";
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
    await migrate(db, { migrationsFolder: path.join(__dirname, "../drizzle") });
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
