// Unicode hygiene for message bodies (REQ-031).
// Applied after zod parse (size enforced there) and before INSERT.
//
// 1. NFC normalize so semantically-identical strings hash/index identically
//    ("é" as U+00E9 vs U+0065 U+0301).
// 2. Strip C0 controls + DEL, EXCEPT LF (\n), TAB (\t), CR (\r), which are
//    legitimate in chat bodies.

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function normalizeBody(input: string): string {
  return input.normalize("NFC").replace(CONTROL_CHARS, "");
}
