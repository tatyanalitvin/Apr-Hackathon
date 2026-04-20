import { describe, it, expect } from "vitest";
import { tierForConfidence } from "./ConfidenceChip";

describe("tierForConfidence", () => {
  it("returns High for >= 0.8", () => {
    expect(tierForConfidence(0.8)).toEqual({ label: "High", tier: "high" });
    expect(tierForConfidence(0.95)).toEqual({ label: "High", tier: "high" });
    expect(tierForConfidence(1)).toEqual({ label: "High", tier: "high" });
  });
  it("returns Med for 0.5..0.8", () => {
    expect(tierForConfidence(0.5)).toEqual({ label: "Med", tier: "med" });
    expect(tierForConfidence(0.65)).toEqual({ label: "Med", tier: "med" });
    expect(tierForConfidence(0.79999)).toEqual({ label: "Med", tier: "med" });
  });
  it("returns Low for < 0.5", () => {
    expect(tierForConfidence(0)).toEqual({ label: "Low", tier: "low" });
    expect(tierForConfidence(0.49)).toEqual({ label: "Low", tier: "low" });
  });
  it("returns null for undefined", () => {
    expect(tierForConfidence(undefined)).toBeNull();
  });
});
