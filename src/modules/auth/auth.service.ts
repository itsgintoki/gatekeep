import argon2, { HashOptions } from "argon2";
import { eq, and, gt } from "drizzle-orm";
import { db } from "../../db/index";
import { users, refreshTokens } from "../../db/schema";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashToken,
  type RefreshTokenPayload,
} from "../../lib/jwt";

const ARGON2_OPTIONS: HashOptions = {
  type: 2,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
};

export async function signup(email: string, password: string) {
  const existing = await db.query.users.findFirst({
    where: eq(users.email, email.toLowerCase()),
  });

  if (existing) {
    throw Object.assign(new Error("Email already registered"), { status: 409 });
  }

  const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);

  const insertedUsers = await db
    .insert(users)
    .values({ email: email.toLowerCase(), passwordHash })
    .returning();
  const user = insertedUsers[0];

  const safeUser = { id: user.id, email: user.email, createdAt: user.createdAt };
  const tokenPair = await issueTokenPair(safeUser.id, safeUser.email);

  return { user: safeUser, ...tokenPair };
}

export async function login(email: string, password: string) {
  const user = await db.query.users.findFirst({
    where: eq(users.email, email.toLowerCase()),
  });

  if (!user) {
    await argon2.hash("dummy_constant_time_op", ARGON2_OPTIONS);
    throw Object.assign(new Error("Invalid credentials"), { status: 401 });
  }

  const isValid = await argon2.verify(user.passwordHash, password);
  if (!isValid) {
    throw Object.assign(new Error("Invalid credentials"), { status: 401 });
  }

  const tokenPair = await issueTokenPair(user.id, user.email);
  return {
    user: { id: user.id, email: user.email, createdAt: user.createdAt },
    ...tokenPair,
  };
}

export async function refreshTokens_rotate(rawRefreshToken: string) {
  let payload: RefreshTokenPayload;
  try {
    payload = verifyRefreshToken(rawRefreshToken);
  } catch {
    throw Object.assign(new Error("Invalid refresh token"), { status: 401 });
  }

  const tokenHash = hashToken(rawRefreshToken);
  return db.transaction(async (tx) => {
    const [storedToken] = await tx
      .update(refreshTokens)
      .set({ isRevoked: true })
      .where(
        and(
          eq(refreshTokens.tokenHash, tokenHash),
          eq(refreshTokens.isRevoked, false),
          gt(refreshTokens.expiresAt, new Date())
        )
      )
      .returning({ userId: refreshTokens.userId });

    if (!storedToken || storedToken.userId !== payload.sub) {
      throw Object.assign(new Error("Refresh token expired or revoked"), {
        status: 401,
      });
    }

    const user = await tx.query.users.findFirst({
      where: eq(users.id, storedToken.userId),
      columns: { id: true, email: true },
    });
    if (!user) {
      throw Object.assign(new Error("User not found"), { status: 401 });
    }

    const accessToken = signAccessToken({ sub: user.id, email: user.email });
    const { token: refreshToken, expiresAt } = signRefreshToken(user.id);
    await tx.insert(refreshTokens).values({
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt,
      isRevoked: false,
    });

    return { accessToken, refreshToken };
  });
}

export async function logout(rawRefreshToken: string) {
  const tokenHash = hashToken(rawRefreshToken);
  await db
    .update(refreshTokens)
    .set({ isRevoked: true })
    .where(eq(refreshTokens.tokenHash, tokenHash));
}

async function issueTokenPair(userId: string, email: string) {
  const accessToken = signAccessToken({ sub: userId, email });
  const { token: refreshToken, expiresAt } = signRefreshToken(userId);

  await db.insert(refreshTokens).values({
    userId,
    tokenHash: hashToken(refreshToken),
    expiresAt,
    isRevoked: false,
  });

  return { accessToken, refreshToken };
}
