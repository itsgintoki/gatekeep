const MIN_SECRET_LENGTH = 32;

export function validateRuntimeConfig(): void {
  if (process.env.NODE_ENV !== "production") {
    return;
  }

  for (const name of ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET"] as const) {
    const value = process.env[name];
    if (!value || value.length < MIN_SECRET_LENGTH || value.startsWith("your_")) {
      throw new Error(`${name} must be replaced with at least 32 random characters`);
    }
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set in production");
  }
  if (databaseUrl.includes("gatekeep_secret")) {
    throw new Error("DATABASE_URL still contains the documented development password");
  }
}
