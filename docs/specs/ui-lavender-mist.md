# Spec: UI Lavender Mist

**Status**: approved
**Branch**: `feat/ui-lavender-mist`
**Worktree**: `hackaton-ui-lavender`
**Base**: `main@2bcb889`
**Owner (human)**: Tatiana
**Owner (agent)**: Claude Code

## 1. Why

The current `apps/web` UI uses shadcn defaults — neutral grays, system fonts, no theme distinction — which is competent but generic. For the post-hackathon polish pass, we want a distinctive, memorable visual identity: **dark-glassmorphism lavender-mist** with a symmetric spring-leaning light variant. The aesthetic adds a small amount of structural upgrade to the chat room (frosted composer, AI message variant with confidence chip + streaming shimmer) so AI-generated replies visibly read differently from human ones. Target user: anyone demoing AI Herders Jam to an audience — the UI should register as designed, not generated.

## 2. Non-goals

- No backend changes. `confidence` and `status` fields are frontend-only additions to the message type.
- No socket.io / API protocol changes. No new DB columns, no new endpoints.
- No real AI-streaming wire-up — the shimmer is driven off a frontend `status` field that a producer can fill in later.
- No e2e test updates. Playwright screenshot baselines will drift; regenerating them is a separate task.
- No admin/settings layout restructure beyond palette + typography.
- No accessibility regression — contrast ratios must stay ≥ 4.5:1 for body text in both themes.

## 3. User stories

- As a **visitor** landing on `/` or an auth page, I see a split-screen with a serif wordmark, drifting sakura petals, and a frosted form panel, so the product feels intentional before I sign in.
- As a **room member**, I see a frosted composer pinned to the bottom of the chat pane, so I always know where to type without hunting for it.
- As a **room member**, I can distinguish AI replies from human replies at a glance (subtle lavender wash + `✦ AI` chip + confidence pill), so I calibrate trust appropriately.
- As a **room member** reading an AI reply while it streams, I see a shimmer bar at the bottom of the bubble, so I know the content is still arriving.
- As an **admin** on `/admin` or `/admin/federation`, I get the same palette and serif titles, but tables stay readable (solid panels, no blur), so the aesthetic doesn't punish dense-data workflows.
- As any **user**, I can toggle between dark and light themes from the top bar, so I can match my environment; my choice persists across sessions.

## 4. Requirements (testable)

Each requirement has an observable outcome.

### Tokens & theming
- [ ] **R1**: `apps/web/src/app/globals.css` defines the full lavender-mist token set (§5) in two layers: (a) brand tokens (`--bg-base`, `--bg-elevated`, `--glass-bg`, `--glass-border`, `--accent`, `--accent-soft`, `--on-accent`, `--text-hi`, `--text-lo`, `--success`, `--warn`, `--destructive`, `--ring`, `--blossom`), (b) shadcn aliases (`--background`, `--foreground`, `--card`, `--card-foreground`, `--popover`, `--popover-foreground`, `--primary`, `--primary-foreground`, `--secondary`, `--secondary-foreground`, `--muted`, `--muted-foreground`, `--accent-foreground`, `--destructive-foreground`, `--border`, `--input`, `--radius`) mapped via `var(...)` chains so shadcn primitives resolve correctly without edits. All `oklch(...)` values are removed.
- [ ] **R2**: `apps/web/src/components/theme-provider.tsx` is a client component (`"use client"`) that wraps `next-themes` `ThemeProvider` with `attribute="class"`, `defaultTheme="dark"`, `enableSystem={false}`. `apps/web/src/app/layout.tsx` imports it and wraps children in it. The `<html>` element gets `suppressHydrationWarning`.
- [ ] **R3**: A theme toggle (sun/moon icon, `ghost-glass` button) is present in the chat shell top bar and in the auth split-screen marketing footer. Clicking it flips themes and persists to `localStorage` via `next-themes`.
- [ ] **R4**: `body` renders the two-layer radial gradient defined in §5 in both themes.
- [ ] **R5**: Cards and glass panels (`.glass-panel` utility, `components/ui/card.tsx`, any bespoke panel containers) define their edges via `box-shadow: inset 0 1px 0 var(--glass-border), 0 ...` only — no `border`. Other shadcn primitives that rely on `border` utilities (`button` outline/destructive variants, `input`, `textarea`, `dialog`, `separator`, `tabs` triggers) retain their borders.

### Typography
- [ ] **R6**: `Instrument Serif` and `Inter` are loaded via `next/font/google` in `apps/web/src/app/layout.tsx`, exposed as `--font-display` and `--font-sans` CSS vars. The existing hardcoded `--font-sans: ui-sans-serif, system-ui, sans-serif;` declaration in `globals.css` is removed so it doesn't shadow the `next/font`-injected value.
- [ ] **R7**: Room titles, auth hero wordmarks, auth route headlines, admin/settings H1s, and empty-state taglines render in Instrument Serif. Everything else renders in Inter.

