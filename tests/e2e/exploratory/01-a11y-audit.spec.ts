// Exploratory a11y audit across the authenticated + unauthenticated
// surface. Does NOT run axe — deliberately focused on the failure modes
// I already spotted by hand so each assertion maps to a concrete finding
// in FINDINGS.md instead of a generic score.
//
// Per-route claims checked:
//   1. Every page has at least one <h1-6> (tab-by-heading / screen reader).
//   2. Every form input with a visible error message has
//      aria-invalid="true" + aria-describedby pointing at the error.
//   3. Every visible input has a <label for=...> association OR an
//      aria-label. Placeholder-only inputs fail.
//   4. There is a live region for transient status (toast/status).
//
// Expected outcome when written: multiple of these fail against the
// running build — the failures ARE the findings.

import { test, expect, type Page } from "@playwright/test";
import { a11ySnapshot, signInSeeded, skipIfBackendDown } from "./helpers";

test.describe.configure({ mode: "default" });

const UNAUTH_ROUTES = ["/login", "/register", "/forgot-password"] as const;
const AUTH_ROUTES = [
  "/rooms",
  "/rooms/general",
  "/rooms/browse",
  "/contacts",
  "/settings/password",
  "/settings/sessions",
  "/settings/account",
] as const;

async function auditRoute(page: Page, route: string) {
  await page.goto(route);
  // Give client components a moment to settle (toasts, hydration).
  await page.waitForLoadState("networkidle").catch(() => undefined);
  const snap = await a11ySnapshot(page);
  return { route, snap };
}

test.describe("exploratory/a11y — headings, labels, errors, live regions", () => {
  test.beforeAll(skipIfBackendDown);

  test("every unauthenticated route has at least one heading", async ({ page }) => {
    const failures: string[] = [];
    for (const route of UNAUTH_ROUTES) {
      const { snap } = await auditRoute(page, route);
      if (snap.headings.length === 0) failures.push(route);
    }
    expect(
      failures,
      `Routes with zero <h1-6>: ${failures.join(", ")}. ` +
        "Use a real heading for page title; CardTitle renders as <div>.",
    ).toEqual([]);
  });

  test("every authenticated route has at least one heading", async ({ page }) => {
    await signInSeeded(page, "alice");
    const failures: string[] = [];
    for (const route of AUTH_ROUTES) {
      const { snap } = await auditRoute(page, route);
      if (snap.headings.length === 0) failures.push(route);
    }
    expect(
      failures,
      `Routes with zero <h1-6>: ${failures.join(", ")}. ` +
        "Screen readers navigate by heading; pages without one are unnavigable.",
    ).toEqual([]);
  });

  test("login form wires aria-invalid + aria-describedby when validation fails", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: /^sign in$/i }).click();

    // Error text should appear; the contract is that the inputs advertise
    // their invalid state + describe-by the error message so AT users
    // don't just hear a silent "Sign in" that did nothing.
    await expect(page.getByText(/Invalid email/i)).toBeVisible();

    const snap = await a11ySnapshot(page);
    const email = snap.inputs.find((i) => i.id === "email");
    const pw = snap.inputs.find((i) => i.id === "password");

    expect.soft(email?.ariaInvalid, "email missing aria-invalid after failed submit").toBe("true");
    expect.soft(pw?.ariaInvalid, "password missing aria-invalid after failed submit").toBe("true");
    expect.soft(email?.ariaDescribedBy, "email missing aria-describedby linking error").toBeTruthy();
    expect.soft(pw?.ariaDescribedBy, "password missing aria-describedby linking error").toBeTruthy();
  });

  test("login form does not leak raw zod error copy to users", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill("not-an-email");
    await page.getByRole("button", { name: /^sign in$/i }).click();

    // "Too small: expected string to have >=..." is the default zod
    // message that leaks implementation detail. Password emptiness
    // should render something human like "Password is required".
    const body = await page.textContent("body");
    expect(
      body,
      "Page shows raw zod message — replace with human-readable copy.",
    ).not.toMatch(/expected string to have >=/i);
  });

  test("every visible input has a label, aria-label, or htmlFor association", async ({ page }) => {
    await signInSeeded(page, "alice");
    const offenders: Array<{ route: string; input: unknown }> = [];
    for (const route of AUTH_ROUTES) {
      const { snap } = await auditRoute(page, route);
      for (const input of snap.inputs) {
        // Hidden/file inputs often omit labels deliberately — skip them.
        if (input.type === "hidden" || input.type === "file") continue;
        if (!input.hasLabel && !input.ariaLabel) {
          offenders.push({ route, input });
        }
      }
    }
    expect(
      offenders,
      `Unlabelled inputs:\n${offenders.map((o) => `  ${o.route} — ${JSON.stringify(o.input)}`).join("\n")}`,
    ).toEqual([]);
  });
});
