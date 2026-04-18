// Fastify → WHATWG Headers bridge. better-auth's server API (auth.api.*)
// and raw handler both accept a Headers instance; Fastify exposes headers as
// a plain object with string | string[] | undefined values. This converter is
// the single place that reconciles the two.
//
// INBOUND ONLY. Outbound (better-auth → Fastify reply) is handled in
// app.ts's proxyToBetterAuth via `response.headers.forEach((v,k) => reply.header(k,v))`
// — which correctly repeats `set-cookie`. Do not use this helper for that
// direction: `Array.isArray ? join(",")` would merge multiple Set-Cookies.

import type { FastifyRequest } from "fastify";

export function toFetchHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(","));
    else if (value !== undefined) headers.set(key, String(value));
  }
  return headers;
}
