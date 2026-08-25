import { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../lib/jwt";

export function authenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  let token: string | undefined;

  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  } else if (req.cookies?.access_token) {
    token = req.cookies.access_token;
  }

  if (!token) {
    res.status(401).json({ message: "Authentication required" });
    return;
  }

  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, email: payload.email };
    next();
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "TokenExpiredError") {
      res.status(401).json({ message: "Access token expired", code: "TOKEN_EXPIRED" });
    } else {
      res.status(401).json({ message: "Invalid access token" });
    }
  }
}

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; email: string };
    }
  }
}
