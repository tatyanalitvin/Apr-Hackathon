// REQ-006 / REQ-007 / REQ-017 / REQ-018 — pure-logic tests for the two
// exported helpers in auth-api.ts. The network helpers
// (`requestPasswordReset`, `confirmPasswordReset`) are deliberately out of
// scope here: they wrap `fetch` against a running backend and belong in a
// separate test surface with fetch mocks.

import { describe, it, expect, vi } from "vitest";
import type { FieldValues, UseFormReturn } from "react-hook-form";
import { prettyPasswordMessage, applyAuthIssues } from "./auth-api";

describe("prettyPasswordMessage (REQ-006)", () => {
  it("maps password_common prefix to the 'too common' copy", () => {
    expect(prettyPasswordMessage("password_common")).toBe(
      "This password is too common — please pick a stronger one.",
    );
  });

  it("matches password_common by prefix (extra detail is ignored)", () => {
    expect(prettyPasswordMessage("password_common:rockyou")).toBe(
      "This password is too common — please pick a stronger one.",
    );
  });

  it("maps password_too_short prefix to the 'too short' copy", () => {
    expect(prettyPasswordMessage("password_too_short")).toBe(
      "Password is too short (minimum 12 characters).",
    );
  });

  it("maps password_too_short by prefix (e.g. password_too_short:9)", () => {
    expect(prettyPasswordMessage("password_too_short:9")).toBe(
      "Password is too short (minimum 12 characters).",
    );
  });

  it("maps password_too_long prefix to the 'too long' copy", () => {
    expect(prettyPasswordMessage("password_too_long")).toBe(
      "Password is too long (maximum 128 characters).",
    );
  });

  it("maps password_mismatch prefix to the 'do not match' copy", () => {
    expect(prettyPasswordMessage("password_mismatch")).toBe(
      "Passwords do not match.",
    );
  });

  it("passes through unknown messages unchanged", () => {
    expect(prettyPasswordMessage("something_else")).toBe("something_else");
    expect(prettyPasswordMessage("")).toBe("");
  });

  it("does not match substrings that aren't prefixes", () => {
    // startsWith semantics: 'weak_password_common' should NOT map.
    expect(prettyPasswordMessage("weak_password_common")).toBe(
      "weak_password_common",
    );
  });
});

type TestForm = { password: string; newPassword: string; email: string };

function makeForm(): {
  form: UseFormReturn<TestForm>;
  setError: ReturnType<typeof vi.fn>;
} {
  const setError = vi.fn();
  return { form: { setError } as unknown as UseFormReturn<TestForm>, setError };
}

