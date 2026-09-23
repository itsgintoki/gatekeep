import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import path from "node:path";

import authRouter from "./modules/auth/auth.routes";
import notesRouter from "./modules/notes/notes.routes";
import linksRouter from "./modules/links/links.routes";
import webhooksRouter from "./modules/webhooks/webhooks.routes";
import resolveRouter from "./modules/resolve/resolve.routes";
import { errorHandler } from "./middleware/errorHandler";
import { resolveLimiter, apiLimiter } from "./middleware/rateLimiter";
import { storageConfigured, storageOrigin } from "./lib/storage";

export const app = express();
const trustProxyHops = process.env.TRUST_PROXY?.trim();
if (trustProxyHops) {
  const hops = Number(trustProxyHops);
  if (!Number.isInteger(hops) || hops < 0) {
    throw new Error("TRUST_PROXY must be a non-negative integer");
  }
  app.set("trust proxy", hops);
}

const storageSource = storageOrigin();
app.use(helmet({ contentSecurityPolicy: { directives: {
  imgSrc: ["'self'", "data:", ...(storageSource ? [storageSource] : [])],
  mediaSrc: ["'self'", ...(storageSource ? [storageSource] : [])],
  frameSrc: ["'self'", ...(storageSource ? [storageSource] : [])],
} } }));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:3000")
  .split(",")
  .map((o) => o.trim());

app.use(cors((req, callback) => {
  const origin = req.get("Origin");
  const sameOrigin = origin === `${req.protocol}://${req.get("host")}`;
  if (!origin || sameOrigin || allowedOrigins.includes(origin)) {
    callback(null, { origin: true, credentials: true });
    return;
  }
  callback(new Error(`CORS: origin ${origin} not allowed`));
}));

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

const builtPublic = path.resolve(__dirname, "../dist/public");
const pageDirectory = process.env.NODE_ENV === "production"
  ? builtPublic
  : path.resolve(__dirname, "../public");

app.get("/public/style.css", (_req, res) => {
  res.sendFile(path.join(pageDirectory, "style.css"));
});
app.use("/public", express.static(builtPublic));

// Private notes and limited-read responses must not be cached by browsers.
app.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

app.get(["/", "/share/:slug"], (_req, res) => {
  res.sendFile(path.join(pageDirectory, "index.html"));
});

// Mount routes with tiered rate limiting
app.use("/auth", authRouter);
app.use("/notes", apiLimiter, notesRouter);
app.use("/links", apiLimiter, linksRouter);
app.use("/webhooks", apiLimiter, webhooksRouter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/config", (_req, res) => {
  res.json({ uploadsEnabled: storageConfigured(), maxUploadBytes: 30 * 1024 * 1024 });
});

// Mount public resolve routes last with rate limiting
app.use(resolveLimiter, resolveRouter);

app.use(errorHandler);
