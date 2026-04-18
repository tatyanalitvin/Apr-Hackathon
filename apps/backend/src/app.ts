import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { env } from "./env";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
    trustProxy: true,
  });

  await app.register(cors, {
    origin: env.WEB_ORIGIN,
    credentials: true,
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "backend",
    env: env.NODE_ENV,
  }));

  return app;
}
