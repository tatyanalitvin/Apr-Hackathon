// Shared test fixtures for the backend Supertest suite.
//
// `TEST_PASSWORD_OK` replaces the previous `"password1234"` literal
// that was scattered across ~100 test files (see docs/FOLLOWUPS.md
// item #3, closed by the REQ-006 branch). `password1234` sits at rank
// ~2000 on the Pwdb top-10k common-passwords list, so once REQ-006's
// `passwordPolicyGuard` is wired, any sign-up using it 400s with
// `password_common`. The replacement chosen here is:
//   - 22 bytes UTF-8 (passes REQ-006 R1 `.min(12)` / R2 `.max(128)`),
//   - mixed case + digits + symbols (typical strong-password shape),
//   - NOT present in the committed blocklist
//     (asserted in src/lib/password-blocklist.test.ts — R9).
//
// A named constant is deliberate: a future blocklist refresh that
// accidentally includes this literal will fail R9's unit test, giving
// us one place to fix rather than hunting through 100+ files again.
export const TEST_PASSWORD_OK = "Hackaton_Test_Pw_2026!";
