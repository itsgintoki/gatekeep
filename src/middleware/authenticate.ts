// ============================================================================
// [Phase 1 — Foundation] src/middleware/authenticate.ts — JWT GATEKEEPER
// See NAVIGATION.md Phase 1.4. WHAT: Bearer OR cookie → req.user. WHY two
// sources: API clients + browser. DESIGN: TOKEN_EXPIRED code triggers refresh.
// ----------------------------------------------------------------------------
// Usage: router.use(authenticate) (see notes/links/webhooks routes).
// Accepts token from EITHER:
//   1. Authorization: Bearer <jwt>  (API clients / tests)
//   2. access_token cookie          (browser frontend, httpOnly)
// On success attaches req.user = { id, email } for downstream
// controllers/services to scope DB queries to the owner.
// On failure: 401 immediately (distinguishes expiry via code=TOKEN_EXPIRED
// so the frontend knows to call /auth/refresh).
// CONCEPT — global augmentation below teaches TypeScript that Express.Request
// now optionally carries .user after this middleware runs.
// ============================================================================
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
