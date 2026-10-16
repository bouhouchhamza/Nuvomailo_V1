import "dotenv/config";
import { z } from "zod";

export const env = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    PGHOST: z.string().min(1),
    PGPORT: z.coerce.number().int().min(1).max(65535),
    PGUSER: z.string().min(1),
    PGDATABASE: z.string().min(1),
    PGPASSWORD: z.string().min(1),
    JWT_SECRET: z.string().min(32).optional(),
    IDENTITY_ENCRYPTION_KEY: z
      .string()
      .optional()
      .refine(
        (v) =>
          v === undefined ||
          (/^[A-Za-z0-9+/]{43}=$/.test(v) &&
            Buffer.from(v, "base64").length === 32),
        "Expected a base64-encoded 32-byte key",
      ),
    FRONTEND_ORIGIN: z.url().default("http://localhost:5173"),
    WORKER_POLL_MS: z.coerce.number().int().min(100).max(60000).default(2000),
    WORKER_RECONCILE_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(60000)
      .max(86400000)
      .default(300000),
    WORKER_RECONCILE_AFTER_MS: z.coerce
      .number()
      .int()
      .min(60000)
      .max(604800000)
      .default(3600000),
  })
  .parse(process.env);

// Development tokens intentionally expire across restarts. Production must supply a secret.
// HTTP authentication enforces its production signing key in auth.ts.
// Non-HTTP workers must not receive that key merely to validate shared DB config.
