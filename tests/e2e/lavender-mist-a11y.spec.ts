import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const ROUTES = ["/login", "/rooms", "/settings/sessions", "/admin"];

for (const theme of ["dark", "light"] as const) {
  test.describe(`lavender-mist a11y — ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      // Pre-set the theme via next-themes localStorage key before first render
      await page.addInitScript((t) => {
        window.localStorage.setItem("theme", t);
      }, theme);
    });

    for (const route of ROUTES) {
      test(`${route} has no color-contrast violations`, async ({ page }) => {
        await page.goto(route);
        // Wait for the page to settle
        await page.waitForLoadState("networkidle");
        const results = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa"])
          .include("body")
          .analyze();
        const contrastIssues = results.violations.filter((v) => v.id === "color-contrast");
        expect(contrastIssues, JSON.stringify(contrastIssues, null, 2)).toEqual([]);
      });
    }
  });
}

test("rooms room view with AI fixtures has no color-contrast violations", async ({ page }) => {
  // Requires: dev server started with NEXT_PUBLIC_AI_FIXTURES=1 and a seeded room.
  test.skip(!process.env.TEST_ROOM_ID, "TEST_ROOM_ID env not set; skipping fixture contrast check");
  await page.addInitScript(() => window.localStorage.setItem("theme", "dark"));
  await page.goto(`/rooms/${process.env.TEST_ROOM_ID}`);
  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const contrastIssues = results.violations.filter((v) => v.id === "color-contrast");
  expect(contrastIssues, JSON.stringify(contrastIssues, null, 2)).toEqual([]);
});
