# UI Lavender Mist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle all 15 pages of `apps/web` with a dark-glassmorphism lavender-mist aesthetic + symmetric spring-leaning light variant, and add a frosted chat composer + AI message variant (confidence chip + streaming shimmer).

**Architecture:** Big-bang token rewrite in `apps/web/src/app/globals.css` using a two-layer structure — brand tokens + shadcn aliases via `var()` chains — so shadcn primitives resolve without component edits. `next-themes` drives theme switching; `next/font/google` loads Instrument Serif + Inter. New components live under `src/components/auth/`, `src/components/chat/`, `src/components/theme-*`. No backend changes; `MessagePayload` gains three optional fields frontend-only.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Tailwind CSS, shadcn/ui, `next-themes`, `next/font/google`, Playwright + `@axe-core/playwright` for accessibility verification.

**Spec:** [`docs/specs/ui-lavender-mist.md`](../specs/ui-lavender-mist.md)

---

## File structure

### Create

| Path | Responsibility |
|---|---|
| `apps/web/src/components/theme-provider.tsx` | Client shim wrapping `next-themes` `ThemeProvider`. |
| `apps/web/src/components/theme-toggle.tsx` | Sun/moon toggle button, uses `useTheme`. |
| `apps/web/src/components/auth/AuthSplitLayout.tsx` | 50/50 split layout (marketing left, form right). |
| `apps/web/src/components/auth/SakuraPetals.tsx` | Drifting-petals decoration (CSS keyframe). |
| `apps/web/src/components/chat/ChatComposer.tsx` | Frosted composer (new, wraps existing `MessageComposer` as form body). |
| `apps/web/src/components/chat/AiMessageBubble.tsx` | AI variant with wash + chip + confidence pill + shimmer. |
| `apps/web/src/components/chat/ConfidenceChip.tsx` | Pill showing High/Med/Low based on confidence. |
| `apps/web/src/components/chat/ConfidenceChip.test.ts` | Unit test for label/tier mapping. |
| `apps/web/src/components/chat/StreamingShimmer.tsx` | 1px shimmer bar w/ reduced-motion fallback. |
| `apps/web/src/components/empty/BlossomEmptyState.tsx` | Reusable empty state (sakura + serif tagline). |
| `apps/web/src/lib/chat/ai-fixtures.ts` | Dev-only seed for AI bubble visual states. |
| `tests/e2e/lavender-mist-a11y.spec.ts` | axe-core contrast + focus-ring checks (R30). |

### Modify

| Path | Change |
|---|---|
| `apps/web/src/app/globals.css` | Two-layer token rewrite, drop hardcoded `--font-sans`, add utilities. |
| `apps/web/src/app/layout.tsx` | Load Instrument Serif + Inter via `next/font`, wrap in `ThemeProvider`. |
| `apps/web/tailwind.config.ts` | Add `display` font family mapping. |
| `apps/web/src/components/ui/button.tsx` | Add `ghost-glass` variant. |
| `apps/web/src/components/ui/card.tsx` | Strip default `border`; glass opt-in via `.glass-panel`. |
| `apps/web/src/components/ui/input.tsx` | Lavender `--ring` focus; glass-on-focus bg. |
| `apps/web/src/components/ui/textarea.tsx` | Same as input. |
| `apps/web/src/components/chat/MessageList.tsx` | Dispatch to `AiMessageBubble` when `authorType === "ai"`. |
| `apps/web/src/components/chat/MessageComposer.tsx` | Slot into `ChatComposer` frosted shell. |
| `apps/web/src/components/chat/Header.tsx` | Serif room title; mount `ThemeToggle`. |
| `apps/web/src/app/page.tsx` | Unauth landing via `AuthSplitLayout`. |
| `apps/web/src/app/login/page.tsx` | Wrap in `AuthSplitLayout`. |
| `apps/web/src/app/register/page.tsx` | Wrap in `AuthSplitLayout`. |
| `apps/web/src/app/forgot-password/page.tsx` | Wrap in `AuthSplitLayout`. |
| `apps/web/src/app/reset-password/page.tsx` | Wrap in `AuthSplitLayout`. |
| `apps/web/src/app/rooms/page.tsx` | Three-pane layout shell. |
| `apps/web/src/app/rooms/[roomId]/page.tsx` | Three-pane layout; AI fixtures toggle (dev only). |
| `apps/web/src/app/rooms/browse/page.tsx` | Masonry grid + hover lift. |
| `apps/web/src/app/contacts/page.tsx` | Two-col + `BlossomEmptyState`. |
| `apps/web/src/app/admin/page.tsx` | Tiered: serif H1, solid panels. |
| `apps/web/src/app/admin/federation/page.tsx` | Tiered. |
| `apps/web/src/app/settings/account/page.tsx` | Tiered. |
| `apps/web/src/app/settings/password/page.tsx` | Tiered. |
| `apps/web/src/app/settings/sessions/page.tsx` | Tiered; quiet table styling. |
| `packages/shared/src/protocol.ts` | Extend `MessagePayload` with three optional fields. |
| `apps/web/package.json` | Add `@axe-core/playwright` dev dep. |

---

## Task 1: Token foundation + fonts + ThemeProvider

**Files:**
- Create: `apps/web/src/components/theme-provider.tsx`
- Modify: `apps/web/src/app/globals.css`, `apps/web/src/app/layout.tsx`, `apps/web/tailwind.config.ts`

Covers spec requirements: R1, R2, R4, R6.

- [ ] **Step 1.1: Rewrite `apps/web/src/app/globals.css`**

