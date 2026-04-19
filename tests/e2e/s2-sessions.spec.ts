// REQ-017 + REQ-018 — /settings/sessions list + revoke (v3.docx §2.2.4).
//
// Binding: docs/specs/s2-e2e-coverage.md §4 R1/R2/R3. Sessions-UI spec at
// docs/specs/s2-sessions-ui.md §4 R1–R11 describes the component-level
// behaviours; this file is the browser-level round-trip.
//
// Multi-session dance: R2 needs Alice signed in on TWO isolated
// BrowserContexts (Chrome A + Chrome B) so Chrome A can see two rows in
// the sessions list. Non-MCP Playwright's browser.newContext() allocates
// an isolated cookie jar per call — the memory entry
// "Playwright MCP multi-user needs two browsers" only applies to the MCP
// driver. See docs/specs/s2-e2e-coverage.md §5.

import { test, expect, type Page, type BrowserContext } from "@playwright/test";

const BACKEND_HEALTH = "http://localhost:4000/health";

const stamp = () => Date.now().toString(36);

async function registerAndEnterRooms(
  page: Page,
  user: { email: string; username: string; name: string; password: string },
): Promise<void> {
  await page.goto("/register");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Username").fill(user.username);
  await page.getByLabel("Display name").fill(user.name);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByLabel("Confirm password").fill(user.password);
  await page.getByRole("button", { name: /create account/i }).click();
  await expect(page).toHaveURL(/\/rooms(\/|$)/, { timeout: 15_000 });
}

async function signInAs(
  page: Page,
  user: { email: string; password: string },
): Promise<void> {
  // Direct nav (not Link click) — per feedback-playwright-rhf-spa-transition,
  // react-hook-form register() races with Next.js Link transitions; goto
  // sidesteps it.
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await expect(page).toHaveURL(/\/rooms(\/|$)/, { timeout: 15_000 });
}

test.describe.configure({ mode: "serial" });

test.describe("REQ-017 REQ-018 — active sessions list + revoke", () => {
  test.beforeAll(async () => {
    const res = await fetch(BACKEND_HEALTH).catch(() => null);
    test.skip(
      !res || !res.ok,
      `Backend not healthy at ${BACKEND_HEALTH}. Boot with: docker compose up --build -d (or pnpm --filter backend dev).`,
    );
  });

  test("REQ-017 — sessions list renders one current-browser row with the expected columns", async ({
    browser,
  }) => {
    const suffix = stamp();
    const alice = {
      email: `sess-r1-${suffix}@herders.local`,
      username: `sessR1${suffix}`,
      name: "Sessions R1",
      password: "playwright-sess-1234",
    };

    const ctx: BrowserContext = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await registerAndEnterRooms(page, alice);

      await page.goto("/settings/sessions");
      await expect(
        page.getByRole("heading", { name: /active sessions/i }),
      ).toBeVisible({ timeout: 10_000 });

      // REQ-017 R2 — column headers are authoritative; if sessions-ui renames
      // one, this test fails immediately.
      for (const header of [
        "Browser",
        "IP",
        "Last active",
        "Created",
        "Status",
        "Action",
      ]) {
        await expect(
          page.getByRole("columnheader", { name: new RegExp(`^${header}$`, "i") }),
        ).toBeVisible();
      }

      // REQ-017 R3 — current-browser badge present on the only row.
      await expect(page.getByText("This browser")).toBeVisible();
      await expect(page.getByRole("row")).toHaveCount(2); // header + 1 session row
      await expect(
        page.getByRole("button", { name: /^sign out this browser$/i }),
      ).toBeVisible();
    } finally {
      await ctx.close();
    }
  });

  test("REQ-018 — revoke a non-current session; the revoked context redirects to /login on next nav", async ({
    browser,
  }) => {
    const suffix = stamp();
    const alice = {
      email: `sess-r2-${suffix}@herders.local`,
      username: `sessR2${suffix}`,
      name: "Sessions R2",
      password: "playwright-sess-1234",
    };

    const chromeA: BrowserContext = await browser.newContext();
    const chromeB: BrowserContext = await browser.newContext();
    try {
      const pageA = await chromeA.newPage();
      const pageB = await chromeB.newPage();

      await registerAndEnterRooms(pageA, alice);
      // Second context signs IN (not registers) as the same user — this is
      // what produces a second row in the sessions table.
      await signInAs(pageB, alice);

      await pageA.goto("/settings/sessions");
      // Two rows: current (Chrome A) + other (Chrome B).
      await expect(pageA.getByRole("row")).toHaveCount(3, {
        timeout: 15_000,
      });
      await expect(pageA.getByText("This browser")).toHaveCount(1);

      // Sign out the non-current row. The current row's button text is
      // "Sign out this browser"; the other row's is "Sign out".
      await pageA
        .getByRole("button", { name: /^sign out$/i })
        .first()
        .click();

      // Optimistic remove → one session row left (header + 1).
      await expect(pageA.getByRole("row")).toHaveCount(2, {
        timeout: 10_000,
      });

      // Chrome B's cookie is now invalid. Navigating to a protected route
      // triggers RequireSession → /login redirect. Using /rooms (not the
      // sessions page) to keep the next= query predictable.
      await pageB.goto("/rooms");
      await expect(pageB).toHaveURL(/\/login(\?|$)/, { timeout: 15_000 });
    } finally {
      await chromeA.close();
      await chromeB.close();
    }
  });

  test("REQ-018 — self-revoke redirects the current browser to /login", async ({
    browser,
  }) => {
    const suffix = stamp();
    const alice = {
      email: `sess-r3-${suffix}@herders.local`,
      username: `sessR3${suffix}`,
      name: "Sessions R3",
      password: "playwright-sess-1234",
    };

    const ctx: BrowserContext = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await registerAndEnterRooms(page, alice);

      await page.goto("/settings/sessions");
      await expect(
        page.getByRole("button", { name: /^sign out this browser$/i }),
      ).toBeVisible({ timeout: 10_000 });

      await page
        .getByRole("button", { name: /^sign out this browser$/i })
        .click();

      await expect(page).toHaveURL(/\/login(\?|$)/, { timeout: 15_000 });
    } finally {
      await ctx.close();
    }
  });
});