### Auth pages
- [ ] **R8**: `/`, `/login`, `/register`, `/forgot-password`, `/reset-password` render the split-screen layout (50/50 desktop, stacked below 768px).
- [ ] **R9**: The marketing side shows 5–7 animated SVG sakura petals drifting via `@keyframes sakura-drift` (translateY + rotate over 40–60s per petal, randomized delays). Under `@media (prefers-reduced-motion: reduce)` the animation is disabled (`animation: none`); petals render in their starting positions only.
- [ ] **R10**: Each auth route shows its own serif headline: `/login` "Welcome back.", `/register` "Start herding ideas.", `/forgot-password` "Recover your space.", `/reset-password` "Set a new key.", `/` unauth shows a marketing tagline + CTAs.
- [ ] **R11**: The form panel is a frosted glass card (max-width 440px, inset shadow only).

### Chat pages
- [ ] **R12**: `/rooms` and `/rooms/[roomId]` use the three-pane layout: left sidebar (256px, glass), center message pane, right member panel (240px, collapses below 1100px viewport).
- [ ] **R13**: Room titles render in Instrument Serif 28px at the top of the center pane.
- [ ] **R14**: The composer is pinned to the bottom of the center pane with a 40px `linear-gradient(to top, var(--bg-base), transparent)` overlay above it. Messages visibly scroll *under* the composer.
- [ ] **R15**: Composer textarea auto-grows up to 6 lines before scrolling internally. Placeholder is Instrument Serif italic, e.g. `Write to #{roomName}…`.
- [ ] **R16**: The frontend `ChatMessage` type gains three optional fields: `authorType?: "user" | "ai"`, `status?: "streaming" | "final"`, `confidence?: number`. Absence of each defaults to user / final / hide-chip.
- [ ] **R17**: AI bubbles render with a top-edge lavender gradient wash and a `✦ AI` chip next to the author name. User bubbles render without either.
- [ ] **R18**: When `confidence` is present, a pill renders bottom-right of the AI bubble. Label is `High` (≥0.8), `Med` (0.5–0.8), `Low` (<0.5). Colors per §5 — Med uses `var(--on-accent)` as its text color (flips per theme: dark text in dark mode, light text in light mode) so contrast passes in both themes. When `confidence` is absent, no pill renders.
- [ ] **R19**: When `status === "streaming"`, a 1px shimmer bar animates along the bottom of the AI bubble (`transparent → var(--accent) → var(--blossom) → transparent`, 1.4s linear infinite). Under `@media (prefers-reduced-motion: reduce)` the bar renders as a static 1px line (`background: var(--accent)`, no animation) so the streaming state stays visible without motion. Performance target: ≥30fps in Chromium on a 2020-class laptop (e.g., M1 MBA) with 15 bubbles visible and up to 3 in `status: "streaming"`. When `status !== "streaming"`, no shimmer.
- [ ] **R20**: Empty room state shows a large sakura blossom SVG at 20% opacity + Instrument Serif italic tagline.

### Rooms browse
- [ ] **R21**: `/rooms/browse` renders a masonry-ish grid via CSS `columns` (3 desktop / 2 tablet / 1 mobile).
- [ ] **R22**: Each room card is a glass panel with serif room name. Hover applies `transform: translateY(-4px) rotate(-0.5deg)` + deepened shadow, 180ms ease-out.

### Contacts
- [ ] **R23**: `/contacts` renders two columns (filters left, cards right). Empty state uses the sakura blossom + serif tagline pattern.

### Tiered pages (admin + settings)
- [ ] **R24**: `/admin`, `/admin/federation`, `/settings/account`, `/settings/password`, `/settings/sessions` render with serif H1 (36px) + single-column layout (max-width 880px).
- [ ] **R25**: Panels on tiered pages are **solid** `var(--bg-elevated)` with inset shadow — no `backdrop-filter`, no translucency.
- [ ] **R26**: Tables on `/settings/sessions` use no vertical dividers; row hover tints the row with `var(--glass-bg)` only.

### Shadcn overrides
- [ ] **R27**: `components/ui/button.tsx` gains a `ghost-glass` variant: transparent bg, `var(--glass-bg)` on hover.
- [ ] **R28**: `components/ui/card.tsx` removes the default `border` class. Consumers opt into glass via the new `.glass-panel` utility.
- [ ] **R29**: `components/ui/input.tsx` and `components/ui/textarea.tsx` use `var(--ring)` lavender focus ring; backgrounds flip from transparent to `var(--glass-bg)` on focus.