Replace the entire file with:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    /* brand layer — spring-leaning cream + deep violet */
    --bg-base: #FAF6EE;
    --bg-elevated: #F1ECF7;
    --glass-bg: rgba(124, 58, 237, 0.06);
    --glass-border: rgba(124, 58, 237, 0.22);
    --accent: #7C3AED;
    --accent-soft: #F5F3FF;
    --on-accent: var(--accent-soft);
    --text-hi: #201A2E;
    --text-lo: #6B6283;
    --success: #047857;
    --warn: #92400E;
    --destructive: #B91C1C;
    --ring: rgba(124, 58, 237, 0.45);
    --blossom: #E89EC4;

    /* shadcn aliases — declared once, resolve per theme via var() chains */
    --background: var(--bg-base);
    --foreground: var(--text-hi);
    --card: var(--bg-elevated);
    --card-foreground: var(--text-hi);
    --popover: var(--bg-elevated);
    --popover-foreground: var(--text-hi);
    --primary: var(--accent);
    --primary-foreground: var(--on-accent);
    --secondary: var(--bg-elevated);
    --secondary-foreground: var(--text-hi);
    --muted: var(--bg-elevated);
    --muted-foreground: var(--text-lo);
    --accent-foreground: var(--on-accent);
    --destructive-foreground: var(--accent-soft);
    --border: var(--glass-border);
    --input: var(--glass-border);
    --radius: 0.625rem;
  }

  .dark {
    --bg-base: #0F0B1A;
    --bg-elevated: #1A1428;
    --glass-bg: rgba(180, 160, 220, 0.08);
    --glass-border: rgba(196, 181, 253, 0.12);
    --accent: #C4B5FD;
    --accent-soft: #F5F3FF;
    --on-accent: var(--bg-base);
    --text-hi: #F4F1F8;
    --text-lo: #A89FB8;
    --success: #A7F3D0;
    --warn: #FDE68A;
    --destructive: #F0A5A5;
    --ring: rgba(196, 181, 253, 0.55);
    --blossom: #FBCFE8;
  }

  * {
    @apply border-border;
  }

  body {
    @apply text-foreground antialiased;
    font-family: var(--font-sans), system-ui, sans-serif;
    background-color: var(--bg-base);
    background-image:
      radial-gradient(ellipse 80% 60% at 20% 0%, rgba(196, 181, 253, 0.35), transparent 65%),
      radial-gradient(ellipse 70% 50% at 85% 100%, rgba(232, 158, 196, 0.35), transparent 55%);
    background-attachment: fixed;
  }

  .dark body {
    background-image:
      radial-gradient(ellipse 80% 60% at 20% 0%, rgba(139, 92, 246, 0.15), transparent 60%),
      radial-gradient(ellipse 70% 50% at 85% 100%, rgba(196, 181, 253, 0.08), transparent 50%);
  }
}

@layer utilities {
  .glass-panel {
    background: var(--glass-bg);
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    box-shadow: inset 0 1px 0 var(--glass-border), 0 12px 40px rgba(0, 0, 0, 0.25);
    border-radius: var(--radius);
  }

  .dark .glass-panel {
    box-shadow: inset 0 1px 0 var(--glass-border), 0 12px 40px rgba(0, 0, 0, 0.45);
  }

  .font-display {
    font-family: var(--font-display), ui-serif, Georgia, serif;
  }

  @keyframes sakura-drift {
    0% { transform: translate3d(0, -10vh, 0) rotate(0deg); opacity: 0; }
    10% { opacity: 0.7; }
    90% { opacity: 0.7; }
    100% { transform: translate3d(4vw, 110vh, 0) rotate(360deg); opacity: 0; }
  }

  @keyframes shimmer-sweep {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(100%); }
  }

  @media (prefers-reduced-motion: reduce) {
    .sakura-drift { animation: none !important; opacity: 0.5 !important; }
    .shimmer-sweep { animation: none !important; }
  }
}
```

- [ ] **Step 1.2: Install `next/font` imports in `apps/web/src/app/layout.tsx`**

Replace the file with:

```tsx
import type { Metadata } from "next";
import { Inter, Instrument_Serif } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-display",
  display: "swap",
});

