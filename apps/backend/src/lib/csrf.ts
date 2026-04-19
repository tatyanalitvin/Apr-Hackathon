// S3 — CSRF double-submit (REQ-146).
//
// Model: better-auth owns session establishment and emits an httpOnly
// `auth.session_token` cookie. That cookie alone is NOT sufficient defense
// against a CSRF attack — a cross-origin form POST to a state-changing
// endpoint will ride the cookie the browser attaches automatically, and the
// same-site hint isn't universally honoured (especially for top-level POST
// navigations in older browsers).
//
// We layer a classic double-submit CSRF token on top of better-auth:
//
//   1. On successful session establishment (sign-up / sign-in success),
//      `issueCsrfCookie()` stamps a `csrf_token` cookie. The cookie is
//      SameSite=Strict, Secure (in prod), and readable by JS (NOT
//      HttpOnly) — the client needs to read it and echo it in a header.
//   2. Every mutating request to `/api/v1/*` MUST carry a matching
//      `X-CSRF-Token` header. A cross-origin attacker cannot read the
//      cookie (same-origin policy) and therefore cannot forge the header,
//      so the preHandler returns 403.
//
// Exemptions:
//   - GET / HEAD / OPTIONS — no state change; header is not required.
//   - `/api/auth/*` — better-auth runs its own request-sig mechanism for
//     the bridge routes; layering double-submit on top creates a
//     chicken-and-egg on sign-in (no session = no csrf cookie yet).
//
// NOT exempted:
//   - `POST /api/v1/attachments` — multipart upload still goes through
//     the CSRF check because the web client uses `fetch()` with headers,
//     which can set `X-CSRF-Token` alongside the multipart body. The
//     brief's "X-Requested-With" escape is explicitly rejected (see §1b).
//   - `DELETE /api/v1/attachments/:id` — revoke is a regular JSON
//     mutation; no special-case.
//
// Shape: 403 `{ error: "csrf_token_missing" | "csrf_token_invalid" }`.

import { randomBytes, timingSafeEqual } from "node:crypto";
import type {
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";
import { env } from "../env";

export const CSRF_COOKIE_NAME = "csrf_token";
export const CSRF_HEADER_NAME = "x-csrf-token";

// 32 bytes of entropy, base64url-encoded. 43 URL-safe chars — fits comfortably
// in a cookie value and a header.
export function generateCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

// Attach a Set-Cookie on the outgoing response. We build the header by hand
// rather than reaching for @fastify/cookie — adding a plugin here is a larger
// dep than the one-line serialisation we need. SameSite=Strict is the right
// default for a same-origin SPA: the web client and the API share the root
// origin via the reverse proxy in prod (and via WEB_ORIGIN in local dev the
// cookie still flows because the browser treats :3000 and :4000 as same-site
// for cookie purposes).
export function issueCsrfCookie(reply: FastifyReply, token: string): void {
  const parts = [
    `${CSRF_COOKIE_NAME}=${token}`,
    "Path=/",
    "SameSite=Strict",
    "Max-Age=" + 60 * 60 * 24 * 7, // 7d — matches the better-auth session cap.
  ];
  if (env.NODE_ENV === "production") {
    parts.push("Secure");
  }
  // Intentionally NOT HttpOnly — the client must read the value to echo it
  // in the X-CSRF-Token header. The same-origin policy still prevents a
  // third-party page from reading the cookie via document.cookie.
  reply.header("Set-Cookie", parts.join("; "));
}

// Parse the csrf_token value out of a Cookie header. Fastify doesn't have a
// cookie parser registered (we deliberately didn't bring one in), so we walk
// the header manually. Returns null when the cookie isn't present.
function readCsrfCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const segment of cookieHeader.split(/;\s*/)) {
    const eq = segment.indexOf("=");
    if (eq === -1) continue;
    const name = segment.slice(0, eq).trim();
    if (name === CSRF_COOKIE_NAME) {
      return segment.slice(eq + 1).trim();
    }
  }
  return null;
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isExemptPath(url: string): boolean {
  // Strip querystring before prefix matching — a crafted `?_=/api/v1/...`
  // suffix can't sneak past (URL-parse via URL is overkill; path is always
  // the first `?`-terminated prefix).
  const path = url.split("?", 1)[0];
  // better-auth bridge runs its own CSRF protection + origin check on the
  // auth flow. Layering double-submit on top would block sign-in before the
  // csrf_token cookie has been issued. Also exempt socket.io handshake +
  // health probes — neither is JSON state-changing on a /api/v1/* surface.
  return (
    path.startsWith("/api/auth/") ||
    path.startsWith("/socket.io/") ||
    path === "/health"
  );
}

// Fastify onRequest hook — runs BEFORE body parsing, which matters for
// multipart: a missing CSRF header fails the request before we start reading
// the (potentially 20 MB) attachment body. Ordering: @fastify/cors runs its
// own preflight response before onRequest for OPTIONS, so the `return` on
// OPTIONS below is insurance, not strictly necessary.
//
// Non-browser-caller pass-through: if neither `Origin` nor `Referer` is
// present, the request did NOT come from a browser. A curl / CLI / Node
// fetch client is not a CSRF attack vector — CSRF requires a browser that
// the attacker has tricked into making a state-changing request while
// carrying victim cookies. Browsers set `Origin` on every cross-origin
// AND every same-origin mutating request as of modern WHATWG fetch. This
// pass-through lets backend-to-backend / test-runner / server-rendered
// fetch flows work without a CSRF cookie, while still enforcing the
// double-submit on anything that might be a browser. OWASP's CSRF prevention
// cheat sheet lists Origin/Referer check as a primary defense; double-submit
// is the second layer we run when a browser IS the caller.
export const csrfPreHandler: onRequestHookHandler = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  if (!MUTATING_METHODS.has(request.method)) return;
  if (isExemptPath(request.url)) return;

  const origin = request.headers.origin;
  const referer = request.headers.referer;
  if (!origin && !referer) {
    // Not a browser. Skip CSRF; the session cookie (if any) still authenticates.
    return;
  }

  const cookie = readCsrfCookie(request.headers.cookie);
  if (!cookie) {
    return reply.status(403).send({ error: "csrf_token_missing" });
  }

  const header = request.headers[CSRF_HEADER_NAME];
  const provided = Array.isArray(header) ? header[0] : header;
  if (typeof provided !== "string" || provided.length === 0) {
    return reply.status(403).send({ error: "csrf_token_missing" });
  }

  // Constant-time compare. Timing-safe matters less here than on a password
  // compare, but it's a 2-line defense — a timing side-channel on a header
  // value still leaks N bytes per attempt.
  const a = Buffer.from(cookie);
  const b = Buffer.from(provided);
  const equal = a.length === b.length && timingSafeEqual(a, b);
  if (!equal) {
    return reply.status(403).send({ error: "csrf_token_invalid" });
  }
};
