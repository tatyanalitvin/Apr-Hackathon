# ADR-0009 — Accept scrypt over argon2id — scope-bound by auth stack choice

**Status**: accepted
**Date**: 2026-04-19
**Deciders**: Tatianka, Claude Opus 4.7

## Context

v4 REQ-008 asks that passwords be hashed with argon2id. The project adopted
`better-auth` for the auth surface (ADR-0001) because the alternative —
hand-rolled NextAuth on App Router plus a custom sessions-list plus custom
rate-limit plus custom password-reset flow — would have consumed more than
the whole hackathon window.

better-auth 1.6.x uses **scrypt** for password hashing via `node:crypto scrypt`
(runtime: Node / Bun / Deno) with a pure-JS `@noble/hashes` fallback for
unsupported runtimes. The hash algorithm is fixed inside the library —
`better-auth/dist/crypto/password.mjs` — and is not pluggable via a public
configuration knob in 1.6.x. Swapping in argon2id therefore means one of:

1. Replacing better-auth with a hand-rolled auth stack (6+ hours; unwinds
   ADR-0001 and blows every downstream REQ that depended on the built-in
   sessions list, rate limiting, and password-reset flow).
2. Forking better-auth or writing a custom password adapter (not a public
   extension point in 1.6.x).
3. Waiting for a future better-auth release that exposes the hash choice.

Within the hackathon timebox none of these is viable against the cost of a
documented deviation.

## Decision

We keep better-auth's built-in scrypt (N=16384, r=8, p=1, dkLen=32 — the
library's default parameters) and document the deviation from REQ-008.

v3.docx §8 threat model is a classic web chat server: no financial PII,
no HIPAA-class data, short-lived credentials at hackathon scale. scrypt
with the library defaults is a memory-hard KDF (OWASP-approved for
password storage); it is not a known break at this threat model. The
gap between scrypt and argon2id for this workload is not where the
security budget should be spent — the bigger risks are the items tracked
in FOLLOWUPS.md (SMTP for password reset, distributed rate-limit storage,
CSRF double-submit).

## Consequences

+ Zero risk to the submission gate. ADR-0001's ~30-line auth config
  continues to cover REQ-010 / REQ-012 / REQ-014 / REQ-018 / REQ-019
  without custom hashing code.
+ No custom crypto surface to review or bug-fix inside the hackathon
  window — better-auth's scrypt path is a well-trodden default.
- Spec literalism: REQ-008 names argon2id; we ship scrypt. The test trace
  will reference this ADR instead of a test. Note in FOLLOWUPS.md.

## Post-hackathon path

If/when an argon2id migration is needed:

1. Wait for better-auth to expose a password-adapter extension point, OR
2. Replace better-auth with a stack that does — and re-derive sessions
   list / rate limiting / password reset on top.
3. Migrate existing users on next successful sign-in by rehashing
   transparently (double-hash check, upgrade in place). ADR-0001's
   stack pivot cost is the reason this is post-hackathon work.

Flag for post-hackathon; scope-blocked by ADR-0001 (stack pivot).
