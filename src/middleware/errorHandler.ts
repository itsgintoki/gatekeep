import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
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

  const status = err.status ?? err.statusCode ?? 500;
  const message = err.message ?? "Internal server error";

  const response: Record<string, unknown> = { message };
  if (process.env.NODE_ENV !== "production" && err.stack) {
    response.stack = err.stack;
  }

  console.error(`[${req.method}] ${req.path} →`, err.message);
  res.status(status).json(response);
}