export const metadata: Metadata = {
  title: "AI Herders Chat",
  description: "S1 walking skeleton",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${instrumentSerif.variable}`}>
      <body className="min-h-dvh antialiased">
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false} disableTransitionOnChange>
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:shadow focus:ring-2 focus:ring-ring"
          >
            Skip to main content
          </a>
          {children}
          <Toaster richColors closeButton />
        </ThemeProvider>
      </body>
    </html>
  );
}
```

- [ ] **Step 1.3: Create `apps/web/src/components/theme-provider.tsx`**

```tsx
"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ThemeProviderProps } from "next-themes";

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
```

- [ ] **Step 1.4: Add `display` font family to `apps/web/tailwind.config.ts`**

Under `theme.extend.fontFamily`, update to:

```ts
fontFamily: {
  sans: ["var(--font-sans)", "system-ui", "sans-serif"],
  display: ["var(--font-display)", "ui-serif", "Georgia", "serif"],
},
```

- [ ] **Step 1.5: Verify typecheck**

Run: `pnpm --filter web typecheck`
Expected: exits 0.

- [ ] **Step 1.6: Verify dev server boots and fonts load**

Run: `pnpm --filter web dev`
Open `http://localhost:3000/login`. Expected: page renders with lavender dark theme (default), Instrument Serif + Inter loaded (no FOUT on reload). Check DevTools → Network → Fonts to see both families fetched. Kill the dev server.

- [ ] **Step 1.7: Commit**

```bash
git add apps/web/src/app/globals.css apps/web/src/app/layout.tsx apps/web/src/components/theme-provider.tsx apps/web/tailwind.config.ts
git commit -m "feat(web): lavender-mist token foundation + next/font + ThemeProvider"
```

---

## Task 2: Shadcn primitive overrides

**Files:**
- Modify: `apps/web/src/components/ui/button.tsx`, `card.tsx`, `input.tsx`, `textarea.tsx`

Covers: R5 (scoped), R27, R28, R29.

- [ ] **Step 2.1: Add `ghost-glass` variant to `apps/web/src/components/ui/button.tsx`**

Locate the `buttonVariants` cva call. Inside `variants.variant`, add:

```ts
"ghost-glass":
  "bg-transparent text-foreground hover:bg-[var(--glass-bg)] hover:text-foreground",
```

Do not remove any existing variants.

- [ ] **Step 2.2: Strip default border from `apps/web/src/components/ui/card.tsx`**

Locate the `Card` root element. Remove `border` from its className. The resulting `className` should read (example):

```tsx
className={cn(
  "bg-card text-card-foreground shadow-sm rounded-[var(--radius)]",
  className,
)}
```

Leave child components (`CardHeader`, `CardContent`, etc.) untouched.

- [ ] **Step 2.3: Update `apps/web/src/components/ui/input.tsx` focus ring + glass-on-focus bg**

Modify the `className` on the root `<input>` to include:

```tsx
className={cn(
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors",
  "placeholder:text-muted-foreground",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-0 focus-visible:bg-[var(--glass-bg)]",
  "disabled:cursor-not-allowed disabled:opacity-50",
  className,
)}
```

Preserve existing `type`, `ref`, and disabled handling.

- [ ] **Step 2.4: Apply same focus pattern to `apps/web/src/components/ui/textarea.tsx`**

Apply the identical `focus-visible:*` classes as Step 2.3 to the `<textarea>` root className.

- [ ] **Step 2.5: Verify typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: both exit 0.

- [ ] **Step 2.6: Visual smoke test**

Run: `pnpm --filter web dev`
Open `/login`. Tab through the form fields. Expected: focus ring renders in lavender (`--ring`), input bg tints with glass on focus. Buttons render correctly (primary = lavender). Kill the dev server.

- [ ] **Step 2.7: Commit**

```bash
git add apps/web/src/components/ui/button.tsx apps/web/src/components/ui/card.tsx apps/web/src/components/ui/input.tsx apps/web/src/components/ui/textarea.tsx
git commit -m "feat(web/ui): ghost-glass button variant + glass-on-focus inputs, drop card border"
```

---

## Task 3: Auth split-screen shell + retrofit 5 auth routes

**Files:**
- Create: `apps/web/src/components/auth/AuthSplitLayout.tsx`, `apps/web/src/components/auth/SakuraPetals.tsx`
- Modify: `apps/web/src/app/page.tsx`, `login/page.tsx`, `register/page.tsx`, `forgot-password/page.tsx`, `reset-password/page.tsx`

Covers: R8, R9, R10, R11.

- [ ] **Step 3.1: Create `apps/web/src/components/auth/SakuraPetals.tsx`**

```tsx
const PETALS = [
  { left: "8%", delay: "0s", duration: "48s", size: 18 },
  { left: "22%", delay: "6s", duration: "52s", size: 14 },
  { left: "38%", delay: "12s", duration: "44s", size: 22 },
  { left: "55%", delay: "18s", duration: "58s", size: 16 },
  { left: "70%", delay: "4s", duration: "50s", size: 20 },
  { left: "85%", delay: "22s", duration: "46s", size: 15 },
  { left: "93%", delay: "10s", duration: "56s", size: 18 },
];

export function SakuraPetals() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {PETALS.map((p, i) => (
        <svg
          key={i}
          className="sakura-drift absolute"
          style={{
            left: p.left,
            width: p.size,
            height: p.size,
            animation: `sakura-drift ${p.duration} linear infinite`,
            animationDelay: p.delay,
            color: "var(--blossom)",
          }}
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M12 2c1.5 3 4 4 6 4 0 2-1 4.5-3 6 2 1.5 3 4 3 6-2 0-4.5-1-6-3-1.5 2-4 3-6 3 0-2 1-4.5 3-6-2-1.5-3-4-3-6 2 0 4.5-1 6-4z" />
        </svg>
      ))}
    </div>
  );
}
```

- [ ] **Step 3.2: Create `apps/web/src/components/auth/AuthSplitLayout.tsx`**

```tsx
import type { ReactNode } from "react";
import { SakuraPetals } from "./SakuraPetals";

interface AuthSplitLayoutProps {
  headline: string;
  tagline?: string;
  children: ReactNode;
}

export function AuthSplitLayout({ headline, tagline, children }: AuthSplitLayoutProps) {
  return (
    <main id="main" className="min-h-dvh flex flex-col md:flex-row">
      <section className="relative flex flex-1 items-center justify-center overflow-hidden px-8 py-16 md:py-0 md:min-h-dvh">
        <SakuraPetals />
        <div className="relative z-10 max-w-md">
          <h1 className="font-display text-5xl leading-[0.95] tracking-[-0.03em] text-text-hi md:text-7xl" style={{ color: "var(--text-hi)" }}>
            AI Herders Jam
          </h1>
          <p className="mt-4 font-display italic text-2xl" style={{ color: "var(--text-lo)" }}>
            {headline}
          </p>
          {tagline ? (
            <p className="mt-6 text-sm" style={{ color: "var(--text-lo)" }}>{tagline}</p>
          ) : null}
        </div>
      </section>
      <section className="flex flex-1 items-center justify-center px-6 py-12 md:py-0">
        <div className="glass-panel w-full max-w-[440px] p-8">
          {children}
        </div>
      </section>
    </main>
  );
}
```

- [ ] **Step 3.3: Wrap `apps/web/src/app/login/page.tsx` in `AuthSplitLayout`**

Find the outer JSX of `LoginForm`'s return (the `<Card>` tree). Replace the top-level `<main>`/wrapper with `<AuthSplitLayout headline="Welcome back.">`. The form body (everything inside `CardContent`, or the `CardContent` itself if that's the simplest wrap) goes as children. Drop the outer `<Card>` + `<CardHeader>` — the `glass-panel` provides the panel. Keep the form logic unchanged.

Example — inside the default-export component's JSX:

```tsx
return (
  <AuthSplitLayout headline="Welcome back.">
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
      {/* existing form fields unchanged */}
    </form>
  </AuthSplitLayout>
);
```

Preserve: `Suspense` boundary, `safeNextOr`, `describeAuthError`, error state, the "Remember me" checkbox, deep-link behavior.

- [ ] **Step 3.4: Wrap `apps/web/src/app/register/page.tsx`**

Same pattern as Step 3.3. Headline: `"Start herding ideas."` Preserve all existing form behavior.

- [ ] **Step 3.5: Wrap `apps/web/src/app/forgot-password/page.tsx`**

Same pattern. Headline: `"Recover your space."`

- [ ] **Step 3.6: Wrap `apps/web/src/app/reset-password/page.tsx`**

Same pattern. Headline: `"Set a new key."`

- [ ] **Step 3.7: Update `apps/web/src/app/page.tsx` to unauth landing**

Current file redirects authed users. Add the unauth branch using `AuthSplitLayout`. The children for the unauth case:

