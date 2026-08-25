import { Router } from "express";
import * as AuthController from "./auth.controller";
import { authenticate } from "../../middleware/authenticate";

const router = Router();

// Public routes
router.post("/signup", AuthController.signup);
router.post("/login", AuthController.login);
router.post("/refresh", AuthController.refresh);
router.post("/logout", AuthController.logout);

// Protected route — requires valid access token
router.get("/me", authenticate, AuthController.me);

export default router;
