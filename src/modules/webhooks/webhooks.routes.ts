// ============================================================================
// src/modules/webhooks/* — OUTBOUND NOTIFICATION ENDPOINTS (owner CRUD)
// ----------------------------------------------------------------------------
// Lets a user register an HTTPS URL that GateKeep POSTs to on link events.
//   POST   /webhooks/     {url} -> {id,url,secret,createdAt} (secret shown ONCE)
//   GET    /webhooks/     paginated list (secret OMITTED — list is safe to log)
//   GET    /webhooks/:id  detail incl. secret (needed to verify signatures)
//   DELETE /webhooks/:id  remove (links keep working, webhookId SET NULL)
// Actual delivery is async via webhook_deliveries outbox — see lib/webhook.ts
// (worker) + lib/webhookHttp.ts (SSRF-safe POST). Validation here is shallow
// (HTTPS check); the deep DNS/BlockList check lives in the service.
// ============================================================================
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