```tsx
return (
  <AuthSplitLayout headline="A calmer place to think out loud." tagline="Chat rooms, direct messages, and AI delegates — in one quiet canvas.">
    <div className="flex flex-col gap-3">
      <Link href="/register" className="w-full">
        <Button className="w-full">Create an account</Button>
      </Link>
      <Link href="/login" className="w-full">
        <Button variant="ghost-glass" className="w-full">Sign in</Button>
      </Link>
    </div>
  </AuthSplitLayout>
);
```

Keep the existing `useSession` / `useRouter` redirect logic for authed users unchanged.

- [ ] **Step 3.8: Verify typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: both exit 0.

- [ ] **Step 3.9: Visual check of all 5 auth routes**

Run: `pnpm --filter web dev`. Open each of `/`, `/login`, `/register`, `/forgot-password`, `/reset-password`. Confirm: split-screen desktop, stacked ≤768px, serif wordmark + petals on marketing side, frosted form on right, correct route headline. Toggle the OS reduced-motion preference (macOS: System Settings → Accessibility → Display → Reduce motion) and reload `/login` — petals should be static. Kill the dev server.

- [ ] **Step 3.10: Commit**

```bash
git add apps/web/src/components/auth apps/web/src/app/page.tsx apps/web/src/app/login/page.tsx apps/web/src/app/register/page.tsx apps/web/src/app/forgot-password/page.tsx apps/web/src/app/reset-password/page.tsx
git commit -m "feat(web/auth): split-screen layout with sakura petals; retrofit all auth routes"
```

---

## Task 4: Chat three-pane layout + ThemeToggle

**Files:**
- Create: `apps/web/src/components/theme-toggle.tsx`
- Modify: `apps/web/src/app/rooms/page.tsx`, `rooms/[roomId]/page.tsx`, `apps/web/src/components/chat/Header.tsx`, `apps/web/src/components/auth/AuthSplitLayout.tsx`

Covers: R3, R12, R13.

- [ ] **Step 4.1: Create `apps/web/src/components/theme-toggle.tsx`**

```tsx
"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  if (!mounted) return <div className="h-9 w-9" aria-hidden />;
  const isDark = resolvedTheme === "dark";
  return (
    <Button
      variant="ghost-glass"
      size="icon"
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isDark ? (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
      ) : (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z"/></svg>
      )}
    </Button>
  );
}
```

- [ ] **Step 4.2: Serif room title + mount `ThemeToggle` in `apps/web/src/components/chat/Header.tsx`**

At the top of the Header JSX, wrap the room title in a `font-display` span, e.g.:

```tsx
<span className="font-display text-[28px] leading-tight" style={{ letterSpacing: "-0.01em" }}>
  {roomName}
</span>
```

Add `<ThemeToggle />` in the header's right-side action slot (next to any existing overflow/menu button). Import it from `@/components/theme-toggle`.

- [ ] **Step 4.3: Mount `ThemeToggle` in the auth marketing footer (`apps/web/src/components/auth/AuthSplitLayout.tsx`)**

R3 requires the toggle in both the chat top bar and the auth split-screen marketing footer. Update the marketing `<section>` in `AuthSplitLayout` to render the toggle in a bottom-left footer slot. Import `ThemeToggle` from `@/components/theme-toggle`.

Update the marketing section to:

```tsx
<section className="relative flex flex-1 items-center justify-center overflow-hidden px-8 py-16 md:py-0 md:min-h-dvh">
  <SakuraPetals />
  <div className="relative z-10 max-w-md">
    <h1 className="font-display text-5xl leading-[0.95] tracking-[-0.03em] md:text-7xl" style={{ color: "var(--text-hi)" }}>
      AI Herders Jam
    </h1>
    <p className="mt-4 font-display italic text-2xl" style={{ color: "var(--text-lo)" }}>
      {headline}
    </p>
    {tagline ? (
      <p className="mt-6 text-sm" style={{ color: "var(--text-lo)" }}>{tagline}</p>
    ) : null}
  </div>
  <div className="absolute bottom-6 left-6 z-10">
    <ThemeToggle />
  </div>
</section>
```

Leave the form-side `<section>` unchanged.

- [ ] **Step 4.4: Restructure `apps/web/src/app/rooms/[roomId]/page.tsx` into three-pane layout**

Wrap the existing room-view tree in a three-column flex container. Skeleton:

```tsx
<main id="main" className="flex h-dvh">
  <aside className="w-[256px] shrink-0 glass-panel m-3 p-4 overflow-y-auto">
    {/* existing <RoomList> goes here */}
  </aside>
  <section className="flex-1 flex flex-col min-w-0 relative">
    {/* existing header, message list, composer — inner children unchanged */}
  </section>
  <aside className="hidden xl:block w-[240px] shrink-0 m-3 p-4 overflow-y-auto" style={{ color: "var(--text-lo)" }}>
    {/* existing <MemberList> goes here */}
  </aside>
</main>
```

The `xl:` breakpoint in Tailwind defaults to 1280px — override in `tailwind.config.ts` if not already done, OR swap to a custom arbitrary class `min-[1100px]:block`. Use `min-[1100px]:block` to match R12.

Preserve: data fetching hooks, websocket wiring, scroll behavior, message render.

- [ ] **Step 4.5: Apply same three-pane shell to `apps/web/src/app/rooms/page.tsx`**

Same skeleton as Step 4.4. Center pane shows a serif empty-state tagline ("Pick a room to start reading.") when no roomId is selected.

- [ ] **Step 4.6: Verify typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: both exit 0.

- [ ] **Step 4.7: Visual check**

Run: `pnpm --filter web dev`. Sign in (or use an existing dev account). Navigate to `/rooms/<some-roomId>`. Confirm: sidebar left, message pane center, member list right (hides below 1100px), serif room title, theme toggle in header flips dark/light and persists across reload. Navigate to `/login` and confirm the theme toggle is visible in the bottom-left of the marketing side and flips themes. Kill the dev server.

- [ ] **Step 4.8: Commit**

