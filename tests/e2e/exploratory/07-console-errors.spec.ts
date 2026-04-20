// Console + network-error sweep. Every exploratory pass I've run picks up
// runtime JS errors nobody noticed because they only fire on cold-load.
// This spec walks the key routes, collects console errors and failed
// (4xx/5xx) requests, and reports them per-route so we can triage.
//
// Intentionally permissive: the favicon 404 is the only known-noise
// entry, so we filter it out. Everything else gets logged.

import { test, expect, type Page } from "@playwright/test";
import { signInSeeded, skipIfBackendDown } from "./helpers";

test.describe.configure({ mode: "default" });

const AUTH_ROUTES = [
  "/rooms",
  "/rooms/general",
  "/rooms/browse",
  "/contacts",
  "/settings/password",
  "/settings/sessions",
  "/settings/account",
];

interface Observation {
  consoleErrors: string[];
  failedRequests: string[];
}

function attach(page: Page): { obs: Observation; detach: () => void } {
  const obs: Observation = { consoleErrors: [], failedRequests: [] };
  const onConsole = (m: import("@playwright/test").ConsoleMessage) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (/favicon\.ico/.test(text)) return;
    obs.consoleErrors.push(text);
  };
  const onResponse = (r: import("@playwright/test").Response) => {
    const status = r.status();
    if (status < 400) return;
    const url = r.url();
    if (/favicon\.ico/.test(url)) return;
    obs.failedRequests.push(`${status} ${url}`);
  };
  page.on("console", onConsole);
  page.on("response", onResponse);
  return {
    obs,
    detach: () => {
      page.off("console", onConsole);
      page.off("response", onResponse);
    },
  };
}

test.describe("exploratory/runtime — console + network sweep", () => {
  test.beforeAll(skipIfBackendDown);

  test("authenticated routes load without console errors or failed requests", async ({ page }) => {
    await signInSeeded(page, "alice");
    const perRoute: Array<{ route: string; obs: Observation }> = [];
    for (const route of AUTH_ROUTES) {
      const { obs, detach } = attach(page);
      await page.goto(route);
      await page.waitForLoadState("networkidle").catch(() => undefined);
      detach();
      perRoute.push({ route, obs });
    }

    const noisy = perRoute.filter(
      (r) => r.obs.consoleErrors.length > 0 || r.obs.failedRequests.length > 0,
    );
    expect(
      noisy,
      `Noisy routes:\n${noisy
        .map(
          (n) =>
            `  ${n.route}: ${n.obs.consoleErrors.length} console err, ${n.obs.failedRequests.length} failed req\n` +
            `    console: ${n.obs.consoleErrors.slice(0, 3).join(" | ")}\n` +
            `    network: ${n.obs.failedRequests.slice(0, 3).join(" | ")}`,
        )
        .join("\n")}`,
    ).toEqual([]);
  });
});
