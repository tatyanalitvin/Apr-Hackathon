import { firefox } from "@playwright/test";

const OUT = "docs/ui-review/20260420T160449/before/firefox";
const BASE = "http://localhost:3000";

const SURFACES = [
  { slug: "01-login", url: "/login" },
  { slug: "02-register", url: "/register" },
  { slug: "03-forgot-password", url: "/forgot-password" },
  { slug: "04-reset-password", url: "/reset-password?token=demo" },
  { slug: "05-rooms", url: "/rooms", auth: true },
  { slug: "06-room-general", url: "/rooms/general", auth: true },
  { slug: "07-rooms-browse", url: "/rooms/browse", auth: true },
  { slug: "08-contacts", url: "/contacts", auth: true },
  { slug: "09-settings-sessions", url: "/settings/sessions", auth: true },
  { slug: "10-settings-password", url: "/settings/password", auth: true },
  { slug: "11-admin", url: "/admin", auth: true },
  { slug: "12-admin-federation", url: "/admin/federation", auth: true },
];

async function signIn(page) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[type=email], input[name=email], input[placeholder=Email], input', "alice@herders.local", { timeout: 5000 }).catch(() => {});
  // Use role-based locators for stability
  await page.getByLabel("Email").fill("alice@herders.local");
  await page.getByLabel("Password").fill("hunter2hunter2");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/rooms/, { timeout: 10000 });
}

async function capture(theme) {
  const browser = await firefox.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  await page.goto(BASE);
  await page.evaluate((t) => {
    if (t === "light") document.documentElement.classList.remove("dark");
    else document.documentElement.classList.add("dark");
  }, theme);

  await signIn(page);

  // Re-assert theme after nav (next-themes may rehydrate)
  await page.evaluate((t) => {
    if (t === "light") {
      document.documentElement.classList.remove("dark");
      document.documentElement.classList.add("light");
    } else {
      document.documentElement.classList.remove("light");
      document.documentElement.classList.add("dark");
    }
  }, theme);

  for (const s of SURFACES) {
    await page.goto(`${BASE}${s.url}`);
    await page.evaluate((t) => {
      if (t === "light") {
        document.documentElement.classList.remove("dark");
        document.documentElement.classList.add("light");
      } else {
        document.documentElement.classList.remove("light");
        document.documentElement.classList.add("dark");
      }
    }, theme);
    await page.waitForTimeout(1500);
    await page.screenshot({
      path: `${OUT}/${theme}-${s.slug}.png`,
      fullPage: true,
    });
    console.log(`[${theme}] captured ${s.slug}`);
  }

  await browser.close();
}

await capture("dark");
await capture("light");
console.log("done");
