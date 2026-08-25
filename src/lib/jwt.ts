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
