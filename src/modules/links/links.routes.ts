// ============================================================================
// src/modules/links/* — SHARE-LINK MANAGEMENT (owner's private view)
// ----------------------------------------------------------------------------
// Contrast with modules/resolve/* (public unlock by slug). Here the OWNER
// manages links for their notes (all routes authenticate):
//   POST /links/            create slug for a note (+optional passphrase,
//                           expiry, maxReads, webhookId)
//   GET  /links/            paginated list with noteTitle denormalised in JS
//   GET  /links/:id         single link (ownership checked via joined note)
//   GET  /links/:id/analytics  dashboard: totals + GROUP BY breakdowns
//   GET  /links/:id/qr       SVG QR code for /share/:slug (uses `qrcode` lib)
//   DELETE /links/:id        revoke (cascades accessLogs via FK)
// Never returns passphraseHash — only hasPassphrase:boolean (hash stays secret).
// ============================================================================
import { Router } from "express";
import * as LinksController from "./links.controller";
import { authenticate } from "../../middleware/authenticate";

const router = Router();

// All routes in this router require JWT authentication
router.use(authenticate);

router.post("/", LinksController.createLink);
router.get("/", LinksController.listLinks);
router.get("/:id", LinksController.getLink);
router.get("/:id/analytics", LinksController.getLinkAnalytics);
router.get("/:id/qr", LinksController.getLinkQr);
router.delete("/:id", LinksController.deleteLink);

export default router;