```bash
git add apps/web/src/components/theme-toggle.tsx apps/web/src/components/auth/AuthSplitLayout.tsx apps/web/src/app/rooms/page.tsx apps/web/src/app/rooms/[roomId]/page.tsx apps/web/src/components/chat/Header.tsx
git commit -m "feat(web/chat): three-pane layout + serif room title + theme toggle (chat + auth)"
```

---

## Task 5: Frosted composer

**Files:**
- Create: `apps/web/src/components/chat/ChatComposer.tsx`
- Modify: `apps/web/src/components/chat/MessageComposer.tsx` and the room page that renders it

Covers: R14, R15.

- [ ] **Step 5.1: Create `apps/web/src/components/chat/ChatComposer.tsx`**

```tsx
import type { ReactNode } from "react";

interface ChatComposerProps {
  children: ReactNode;
}

export function ChatComposer({ children }: ChatComposerProps) {
  return (
    <div className="pointer-events-none sticky bottom-0 px-3 pb-3 pt-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-4 h-10"
        style={{
          background: "linear-gradient(to top, var(--bg-base), transparent)",
        }}
      />
      <div className="pointer-events-auto glass-panel p-3">
        {children}
      </div>
    </div>
  );
}
```

- [ ] **Step 5.2: Refactor `apps/web/src/components/chat/MessageComposer.tsx`**

The existing component renders a textarea + send button. Two changes:

(a) Replace any outer `div`/`form` chrome with a plain `<form>` so the visual shell comes from `ChatComposer`. The form fills the composer slot.

(b) Ensure the textarea uses auto-grow (max 6 lines) and an Instrument-Serif italic placeholder. Add to the textarea element:

```tsx
<Textarea
  // ...existing props
  placeholder={`Write to #${roomName}…`}
  rows={1}
  className="font-display italic resize-none max-h-[9rem] overflow-y-auto"
  onInput={(e) => {
    const el = e.currentTarget;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
  }}
/>
```

Keep: submission handler, keyboard shortcuts (Enter to send, Shift+Enter for newline), validation, emoji/attachment triggers.

- [ ] **Step 5.3: Wrap the rendered `MessageComposer` in `ChatComposer` on the room page**

In `apps/web/src/app/rooms/[roomId]/page.tsx` (or wherever `<MessageComposer />` is mounted inside the center pane), wrap it:

```tsx
<ChatComposer>
  <MessageComposer {...existingProps} />
</ChatComposer>
```

Import from `@/components/chat/ChatComposer`.

- [ ] **Step 5.4: Verify typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: both exit 0.

- [ ] **Step 5.5: Visual check**

Run: `pnpm --filter web dev`. Open a room. Scroll older messages. Confirm: the composer floats frosted at the bottom, messages visibly slide *under* it with a gradient fade, textarea grows up to ~6 lines then scrolls internally, italic serif placeholder shows the room name. Kill the dev server.

- [ ] **Step 5.6: Commit**

```bash
git add apps/web/src/components/chat/ChatComposer.tsx apps/web/src/components/chat/MessageComposer.tsx apps/web/src/app/rooms/[roomId]/page.tsx
git commit -m "feat(web/chat): frosted composer pinned bottom with gradient fade"
```

---

## Task 6: AI message variant — type, chip, shimmer, bubble, fixtures

**Files:**
- Create: `apps/web/src/components/chat/ConfidenceChip.tsx`, `ConfidenceChip.test.ts`, `StreamingShimmer.tsx`, `AiMessageBubble.tsx`, `apps/web/src/lib/chat/ai-fixtures.ts`
- Modify: `packages/shared/src/protocol.ts`, `apps/web/src/components/chat/MessageList.tsx`

Covers: R16, R17, R18, R19, R20.

- [ ] **Step 6.1: Extend `MessagePayload` in `packages/shared/src/protocol.ts`**

Add three optional fields at the bottom of the interface (keep them optional so existing producers stay valid):

```ts
export interface MessagePayload {
  // ...all existing fields unchanged
  // Frontend-only fields (optional; backend does not populate these yet):
  authorType?: "user" | "ai";
  status?: "streaming" | "final";
  confidence?: number;
}
```

- [ ] **Step 6.2: Write failing test for `ConfidenceChip` label logic**

Create `apps/web/src/components/chat/ConfidenceChip.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { tierForConfidence } from "./ConfidenceChip";

describe("tierForConfidence", () => {
  it("returns High for >= 0.8", () => {
    expect(tierForConfidence(0.8)).toEqual({ label: "High", tier: "high" });
    expect(tierForConfidence(0.95)).toEqual({ label: "High", tier: "high" });
    expect(tierForConfidence(1)).toEqual({ label: "High", tier: "high" });
  });
  it("returns Med for 0.5..0.8", () => {
    expect(tierForConfidence(0.5)).toEqual({ label: "Med", tier: "med" });
    expect(tierForConfidence(0.65)).toEqual({ label: "Med", tier: "med" });
    expect(tierForConfidence(0.79999)).toEqual({ label: "Med", tier: "med" });
  });
  it("returns Low for < 0.5", () => {
    expect(tierForConfidence(0)).toEqual({ label: "Low", tier: "low" });
    expect(tierForConfidence(0.49)).toEqual({ label: "Low", tier: "low" });
  });
  it("returns null for undefined", () => {
    expect(tierForConfidence(undefined)).toBeNull();
  });
});
```

Run: `pnpm --filter web test:run src/components/chat/ConfidenceChip.test.ts`
Expected: FAIL — `tierForConfidence` not found.

- [ ] **Step 6.3: Implement `ConfidenceChip`**

Create `apps/web/src/components/chat/ConfidenceChip.tsx`:

```tsx
export type ConfidenceTier = "high" | "med" | "low";

export function tierForConfidence(
  confidence: number | undefined,
): { label: "High" | "Med" | "Low"; tier: ConfidenceTier } | null {
  if (confidence === undefined) return null;
  if (confidence >= 0.8) return { label: "High", tier: "high" };
  if (confidence >= 0.5) return { label: "Med", tier: "med" };
  return { label: "Low", tier: "low" };
}

const TIER_STYLE: Record<ConfidenceTier, { bg: string; text: string }> = {
  high: { bg: "var(--success)", text: "var(--bg-base)" },
  med: { bg: "var(--accent)", text: "var(--on-accent)" },
  low: { bg: "var(--warn)", text: "var(--bg-base)" },
};

