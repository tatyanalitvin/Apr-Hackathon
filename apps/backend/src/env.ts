import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().default(4000),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  WEB_ORIGIN: z.string().default("http://localhost:3000"),
  // better-auth + CSRF signing. Must be >= 16 chars; 32+ in prod (§2.2).
  SESSION_SECRET: z.string().min(16),
  // §3.4 local-FS storage root for attachments
  UPLOAD_DIR: z.string().default("./infra/uploads"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Fail loudly on boot — bad env should not produce a half-working server.
  // eslint-disable-next-line no-console
  console.error("[env] invalid environment:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
