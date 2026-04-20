// REQ-006 — unit tests for the common-password blocklist loader.
//
// TDD red state: imports from `./password-blocklist` before the module
// exists, so the file-not-found error IS the red signal. Green state
// replaces it with the real module that satisfies every case below.
//
// The loader has two layers:
//   - `parseBlocklist(text)` — pure: split, trim, lowercase, dedupe,
//     throw on empty. Directly exercised here (no FS, no mocks).
//   - `isCommonPassword(pw)` / `BLOCKLIST_SIZE` — module-level loader
//     that reads the committed asset at import-time. Covered via the
//     behavioural checks at the bottom of this file; the import itself
//     is the R7 fail-loud check on the real asset.

import { describe, expect, test } from "vitest";
import {
  BLOCKLIST_SIZE,
  isCommonPassword,
  parseBlocklist,
} from "./password-blocklist";

// ── R7: fail-loud on empty / whitespace-only asset ─────────────────────────
describe("parseBlocklist — fail-loud contract (R7)", () => {
  test("throws on empty input", () => {
    expect(() => parseBlocklist("")).toThrow(/empty/i);
  });

  test("throws on whitespace-only input", () => {
    expect(() => parseBlocklist("   \n\n\t\n")).toThrow(/empty/i);
  });

  test("accepts a minimal valid list", () => {
    const set = parseBlocklist("password\n123456\n");
    expect(set.size).toBe(2);
    expect(set.has("password")).toBe(true);
  });

  test("lowercases entries at parse time (one-sided match later)", () => {
    const set = parseBlocklist("PASSWORD\nQwerty\n");
    expect(set.has("password")).toBe(true);
    expect(set.has("qwerty")).toBe(true);
    expect(set.has("Qwerty")).toBe(false); // stored lowercase only
  });

  test("deduplicates case-folded entries", () => {
    const set = parseBlocklist("password\nPASSWORD\nPassword\n");
    expect(set.size).toBe(1);
  });

  test("trims surrounding whitespace and ignores blank lines", () => {
    const set = parseBlocklist("  password  \n\n\n   \n123456\n");
    expect(set.size).toBe(2);
    expect(set.has("password")).toBe(true);
    expect(set.has("123456")).toBe(true);
  });
});

// ── R8: loaded set size matches the committed asset (bounded) ──────────────
// Pwdb_top-10000.txt is 10 000 raw lines; parseBlocklist dedupes by
// lowercased value. Measured dedupe at commit time is 9789 — SecLists
// preserves case-variant duplicates like `Password` / `PASSWORD` /
// `password` in the raw list, which collapse to one entry here. Using a
// sanity bound (≥ 9500, ≤ 10 000) rather than the exact 9789 keeps the
// test robust to upstream asset refreshes that shift the dedupe count
// slightly, while still catching a truncated / wrong-file regression.
describe("BLOCKLIST_SIZE — committed asset (R8)", () => {
  test("size is within sanity bounds for a 10k list post-case-dedupe", () => {
    expect(BLOCKLIST_SIZE).toBeGreaterThanOrEqual(9500);
    expect(BLOCKLIST_SIZE).toBeLessThanOrEqual(10000);
  });
});

// ── R3: blocklist rejects v4-acceptance fixture + case variants ────────────
describe("isCommonPassword — v4 acceptance (R3)", () => {
  test("rejects password1234 (v4 spec literal)", () => {
    expect(isCommonPassword("password1234")).toBe(true);
  });

  test("rejects Password1234 via lowercase-match (closes case-variant bypass)", () => {
    expect(isCommonPassword("Password1234")).toBe(true);
  });

  test("rejects PASSWORD1234 via lowercase-match", () => {
    expect(isCommonPassword("PASSWORD1234")).toBe(true);
  });

  test("rejects the top-1 entry (123456)", () => {
    expect(isCommonPassword("123456")).toBe(true);
  });
});

// ── R4: random high-entropy string passes ──────────────────────────────────
describe("isCommonPassword — high-entropy miss (R4)", () => {
  test("16-char random alphanumeric+symbol string is not common", () => {
    // Static literal picked for reproducibility; the shape matches the
    // v4 spec's acceptance ("cryptographically random 16-char string").
    expect(isCommonPassword("p7K#vN2mQ!xLj$9W")).toBe(false);
  });

  test("a distinctly non-dictionary 32-char string is not common", () => {
    expect(
      isCommonPassword("wZ3!rT9@qB5#hL7%kM2$nP4&cV6*xR8("),
    ).toBe(false);
  });
});

// ── R9: the test fixture itself is not on the blocklist ────────────────────
// The fixtures helper (apps/backend/tests/helpers/fixtures.ts) lands in
// Task 6; at this point we inline the literal so the unit test can exist
// before the helper does. When Task 6 introduces the helper, this test
// should be updated to import `TEST_PASSWORD_OK` — the assertion stays.
describe("isCommonPassword — test fixture safety (R9)", () => {
  test("TEST_PASSWORD_OK is not on the blocklist", () => {
    expect(isCommonPassword("Hackaton_Test_Pw_2026!")).toBe(false);
  });

  test("seed script password (hunter2hunter2) is not on the blocklist", () => {
    expect(isCommonPassword("hunter2hunter2")).toBe(false);
  });
});
