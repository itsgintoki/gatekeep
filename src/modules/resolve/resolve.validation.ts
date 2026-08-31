import { z } from "zod";

export const accessLinkSchema = z.object({
  passphrase: z.string().min(1, "Passphrase cannot be empty").optional(),
});

export type AccessLinkInput = z.infer<typeof accessLinkSchema>;
