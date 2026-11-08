
// Zod = runtime type-check for untrusted JSON. .parse() throws ZodError ->
// errorHandler.ts turns it into 400 { field, message }. Keep schemas strict:
// trim/lowercase email so "A@x.com " == "a@x.com" (also enforced in service).
import { z } from "zod";

// Signup: names optional, email normalised, password length-bounded.
// NOTE: no complexity regex — length (8+) + argon2 hashing is the modern
// baseline (NIST SP 800-63B); complexity rules hurt UX more than they help.
export const signupSchema = z.object({
  firstName: z.string().trim().max(255).optional(),
  lastName: z.string().trim().max(255).optional(),
  email: z
    .string()
    .email("Invalid email format")
    .trim()
    .toLowerCase(),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128, "Password must be less than 128 characters"),
});

export const loginSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  password: z.string().min(1, "Password is required"),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