interface Props {
  confidence: number | undefined;
}

export function ConfidenceChip({ confidence }: Props) {
  const result = tierForConfidence(confidence);
  if (!result) return null;
  const style = TIER_STYLE[result.tier];
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums"
      style={{ background: style.bg, color: style.text }}
    >
      {result.label}
    </span>
  );
}
```

- [ ] **Step 6.4: Re-run the test**

Run: `pnpm --filter web test:run src/components/chat/ConfidenceChip.test.ts`
Expected: PASS, 4/4 tests.

- [ ] **Step 6.5: Create `apps/web/src/components/chat/StreamingShimmer.tsx`**

```tsx
export function StreamingShimmer() {
  return (
    <span className="pointer-events-none absolute inset-x-0 bottom-0 h-px overflow-hidden rounded-b-[var(--radius)]" aria-hidden>
      <span
        className="shimmer-sweep block h-full w-1/3"
        style={{
          background: "linear-gradient(90deg, transparent, var(--accent), var(--blossom), transparent)",
          animation: "shimmer-sweep 1.4s linear infinite",
        }}
      />
      <noscript />
    </span>
  );
}
```

Note: the `@media (prefers-reduced-motion: reduce)` rule in `globals.css` (Task 1) already disables `shimmer-sweep`. The static 1px line remains visible because the wrapper keeps `bottom: 0; height: 1px;` with the gradient `background`.

- [ ] **Step 6.6: Create `apps/web/src/components/chat/AiMessageBubble.tsx`**

```tsx
import type { MessagePayload } from "@ai-herders/shared/protocol";
import { ConfidenceChip } from "./ConfidenceChip";
import { StreamingShimmer } from "./StreamingShimmer";

interface Props {
  message: MessagePayload;
}

