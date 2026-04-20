// Round-3 UX pass. Settings lives across three separate routes
// (/settings/password, /settings/sessions, /settings/account) but the Header
// only exposes icon-pills — once you land on one, there's no in-page way to
// jump to a sibling without going back to the Header. This shared sub-nav
// renders a glass pill row under the page <h1> so the three pages feel like
// one surface. `aria-current="page"` drives the active-state style in
// globals.css .settings-nav.

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/settings/password", label: "Password" },
  { href: "/settings/sessions", label: "Sessions" },
  { href: "/settings/account", label: "Account" },
] as const;

export function SettingsNav() {
  const pathname = usePathname() ?? "";
  return (
    <nav aria-label="Account settings" className="settings-nav">
      {TABS.map((t) => {
        const active = pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
