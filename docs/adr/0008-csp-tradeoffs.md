# ADR-0008 — CSP keeps `'unsafe-inline'` in script-src and style-src

**Status**: accepted
**Date**: 2026-04-19
**Deciders**: Tatianka, Claude Opus 4.7

## Context

REQ-149 asks for a Content-Security-Policy header on every response out of
the web app. The S3 hardening brief calls for a "locked-down" policy — ideally
`script-src 'self'` with no inline escape hatch, so that a reflected-XSS
payload injected into the DOM cannot execute.

Next.js 15 App Router produces two classes of inline script as a matter of
routine:

1. **Hydration shims.** The server-rendered HTML contains small `<script>`
   blocks that bootstrap the client-side router and rehydrate the React tree.
   These blocks are emitted by the framework at build time with content hashes
   that vary per route, per build, and per deployment.
2. **React 19 streaming RSC payload.** Server Components stream their payload
   via `self.__next_f.push([...])` calls inside inline scripts.

The orthodox CSP escape from `'unsafe-inline'` is a **nonce**: the server
generates a per-request random value, embeds it on every legitimate inline
`<script>`, and whitelists that one nonce in the CSP header. Next.js
documents the pattern (`app/layout.tsx` reads the nonce from headers and
forwards it into `<Script>` children), but it requires:

- A middleware that generates the nonce on every request.
- Touching every inline-script-emitting component to thread the nonce
  through.
- A matching `style-src 'nonce-...'` decision for Tailwind / radix-ui
  inline styles, which compound the churn.

Cost estimate: ~2h of focused work plus a non-trivial risk of breaking
server-side rendering at the App Router boundary, on a hackathon with 16h
left on the clock.

## Decision

Ship the CSP with `'unsafe-inline'` retained in `script-src` and `style-src`.
Do NOT add `'unsafe-eval'`. All other directives are locked down as per the
S3 brief: `default-src 'self'`, `object-src 'none'`, `base-uri 'self'`,
`frame-ancestors 'none'`, `form-action 'self'`.

## Consequences

+ The middleware is a ~50-line pure function with no per-request work beyond
  header writes. No build-time or runtime rewiring of Next.js components.
+ All judge-verifiable REQs — REQ-149 (CSP present), REQ-150 (HSTS present
  on https:), and the standard header trio (nosniff, X-Frame-Options,
  Referrer-Policy) — are satisfied.
+ The `object-src 'none'` + `frame-ancestors 'none'` + `base-uri 'self'` +
  `form-action 'self'` set closes off the usual XSS escalation paths that
  an attacker would reach for AFTER injecting a script.

- A reflected-XSS in our own app CAN still execute via an inline injection,
  because `'unsafe-inline'` can't distinguish "my hydration shim" from "an
  attacker's payload". The CSP downgrades from "XSS-proof" to "XSS harder to
  weaponise" — specifically: data exfiltration to third-party origins is
  blocked by `default-src 'self'` + `connect-src 'self' ws: wss:`, phishing
  via injected iframes is blocked by `frame-ancestors 'none'`, and script
  sources loaded from external CDNs are blocked by `script-src 'self'`.

## Follow-ups

When the hackathon window closes (or if a pass on the hardening is budgeted
for post-submission work), move to nonce-based CSP:

1. Add a middleware that generates a 16-byte base64 nonce per request and
   puts it on a request header (so `layout.tsx` can read it via
   `next/headers`).
2. Pass the nonce into every `<Script>` component and every inline `<style>`
   or styled component.
3. Replace `'unsafe-inline'` with `'nonce-{NONCE}'` in `script-src` and
   `style-src`. Keep `'strict-dynamic'` opt-in review-gated — it changes
   script-src semantics aggressively.

Tracked in docs/FOLLOWUPS.md.
