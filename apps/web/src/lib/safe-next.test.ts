import { describe, it, expect } from "vitest";
import { isSafeNext } from "./safe-next";

describe("isSafeNext (R2b open-redirect guard)", () => {
  it("accepts a same-origin path", () => {
    expect(isSafeNext("/rooms/general")).toBe(true);
  });
  it("rejects protocol-relative //evil.com", () => {
    expect(isSafeNext("//evil.com")).toBe(false);
  });
  it("rejects /\\evil.com (Windows-style)", () => {
    expect(isSafeNext("/\\evil.com")).toBe(false);
  });
  it("rejects absolute https URL", () => {
    expect(isSafeNext("https://evil.com")).toBe(false);
  });
  it("rejects null / undefined / empty", () => {
    expect(isSafeNext(null)).toBe(false);
    expect(isSafeNext(undefined)).toBe(false);
    expect(isSafeNext("")).toBe(false);
  });
});
