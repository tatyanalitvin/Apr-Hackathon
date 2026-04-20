"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";

type ThemeToggleSize = "sm" | "default";

export function ThemeToggle({ size = "sm" }: { size?: ThemeToggleSize } = {}) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  // P1-1 — icon-button size must match sibling actions in the header. `sm`
  // (default) = h-9 w-9 to align with the other size="sm" buttons; `default`
  // = h-10 w-10, matching the shadcn `icon` size for non-header uses.
  const dimensions = size === "sm" ? "h-9 w-9" : "h-10 w-10";
  if (!mounted) return <div className={dimensions} aria-hidden="true" />;
  const isDark = resolvedTheme === "dark";
  return (
    <Button
      variant="ghost-glass"
      size="icon"
      className={dimensions}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isDark ? (
        <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
      ) : (
        <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z"/></svg>
      )}
    </Button>
  );
}
