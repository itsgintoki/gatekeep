import { Router } from "express";
import * as WebhooksController from "./webhooks.controller";
import { authenticate } from "../../middleware/authenticate";

const router = Router();

// All webhook management routes require authentication
router.use(authenticate);

router.post("/", WebhooksController.createWebhook);
router.get("/", WebhooksController.listWebhooks);
router.get("/:id", WebhooksController.getWebhook);
router.delete("/:id", WebhooksController.deleteWebhook);

export default router;
