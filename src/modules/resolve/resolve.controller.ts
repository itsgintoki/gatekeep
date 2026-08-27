import { Request, Response, NextFunction } from "express";
import * as ResolveService from "./resolve.service";
import { accessLinkSchema, type AccessLinkInput } from "./resolve.validation";

function extractAccessContext(req: Request) {
  const forwarded = req.headers["x-forwarded-for"];
  const rawIp = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const clientIp = (rawIp ? rawIp.split(",")[0].trim() : req.ip) || "unknown";

  return {
    ip: clientIp.slice(0, 45),
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
    const slug = Array.isArray(req.params.slug)
      ? req.params.slug[0]
      : req.params.slug;

    const ctx = extractAccessContext(req);

    const result = await ResolveService.resolveLink(slug, undefined, ctx);
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

    const { passphrase }: AccessLinkInput = accessLinkSchema.parse(req.body);
    const ctx = extractAccessContext(req);

    const result = await ResolveService.resolveLink(slug, passphrase, ctx);
    res.json(result);
  } catch (err) {
    next(err);
  }
}
