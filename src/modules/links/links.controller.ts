import { Request, Response, NextFunction } from "express";
import * as LinksService from "./links.service";
import { createLinkSchema, listLinksQuerySchema } from "./links.validation";

const param = (val: string | string[]): string =>
  Array.isArray(val) ? val[0] : val;

export async function createLink(req: Request, res: Response, next: NextFunction) {
  try {
    const data = createLinkSchema.parse(req.body);
    const link = await LinksService.createLink(req.user!.id, data);
    res.status(201).json(link);
  } catch (err) {
    next(err);
  }
}

export async function listLinks(req: Request, res: Response, next: NextFunction) {
  try {
    const { page, limit } = listLinksQuerySchema.parse(req.query);
    const data = await LinksService.listLinks(req.user!.id, page, limit);
    res.json({ data, page, limit });
  } catch (err) {
    next(err);
  }
}

export async function getLink(req: Request, res: Response, next: NextFunction) {
  try {
    const link = await LinksService.getLink(param(req.params.id), req.user!.id);
    res.json(link);
  } catch (err) {
    next(err);
  }
}

export async function deleteLink(req: Request, res: Response, next: NextFunction) {
  try {
    await LinksService.deleteLink(param(req.params.id), req.user!.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
