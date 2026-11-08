// ============================================================================
// [Phase 1 — Foundation] src/app.ts — EXPRESS APP WIRING
// See NAVIGATION.md Phase 1. WHAT: top-to-bottom request pipeline.
// WHY order matters: security → routes → /:slug last (no shadowing) →
// errorHandler last. DESIGN: tiered limiters per abuse profile.
// ----------------------------------------------------------------------------
// Read top-to-bottom as the request pipeline. Order matters in Express:
// global middleware -> public routes -> auth'd API routes -> error handler.
//
// Route map (backend-focused):
//   /auth      -> modules/auth/*        (signup/login/refresh, strict limiter)
//   /notes     -> modules/notes/*       (CRUD + attachments, apiLimiter)
//   /links     -> modules/links/*       (share-link management, apiLimiter)
//   /webhooks  -> modules/webhooks/*    (outbound webhook CRUD, apiLimiter)
//   /:slug     -> modules/resolve/*     (PUBLIC link unlock, resolveLimiter)
//   /health,/config                     (ops / frontend feature flags)
//
// CONCEPTS:
// - helmet: sets secure HTTP headers (incl. CSP for images from Supabase).
// - cors with credentials: only ALLOWED_ORIGINS + same-origin may call APIs.
// - trust proxy: needed so req.ip is real client IP behind Render/Nginx.
// - Cache-Control: no-store: private/burn-after-read notes must never cache.
// ============================================================================
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
// TRUST_PROXY = how many reverse proxies sit in front (e.g. Render = 1).
// Required for correct req.ip -> used in rate-limiting + access_logs.
const trustProxyHops = process.env.TRUST_PROXY?.trim();
if (trustProxyHops) {
  const hops = Number(trustProxyHops);
  if (!Number.isInteger(hops) || hops < 0) {
    throw new Error("TRUST_PROXY must be a non-negative integer");
  }
  app.set("trust proxy", hops);
}

// Helmet CSP tweak: allow <img>/<video> from Supabase storage origin,
// otherwise attachments would be blocked by the browser.
const storageSource = storageOrigin();
app.use(helmet({ contentSecurityPolicy: { directives: {
  imgSrc: ["'self'", "data:", ...(storageSource ? [storageSource] : [])],
  mediaSrc: ["'self'", ...(storageSource ? [storageSource] : [])],
  frameSrc: ["'self'", ...(storageSource ? [storageSource] : [])],
} } }));

// Dynamic CORS allowlist: browser sends Origin header; we echo it back
// only if allowlisted (with credentials:true so cookies/JWT pass through).
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

app.use(express.json({ limit: "1mb" })); // Cap JSON body -> mitigates payload DoS.
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser()); // Populates req.cookies (access/refresh tokens live here).

// Static frontend (index.html + style.css). In prod these are copied to dist/.
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
// NOTE: authRouter applies its own stricter authLimiter internally (see auth.routes.ts).
app.use("/auth", authRouter);
app.use("/notes", apiLimiter, notesRouter); // apiLimiter = 120 req / 15 min per IP.
app.use("/links", apiLimiter, linksRouter);
app.use("/webhooks", apiLimiter, webhooksRouter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/config", (_req, res) => {
  // Frontend feature-flag: hides upload UI when Supabase is not configured.
  res.json({ uploadsEnabled: storageConfigured(), maxUploadBytes: 30 * 1024 * 1024 });
});

// Mount public resolve routes last with rate limiting
// Placed LAST so /:slug doesn't shadow /auth, /notes, etc.
app.use(resolveLimiter, resolveRouter); // resolveLimiter = 60 req/min (anti-scraping).

// errorHandler MUST be last: Express routes errors here via next(err).
app.use(errorHandler);
