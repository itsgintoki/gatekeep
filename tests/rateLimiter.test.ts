import { describe, it } from "node:test";
import assert from "node:assert";
import { createRateLimiter } from "../src/middleware/rateLimiter";

describe("Sliding Window Rate Limiter Middleware", () => {
  it("should allow requests under the limit and set rate limit headers", () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 3 });

    let statusCalled = false;
    let nextCalled = false;
    const headers: Record<string, unknown> = {};

    const req: any = { headers: {}, ip: "192.168.1.1" };
    const res: any = {
      setHeader: (key: string, val: unknown) => {
        headers[key] = val;
      },
      status: () => ({
        json: () => {
          statusCalled = true;
        },
      }),
    };
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
    let blockedJson: any;
    const blockRes: any = {
      setHeader: (key: string, val: unknown) => {
        headers[key] = val;
      },
      status: (code: number) => {
        assert.strictEqual(code, 429);
        return {
          json: (body: any) => {
            blockedJson = body;
          },
        };
      },
    };

    limiter(req, blockRes, next);
    assert.strictEqual(nextCalled, false, "next() must not be called when rate limit is exceeded");
    assert.strictEqual(blockedJson.code, "RATE_LIMIT_EXCEEDED");
  });
});
