import { Request, Response, NextFunction } from "express";
import * as WebhooksService from "./webhooks.service";
import {
  createWebhookSchema,
  listWebhooksQuerySchema,
} from "./webhooks.validation";

const param = (val: string | string[]): string =>
  Array.isArray(val) ? val[0] : val;

export async function createWebhook(req: Request, res: Response, next: NextFunction) {
  try {
    const data = createWebhookSchema.parse(req.body);
    const webhook = await WebhooksService.createWebhook(req.user!.id, data);
    res.status(201).json(webhook);
  } catch (err) {
    next(err);
  }
}

export async function listWebhooks(req: Request, res: Response, next: NextFunction) {
  try {
    const { page, limit } = listWebhooksQuerySchema.parse(req.query);
    const data = await WebhooksService.listWebhooks(req.user!.id, page, limit);
    res.json({ data, page, limit });
  } catch (err) {
    next(err);
  }
}

export async function getWebhook(req: Request, res: Response, next: NextFunction) {
  try {
    const webhook = await WebhooksService.getWebhook(param(req.params.id), req.user!.id);
    res.json(webhook);
  } catch (err) {
    next(err);
  }
}

export async function deleteWebhook(req: Request, res: Response, next: NextFunction) {
  try {
    await WebhooksService.deleteWebhook(param(req.params.id), req.user!.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
