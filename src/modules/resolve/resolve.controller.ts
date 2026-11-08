import { Request, Response, NextFunction } from "express";
import * as ResolveService from "./resolve.service";
import { accessLinkSchema, type AccessLinkInput } from "./resolve.validation";

// Snapshot of WHO is viewing: truncated IP (45 chars = max IPv6), UA + Referer
// headers. Stored per-view in accessLogs and forwarded in webhook payloads.
function extractAccessContext(req: Request) {
  return {
    ip: (req.ip || "unknown").slice(0, 45),
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
    referrer: typeof req.headers["referer"] === "string" ? req.headers["referer"] : undefined,
  };
}

export async function resolveGet(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    // Normalise Express 5 param (string | string[]) to a single slug.
    const slug = Array.isArray(req.params.slug)
      ? req.params.slug[0]
      : req.params.slug;


    // Read-only probe: checks burned/expired, reports gate flags. No logging.
    const result = await ResolveService.inspectLink(slug);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function resolvePost(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const slug = Array.isArray(req.params.slug)
      ? req.params.slug[0]
      : req.params.slug;

    const { passphrase, notePassphrase }: AccessLinkInput = accessLinkSchema.parse(req.body);
    const ctx = extractAccessContext(req); // Capture viewer fingerprint for logging.

    const result = await ResolveService.resolveLink(slug, passphrase, ctx, notePassphrase);
    res.json(result); // Either {requiresPassphrase:true} or full content (see service types).
  } catch (err) {
    next(err);
  }
}
