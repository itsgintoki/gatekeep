import { Router } from "express";
import * as AuthController from "./auth.controller";
import { authenticate } from "../../middleware/authenticate";
import { authLimiter } from "../../middleware/rateLimiter";

const router = Router();

router.post("/signup", authLimiter, AuthController.signup);
router.post("/login", authLimiter, AuthController.login);
router.post("/refresh", AuthController.refresh);
router.post("/logout", AuthController.logout);

router.get("/me", authenticate, AuthController.me);

export default router;
