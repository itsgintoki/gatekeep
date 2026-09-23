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
