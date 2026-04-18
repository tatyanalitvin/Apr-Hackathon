import { describe, it, expect } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("merges class strings", () => {
    expect(cn("p-2", "text-sm")).toBe("p-2 text-sm");
  });

  it("dedupes conflicting Tailwind utilities", () => {
    // later utility wins
    expect(cn("p-2", "p-4")).toBe("p-4");
  });

  it("handles falsy values", () => {
    expect(cn("p-2", false && "hidden", null, undefined, "text-sm")).toBe("p-2 text-sm");
  });
});
