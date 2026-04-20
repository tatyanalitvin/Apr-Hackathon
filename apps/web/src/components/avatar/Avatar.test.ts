import { describe, it, expect } from "vitest";
import { hashUserIdToPalette, getInitials } from "./Avatar";

describe("hashUserIdToPalette", () => {
  it("is deterministic for the same userId", () => {
    expect(hashUserIdToPalette("user-1")).toEqual(hashUserIdToPalette("user-1"));
    expect(hashUserIdToPalette("abc-xyz-42")).toEqual(hashUserIdToPalette("abc-xyz-42"));
  });
  it("returns an index in [0, 8)", () => {
    for (const id of ["a", "b", "c", "long-user-id-with-dashes", "", "日本語"]) {
      const idx = hashUserIdToPalette(id);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(8);
    }
  });
});

describe("getInitials", () => {
  it("takes first letter of first word + first letter of last word, uppercased", () => {
    expect(getInitials("Alice Smith")).toBe("AS");
    expect(getInitials("alice smith")).toBe("AS");
    expect(getInitials("Alice Middle Smith")).toBe("AS");
  });
  it("uses one letter for single-word names", () => {
    expect(getInitials("bob")).toBe("B");
  });
  it("falls back to userId first letter when name is missing", () => {
    expect(getInitials(undefined, "user-123")).toBe("U");
  });
  it("returns ? when both are missing/empty", () => {
    expect(getInitials(undefined, undefined)).toBe("?");
    expect(getInitials("", "")).toBe("?");
  });
});