### Accessibility
- [ ] **R30**: Body text contrast against its background ≥ 4.5:1 in both themes. Verified by running axe-core (via `@axe-core/playwright`) against `/login`, `/rooms/[roomId]` (with fixture seeding all four AI bubble states — streaming, High, Med, Low, no-chip), `/settings/sessions`, and `/admin` in both themes. No `color-contrast` violations. Focus rings on inputs + buttons pass the non-text 3:1 minimum against the adjacent panel background.

## 5. Design notes

### Data model changes

**None in the database.** Frontend `ChatMessage` type gains three optional fields (see R16).

### New UI routes

None. All 15 existing routes are restyled.

### Security / auth

No changes. Theme choice is cosmetic and client-persisted via `next-themes`.

### External services

None. Instrument Serif and Inter fetched once at build time via `next/font/google` (self-hosted after build; no runtime calls to Google).

### Tokens — two-layer structure

The token system has two layers:

1. **Brand layer** — the lavender-mist semantic tokens. Defined fresh per theme. These are what component CSS should prefer.
2. **Shadcn alias layer** — the variable names shadcn expects (`--background`, `--card`, `--primary`, etc.), redeclared in `:root` once using `var(...)` chains that point at the brand layer. Because the aliases resolve at use time, flipping `.dark` updates the brand layer and the aliases automatically resolve to the new values — no duplicate declarations in `.dark`.

#### Light theme (`:root`) — brand layer + aliases

```css
:root {
  /* brand layer — spring-leaning cream + deep violet */
  --bg-base:        #FAF6EE;
  --bg-elevated:    #F1ECF7;
  --glass-bg:       rgba(124, 58, 237, 0.06);
  --glass-border:   rgba(124, 58, 237, 0.22);   /* bumped from 0.14 for edge definition on cream */
  --accent:         #7C3AED;                    /* violet-600 */
  --accent-soft:    #F5F3FF;
  --on-accent:      var(--accent-soft);         /* light text on dark-violet brand bg */
  --text-hi:        #201A2E;
  --text-lo:        #6B6283;
  --success:        #047857;
  --warn:           #92400E;
  --destructive:    #B91C1C;
  --ring:           rgba(124, 58, 237, 0.45);
  --blossom:        #E89EC4;

  /* shadcn aliases — declared once, resolve per theme via var() chains */
  --background:            var(--bg-base);
  --foreground:            var(--text-hi);
  --card:                  var(--bg-elevated);
  --card-foreground:       var(--text-hi);
  --popover:               var(--bg-elevated);
  --popover-foreground:    var(--text-hi);
  --primary:               var(--accent);
  --primary-foreground:    var(--on-accent);
  --secondary:             var(--bg-elevated);
  --secondary-foreground:  var(--text-hi);
  --muted:                 var(--bg-elevated);
  --muted-foreground:      var(--text-lo);
  --accent-foreground:     var(--on-accent);
  --destructive-foreground: var(--accent-soft);
  --border:                var(--glass-border);
  --input:                 var(--glass-border);
  --radius:                0.625rem;
}
```

#### Dark theme (`.dark`) — brand-layer overrides only

```css
.dark {
  --bg-base:        #0F0B1A;
  --bg-elevated:    #1A1428;
  --glass-bg:       rgba(180, 160, 220, 0.08);
  --glass-border:   rgba(196, 181, 253, 0.12);
  --accent:         #C4B5FD;                    /* lavender-300 */
  --accent-soft:    #F5F3FF;
  --on-accent:      var(--bg-base);             /* dark text on light-lavender brand bg */
  --text-hi:        #F4F1F8;
  --text-lo:        #A89FB8;
  --success:        #A7F3D0;
  --warn:           #FDE68A;
  --destructive:    #F0A5A5;
  --ring:           rgba(196, 181, 253, 0.55);
  --blossom:        #FBCFE8;
}
```

The `--on-accent` flip is what makes the Med confidence chip readable in both themes: in dark mode it resolves to near-black on light-lavender (~14:1); in light mode it resolves to near-white on dark-violet (~7.9:1).

### Radial gradient base (applied to `body`)

**Dark**:

```css
background-color: #0F0B1A;
background-image:
  radial-gradient(ellipse 80% 60% at 20% 0%,  rgba(139, 92, 246, 0.15), transparent 60%),
  radial-gradient(ellipse 70% 50% at 85% 100%, rgba(196, 181, 253, 0.08), transparent 50%);
```

**Light**:

