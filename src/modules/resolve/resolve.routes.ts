// ============================================================================
// src/modules/resolve/* — PUBLIC LINK UNLOCK (no login; the heart of GateKeep)
// ----------------------------------------------------------------------------
// Mounted LAST in app.ts under resolveLimiter (60/min) so /:slug can't
// swallow /auth, /notes, etc. Two-step frontend flow:
//   GET  /:slug       -> inspectLink: returns {requiresPassphrase, isEncrypted?}
//                       (lets UI decide which password fields to show WITHOUT
//                       spending a read).
//   POST /:slug       -> resolveLink {passphrase?, notePassphrase?}: verifies
//                       link passphrase (argon2), pre-verifies note decryption
//                       BEFORE consuming the read (so a typo on a 1-read link
//                       doesn't burn it), mints signed attachment URLs, then
//                       consumeLink() atomically increments + logs + queues
//                       webhooks. Wrong passphrase -> 401 (no read spent).
// Status codes: 404 unknown/deleted, 410 burned/expired (Gone, not Not Found
// — tells clients "existed but dead"), 401 bad passphrase.
// ============================================================================
import { Router } from "express";
import * as ResolveController from "./resolve.controller";

const router = Router();

router.get("/:slug", ResolveController.resolveGet); // Metadata probe (free, no side effects).
router.post("/:slug", ResolveController.resolvePost); // Actual unlock (spends a read).

export default router;
