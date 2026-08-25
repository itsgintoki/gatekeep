
import { z } from "zod";

export const signupSchema = z.object({
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
