import { describe, expect, test } from "vitest";
import { isUniqueViolation } from "./pg-error";

describe("isUniqueViolation", () => {
  test("returns true for pg 23505 error with matching constraint name", () => {
    const err = {
      code: "23505",
      constraint_name: "room_name_ci_uq",
    };
    expect(isUniqueViolation(err, "room_name_ci_uq")).toBe(true);
  });

  test("returns true when pg error nests the code under `cause`", () => {
    // drizzle often wraps pg errors; test against both shapes.
    const err = {
      cause: { code: "23505", constraint_name: "room_name_ci_uq" },
    };
    expect(isUniqueViolation(err, "room_name_ci_uq")).toBe(true);
  });

  test("returns false for non-23505 errors", () => {
    const err = { code: "42P01", constraint_name: "room_name_ci_uq" };
    expect(isUniqueViolation(err, "room_name_ci_uq")).toBe(false);
  });

  test("returns false when constraint name does not match", () => {
    const err = { code: "23505", constraint_name: "room_pkey" };
    expect(isUniqueViolation(err, "room_name_ci_uq")).toBe(false);
  });

  test("returns false for non-object inputs (null, string, undefined)", () => {
    expect(isUniqueViolation(null, "room_name_ci_uq")).toBe(false);
    expect(isUniqueViolation(undefined, "room_name_ci_uq")).toBe(false);
    expect(isUniqueViolation("oops", "room_name_ci_uq")).toBe(false);
  });
});
