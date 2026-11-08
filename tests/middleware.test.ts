import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { MulterError } from "multer";
import { errorHandler } from "../src/middleware/errorHandler";
import { createRateLimiter } from "../src/middleware/rateLimiter";

interface CapturedResponse {
  status?: number;
  body?: unknown;
}

function captureError(error: unknown): CapturedResponse {
  const captured: CapturedResponse = {};
  const request = { method: "GET", path: "/test" } as unknown as Request;
  const response = {
    status(status: number) {
      captured.status = status;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
  } as unknown as Response;
  const next = (() => {}) as NextFunction;
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    errorHandler(error, request, response, next);
  } finally {
    console.error = originalConsoleError;
  }
  return captured;
}

describe("Production error responses", () => {
  it("reports oversized attachments as a client error", () => {
    assert.deepStrictEqual(captureError(new MulterError("LIMIT_FILE_SIZE")), {
      status: 400,
      body: { message: "Files must be 30 MB or smaller" },
    });
  });

  it("hides internal error details", () => {
    const previousEnvironment = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const captured = captureError(new Error("database password leaked"));
      assert.strictEqual(captured.status, 500);
      assert.deepStrictEqual(captured.body, { message: "Internal server error" });
    } finally {
      if (previousEnvironment === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousEnvironment;
      }
    }
  });

  it("preserves expected client-facing errors", () => {
    const captured = captureError(
      Object.assign(new Error("Link not found"), { status: 404 })
    );
    assert.strictEqual(captured.status, 404);
    assert.ok(captured.body && typeof captured.body === "object" && "message" in captured.body);
    assert.strictEqual(captured.body.message, "Link not found");
  });
});

describe("Sliding-window rate limiter middleware", () => {
  it("allows requests under the limit and sets rate limit headers", () => {
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

    limiter(req, res, next);
    assert.strictEqual(nextCalled, true);
    assert.strictEqual(headers["RateLimit-Remaining"], 2);
    assert.strictEqual(statusCalled, false);

    nextCalled = false;
    limiter(req, res, next);
    assert.strictEqual(nextCalled, true);
    assert.strictEqual(headers["RateLimit-Remaining"], 1);

    nextCalled = false;
    limiter(req, res, next);
    assert.strictEqual(nextCalled, true);
    assert.strictEqual(headers["RateLimit-Remaining"], 0);

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
    assert.strictEqual(nextCalled, false, "next() must not be called when the rate limit is exceeded");
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
