// Account-delete confirm dialog — closes on success before the 600ms
// toast→redirect delay. Binding fix: 07f0ecd "fix(settings): close delete
// dialog before 600ms redirect delay".
//
// Symptom the fix addresses: after the backend DELETE returned 204 the
// dialog stayed mounted while the page waited 600ms so sonner could paint
// "Account deleted" before the redirect tore the Toaster down. During
// that window the user saw a "Deleting…" spinner on an already-deleted
// account. The fix calls setDeleteOpen(false) before the toast + setTimeout
// so the dialog unmounts immediately.
//
// The assertion shape has to account for the Radix Dialog exit animation
// (~200ms) — so we can't demand role=dialog disappears in the same tick;
// we require it to be gone well before the 600ms redirect fires.

import { test, expect, type Page } from "@playwright/test";

const BACKEND_HEALTH = "http://localhost:4000/health";

const stamp = () => Date.now().toString(36);
const PASSWORD = "Hackaton_Test_Pw_2026!";

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

test.describe.configure({ mode: "serial" });

test.describe("REQ-017 — account delete dialog unmounts on success", () => {
  test.beforeAll(async () => {
    const res = await fetch(BACKEND_HEALTH).catch(() => null);
    test.skip(
      !res || !res.ok,
      `Backend not healthy at ${BACKEND_HEALTH}. Boot with: docker compose up --build -d`,
    );
  });

  test("confirming delete closes the dialog before navigating to /register", async ({
    page,
  }) => {
    const suffix = stamp();
    const user = {
      email: `acctdel-${suffix}@herders.local`,
      username: `acd${suffix}`,
      name: "Account Delete",
      password: PASSWORD,
    };

    await registerAndEnterRooms(page, user);

    await page.goto("/settings/account");
    // Page-level trigger: opens the Radix Dialog.
    await page
      .getByRole("button", { name: /delete my account/i })
      .click();

    const dialog = page.getByRole("dialog", { name: /delete account/i });
    await expect(dialog).toBeVisible();

    // Fill the confirm input and submit. The submit button is labelled
    // "Delete account" (not "Delete my account…" — that's the page-level
    // trigger).
    await dialog.getByLabel(/^Password$/i).fill(PASSWORD);
    await dialog
      .getByRole("button", { name: /^delete account$/i })
      .click();

    // With the fix: the dialog closes on success (allow for Radix's
    // ~200ms exit animation). This must happen BEFORE the 600ms
    // redirect setTimeout fires, so we bound the wait at 500ms.
    await expect(dialog).toBeHidden({ timeout: 500 });

    // And the page ultimately routes to /register (the redirect runs at
    // setTimeout 600ms after success).
    await expect(page).toHaveURL(/\/register(\?|$)/, { timeout: 5_000 });

    // The success toast should still have painted during the 600ms
    // window — sanity-check it surfaced.
    await expect(page.getByText(/account deleted/i)).toBeVisible({
      timeout: 2_000,
    });
  });
});
