// REQ-149 (CSP) + REQ-150 (HSTS) + misc hardening header coverage.
//
// We call the middleware directly with a synthesized NextRequest and inspect
// the response headers it sets. No HTTP server spin-up — middleware is a pure
// function of (request) → response in Next.js 15, so vitest under jsdom is
// enough.

import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "./middleware";

function buildRequest(url: string): NextRequest {
  return new NextRequest(new URL(url));
}

describe("REQ-149 CSP + REQ-150 HSTS middleware", () => {
  it("REQ-149 sets a locked-down Content-Security-Policy on every response", () => {
    const res = middleware(buildRequest("http://localhost:3000/"));
    const csp = res.headers.get("content-security-policy");
    expect(csp).not.toBeNull();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    // unsafe-eval must NEVER be present — eval is the classic XSS escalator.
    expect(csp).not.toContain("unsafe-eval");
  });

  it("img-src includes the backend sidecar origin so attachment thumbnails load (REQ-213)", () => {
    // AttachmentImage / AttachmentChip render <img src="{BACKEND_URL}{download}">.
    // Without the backend origin in img-src, `'self' data: blob:` blocks every
    // /attachments/* image fetch — breaking inline previews post-login.
    const res = middleware(buildRequest("http://localhost:3000/rooms/general"));
    const csp = res.headers.get("content-security-policy") ?? "";
    const imgDirective = csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("img-src"));
    expect(imgDirective).toBeDefined();
    expect(imgDirective).toContain("'self'");
    expect(imgDirective).toContain("http://localhost:4000");
  });

  it("connect-src includes the backend sidecar origin so auth + REST XHR reach :4000", () => {
    // The web app runs on :3000 and talks to the Fastify sidecar on a
    // different origin (:4000 under docker compose, see docker-compose.yml
    // and apps/web/src/lib/backend.ts). `'self'` only covers :3000, so
    // NEXT_PUBLIC_BACKEND_URL's origin must be listed explicitly or every
    // /api/auth/* fetch (and every REST mutation) is CSP-blocked.
    const res = middleware(buildRequest("http://localhost:3000/register"));
    const csp = res.headers.get("content-security-policy") ?? "";
    const connectDirective = csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("connect-src"));
    expect(connectDirective).toBeDefined();
    expect(connectDirective).toContain("'self'");
    expect(connectDirective).toContain("http://localhost:4000");
  });

  it("sets nosniff / X-Frame-Options / Referrer-Policy on every response", () => {
    const res = middleware(buildRequest("http://localhost:3000/any/path"));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe(
      "strict-origin-when-cross-origin",
    );
  });

  it("REQ-150 emits HSTS with includeSubDomains only on https:", () => {
    const res = middleware(buildRequest("https://chat.example/"));
    const hsts = res.headers.get("strict-transport-security");
    expect(hsts).toBe("max-age=31536000; includeSubDomains");
  });

  it("REQ-150 omits HSTS on plaintext http: so local dev isn't TOFU-pinned", () => {
    const res = middleware(buildRequest("http://localhost:3000/"));
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });
});
