import { test, expect } from "@playwright/test";

test("home page renders app name", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /ai herders jam/i })).toBeVisible();
});
