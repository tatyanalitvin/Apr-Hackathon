// REQ-017 / REQ-018 — /forgot-password + /reset-password end-to-end.
//
// Covers:
//   - "Forgot password?" link visible on /login
//   - /forgot-password shows the SAME neutral copy for known and unknown emails
//     (anti-enumeration — backend returns 200 either way)
//   - /reset-password?token=<t> accepts a new password, redirects to /login
//   - After reset: the old password is rejected, the new one is accepted
//
// Token acquisition: better-auth is configured with `secondaryStorage: Redis`,
// so the verification row is written to Redis under
// `verification:reset-password:<token>` (see apps/backend/tests/password-reset-confirm.test.ts).
// We scan Redis for it rather than scraping backend logs.

import { test, expect } from "@playwright/test";
import { createClient } from "redis";

const BACKEND_HEALTH = "http://localhost:4000/health";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const NEUTRAL_COPY =
  "If an account exists for this email, a reset link has been sent.";

const stamp = () => Date.now().toString(36);

async function latestResetToken(): Promise<string> {
  const r = createClient({ url: REDIS_URL });
  await r.connect();
  try {
    const keys: string[] = [];
    for await (const key of r.scanIterator({
      MATCH: "verification:reset-password:*",
    })) {
      if (typeof key === "string") keys.push(key);
      else if (Array.isArray(key)) keys.push(...key);
    }
    if (keys.length === 0) throw new Error("no reset token found in Redis");
    return keys[keys.length - 1].replace(/^verification:reset-password:/, "");
  } finally {
    await r.quit();
  }
}

test.describe.configure({ mode: "serial" });

test.describe("REQ-017 REQ-018 — forgot / reset password", () => {
  test.beforeAll(async () => {
    const res = await fetch(BACKEND_HEALTH).catch(() => null);
    test.skip(
      !res || !res.ok,
      `Backend not healthy at ${BACKEND_HEALTH}. Boot with: docker compose up --build -d`,
    );
  });

  test("full flow: link → request → token → new password → sign-in flip", async ({
    page,
  }) => {
    const suffix = stamp();
    const user = {
      email: `reset-e2e-${suffix}@herders.local`,
      username: `resetE2E${suffix}`,
      name: "Reset E2E",
      oldPassword: "playwright-old-1234",
      newPassword: "playwright-new-5678",
    };

    // Register a brand-new user so we own both the old and new password.
    await page.goto("/register");
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Username").fill(user.username);
    await page.getByLabel("Display name").fill(user.name);
    await page.getByLabel("Password", { exact: true }).fill(user.oldPassword);
    await page.getByLabel("Confirm password").fill(user.oldPassword);
    await page.getByRole("button", { name: /create account/i }).click();
    await expect(page).toHaveURL(/\/rooms$/, { timeout: 15_000 });

    // REQ-043 regression guard: "Forgot password?" link wired on /login.
    await page.goto("/login");
    const forgotLink = page.getByRole("link", { name: /forgot password\?/i });
    await expect(forgotLink).toBeVisible();
    await expect(forgotLink).toHaveAttribute("href", "/forgot-password");
    await Promise.all([
      page.waitForURL(/\/forgot-password$/),
      forgotLink.click(),
    ]);
    // Hard-reload into the target page to avoid SPA-transition races where the
    // useForm hook on the new page hasn't mounted yet when fill() runs — with
    // react-hook-form that desyncs the input value from form state and zod
    // rejects the submit as if the field were empty.
    await page.goto("/forgot-password");
    const sendButton = page.getByRole("button", { name: /send reset link/i });
    await expect(sendButton).toBeVisible();

    // REQ-017: submit the registered email → neutral confirmation.
    await page.getByLabel("Email").fill(user.email);
    await expect(page.getByLabel("Email")).toHaveValue(user.email);
    await sendButton.click();
    await expect(page.getByText(NEUTRAL_COPY)).toBeVisible();

    // REQ-018: consume the token from Redis and set a new password.
    const token = await latestResetToken();
    await page.goto(`/reset-password?token=${encodeURIComponent(token)}`);
    await page
      .getByLabel("New password", { exact: true })
      .fill(user.newPassword);
    await page.getByLabel("Confirm new password").fill(user.newPassword);
    await page.getByRole("button", { name: /update password/i }).click();
    await expect(page).toHaveURL(/\/login$/, { timeout: 15_000 });

    // Old password must now fail.
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Password").fill(user.oldPassword);
    await page.getByRole("button", { name: /^sign in$/i }).click();
    // Both the inline form error and a toast say this — assert at least one.
    await expect(
      page.getByText(/invalid email or password/i).first(),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);

    // New password must succeed.
    await page.getByLabel("Password").fill(user.newPassword);
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await expect(page).toHaveURL(/\/rooms$/, { timeout: 15_000 });
  });

  test("REQ-017 anti-enumeration: unknown email gets the same neutral copy", async ({
    page,
  }) => {
    await page.goto("/forgot-password");
    await page.getByLabel("Email").fill(`ghost-${stamp()}@nowhere.local`);
    await page.getByRole("button", { name: /send reset link/i }).click();
    await expect(page.getByText(NEUTRAL_COPY)).toBeVisible();
  });
});
