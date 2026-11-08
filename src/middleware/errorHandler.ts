// ============================================================================
// [Phase 1 — Foundation] src/middleware/errorHandler.ts — CENTRAL ERROR MAP
// See NAVIGATION.md Phase 1.4. WHAT: Multer/Zod/{status} → HTTP. WHY one place:
// controllers stay thin, no leaked stacks in prod. DESIGN: {status} convention
// avoids custom error classes.
// ----------------------------------------------------------------------------
// All controllers forward errors via next(err) -> they land here.
// Translates:
//   MulterError (file upload) -> 400 (friendly size message)
//   ZodError (validation)     -> 400 + per-field { field, message } list
//   HttpError (Object.assign(new Error, {status})) -> that status + message
//   anything else             -> 500 "Internal server error" (hides internals
//                                in prod; includes stack in dev for debugging).
// CONCEPT — error.status convention: services throw
// `Object.assign(new Error("..."), { status: 404 })` instead of custom
// error classes. This handler reads .status/.statusCode, clamps to 400-599.
// ============================================================================
import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { MulterError } from "multer";

interface HttpError extends Error {
  status?: number;
  statusCode?: number;
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof MulterError) {
    res.status(400).json({ message: err.code === "LIMIT_FILE_SIZE" ? "Files must be 30 MB or smaller" : err.message });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      message: "Validation failed",
      errors: err.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  const error: HttpError = err instanceof Error ? err : new Error(String(err));
  const requestedStatus = error.status ?? error.statusCode;
  const status =
    Number.isInteger(requestedStatus) &&
    requestedStatus !== undefined &&
    requestedStatus >= 400 &&
    requestedStatus <= 599
      ? requestedStatus
      : 500;
  const response: Record<string, unknown> = {
    message: status >= 500 ? "Internal server error" : error.message,
  };

  if (process.env.NODE_ENV !== "production" && error.stack) {
    response.stack = error.stack;
  }

  console.error(`[${req.method}] ${req.path} →`, error);
  res.status(status).json(response);
}