describe("applyAuthIssues (REQ-006/007/018)", () => {
  it("returns false and never calls setError when envelope is null", () => {
    const { form, setError } = makeForm();
    expect(applyAuthIssues(null, form, { password: "password" })).toBe(false);
    expect(setError).not.toHaveBeenCalled();
  });

  it("returns false when envelope has no issues array", () => {
    const { form, setError } = makeForm();
    expect(
      applyAuthIssues({ error: "other" }, form, { password: "password" }),
    ).toBe(false);
    expect(setError).not.toHaveBeenCalled();
  });

  it("returns false when issues array is empty", () => {
    const { form, setError } = makeForm();
    expect(
      applyAuthIssues({ error: "validation", issues: [] }, form, {
        password: "password",
      }),
    ).toBe(false);
    expect(setError).not.toHaveBeenCalled();
  });

  it("skips issues whose path is not an array", () => {
    const { form, setError } = makeForm();
    expect(
      applyAuthIssues(
        {
          error: "validation",
          issues: [{ path: "password", message: "boom" }],
        },
        form,
        { password: "password" },
      ),
    ).toBe(false);
    expect(setError).not.toHaveBeenCalled();
  });

  it("skips issues whose path[0] is not in fieldMap", () => {
    const { form, setError } = makeForm();
    expect(
      applyAuthIssues(
        {
          error: "validation",
          issues: [{ path: ["unmapped"], message: "boom" }],
        },
        form,
        { password: "password" },
      ),
    ).toBe(false);
    expect(setError).not.toHaveBeenCalled();
  });

  it("attaches a matched issue to the mapped form field", () => {
    const { form, setError } = makeForm();
    expect(
      applyAuthIssues(
        {
          error: "validation",
          issues: [{ path: ["email"], message: "bad email" }],
        },
        form,
        { email: "email" },
      ),
    ).toBe(true);
    expect(setError).toHaveBeenCalledTimes(1);
    expect(setError).toHaveBeenCalledWith("email", { message: "bad email" });
  });

  it("uses 'Invalid input' as the default message when issue.message is missing", () => {
    const { form, setError } = makeForm();
    expect(
      applyAuthIssues(
        { error: "validation", issues: [{ path: ["email"] }] },
        form,
        { email: "email" },
      ),
    ).toBe(true);
    expect(setError).toHaveBeenCalledWith("email", { message: "Invalid input" });
  });

  it("humanises password_* codes when the TARGET field name contains 'password' (case-insensitive)", () => {
    const { form, setError } = makeForm();
    applyAuthIssues(
      {
        error: "validation",
        issues: [{ path: ["password"], message: "password_too_short:9" }],
      },
      form,
      { password: "newPassword" },
    );
    expect(setError).toHaveBeenCalledWith("newPassword", {
      message: "Password is too short (minimum 12 characters).",
    });
  });

  it("humanises password_* codes when the INCOMING path key is 'password' (even for non-pw-named target)", () => {
    const { form, setError } = makeForm();
    applyAuthIssues(
      {
        error: "validation",
        issues: [{ path: ["password"], message: "password_common" }],
      },
      form,
      // deliberately route to a non-password-named target — the `key === "password"`
      // branch of the isPwField heuristic still applies.
      { password: "email" },
    );
    expect(setError).toHaveBeenCalledWith("email", {
      message: "This password is too common — please pick a stronger one.",
    });
  });

  it("passes non-password messages through unchanged for non-password fields", () => {
    const { form, setError } = makeForm();
    applyAuthIssues(
      {
        error: "validation",
        issues: [{ path: ["email"], message: "password_common" }],
      },
      form,
      { email: "email" },
    );
    // email is not a pw-field, key is not "password" — raw string survives.
    expect(setError).toHaveBeenCalledWith("email", {
      message: "password_common",
    });
  });

  it("attaches every matched issue; returns true if at least one attached", () => {
    const { form, setError } = makeForm();
    const ok = applyAuthIssues(
      {
        error: "validation",
        issues: [
          { path: ["email"], message: "bad email" },
          { path: ["unmapped"], message: "ignored" },
          { path: ["password"], message: "password_too_short" },
        ],
      },
      form,
      { email: "email", password: "password" },
    );
    expect(ok).toBe(true);
    expect(setError).toHaveBeenCalledTimes(2);
    expect(setError).toHaveBeenNthCalledWith(1, "email", {
      message: "bad email",
    });
    expect(setError).toHaveBeenNthCalledWith(2, "password", {
      message: "Password is too short (minimum 12 characters).",
    });
  });

  it("tolerates an empty path array (coerces to '' and skips)", () => {
    const { form, setError } = makeForm();
    const ok = applyAuthIssues(
      {
        error: "validation",
        issues: [{ path: [], message: "boom" }],
      },
      form,
      { "": "email" as never } as Record<string, keyof TestForm>,
    );
    // Empty path coerces to "" — if the caller happened to map "" we'd route;
    // here we supply a mapping for "" to prove the coercion. Asserts the
    // path[0]-??-"" behaviour is stable contract.
    expect(ok).toBe(true);
    expect(setError).toHaveBeenCalledWith("email", { message: "boom" });
  });

  it("is generic over the form's field shape (compile-time)", () => {
    // This test exists to exercise the generic; it will fail typecheck if
    // the generic signature regresses.
    type OtherForm = { token: string; newPassword: string } & FieldValues;
    const setError = vi.fn();
    const form = { setError } as unknown as UseFormReturn<OtherForm>;
    applyAuthIssues(
      {
        error: "validation",
        issues: [{ path: ["password"], message: "password_too_long" }],
      },
      form,
      { password: "newPassword" },
    );
    expect(setError).toHaveBeenCalledWith("newPassword", {
      message: "Password is too long (maximum 128 characters).",
    });
  });
});
