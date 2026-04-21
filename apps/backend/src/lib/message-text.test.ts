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

  // Invisible + bidi hardening — see exploratory bug report 2026-04-20 (B2, B3).
  // Zero-width and bidi-format characters let attackers post visible-but-empty
  // messages (B2) or visually reverse content (B3 spoofing). Strip Cf controls
  // that have no legitimate use in chat bodies, but keep ZWJ/ZWNJ so emoji
  // sequences ("👨‍👩‍👧" = U+200D) and Indic/Persian ligatures survive.
  it("strips zero-width space, LRM, RLM, word joiner, BOM", () => {
    expect(normalizeBody("a\u200bb")).toBe("ab");
    expect(normalizeBody("a\u200eb\u200fc")).toBe("abc");
    expect(normalizeBody("a\u2060b\ufeffc")).toBe("abc");
  });

  it("strips bidi embedding + override + isolate controls", () => {
    expect(normalizeBody("hello \u202eworld")).toBe("hello world");
    expect(normalizeBody("a\u202ab\u202bc\u202cd\u202de\u202ef")).toBe("abcdef");
    expect(normalizeBody("a\u2066b\u2067c\u2068d\u2069e")).toBe("abcde");
  });

  it("preserves ZWJ and ZWNJ (emoji sequences, Indic/Persian ligatures)", () => {
    const emojiFamily = "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}";
    expect(normalizeBody(emojiFamily)).toBe(emojiFamily);
    expect(normalizeBody("می\u200cخواهم")).toBe("می\u200cخواهم");
  });

  it("reduces invisible-only input to empty string", () => {
    expect(normalizeBody("\u200b\u200b\u200b")).toBe("");
    expect(normalizeBody("\u202e\u202d")).toBe("");
    expect(normalizeBody("\ufeff\u2060\u200e")).toBe("");
  });

  // B2 follow-up: the four invisible math operators U+2061..U+2064
  // (FUNCTION APPLICATION, INVISIBLE TIMES, INVISIBLE SEPARATOR, INVISIBLE
  // PLUS) are zero-width Cf controls and were missing from the original
  // INVISIBLE_FORMAT_CHARS range, letting an attacker post a body that
  // looked empty but survived `trim().length > 0`.
  it("strips invisible math operators U+2061..U+2064 (B2 gap)", () => {
    expect(normalizeBody("a\u2061b\u2062c\u2063d\u2064e")).toBe("abcde");
    expect(normalizeBody("\u2061\u2062")).toBe("");
    expect(normalizeBody("\u2061\u2062\u2063\u2064")).toBe("");
  });
});
