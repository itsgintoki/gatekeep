import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { errorHandler } from "../src/middleware/errorHandler";

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
