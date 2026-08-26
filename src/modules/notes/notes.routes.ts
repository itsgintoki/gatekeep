import { Router } from "express";
import * as NotesController from "./notes.controller";
import { authenticate } from "../../middleware/authenticate";
import { upload } from "../../middleware/upload";

const router = Router();

router.use(authenticate);

router.post("/", NotesController.createNote);
router.get("/", NotesController.listNotes);
router.get("/:id", NotesController.getNote);
router.patch("/:id", NotesController.updateNote);
router.delete("/:id", NotesController.deleteNote);

router.post("/:id/attachments", upload.single("file"), NotesController.uploadAttachment);
router.delete("/:id/attachments/:attachmentId", NotesController.deleteAttachment);

export default router;
