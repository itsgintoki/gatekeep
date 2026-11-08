// ============================================================================
// src/middleware/upload.ts — MULTER FILE-UPLOAD GUARD (memory storage)
// ----------------------------------------------------------------------------
// Used as: router.post("/:id/attachments", upload.single("file"), controller)
//  - memoryStorage: file lands in req.file.buffer (no temp files on disk).
//    Service then streams it to Supabase (see notes.service uploadAttachment).
//  - limits.fileSize 30MB: oversize -> MulterError LIMIT_FILE_SIZE -> 400
//    via errorHandler.
//  - fileFilter allowlist: images, PDF, Word, common video. Rejects executables
//    (basic malware vector reduction; NOT a full antivirus).
// CONCEPT — multer `fileFilter` + `limits` run BEFORE your controller, so
// invalid files never reach service/DB code.
// ============================================================================
import multer from "multer";

// Keep in sync with public UI accept list + /config maxUploadBytes.
const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
];

const MAX_SIZE_BYTES = 30 * 1024 * 1024;

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(Object.assign(new Error("File type not allowed. Use JPEG, PNG, GIF, WebP, PDF, Word, MP4, WebM, Ogg, or MOV."), { status: 400 }));
    }
  },
});