```css
background-color: #FAF6EE;
background-image:
  radial-gradient(ellipse 80% 60% at 20% 0%,  rgba(196, 181, 253, 0.35), transparent 65%),
  radial-gradient(ellipse 70% 50% at 85% 100%, rgba(232, 158, 196, 0.35), transparent 55%);
```

(Bottom-right sakura glow alpha bumped from 0.18 to 0.35 so the spring reading registers on cream.)

### Typography scale

| Use | Font | Size | Weight | Tracking |
|---|---|---|---|---|
| Auth hero wordmark | Instrument Serif | 72px | 400 | -0.03em |
| Auth route headline | Instrument Serif | 36px | 400 | -0.02em |
| Admin/settings H1 | Instrument Serif | 36px | 400 | -0.02em |
| Room title | Instrument Serif | 28px | 400 | -0.01em |
| Empty-state tagline | Instrument Serif italic | 22px | 400 | normal |
| Body / message | Inter | 15px | 400 | normal, 1.55 line-height |
| Nav / meta | Inter | 13px | 500 | 0.02em |

### Confidence chip color map

| Range | Label | Background | Text |
|---|---|---|---|
| `conf ≥ 0.8` | `High` | `var(--success)` | `var(--bg-base)` |
| `0.5 ≤ conf < 0.8` | `Med` | `var(--accent)` | `var(--on-accent)` |
| `conf < 0.5` | `Low` | `var(--warn)` | `var(--bg-base)` |
| `conf === undefined` | — | no chip rendered | — |

### Global utilities (added to `globals.css`)

- `.glass-panel` — `backdrop-filter: blur(24px); background: var(--glass-bg); box-shadow: inset 0 1px 0 var(--glass-border), 0 12px 40px rgba(0,0,0,0.25);`
- `.font-display` — maps to `var(--font-display)` (Instrument Serif).
- `.gradient-base` — body background with the two-layer radial gradient.
- `.sakura-drift` — keyframe animation for auth petals.

## 6. Tasks (3-8, each <2h)

1. [ ] **Tokens + fonts foundation**: rewrite `globals.css` with the two-layer token system (brand layer in `:root` + `.dark`, shadcn aliases declared once in `:root` via `var()` chains), drop the hardcoded `--font-sans`, add `next/font` Instrument Serif + Inter in `layout.tsx`, create client-component `ThemeProvider` shim and wrap children, default `dark`. Verify shadcn primitives still render correctly against the new aliases.
2. [ ] **Shadcn primitives**: override `button.tsx` (add `ghost-glass`), `card.tsx` (strip `border`, add `.glass-panel` util; other primitives retain their borders per R5), `input.tsx`/`textarea.tsx` (lavender focus + glass-on-focus).
3. [ ] **Auth split-screen shell**: build `<AuthSplitLayout>` with marketing side + sakura petals animation. Retrofit `/`, `/login`, `/register`, `/forgot-password`, `/reset-password`.
4. [ ] **Chat three-pane + frosted composer**: restructure `/rooms/[roomId]` layout; build `<ChatComposer>` with pin-bottom + gradient fade; add `<ThemeToggle>` to the top bar.
5. [ ] **AI message variant**: extend `ChatMessage` type with optional fields; build `<AIMessageBubble>` with wash + `✦ AI` chip + confidence chip + shimmer-on-streaming. Seed a dev-only fixture to exercise all four visual states (stream/High/Med/Low/no-chip).
6. [ ] **Rooms browse + contacts + empty states**: apply masonry grid, hover lift, sakura empty states.
7. [ ] **Tiered admin + settings restyle**: serif H1s, solid `--bg-elevated` panels, quiet tables.
8. [ ] **Manual QA sweep**: walk every route in both themes on desktop + mobile breakpoints, spot-check contrast, confirm composer fade + streaming shimmer render.

## 7. Out of scope / follow-ups

- Regenerate Playwright screenshot baselines across the new design — separate branch.
- Real producer for `status: "streaming"` and `confidence` on AI messages — later feature, wires into the socket.io event payload.
- System-preference-based auto theme — currently `enableSystem={false}` (default dark); can flip to `true` later if wanted.
- Reduced-motion handling for the `rooms/browse` card hover tilt (R22) — user-initiated motion, safer to defer. Sakura drift (R9) and streaming shimmer (R19) already respect `prefers-reduced-motion` in-scope.
- Accessibility audit beyond contrast + focus-ring checks (screen-reader labels on the theme toggle, ARIA hiding of decorative petals, tab order on the split-screen layout) — follow-up.
- Safari legacy caveat: CSS `columns` children combined with `transform` on hover (R22) can break column flow on Safari < 16. Acceptable for post-hackathon; revisit if baseline support matters.

## 8. Open questions

- [ ] None blocking. (Design approved in brainstorming session 2026-04-20.)
