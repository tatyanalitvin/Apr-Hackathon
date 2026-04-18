import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { env } from "./env";
import { auth } from "./auth";

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

  // Bridge better-auth's fetch-style handler into Fastify.
  // See docs/specs/s1-auth.md §5 "API surface" — all /api/auth/* routes are
  // owned by better-auth; we just forward Request/Response.
  app.route({
    method: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    url: "/api/auth/*",
    async handler(request, reply) {
      const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (Array.isArray(value)) headers.set(key, value.join(","));
        else if (value !== undefined) headers.set(key, String(value));
      }

      const hasBody = !["GET", "HEAD"].includes(request.method);
      const body = hasBody && request.body !== undefined
        ? JSON.stringify(request.body)
        : undefined;

      const response = await auth.handler(
        new Request(url.toString(), { method: request.method, headers, body })
      );

      reply.status(response.status);
      response.headers.forEach((v, k) => reply.header(k, v));
      const text = await response.text();
      return reply.send(text.length === 0 ? null : text);
    },
  });

  return app;
}