export function AiMessageBubble({ message }: Props) {
  const isStreaming = message.status === "streaming";
  return (
    <article className="relative glass-panel px-4 py-3" style={{
      backgroundImage: "linear-gradient(to bottom, rgba(196, 181, 253, 0.12), transparent 40%)",
    }}>
      <header className="flex items-baseline gap-2 mb-1">
        <span className="text-sm font-semibold" style={{ color: "var(--text-hi)" }}>
          {message.authorName}
        </span>
        <span className="text-[11px]" style={{ color: "var(--accent)" }}>✦ AI</span>
        <time className="ml-auto text-[11px]" style={{ color: "var(--text-lo)" }}>
          {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </time>
      </header>
      <div className="text-[15px] leading-[1.55] whitespace-pre-wrap" style={{ color: "var(--text-hi)" }}>
        {message.body}
      </div>
      <footer className="mt-2 flex justify-end">
        <ConfidenceChip confidence={message.confidence} />
      </footer>
      {isStreaming && <StreamingShimmer />}
    </article>
  );
}
```

- [ ] **Step 6.7: Dispatch to `AiMessageBubble` in `apps/web/src/components/chat/MessageList.tsx`**

Where each message is rendered (inside the map that produces the user bubble), branch on `authorType`:

```tsx
{messages.map((msg) => (
  msg.authorType === "ai"
    ? <AiMessageBubble key={msg.id} message={msg} />
    : <UserMessageBubble key={msg.id} message={msg} /* existing render */ />
))}
```

Import `AiMessageBubble` from `./AiMessageBubble`. Keep the existing user-bubble render path.

- [ ] **Step 6.8: Create `apps/web/src/lib/chat/ai-fixtures.ts`**

```ts
import type { MessagePayload } from "@ai-herders/shared/protocol";

export function makeAiFixtures(roomId: string, baseSeq: number): MessagePayload[] {
  const base = {
    roomId,
    authorId: "ai-fixture",
    authorUsername: "fixture-ai",
    authorName: "Lavender",
    replyToId: null,
    replyTo: null,
    editedAt: null,
    deletedAt: null,
    authorType: "ai" as const,
  };
  return [
    { ...base, id: "fx-1", body: "Confidence is high: the spec grid renders cleanly at every breakpoint.", seq: String(baseSeq + 1), createdAt: new Date().toISOString(), confidence: 0.92, status: "final" },
    { ...base, id: "fx-2", body: "I think the composer fade passes — but it's medium confidence, review the 768px mock.", seq: String(baseSeq + 2), createdAt: new Date().toISOString(), confidence: 0.66, status: "final" },
    { ...base, id: "fx-3", body: "Low confidence on the admin table contrast — worth an axe run.", seq: String(baseSeq + 3), createdAt: new Date().toISOString(), confidence: 0.34, status: "final" },
    { ...base, id: "fx-4", body: "Typing… generating the next suggestion", seq: String(baseSeq + 4), createdAt: new Date().toISOString(), status: "streaming" },
    { ...base, id: "fx-5", body: "No-confidence variant (chip should be hidden).", seq: String(baseSeq + 5), createdAt: new Date().toISOString(), status: "final" },
  ];
}
```

- [ ] **Step 6.9: Add a dev-only fixture toggle to the room page**

In `apps/web/src/app/rooms/[roomId]/page.tsx`, after the messages-fetching hook populates the message list, append fixtures when `process.env.NEXT_PUBLIC_AI_FIXTURES === "1"`:

```tsx
import { makeAiFixtures } from "@/lib/chat/ai-fixtures";
// ...inside the component, after you have `messages` and `roomId`:
const withFixtures = process.env.NEXT_PUBLIC_AI_FIXTURES === "1"
  ? [...messages, ...makeAiFixtures(roomId, messages.length)]
  : messages;
// pass `withFixtures` to <MessageList />
```

This keeps fixtures out of production builds unless the env var is explicitly set.

- [ ] **Step 6.10: Verify typecheck + unit tests + build**

Run: `pnpm --filter web typecheck && pnpm --filter web test:run && pnpm --filter web build`
Expected: all three exit 0.

- [ ] **Step 6.11: Visual verification with fixtures**

Run: `NEXT_PUBLIC_AI_FIXTURES=1 pnpm --filter web dev`. Navigate to `/rooms/<any-roomId>`. Confirm all 5 fixture states render: High (green chip), Med (lavender chip, readable text in both themes), Low (amber/butter chip), streaming (shimmer bar along bottom, no chip because no confidence on fixture 4), no-chip (no pill rendered). Toggle to light theme and re-verify Med chip text is readable. Toggle reduced-motion — shimmer becomes a static line. Kill the dev server.

- [ ] **Step 6.12: Commit**

```bash
git add packages/shared/src/protocol.ts apps/web/src/components/chat/ConfidenceChip.tsx apps/web/src/components/chat/ConfidenceChip.test.ts apps/web/src/components/chat/StreamingShimmer.tsx apps/web/src/components/chat/AiMessageBubble.tsx apps/web/src/components/chat/MessageList.tsx apps/web/src/lib/chat/ai-fixtures.ts apps/web/src/app/rooms/[roomId]/page.tsx
git commit -m "feat(web/chat): AI message variant with confidence chip, streaming shimmer, fixtures"
```

---

## Task 7: Rooms browse + contacts + empty states

**Files:**
- Create: `apps/web/src/components/empty/BlossomEmptyState.tsx`
- Modify: `apps/web/src/app/rooms/browse/page.tsx`, `apps/web/src/app/contacts/page.tsx`

Covers: R20, R21, R22, R23.

- [ ] **Step 7.1: Create `apps/web/src/components/empty/BlossomEmptyState.tsx`**

```tsx
import type { ReactNode } from "react";

interface Props {
  tagline: string;
  children?: ReactNode;
}

export function BlossomEmptyState({ tagline, children }: Props) {
  return (
    <div className="flex flex-col items-center justify-center gap-6 py-20 text-center">
      <svg
        viewBox="0 0 120 120"
        className="h-32 w-32 opacity-20"
        fill="currentColor"
        style={{ color: "var(--blossom)" }}
        aria-hidden
      >
        <path d="M60 10c7 15 20 20 30 20 0 10-5 22-15 30 10 7 15 20 15 30-10 0-22-5-30-15-7 10-20 15-30 15 0-10 5-22 15-30-10-7-15-20-15-30 10 0 22-5 30-20z" />
      </svg>
      <p className="font-display italic text-[22px]" style={{ color: "var(--text-lo)" }}>
        {tagline}
      </p>
      {children}
    </div>
  );
}
```

- [ ] **Step 7.2: Masonry grid on `apps/web/src/app/rooms/browse/page.tsx`**

Replace the current grid container (where it maps rooms to cards) with CSS columns. Example outer wrapper:

```tsx
<div className="mx-auto max-w-6xl px-6 py-10">
  <h1 className="font-display text-4xl mb-6" style={{ color: "var(--text-hi)" }}>Browse rooms</h1>
  <div className="columns-1 gap-4 md:columns-2 xl:columns-3">
    {rooms.map((room) => (
      <article
        key={room.id}
        className="glass-panel mb-4 break-inside-avoid p-5 transition-all duration-200 hover:-translate-y-1 hover:rotate-[-0.5deg]"
      >
        <h2 className="font-display text-2xl mb-1" style={{ color: "var(--text-hi)" }}>{room.name}</h2>
        {room.description ? (
          <p className="text-sm" style={{ color: "var(--text-lo)" }}>{room.description}</p>
        ) : null}
        {/* preserve: existing "join" / "preview" buttons */}
      </article>
    ))}
  </div>
</div>
```

If the rooms list is empty, render `<BlossomEmptyState tagline="No rooms yet. Ask someone to invite you." />`.

- [ ] **Step 7.3: Two-col + empty state on `apps/web/src/app/contacts/page.tsx`**

Wrap the existing content in a 2-col layout. Left is the current filter/search UI. Right is the contact cards list. When the right-side list is empty, render `<BlossomEmptyState tagline="No contacts yet. Send an invitation to start." />`.

```tsx
<main id="main" className="mx-auto max-w-6xl grid grid-cols-1 md:grid-cols-[280px_1fr] gap-6 px-6 py-10">
  <aside className="glass-panel p-5 md:sticky md:top-6 md:self-start">
    {/* existing search/filters unchanged */}
  </aside>
  <section>
    {contacts.length === 0 ? (
      <BlossomEmptyState tagline="No contacts yet. Send an invitation to start." />
    ) : (
      <ul className="flex flex-col gap-3">
        {contacts.map(/* existing card render */)}
      </ul>
    )}
  </section>
</main>
```

- [ ] **Step 7.4: Empty-state for rooms without messages**

In `apps/web/src/components/chat/MessageList.tsx`, when `messages.length === 0` render `<BlossomEmptyState tagline="No messages yet. Say hello to start the room." />` in place of the scrolling list.

- [ ] **Step 7.5: Verify typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: both exit 0.

- [ ] **Step 7.6: Visual check**

Run: `pnpm --filter web dev`. Visit `/rooms/browse` — masonry grid, hover lift works. Visit `/contacts` — two-col; if no contacts, see blossom empty state. Enter an empty room — blossom empty state in the message pane. Kill the dev server.

- [ ] **Step 7.7: Commit**

```bash
git add apps/web/src/components/empty/BlossomEmptyState.tsx apps/web/src/app/rooms/browse/page.tsx apps/web/src/app/contacts/page.tsx apps/web/src/components/chat/MessageList.tsx
git commit -m "feat(web): masonry rooms-browse, contacts 2-col, sakura empty states"
```

---

## Task 8: Tiered admin + settings restyle

**Files:**
- Modify: `apps/web/src/app/admin/page.tsx`, `admin/federation/page.tsx`, `settings/account/page.tsx`, `settings/password/page.tsx`, `settings/sessions/page.tsx`

Covers: R24, R25, R26.

- [ ] **Step 8.1: Wrap `apps/web/src/app/admin/page.tsx` in the tiered shell**

Wrap the existing content in:

```tsx
<main id="main" className="mx-auto max-w-[880px] px-6 py-10">
  <h1 className="font-display text-4xl mb-6" style={{ color: "var(--text-hi)" }}>Admin</h1>
  <div className="rounded-[var(--radius)] p-6" style={{ background: "var(--bg-elevated)", boxShadow: "inset 0 1px 0 var(--glass-border)" }}>
    {/* existing admin content unchanged */}
  </div>
</main>
```

No `backdrop-filter`, no glass opacity — solid panel.

- [ ] **Step 8.2: Apply the same shell to `apps/web/src/app/admin/federation/page.tsx`**

Same pattern as Step 8.1. Page H1: `"Federation"`.

- [ ] **Step 8.3: Apply to `apps/web/src/app/settings/account/page.tsx`**

Same pattern. H1: `"Account"`.

- [ ] **Step 8.4: Apply to `apps/web/src/app/settings/password/page.tsx`**

Same pattern. H1: `"Password"`.

- [ ] **Step 8.5: Apply to `apps/web/src/app/settings/sessions/page.tsx` with quiet table**

Same shell plus: the sessions table loses vertical dividers; rows highlight on hover only. Example style block for the table rows:

```tsx
<table className="w-full text-sm">
  <thead>
    <tr className="text-left" style={{ color: "var(--text-lo)" }}>
      {/* existing headers */}
    </tr>
  </thead>
  <tbody>
    {sessions.map((s) => (
      <tr
        key={s.id}
        className="transition-colors"
        style={{
          borderBottom: "1px solid var(--glass-border)",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--glass-bg)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        {/* existing row cells */}
      </tr>
    ))}
  </tbody>
</table>
```

Keep revoke-session behavior unchanged.

- [ ] **Step 8.6: Verify typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: both exit 0.

- [ ] **Step 8.7: Visual check**

Run: `pnpm --filter web dev`. Visit each tiered page — serif H1s, solid elevated panels (no translucency), session table rows highlight on hover only, no vertical dividers. Kill the dev server.

- [ ] **Step 8.8: Commit**

```bash
git add apps/web/src/app/admin apps/web/src/app/settings
git commit -m "feat(web): tiered palette for admin/settings — serif H1 + solid panels"
```

---

## Task 9: Accessibility + performance verification

**Files:**
- Create: `tests/e2e/lavender-mist-a11y.spec.ts`
- Modify: `apps/web/package.json`

Covers: R30, plus validates R9/R19 reduced-motion and R19 perf target.

- [ ] **Step 9.1: Add `@axe-core/playwright` as a dev dep**

From the repo root:

```bash
pnpm add -D -w @axe-core/playwright
```

- [ ] **Step 9.2: Create `tests/e2e/lavender-mist-a11y.spec.ts`**

```ts
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const ROUTES = ["/login", "/rooms", "/settings/sessions", "/admin"];

for (const theme of ["dark", "light"] as const) {
  test.describe(`lavender-mist a11y — ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      // Pre-set the theme via next-themes localStorage key before first render
      await page.addInitScript((t) => {
        window.localStorage.setItem("theme", t);
      }, theme);
    });

    for (const route of ROUTES) {
      test(`${route} has no color-contrast violations`, async ({ page }) => {
        await page.goto(route);
        // Wait for the page to settle
        await page.waitForLoadState("networkidle");
        const results = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa"])
          .include("body")
          .analyze();
        const contrastIssues = results.violations.filter((v) => v.id === "color-contrast");
        expect(contrastIssues, JSON.stringify(contrastIssues, null, 2)).toEqual([]);
      });
    }
  });
}

test("rooms room view with AI fixtures has no color-contrast violations", async ({ page }) => {
  // Requires: dev server started with NEXT_PUBLIC_AI_FIXTURES=1 and a seeded room.
  test.skip(!process.env.TEST_ROOM_ID, "TEST_ROOM_ID env not set; skipping fixture contrast check");
  await page.addInitScript(() => window.localStorage.setItem("theme", "dark"));
  await page.goto(`/rooms/${process.env.TEST_ROOM_ID}`);
  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const contrastIssues = results.violations.filter((v) => v.id === "color-contrast");
  expect(contrastIssues, JSON.stringify(contrastIssues, null, 2)).toEqual([]);
});
```

- [ ] **Step 9.3: Run axe checks against the dev server**

Start the dev server in a second terminal: `pnpm --filter web dev`. Then:

```bash
pnpm test:e2e tests/e2e/lavender-mist-a11y.spec.ts
```

Expected: all contrast tests pass, both themes × 4 routes. If any violation reports, inspect the offending element, adjust tokens (most likely `--text-lo` or a chip edge case), and re-run.

- [ ] **Step 9.4: Perf target spot-check (R19)**

Start dev server: `NEXT_PUBLIC_AI_FIXTURES=1 pnpm --filter web dev`. Open a room that includes the 5 fixture bubbles (plus real messages, aim for ~15 visible). In Chrome DevTools → Performance, start recording, let the streaming shimmer run for 5s, stop. Confirm average FPS ≥ 30 on an M1-class (or similar 2020+) laptop. If below target, reduce backdrop-blur radius or limit shimmer to the most recent streaming bubble only.

- [ ] **Step 9.5: Reduced-motion check**

Enable OS reduced-motion, reload `/login` and a room with fixtures. Confirm: petals render static (no drift), shimmer is a static line (no sweep). Card hover tilt on `/rooms/browse` is still fine because it's user-initiated.

- [ ] **Step 9.6: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml tests/e2e/lavender-mist-a11y.spec.ts
git commit -m "test(web): axe-core contrast spec for lavender-mist across key routes"
```

---

## Completion checklist

Before declaring the branch done:

- [ ] All 15 routes render correctly in both themes.
- [ ] `pnpm --filter web typecheck` passes.
- [ ] `pnpm --filter web test:run` passes.
- [ ] `pnpm --filter web build` passes.
- [ ] `pnpm test:e2e tests/e2e/lavender-mist-a11y.spec.ts` passes (no `color-contrast` violations in either theme on the covered routes).
- [ ] Theme toggle persists across reloads.
- [ ] `prefers-reduced-motion` disables sakura drift + streaming shimmer.
- [ ] No production path imports from `lib/chat/ai-fixtures.ts` without `NEXT_PUBLIC_AI_FIXTURES === "1"`.
- [ ] No backend files modified (git diff confirms scope).
- [ ] Playwright screenshot baselines are NOT updated in this branch — that's a separate task (see spec §7).
