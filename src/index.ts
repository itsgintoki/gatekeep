import "dotenv/config";
import { app } from "./app";
import { pool } from "./db/index";

const PORT = parseInt(process.env.PORT || "3000", 10);

async function main() {
  try {
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();
    console.log("Database connection established");
  } catch (err) {
    console.error("Database connection failed:", err);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`GateKeep running on http://localhost:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  });
}

main();
