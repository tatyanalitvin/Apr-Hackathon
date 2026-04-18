import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "../../packages/shared/src/schema.ts",
  out: "../../infra/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://chat:chat@localhost:5432/chat",
  },
  verbose: true,
  strict: true,
});
