// Unit tests for message-text.ts (R3 / REQ-031).
// Pure helper — no DB. See docs/specs/s1-chat.md §5 "Unicode hygiene".

import { describe, expect, it } from "vitest";
import { normalizeBody } from "./message-text";

describe("REQ-031 unicode hygiene", () => {
  it("REQ-031 NFC-normalizes decomposed sequences to precomposed form", () => {
    const decomposed = "e\u0301"; // "e" + combining acute accent
    const normalized = normalizeBody(decomposed);
    expect(normalized).toBe("\u00e9"); // "é" precomposed
    expect(normalized.length).toBe(1);
  });

  it("REQ-031 strips ASCII control characters (bell, NUL, DEL)", () => {
    const input = "hello\u0007\u0000 world\u007f!";
    expect(normalizeBody(input)).toBe("hello world!");
  });

  it("REQ-031 strips C0 range \\u0000-\\u001F except TAB/LF/CR", () => {
    expect(normalizeBody("a\u0001b\u0002c\u0003")).toBe("abc");
    expect(normalizeBody("a\u001fb")).toBe("ab");
    expect(normalizeBody("a\u000eb\u000fc")).toBe("abc");
  });

  it("REQ-031 preserves TAB, LF, CR (keepable whitespace)", () => {
    const input = "line1\nline2\tcol\rend";
    expect(normalizeBody(input)).toBe("line1\nline2\tcol\rend");
  });

  it("REQ-031 leaves clean UTF-8 unchanged", () => {
    const input = "héllo 世界 🌍";
    expect(normalizeBody(input)).toBe("héllo 世界 🌍");
  });

  it("REQ-031 combines NFC normalization and control-char stripping", () => {
    const input = "caf\u0065\u0301\u0007"; // "cafe" + combining acute + bell
    expect(normalizeBody(input)).toBe("caf\u00e9");
  });
});
