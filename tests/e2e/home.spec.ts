import { test, expect } from "@playwright/test";

test("home page renders heading", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /hackathon starter/i })).toBeVisible();
});

test("chat api returns 400 on bad body", async ({ request }) => {
  const res = await request.post("/api/chat", { data: {} });
  expect(res.status()).toBe(400);
});
