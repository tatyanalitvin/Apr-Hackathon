// S3 — judge-visible security-header middleware (REQ-149, REQ-150).
//
// Every response out of Next.js passes through here. We attach a locked-down
// CSP, the universal misc-hardening trio (nosniff, X-Frame-Options, Referrer-
// Policy), and — ONLY when the request actually arrived over HTTPS — HSTS.
// The HSTS gate matters because a browser that receives `Strict-Transport-
// Security` over a plaintext response ignores the header; but if we're sitting
// behind `docker compose` on localhost (no TLS), pinning HSTS would also
// punish a developer who later points the same hostname at a misconfigured
// staging rig. Gating on `request.nextUrl.protocol === "https:"` keeps the
// header truthful: present when we mean it, absent otherwise.
//
// CSP reasoning (see docs/adr/0008-csp-tradeoffs.md for the full discussion):
//   - `script-src 'self' 'unsafe-inline'` — Next.js 15 App Router emits
//     inline hydration shims; nonce-based CSP is a ~2h rewrite of _document
//     and not worth the hackathon hour. Do NOT add 'unsafe-eval'.
//   - `style-src 'self' 'unsafe-inline'` — Tailwind + radix-ui compose inline
//     styles (radix measures popover/scroll content).
//   - `img-src 'self' data: blob:` — drag-drop previews rely on blob URLs;
//     emoji-picker-react renders inline data: sprites.
//   - `connect-src 'self' ws: wss:` — Socket.IO over the same origin; ws/wss
//     covers both local compose (ws://localhost:4000) and future TLS proxy.
//   - `frame-ancestors 'none'` + `X-Frame-Options: DENY` — doubled up so
//     clickjacking defense works on both modern (CSP-aware) and legacy
//     browsers. CSP wins where both are set, which is fine.
//   - `object-src 'none'`, `base-uri 'self'`, `form-action 'self'` — close
//     off the classic injection escape hatches.

import { NextResponse, type NextRequest } from "next/server";

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self' ws: wss:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

export function middleware(request: NextRequest): NextResponse {
  const response = NextResponse.next();

  response.headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

  // Only ship HSTS to clients that actually reached us over TLS. A `docker
  // compose up` on localhost never hits this branch, which is the point — the
  // header is a TOFU pin and we don't want to burn a developer's browser on
  // plaintext.
  if (request.nextUrl.protocol === "https:") {
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }

  return response;
}

// Next.js routes matching — cover every path EXCEPT static assets and the
// Next.js internals. _next/static is cached on CDNs that strip unknown
// headers anyway; matching it would re-run middleware on every hashed chunk
// for no gain. Images under /public (no extension in the URL) still match.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
