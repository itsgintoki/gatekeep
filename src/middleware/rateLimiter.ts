import { Request, Response, NextFunction } from "express";
export type RateLimitMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => void;

interface RateLimitOptions {
  windowMs: number; // Time window in milliseconds
  max: number;      // Max allowed requests in the window
  message?: string; // Custom error message
}

interface ClientRecord {
  timestamps: number[]; // Every request timestamp for this IP within the window.
}

/**
 * In-memory sliding window rate limiter.
 * Tracks precise timestamp arrays per IP to accurately throttle bursts
 * without boundary reset artifacts found in fixed-window algorithms.
 *
 * CONCEPT — sliding vs fixed window: fixed windows reset counters at :00,
 * letting 2x burst through at the boundary (59th + 1st second). Sliding
 * window filters to [now-windowMs, now] on every request, so bursts are
 * always counted. Trade-off: per-IP arrays in memory (fine for single
 * instance; use Redis for multi-instance prod).
 * Emits IETF RateLimit-* headers + 429 with Retry-After when exceeded.
 * Keyed by req.ip — hence TRUST_PROXY must be correct in app.ts.
 */
export function createRateLimiter(options: RateLimitOptions): RateLimitMiddleware {
  const { windowMs, max, message = "Too many requests, please try again later." } = options;
  const store = new Map<string, ClientRecord>();

  // Periodically clean up stale client records every 5 minutes to prevent memory leaks
  setInterval(() => {
    const now = Date.now();
    for (const [key, record] of store.entries()) {
      record.timestamps = record.timestamps.filter((t) => now - t < windowMs);
      if (record.timestamps.length === 0) {
        store.delete(key);
      }
    }
  }, 5 * 60 * 1000).unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || "unknown";

    const now = Date.now();
    let record = store.get(ip);

    if (!record) {
      record = { timestamps: [] };
      store.set(ip, record);
    }

    // Filter timestamps within the sliding window
    record.timestamps = record.timestamps.filter((t) => now - t < windowMs);

    // Add current request timestamp
    record.timestamps.push(now);

    const remaining = Math.max(0, max - record.timestamps.length);
    const resetTimeSeconds = Math.ceil(
      (record.timestamps[0] + windowMs - now) / 1000
    );

    res.setHeader("RateLimit-Limit", max);
    res.setHeader("RateLimit-Remaining", remaining);
    res.setHeader("RateLimit-Reset", resetTimeSeconds);

    if (record.timestamps.length > max) {
      res.setHeader("Retry-After", resetTimeSeconds);
      res.status(429).json({
        message,
        code: "RATE_LIMIT_EXCEEDED",
        retryAfterSeconds: resetTimeSeconds,
      });
      return;
    }

    next();
  };
}

// ── Tiered Limiters ──────────────────────────────────────────
// Different abuse profiles per surface: auth is brute-force sensitive,
// resolve is public/scrapable, general API is higher-traffic but authed.

/** Strict limiter on auth routes (10 attempts / 15 minutes) to prevent password brute-forcing */
export const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === "production" ? 10 : 100,
  message: "Too many authentication attempts. Please try again in 15 minutes.",
});

/** Moderate limiter on public slug resolution (60 requests / minute) to prevent bot scraping */
export const resolveLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: "Too many link access requests. Please slow down.",
});

/** Relaxed limiter for authenticated CRUD API endpoints (120 requests / 15 minutes) */
export const apiLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 120,
  message: "API rate limit exceeded. Please try again later.",
});
