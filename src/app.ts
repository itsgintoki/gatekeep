import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";

import authRouter from "./modules/auth/auth.routes";
import notesRouter from "./modules/notes/notes.routes";
import linksRouter from "./modules/links/links.routes";
import webhooksRouter from "./modules/webhooks/webhooks.routes";
import resolveRouter from "./modules/resolve/resolve.routes";
import { errorHandler } from "./middleware/errorHandler";
import { resolveLimiter, apiLimiter } from "./middleware/rateLimiter";

export const app = express();
const trustProxyHops = process.env.TRUST_PROXY?.trim();
if (trustProxyHops) {
  const hops = Number(trustProxyHops);
  if (!Number.isInteger(hops) || hops < 0) {
    throw new Error("TRUST_PROXY must be a non-negative integer");
  }
  app.set("trust proxy", hops);
}

app.use(helmet());

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:3000")
  .split(",")
  .map((o) => o.trim());

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin ${origin} not allowed`));
      }
    },
    credentials: true,
  })
);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// Mount routes with tiered rate limiting
app.use("/auth", authRouter);
app.use("/notes", apiLimiter, notesRouter);
app.use("/links", apiLimiter, linksRouter);
app.use("/webhooks", apiLimiter, webhooksRouter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Mount public resolve routes last with rate limiting
app.use(resolveLimiter, resolveRouter);

app.use(errorHandler);
