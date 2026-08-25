import { Request, Response, NextFunction } from "express";
import * as AuthService from "./auth.service";
import { signupSchema, loginSchema } from "./auth.validation";

const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
  const isProduction = process.env.NODE_ENV === "production";

  res.cookie("access_token", accessToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "strict",
    maxAge: ACCESS_TOKEN_TTL_MS,
  });

  // path-scoped: cookie only sent to /auth/refresh, not every request
  res.cookie("refresh_token", refreshToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "strict",
    maxAge: REFRESH_TOKEN_TTL_MS,
    path: "/auth/refresh",
  });
}

function clearAuthCookies(res: Response) {
  res.clearCookie("access_token");
  res.clearCookie("refresh_token", { path: "/auth/refresh" });
}

export async function signup(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password } = signupSchema.parse(req.body);
    const { user, accessToken, refreshToken } = await AuthService.signup(email, password);
    setAuthCookies(res, accessToken, refreshToken);
    res.status(201).json({ message: "Account created", user, accessToken });
  } catch (err) {
    next(err);
  }
}

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const { user, accessToken, refreshToken } = await AuthService.login(email, password);
    setAuthCookies(res, accessToken, refreshToken);
    res.json({ message: "Logged in", user, accessToken });
  } catch (err) {
    next(err);
  }
}

export async function refresh(req: Request, res: Response, next: NextFunction) {
  try {
    const rawToken = req.cookies?.refresh_token || req.headers["x-refresh-token"];
    if (!rawToken || typeof rawToken !== "string") {
      res.status(401).json({ message: "No refresh token provided" });
      return;
    }
    const { accessToken, refreshToken } = await AuthService.refreshTokens_rotate(rawToken);
    setAuthCookies(res, accessToken, refreshToken);
    res.json({ message: "Tokens rotated", accessToken });
  } catch (err) {
    next(err);
  }
}

export async function logout(req: Request, res: Response, next: NextFunction) {
  try {
    const rawToken = req.cookies?.refresh_token || req.headers["x-refresh-token"];
    if (rawToken && typeof rawToken === "string") {
      await AuthService.logout(rawToken);
    }
    clearAuthCookies(res);
    res.json({ message: "Logged out" });
  } catch (err) {
    next(err);
  }
}

export function me(req: Request, res: Response) {
  res.json({ user: req.user });
}
