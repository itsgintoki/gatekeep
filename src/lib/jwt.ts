// ============================================================================
// [Phase 1 — Foundation] src/lib/jwt.ts — SHORT-LIVED ACCESS + ROTATING REFRESH
// See NAVIGATION.md Phase 1.4. WHAT: 15m access {sub,email}, 7d refresh {sub,jti}.
// WHY split: stateless fast path + revocable long session. DESIGN: rotation
// narrows stolen-token window; hashToken() = DB leak ≠ usable bearer.
// ----------------------------------------------------------------------------
// Token split (standard hardening):
//   accessToken  (15m, HS256, {sub:userId,email}) — sent as Bearer/cookie,
//                  verified on every authed request (stateless, no DB hit).
//   refreshToken (7d, HS256, {sub,jti}) — long-lived, but stored HASHED in
//                  refresh_tokens table so it can be revoked (logout).
// CONCEPT — rotation (see auth.service refreshTokens_rotate): each use
// atomically revokes the old token and issues a new pair. Stolen refresh
// tokens thus have a narrow reuse window; replay of an old token fails.
// hashToken (SHA-256): DB stores only the hash, like a password — a dump
// doesn't yield usable bearer tokens. parseTTLtoMs keeps cookie/DB expiry
// in sync with the JWT `expiresIn` string ("15m"/"7d").
// ============================================================================
import jwt, { SignOptions } from "jsonwebtoken";
import crypto from "crypto";

export interface AccessTokenPayload {
  sub: string;
  email: string;
  iat?: number;
  exp?: number;
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;
}

export function signAccessToken(
  payload: Omit<AccessTokenPayload, "iat" | "exp">
): string {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new Error("JWT_ACCESS_SECRET not set");

  const options: SignOptions = {
    expiresIn: (process.env.JWT_ACCESS_EXPIRES_IN || "15m") as SignOptions["expiresIn"],
    algorithm: "HS256",
  };
  return jwt.sign(payload, secret, options);
}

export function signRefreshToken(userId: string): {
  token: string;
  jti: string;
  expiresAt: Date;
} {
  const secret = process.env.JWT_REFRESH_SECRET;
  if (!secret) throw new Error("JWT_REFRESH_SECRET not set");

  const jti = crypto.randomUUID();
  const options: SignOptions = {
    expiresIn: (process.env.JWT_REFRESH_EXPIRES_IN || "7d") as SignOptions["expiresIn"],
    algorithm: "HS256",
  };
  const token = jwt.sign({ sub: userId, jti }, secret, options);
  const ttlMs = parseTTLtoMs(process.env.JWT_REFRESH_EXPIRES_IN || "7d");

  return { token, jti, expiresAt: new Date(Date.now() + ttlMs) };
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new Error("JWT_ACCESS_SECRET not set");
  return jwt.verify(token, secret) as AccessTokenPayload;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const secret = process.env.JWT_REFRESH_SECRET;
  if (!secret) throw new Error("JWT_REFRESH_SECRET not set");
  return jwt.verify(token, secret) as RefreshTokenPayload;
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function parseTTLtoMs(ttl: string): number {
  const units: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  const match = ttl.match(/^(\d+)([smhd])$/);
  if (!match) throw new Error(`Invalid TTL format: ${ttl}`);
  return parseInt(match[1]) * units[match[2]];
}
