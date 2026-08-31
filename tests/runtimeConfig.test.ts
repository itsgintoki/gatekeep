import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateRuntimeConfig } from "../src/lib/runtimeConfig";

const CONFIG_KEYS = [
  "NODE_ENV",
  "JWT_ACCESS_SECRET",
  "JWT_REFRESH_SECRET",
  "DATABASE_URL",
] as const;

function withRuntimeEnvironment(
  values: Partial<Record<(typeof CONFIG_KEYS)[number], string>>,
  assertion: () => void
): void {
  const previous = Object.fromEntries(
    CONFIG_KEYS.map((key) => [key, process.env[key]])
  );
  try {
    for (const key of CONFIG_KEYS) {
      const value = values[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    assertion();
  } finally {
    for (const key of CONFIG_KEYS) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("Production runtime configuration", () => {
  it("rejects documented placeholder secrets", () => {
    withRuntimeEnvironment(
      {
        NODE_ENV: "production",
        JWT_ACCESS_SECRET: "your_access_token_secret_here",
        JWT_REFRESH_SECRET: "your_refresh_token_secret_here",
        DATABASE_URL: "postgresql://app:random-password@database/app",
      },
      () => assert.throws(validateRuntimeConfig, /JWT_ACCESS_SECRET/)
    );
  });

  it("accepts strong production credentials", () => {
    withRuntimeEnvironment(
      {
        NODE_ENV: "production",
        JWT_ACCESS_SECRET: "a".repeat(48),
        JWT_REFRESH_SECRET: "b".repeat(48),
        DATABASE_URL: "postgresql://app:random-password@database/app",
      },
      () => assert.doesNotThrow(validateRuntimeConfig)
    );
  });
});
