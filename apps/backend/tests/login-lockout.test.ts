// REQ-012 — per-email sign-in failure lockout.
//
// STATUS: Production code NOT shipped. This file exists to:
//   1. Give REQ-012 a traceable home in `pnpm trace` output (test names
//      carry REQ-012 so grep-based coverage maps find them).
//   2. Document — as executable-shape placeholders — the exact boundary
//      behaviour the S3 hardening task would need to satisfy when the
//      feature actually lands.
//
// CONTRACT (v3.docx §2.1.5 / v4 REQ-012):
//   After 10 failed sign-in attempts against the same email within a
//   15-minute sliding window, subsequent sign-in attempts against that
//   email return a `locked` / `auth_locked` error code (NOT the generic
//   `INVALID_EMAIL_OR_PASSWORD`). The counter is keyed on email, not IP —
//   a botnet hitting one email from 10 different IPs MUST still trip
//   the lockout on the 10th attempt.
//
// CURRENT BEHAVIOUR (deviation — see docs/adr/0006-req-catalog-canonical.md
// row REQ-012, docs/FOLLOWUPS.md "S3 — hardening / pre-ship" item #7):
//   `rateLimit.customRules["/sign-in/email"] = { window: 60, max: 5 }` in
//   apps/backend/src/auth.ts caps wrong-creds at 5/60s PER IP. A single
//   attacker IP trips at attempt #6 with a 429. A distributed attacker
//   that stays under 5/60s per source IP never triggers anything.
//   `rate-limit.test.ts` pins the IP behaviour; no test asserts per-email
//   lockout because nothing implements per-email lockout.
//
// These tests are deliberately `test.todo` (not `test.skip`) so vitest
// surfaces them as "todo" in the summary — a louder signal than "skipped"
// that the REQ is open, not merely gated behind a flag.

import { describe, test } from "vitest";

describe("REQ-012 per-email sign-in lockout — NOT IMPLEMENTED (see FOLLOWUPS S3 #7)", () => {
  // Boundary: attempt #9 is still a plain invalid-credentials 4xx.
  // When the feature lands, implementation MUST NOT short-circuit before
  // the 10th attempt — otherwise legitimate users who typo their
  // password a handful of times get rejected as "locked" instead of
  // "wrong password", which is a worse UX AND a weak enumeration signal.
  test.todo(
    "REQ-012 9th wrong-password attempt on same email returns invalid-credentials (not locked)",
  );

  // Trigger edge: the 10th failed attempt is the first locked response.
  // Error code MUST be distinguishable from the generic 401 so the web
  // layer can surface the "too many attempts, try again in N minutes"
  // copy instead of the normal "wrong email or password" string. The
  // v3.docx naming is `auth_locked`; any stable sentinel the frontend
  // can switch on is acceptable (coordinate with web if renaming).
  test.todo(
    "REQ-012 10th failed attempt on same email returns locked / auth_locked code",
  );

  // Persistence: once locked, correct credentials on attempt #11 MUST
  // still be rejected with the locked code. Otherwise an attacker who
  // happens to guess right on attempt #11 bypasses the lockout, which
  // defeats the whole REQ. Covered by test #2 if implementation locks
  // the email record itself, but pinned separately because a naive
  // implementation could gate only wrong-password attempts.
  test.todo(
    "REQ-012 11th attempt with correct password still returns locked (lockout outranks credential check)",
  );

  // Per-email scoping: lockout on victim@example.com MUST NOT affect
  // other@example.com. This is the whole reason per-email exists — if
  // the counter bled across emails it would be a trivial DoS vector.
  test.todo(
    "REQ-012 lockout on one email does NOT block sign-in on a different email",
  );

  // Window expiry: after 15 minutes with no further failures, a
  // correct-password attempt MUST succeed. Implementation likely uses a
  // Redis TTL on the counter key (sliding or fixed window — spec is
  // silent; sliding is strictly friendlier to legitimate users). Test
  // this via `vi.useFakeTimers()` + `vi.setSystemTime()` so the suite
  // doesn't sleep 15 real minutes; verify the Redis key actually
  // expires (better-auth's TTL does NOT respect fake timers — the real
  // implementation may need to expose a test-mode clock injection,
  // OR the test can directly DEL the Redis key to simulate expiry).
  test.todo(
    "REQ-012 after 15-minute window elapses, correct-password sign-in succeeds",
  );

  // IP-independence: the counter is per-EMAIL, not per-(email,IP). This
  // is the whole point of the REQ — IP-based limits already exist and
  // don't stop a botnet. Exercising this requires either spoofing
  // X-Forwarded-For (if trust-proxy is on in the test harness) or
  // asserting against whatever key the implementation chose. Flagged
  // here so the implementer remembers the requirement.
  test.todo(
    "REQ-012 10 failures across different source IPs (same email) still trip the lockout",
  );
});

// Implementation sketch for whoever picks up S3 #7:
//   1. better-auth 1.6.5 has no built-in per-email lockout hook — the
//      `rateLimit.customRules` path keys on IP, not request body fields
//      (verified in node_modules/better-auth/.../rate-limiter/index.mjs).
//      So the counter must live in a wrapper preHandler on
//      `POST /api/auth/sign-in/email`, similar in shape to the
//      apps/backend/src/lib/register-rate-limit.ts /24 preHandler.
//   2. Counter storage: Redis, key = `login-lockout:<lower(email)>`,
//      TTL = 15min on first increment, reset on successful login.
//   3. Error surface: return `{ code: "auth_locked", retryAfter: <s> }`
//      with HTTP 423 (Locked) or 429 — decide in the spec review.
//   4. Web layer change: `apps/web/src/app/(auth)/login/...` must
//      switch the error copy when `code === "auth_locked"`.
//   5. Observability: emit a `login.lockout.tripped` metric counter
//      (via apps/backend/src/lib/metrics.ts) so ops can see attacks.
