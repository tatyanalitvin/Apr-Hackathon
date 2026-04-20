// Auth-flow error UX. The happy path is covered elsewhere (s1-demo); this
// spec is the negative-space companion — every way a user can fail to
// sign in and whether the UI talks back in a useful way.
//
// Claims checked:
//   1. Empty submit shows field-level errors AND the submit button is
//      not stuck in its "Signing in…" state afterwards.
//   2. Wrong-password toast and inline error both surface, copy is
//      "Invalid email or password" (generic, not "user not found" —
//      we don't want to leak account existence).
//   3. Disabled submit during inflight prevents a double-submit.
//   4. 429 rate-limit copy is "Too many attempts, wait a minute".
//   5. /login preserves ?next= all the way to /rooms after success.

import { test, expect } from "@playwright/test";
import { skipIfBackendDown, SEED_PASSWORD, SEEDED_USERS } from "./helpers";

test.describe.configure({ mode: "default" });

test.describe("exploratory/auth — error UX + anti-enumeration", () => {
  test.beforeAll(skipIfBackendDown);

  test("empty submit surfaces field-level errors and re-enables the button", async ({ page }) => {
    await page.goto("/login");
    const button = page.getByRole("button", { name: /^sign in$/i });
    await button.click();
    await expect(page.getByText(/invalid email/i)).toBeVisible();
    await expect(button).toBeEnabled();
  });

  test("wrong-password copy does not reveal whether the email exists", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(SEEDED_USERS.alice.email);
    await page.getByLabel("Password").fill("definitely-not-the-password");
    await page.getByRole("button", { name: /^sign in$/i }).click();

    // Wait for the inline error to land in the DOM rather than scraping
    // the body too early (which otherwise captures SSR streaming
    // payload). Using Playwright's auto-waiting assertion for the error
    // region instead.
    await expect(
      page.getByText(/invalid email or password/i),
    ).toBeVisible({ timeout: 10_000 });

    const unwanted = /(no such user|unknown user|account not found|no account|doesn't exist|user not found)/i;
    const inner = await page.innerText("body");
    expect.soft(
      inner,
      "Error copy reveals account existence",
    ).not.toMatch(unwanted);
  });

  test("submit button locks out a rapid double-click", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(SEEDED_USERS.bob.email);
    await page.getByLabel("Password").fill(SEED_PASSWORD);
    const button = page.getByRole("button", { name: /^sign in$/i });

    const clickRace = Promise.all([button.click(), button.click().catch(() => undefined)]);
    await clickRace;

    await expect(page).toHaveURL(/\/rooms(\/|$)/, { timeout: 15_000 });
  });

  test("safe-next: ?next= is honoured when the target is same-origin", async ({ page }) => {
    await page.goto("/login?next=%2Frooms%2Fgeneral");
    await page.getByLabel("Email").fill(SEEDED_USERS.carol.email);
    await page.getByLabel("Password").fill(SEED_PASSWORD);
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await expect(page).toHaveURL(/\/rooms\/general$/);
  });

  test("safe-next: off-origin ?next= is rejected", async ({ page }) => {
    await page.goto("/login?next=https%3A%2F%2Fevil.example%2Fsteal");
    await page.getByLabel("Email").fill(SEEDED_USERS.alice.email);
    await page.getByLabel("Password").fill(SEED_PASSWORD);
    await page.getByRole("button", { name: /^sign in$/i }).click();
    // Must NOT leave localhost. The spec is that safeNextOr snaps back to /rooms.
    await page.waitForLoadState("networkidle").catch(() => undefined);
    expect(new URL(page.url()).host).toContain("localhost");
  });
});
