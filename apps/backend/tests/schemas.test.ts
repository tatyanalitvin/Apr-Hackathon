import { describe, expect, test } from "vitest";
import { registerSchema, loginSchema, usernameSchema } from "@ai-herders/shared/dto";

// Unit coverage for the shared zod schemas that task #2b wires into
// Fastify preHandlers. Schema behaviour is tested here in isolation so
// regressions in `packages/shared/src/dto.ts` get caught without a running
// HTTP server.

describe("registerSchema rejects short password (deviation from v4 REQ-006 password policy, see ADR-0006)", () => {
  test("password with <8 chars fails parse", () => {
    const result = registerSchema.safeParse({
      email: "anna@example.com",
      username: "anna_01",
      password: "short",
      name: "Anna",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const pwIssue = result.error.issues.find((i) => i.path.includes("password"));
      expect(pwIssue).toBeDefined();
    }
  });

  test("password with ≥8 chars parses", () => {
    const result = registerSchema.safeParse({
      email: "anna@example.com",
      username: "anna_01",
      password: "password1234",
      name: "Anna",
    });
    expect(result.success).toBe(true);
  });
});

describe("REQ-004 usernameSchema enforces [A-Za-z0-9_]{3,32} (v4 requires {3,24}, see ADR-0006)", () => {
  test.each([
    ["ab", "too short"],
    ["a".repeat(33), "too long"],
    ["bad-name", "hyphen not allowed"],
    ["bad name", "space not allowed"],
    ["bad!name", "punctuation not allowed"],
  ])("REQ-004 rejects %s (%s)", (value) => {
    expect(usernameSchema.safeParse(value).success).toBe(false);
  });

  test.each([
    ["anna"],
    ["anna_01"],
    ["Anna_01"],
    ["a_b_c"],
    ["a".repeat(32)],
  ])("REQ-004 accepts valid username %s", (value) => {
    expect(usernameSchema.safeParse(value).success).toBe(true);
  });
});

describe("REQ-002 registerSchema rejects malformed email", () => {
  test("REQ-002 missing @-sign fails", () => {
    const result = registerSchema.safeParse({
      email: "not-an-email",
      username: "anna_01",
      password: "password1234",
      name: "Anna",
    });
    expect(result.success).toBe(false);
  });
});

describe("loginSchema basics (REQ-010 contract)", () => {
  test("REQ-010 accepts email + password; rememberMe optional", () => {
    expect(
      loginSchema.safeParse({ email: "anna@example.com", password: "password1234" }).success,
    ).toBe(true);
    expect(
      loginSchema.safeParse({
        email: "anna@example.com",
        password: "password1234",
        rememberMe: true,
      }).success,
    ).toBe(true);
  });

  test("REQ-010 rejects empty password", () => {
    expect(
      loginSchema.safeParse({ email: "anna@example.com", password: "" }).success,
    ).toBe(false);
  });
});
