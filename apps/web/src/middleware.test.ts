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
