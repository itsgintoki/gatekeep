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
  timestamps: number[];
}

/**
 * In-memory sliding window rate limiter.
 * Tracks precise timestamp arrays per IP to accurately throttle bursts
 * without boundary reset artifacts found in fixed-window algorithms.
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

    // Set standard IETF RateLimit headers
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
