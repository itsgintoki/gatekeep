import { z } from "zod";

export const accessLinkSchema = z.object({
  passphrase: z.string().min(1, "Passphrase is required"),
});

export type AccessLinkInput = z.infer<typeof accessLinkSchema>;
