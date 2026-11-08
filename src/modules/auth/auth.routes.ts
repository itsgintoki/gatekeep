// ============================================================================
// src/modules/auth/* — SIGNUP / LOGIN / SESSION ROTATION (vertical slice)
// ----------------------------------------------------------------------------
// Layout per feature (repeat for notes/links/webhooks/resolve):
//   *.routes.ts     -> URL <-> controller mapping + route-level middleware
//   *.validation.ts -> Zod input schemas (400s happen before service runs)
//   *.controller.ts -> HTTP layer: parse/cookies/status codes, then delegate
//   *.service.ts    -> business logic + DB (no req/res here — testable)
// Follow a request: POST /auth/login -> auth.routes -> controller parses
// with loginSchema -> service verifies argon2 -> issueTokenPair -> controller
// sets httpOnly cookies + returns JSON.
// ============================================================================
import { Router } from "express";
import * as AuthController from "./auth.controller";
import { authenticate } from "../../middleware/authenticate";
import { authLimiter } from "../../middleware/rateLimiter";

const router = Router();

// Brute-force shield: 10 attempts/15min per IP in prod (see rateLimiter.ts).
router.post("/signup", authLimiter, AuthController.signup);
router.post("/login", authLimiter, AuthController.login);
router.post("/refresh", AuthController.refresh); // No limiter: needs refresh token, not guessable.
router.post("/logout", AuthController.logout);
router.post("/logout-all", authenticate, AuthController.logoutAll); // Must be logged in to kill all sessions.

router.get("/me", authenticate, AuthController.me); // Session probe for frontend.

export default router;
