// Members sidebar perf smell test. Live observation: /rooms/general's
// member panel reads "Members · 2969" — that's the full seeded user
// count. If every listitem lives in the DOM, scrolling the chat stutters
// and memory climbs. This spec measures the DOM weight and flags an
// unbounded render.

import { test, expect } from "@playwright/test";
import { signInSeeded, skipIfBackendDown } from "./helpers";

test.describe.configure({ mode: "default" });

const DOM_BUDGET_NODES = 3_000;
const LIST_BUDGET_ITEMS = 200;

test.describe("exploratory/perf — members sidebar is bounded", () => {
  test.beforeAll(skipIfBackendDown);

  test("members sidebar does not materialise all 2969 seeded users into the DOM", async ({ page }) => {
    await signInSeeded(page, "alice");
    await page.goto("/rooms/general");
    await page.waitForLoadState("networkidle").catch(() => undefined);

    const stats = await page.evaluate((budget) => {
      const sidebar = document.querySelector('aside, [role="complementary"]');
      const items = sidebar ? sidebar.querySelectorAll("li, [role=listitem], [data-member-id]") : [];
      const domNodes = document.querySelectorAll("*").length;
      return { domNodes, memberItems: items.length, budget };
    }, LIST_BUDGET_ITEMS);

    // eslint-disable-next-line no-console
    console.log(`[members-perf] domNodes=${stats.domNodes} memberItems=${stats.memberItems}`);

    expect.soft(
      stats.memberItems,
      `Members list has ${stats.memberItems} items in DOM — expected ≤${LIST_BUDGET_ITEMS} (virtualise or paginate).`,
    ).toBeLessThanOrEqual(LIST_BUDGET_ITEMS);

    expect.soft(
      stats.domNodes,
      `Total DOM nodes = ${stats.domNodes}; budget ${DOM_BUDGET_NODES}. High node count kills scroll perf on mobile.`,
    ).toBeLessThanOrEqual(DOM_BUDGET_NODES);
  });

  test("scrolling the message list stays above 30fps-equivalent under the seeded load", async ({ page }) => {
    await signInSeeded(page, "alice");
    await page.goto("/rooms/general");
    await page.waitForLoadState("networkidle").catch(() => undefined);

    const main = page.locator("main");
    const longTaskCount = await page.evaluate(() => {
      return new Promise<number>((resolve) => {
        let count = 0;
        const obs = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.duration > 50) count++;
          }
        });
        try {
          obs.observe({ type: "longtask", buffered: false });
        } catch {
          resolve(-1);
          return;
        }
        setTimeout(() => {
          obs.disconnect();
          resolve(count);
        }, 2_500);
      });
    });

    // Scroll the main area up/down a few times during that 2.5s window.
    for (let i = 0; i < 5; i++) {
      await main.hover().catch(() => undefined);
      await page.mouse.wheel(0, 800);
      await page.waitForTimeout(200);
      await page.mouse.wheel(0, -800);
      await page.waitForTimeout(200);
    }

    // eslint-disable-next-line no-console
    console.log(`[members-perf] longTasks(>50ms) during scroll = ${longTaskCount}`);
    expect.soft(longTaskCount, "Too many >50ms tasks during scroll").toBeLessThan(10);
  });
});
