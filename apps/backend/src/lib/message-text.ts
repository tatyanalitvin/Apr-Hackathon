// Unicode hygiene for message bodies (REQ-031).
// Applied after zod parse (size enforced there) and before INSERT.
//
// 1. NFC normalize so semantically-identical strings hash/index identically
//    ("é" as U+00E9 vs U+0065 U+0301).
// 2. Strip C0 controls + DEL, EXCEPT LF (\n), TAB (\t), CR (\r), which are
//    legitimate in chat bodies.
// 3. Strip zero-width + bidi format characters that let attackers post
//    invisible messages or visually reverse text (exploratory report
//    2026-04-20 B2/B3). ZWJ (U+200D) and ZWNJ (U+200C) are intentionally
//    kept so emoji ZWJ sequences and Indic/Persian ligatures survive.

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const INVISIBLE_FORMAT_CHARS =
  /[\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

export function normalizeBody(input: string): string {
  return input
    .normalize("NFC")
    .replace(CONTROL_CHARS, "")
    .replace(INVISIBLE_FORMAT_CHARS, "");
}
