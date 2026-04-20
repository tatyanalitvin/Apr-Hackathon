// Message composer edge cases. The happy send is covered by s1-demo; this
// spec hammers the inputs that break real chat clients: empty sends,
// whitespace-only, huge bodies, HTML/<script> payloads, rapid bursts,
// and multi-line newline handling.
//
// The composer is a textarea with aria-label="Message". Enter sends;
// we expect Shift+Enter to insert a newline (industry convention).

import { test, expect } from "@playwright/test";
import { signInSeeded, skipIfBackendDown } from "./helpers";

test.describe.configure({ mode: "default" });

function composer(page: import("@playwright/test").Page) {
  return page.getByRole("textbox", { name: "Message" });
}

test.describe("exploratory/chat — composer edge cases", () => {
  test.beforeAll(skipIfBackendDown);

  test.beforeEach(async ({ page }) => {
    await signInSeeded(page, "alice");
    await page.goto("/rooms/general");
    await expect(composer(page)).toBeVisible();
  });

  test("empty send is blocked by the client guard (no network call)", async ({ page }) => {
    // The composer's canSend gate requires trimmed.length > 0 OR a ready
    // attachment — verified by reading MessageComposer.tsx. A network
    // monitor is more reliable than DOM heuristics here: any POST to the
    // messages endpoint while the composer is empty is the bug.
    const sends: string[] = [];
    page.on("request", (req) => {
      if (req.method() !== "POST") return;
      const url = req.url();
      if (/\/api\/(rooms\/[^/]+\/messages|messages|v1\/messages)/.test(url)) {
        sends.push(url);
      }
    });
    await composer(page).click();
    for (let i = 0; i < 5; i++) await composer(page).press("Enter");
    await page.waitForTimeout(800);
    expect(sends, `Empty Enter triggered a POST: ${sends.join(", ")}`).toEqual([]);
  });

  test("whitespace-only send is blocked", async ({ page }) => {
    const anchor = `ws-anchor-${Date.now()}`;
    await composer(page).fill(anchor);
    await composer(page).press("Enter");
    await expect(page.getByText(anchor).last()).toBeVisible({ timeout: 5_000 });

    await composer(page).click();
    await composer(page).fill("   \n   \t  ");
    await composer(page).press("Enter");
    await page.waitForTimeout(800);

    // The send input should be cleared-or-kept, but no new visible row
    // with purely whitespace content should appear. We scope to <main>
    // to avoid picking up incidental whitespace elsewhere.
    const blankRows = await page.evaluate(() => {
      const main = document.querySelector("main");
      if (!main) return 0;
      let count = 0;
      main.querySelectorAll("li, [data-message-id], [role=listitem]").forEach((el) => {
        const t = el.textContent ?? "";
        if (t.trim().length === 0 && t.length > 0) count++;
      });
      return count;
    });
    expect(blankRows, "Whitespace-only messages made it into the DOM").toBe(0);
  });

  test("HTML / <script> payload is rendered as text, not HTML", async ({ page }) => {
    const payload = `<img src=x onerror=alert(1)><script>window.__xss=1</script>`;
    await composer(page).click();
    await composer(page).fill(payload);
    await composer(page).press("Enter");

    // The text should appear verbatim.
    await expect(page.getByText(payload).last()).toBeVisible({ timeout: 5_000 });

    // And no side effect should have landed on window.
    const injected = await page.evaluate(() => (window as unknown as { __xss?: number }).__xss);
    expect(injected, "Inline <script> payload executed — XSS!").toBeUndefined();
  });

  test("rapid burst of 10 messages either all render or surface a rate-limit notice", async ({ page }) => {
    // First run of this test revealed that bursts trigger the message
    // rate-limit bucket silently — the UI gives no feedback, messages
    // past the threshold just vanish. That's UX-09 in FINDINGS.md.
    //
    // The spec now asserts one of two good outcomes:
    //   a) all 10 messages render, OR
    //   b) some fail to render AND a visible rate-limit notice is shown.
    // Silent drop = fail.
    const stamp = Date.now();
    const burst = Array.from({ length: 10 }, (_, i) => `burst-${stamp}-${i}`);
    for (const line of burst) {
      await composer(page).fill(line);
      await composer(page).press("Enter");
    }
    await page.waitForTimeout(2_000);
    const counts = await Promise.all(
      burst.map(async (line) => ({ line, count: await page.getByText(line).count() })),
    );
    const missing = counts.filter((c) => c.count === 0).map((c) => c.line);
    const renderedAll = missing.length === 0;

    if (renderedAll) return;

    // Some were dropped. The product MUST tell the user (toast or inline).
    const body = await page.innerText("body").catch(() => "");
    const hasRateNotice = /too many|rate|slow down|wait|throttle/i.test(body);
    expect(
      hasRateNotice,
      `Silent drop: ${missing.length}/${burst.length} messages missing, no user-facing rate-limit notice. Missing: ${missing.slice(0, 3).join(", ")}…`,
    ).toBe(true);
  });

  test("huge message (10k chars) either truncates or is rejected cleanly", async ({ page }) => {
    const huge = "a".repeat(10_000);
    await composer(page).click();
    await composer(page).fill(huge);
    await composer(page).press("Enter");
    // Either it sent and we see SOMETHING, or it rejected with a toast /
    // field error. Both are acceptable; a silent no-op is not.
    await page.waitForTimeout(1_500);
    const body = await page.textContent("body");
    const sawEcho = body?.includes("a".repeat(200));
    const sawError = /too (long|large)|exceeds|limit/i.test(body ?? "");
    expect.soft(sawEcho || sawError, "Neither echo nor error — silent drop of huge message").toBe(true);
  });

  test("Shift+Enter inserts newline; plain Enter sends", async ({ page }) => {
    await composer(page).click();
    await composer(page).type("first line");
    await composer(page).press("Shift+Enter");
    await composer(page).type("second line");
    // The value should be two lines BEFORE we send.
    const value = await composer(page).inputValue();
    expect(value, "Shift+Enter must insert a newline, not submit").toMatch(/first line\nsecond line/);
    // Now Enter sends.
    await composer(page).press("Enter");
    await expect(page.getByText(/first line[\s\S]*second line/).last()).toBeVisible({ timeout: 3_000 });
  });
});
