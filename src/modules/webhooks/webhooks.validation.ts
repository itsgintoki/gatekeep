import { z } from "zod";

export const createWebhookSchema = z.object({
  url: z.string().url("Must be a valid HTTP or HTTPS URL"),
});

export const listWebhooksQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;
