// REQ-006 — common-password blocklist loader.
//
// v4 REQ-006 requires registration to reject passwords that appear in a
// top-10,000 common-passwords list. The committed asset is
// `SecLists/Passwords/Common-Credentials/Pwdb_top-10000.txt`
// (MIT licence — https://github.com/danielmiessler/SecLists). Chosen
// over xato-net-10000 because only Pwdb's 10k list includes
// `password1234`, which is the literal fixture used in the v4 spec's
// acceptance test. Rename note: v3.docx referred to the old
// `10-million-password-list-top-10000.txt` name, renamed upstream to
// xato-net and with different content at 10k.
//
// Loader layering:
//   - `parseBlocklist(text)` — pure. split, trim, lowercase, dedupe.
//     Throws on empty/whitespace input so a zero-byte asset file fails
//     loud rather than silently permitting every password.
//   - Module-top-level: `readFileSync(asset)` → `parseBlocklist` →
//     frozen `Set<string>`. Fires once per worker process, not per
//     request, and not per `buildApp()` (see memory:
//     feedback-vitest-one-buildapp — orthogonal; module-top-level IO is
//     independent of better-auth init).
//   - `isCommonPassword(pw)` — lowercases input before Set lookup.
//     Lowercase-match on both sides closes the `Password1234` /
//     `PASSWORD1234` variant bypass (spec §5).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const ASSET_PATH = join(moduleDir, "../assets/common-passwords.txt");

export function parseBlocklist(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim().toLowerCase();
    if (line.length === 0) continue;
    out.add(line);
  }
  if (out.size === 0) {
    throw new Error(
      `password-blocklist: asset at ${ASSET_PATH} parsed to zero entries (empty or whitespace-only). Refusing to start — a missing blocklist would silently permit every password.`,
    );
  }
  return out;
}

const BLOCKLIST: ReadonlySet<string> = parseBlocklist(
  readFileSync(ASSET_PATH, "utf8"),
);

export const BLOCKLIST_SIZE = BLOCKLIST.size;

export function isCommonPassword(pw: string): boolean {
  return BLOCKLIST.has(pw.toLowerCase());
}
