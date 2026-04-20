// Shared helpers for the exploratory UI test pass.
//
// Kept small on purpose — each spec should still be readable alone. These
// helpers only cover the things every exploratory spec needs: seeded
// sign-in (seeded users bypass the /24 subnet rate-limit bucket), a
// BackendHealth probe so the suite skips cleanly when the stack isn't up,
// and a tiny a11y snapshot shape that each spec can extend.

import { test, expect, type Page, type BrowserContext, type Browser } from "@playwright/test";

export const SEED_PASSWORD = "hunter2hunter2";
export const SEEDED_USERS = {
  alice: { email: "alice@herders.local", username: "alice", name: "Alice" },
  bob: { email: "bob@herders.local", username: "bob", name: "Bob" },
  carol: { email: "carol@herders.local", username: "carol", name: "Carol" },
} as const;

export type SeedKey = keyof typeof SEEDED_USERS;

export const BACKEND_HEALTH = "http://localhost:4000/health";

export async function skipIfBackendDown() {
  const res = await fetch(BACKEND_HEALTH).catch(() => null);
  test.skip(
    !res || !res.ok,
    `Backend not healthy at ${BACKEND_HEALTH}. Boot with: docker compose up --build -d`,
  );
}

export async function signInSeeded(page: Page, who: SeedKey): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(SEEDED_USERS[who].email);
  await page.getByLabel("Password").fill(SEED_PASSWORD);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await expect(page).toHaveURL(/\/rooms(\/|$)/, { timeout: 15_000 });
}

export async function twoSeededContexts(browser: Browser, a: SeedKey, b: SeedKey) {
  const aCtx: BrowserContext = await browser.newContext();
  const bCtx: BrowserContext = await browser.newContext();
  const aPage = await aCtx.newPage();
  const bPage = await bCtx.newPage();
  await signInSeeded(aPage, a);
  await signInSeeded(bPage, b);
  return {
    a: aPage,
    b: bPage,
    dispose: async () => {
      await aCtx.close();
      await bCtx.close();
    },
  };
}

/**
 * Runtime a11y snapshot of the currently loaded page. Intentionally
 * lightweight (no axe): we only collect the primitives every audit spec
 * ends up re-deriving — headings present, inputs with missing error
 * wiring, links that shadow navigation. Keeps each assertion surface
 * explicit in the spec rather than hiding behind a score.
 */
export async function a11ySnapshot(page: Page) {
  return page.evaluate(() => {
    const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).map((el) => ({
      tag: el.tagName,
      text: el.textContent?.trim().slice(0, 80) ?? "",
    }));

    const inputs = Array.from(document.querySelectorAll("input,textarea,select"))
      // POLISH-03 — react-textarea-autosize mounts a measurement twin in
      // <body> with aria-hidden + tabindex=-1. Assistive tech correctly
      // ignores it, so our label audit should too.
      .filter((el) => el.getAttribute("aria-hidden") !== "true" && el.getAttribute("tabindex") !== "-1")
      .map((el) => {
        const id = el.getAttribute("id");
        const label = id ? document.querySelector(`label[for="${id}"]`) : null;
        return {
          tag: el.tagName,
          type: el.getAttribute("type"),
          id,
          name: el.getAttribute("name"),
          ariaLabel: el.getAttribute("aria-label"),
          hasLabel: Boolean(label),
          ariaInvalid: el.getAttribute("aria-invalid"),
          ariaDescribedBy: el.getAttribute("aria-describedby"),
          placeholder: (el as HTMLInputElement).placeholder ?? null,
        };
      });

    const liveRegions = Array.from(document.querySelectorAll("[role=log],[role=status],[role=alert],[aria-live]")).map((el) => ({
      role: el.getAttribute("role"),
      live: el.getAttribute("aria-live"),
    }));

    const buttons = Array.from(document.querySelectorAll("button")).map((b) => ({
      name: (b.getAttribute("aria-label") ?? b.textContent ?? "").trim().slice(0, 40),
      type: b.getAttribute("type"),
      disabled: b.hasAttribute("disabled"),
    }));

    const skipLinks = Array.from(document.querySelectorAll('a[href^="#"]')).map((a) => ({
      href: a.getAttribute("href"),
      text: a.textContent?.trim(),
    }));

    return { headings, inputs, liveRegions, buttons, skipLinks };
  });
}
