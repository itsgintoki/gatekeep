import { describe, it } from "node:test";
import assert from "node:assert";
import type { Request, Response } from "express";
import { createRateLimiter } from "../src/middleware/rateLimiter";

describe("Sliding Window Rate Limiter Middleware", () => {
  it("should allow requests under the limit and set rate limit headers", () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 3 });

    let statusCalled = false;
    let nextCalled = false;
    const headers: Record<string, unknown> = {};

    const req = { headers: {}, ip: "192.168.1.1" } as unknown as Request;
    const res = {
      setHeader: (key: string, val: unknown) => {
        headers[key] = val;
      },
      status: () => ({
        json: () => {
          statusCalled = true;
        },
      }),
    } as unknown as Response;
    const next = () => {
      nextCalled = true;
    };

    // 1st request
    limiter(req, res, next);
    assert.strictEqual(nextCalled, true);
    assert.strictEqual(headers["RateLimit-Remaining"], 2);
    assert.strictEqual(statusCalled, false);

    // 2nd request
    nextCalled = false;
    limiter(req, res, next);
    assert.strictEqual(nextCalled, true);
    assert.strictEqual(headers["RateLimit-Remaining"], 1);

    // 3rd request
    nextCalled = false;
    limiter(req, res, next);
    assert.strictEqual(nextCalled, true);
    assert.strictEqual(headers["RateLimit-Remaining"], 0);

    // 4th request -> blocked!
    nextCalled = false;
    let blockedJson: unknown;
    const blockRes = {
      setHeader: (key: string, val: unknown) => {
        headers[key] = val;
      },
      status: (code: number) => {
        assert.strictEqual(code, 429);
        return {
          json: (body: unknown) => {
            blockedJson = body;
          },
        };
      },
    } as unknown as Response;

    limiter(req, blockRes, next);
    assert.strictEqual(nextCalled, false, "next() must not be called when rate limit is exceeded");
    assert.ok(blockedJson && typeof blockedJson === "object" && "code" in blockedJson);
    assert.strictEqual(blockedJson.code, "RATE_LIMIT_EXCEEDED");
  });

  it("ignores client-supplied forwarding headers when the proxy is not trusted", () => {
    const limiter = createRateLimiter({ windowMs: 1_000, max: 1 });
    let passed = 0;
    let blocked = 0;
    const req = {
      headers: { "x-forwarded-for": "198.51.100.10" },
      ip: "203.0.113.20",
    } as unknown as Request;
    const res = {
      setHeader: () => {},
      status: (status: number) => {
        assert.strictEqual(status, 429);
        return { json: () => blocked++ };
      },
    } as unknown as Response;

    limiter(req, res, () => passed++);
    req.headers["x-forwarded-for"] = "198.51.100.11";
    limiter(req, res, () => passed++);

    assert.strictEqual(passed, 1);
    assert.strictEqual(blocked, 1);
  });
});
