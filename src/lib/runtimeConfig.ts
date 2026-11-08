// ============================================================================
// src/lib/runtimeConfig.ts — FAIL-FAST PRODUCTION SANITY CHECKS
// ----------------------------------------------------------------------------
// Called once from index.ts before listening. In dev it no-ops (DX first);
// in production (NODE_ENV=production) it throws on:
//  - JWT secrets missing / <32 chars / still placeholder ("your_...").
//    Short/guessable HMAC secrets = forgeable tokens.
//  - DATABASE_URL missing or still containing the documented dev password
//    "gatekeep_secret" (prevents accidentally shipping dev creds to prod).
// Throwing at boot is cheaper than debugging forged-token incidents later.
// ============================================================================
const MIN_SECRET_LENGTH = 32; // 256-bit-ish entropy bar for HMAC secrets.

export function validateRuntimeConfig(): void {
  if (process.env.NODE_ENV !== "production") {
    return;
  }

  for (const name of ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET"] as const) {
    const value = process.env[name];
    if (!value || value.length < MIN_SECRET_LENGTH || value.startsWith("your_")) {
      throw new Error(`${name} must be replaced with at least 32 random characters`);
    }
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set in production");
  }
  if (databaseUrl.includes("gatekeep_secret")) {
    throw new Error("DATABASE_URL still contains the documented development password");
  }
}
