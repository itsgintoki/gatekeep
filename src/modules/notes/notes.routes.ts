// ============================================================================
// src/modules/notes/* — PRIVATE NOTE CRUD + ATTACHMENTS (all require login)
// ----------------------------------------------------------------------------
// Routes (authenticate runs first for every route in this file):
//   POST   /notes/            create (optional passphrase -> encrypted)
//   GET    /notes/            list (paginated, title search, no content body)
//   GET    /notes/:id         full note + signed attachment URLs
//   POST   /notes/:id/decrypt return plaintext for an encrypted note
//   PATCH  /notes/:id         partial update incl. passphrase rotation
//   DELETE /notes/:id         soft-delete + purge storage objects
//   POST/DELETE /notes/:id/attachments...  file add/remove via Multer
// See notes.service.ts for ownership scoping (every query has userId) and
// soft-delete filtering (isNull(deletedAt)).
// ============================================================================
import { Router } from "express";
import * as NotesController from "./notes.controller";
import { authenticate } from "../../middleware/authenticate";
import { upload } from "../../middleware/upload";

const router = Router();

router.use(authenticate); // Everything below is private — req.user is guaranteed.

router.post("/", NotesController.createNote);
router.get("/", NotesController.listNotes);
router.get("/:id", NotesController.getNote);
router.post("/:id/decrypt", NotesController.decryptNote);
router.patch("/:id", NotesController.updateNote);
router.delete("/:id", NotesController.deleteNote);

router.post("/:id/attachments", upload.single("file"), NotesController.uploadAttachment);
router.delete("/:id/attachments/:attachmentId", NotesController.deleteAttachment);

export default router;
