# UI review — 2026-04-20 16:04 PT

Baseline captured on `feat/ui-pass-baseline` off `AI-dev`. Lavender-mist theme
is the shipped baseline and is not a redesign target; this list only calls out
items that weaken the aesthetic or usability.

Baseline shots:
- `before/chrome/` — 12 surfaces × 2 themes (Chromium, 1440×900)
- `before/firefox/` — 12 surfaces × 2 themes (Firefox 148, 1440×900)

Firefox and Chromium render consistently across the set — no engine-specific
regressions. All items below apply to both unless noted.

---

## Surfaces reviewed

| # | Path | Current state |
| - | ---- | ------------- |
| 01 | `/login` | Split hero (serif wordmark) + right-side card. Strong identity; input borders almost invisible in dark. |
| 02 | `/register` | Same hero pattern, 5-field card. Tagline *Start herding ideas.* is charming. |
| 03 | `/forgot-password` | *Recover your space.* — clean. |
| 04 | `/reset-password` | *Set a new key.* — clean; help text tiny. |
| 05 | `/rooms` (empty) | Three empty panels + italic *Pick a room to start reading.* — feels thin. |
| 06 | `/rooms/[roomId]` | Timeline/composer/member-list triptych. Dense and functional, lots of small polish opportunities. |
| 07 | `/rooms/browse` | Card grid. Open/Join buttons are visually unequal; hierarchy confuses. |
| 08 | `/contacts` (DM surface) | Nice empty state (pastel star), tabs, solid purple *Add friend* CTA. |
| 09 | `/settings/sessions` | Functional table; loose spacing, locale-y dates. |
| 10 | `/settings/password` | Clean form; container is wider than the inputs it holds. |
| 11 | `/admin` | Widget grid. **Missing the app header entirely.** |
| 12 | `/admin/federation` | Status cards. **Missing header; big stat values nearly invisible in light theme.** |

---

## Punch list (prioritized)

### P0 — demo-blocking / regressions

**P0-1. `/admin` and `/admin/federation` render without the app header.**
Navigating to either admin page drops the `Header` component (Rooms / Contacts
nav, presence, theme toggle, sign-out). Judges land on /admin and have no
obvious way back. Fix: add `apps/web/src/app/admin/layout.tsx` that wraps
children in `<Header />` (same pattern as `/rooms/page.tsx`).

**P0-2. `/admin/federation` stat values fail contrast in light theme.**
`Inbound s2s`/`Outbound s2s` values ("0") and `Last handshake` ("never") render
in `text-muted-foreground` (`--text-lo` = `#6B6283`) against the cream panel at
large display weight. Looks ghosted — reads as "nothing here" rather than a
live metric. Fix: promote these values to `text-foreground` and keep the
`muted` color for labels only. Same class of fix on `/admin` for secondary
widget descriptions.

### P1 — polish that meaningfully improves perception

**P1-1. Header height/alignment: `ThemeToggle` is `size="icon"` (h-10) but
every sibling action in the authenticated header is `size="sm"` (h-9).**
The row visibly steps up at the toggle. Fix: pass `size="sm"` to `ThemeToggle`
or tighten the button-variant `size` table to match.

**P1-2. Header text links (`Password` / `Sessions` / `Account`) read as body
copy, not actions.** All three use `variant="ghost"` which has no background
and no border at rest; visually they line up with the display name. Adjacent
`Sign out` (outline) pops, creating a weird hierarchy where the destructive
action is the most obvious control. Fix: either collapse the three into a
single "Account ▾" dropdown, or give them a faint resting border/underline so
they read as interactive.

**P1-3. Disabled `Send` button disappears in light theme.**
`variant="default" + disabled:opacity-50` over the `glass-panel` composer
becomes pale-lavender-on-lavender. The empty-input state (which is what
judges will see first) reads as "no send button." Fix: keep the Send button
at full foreground contrast when disabled (e.g. override
`disabled:bg-primary/60 disabled:text-primary-foreground` on the composer
send only), or swap the resting treatment to a bordered outline button.

**P1-4. `/rooms` empty state is three blank panels and a tagline.**
Huge, dominant glass rectangles surrounding a ten-word italic. First
impression of the main app is "broken." Fix (minimum): centre a proper empty
state in the main pane — short heading, pointer to "Browse rooms →", and a
second line offering "or send a DM". Left sidebar already has a Browse button
— lean on it.

**P1-5. Member list "Add friend" buttons are visually dominant.**
Five full-size buttons with icons stack next to five tiny avatars; the CTA
outweighs the people. Fix: compact icon-only variant (reveal on row hover),
or move the CTA into a `⋯` menu on the row.

**P1-6. Input borders are barely visible in dark theme on the auth pages.**
The email/password/username inputs render as dark-on-darker with
`--glass-border` at ~0.12 opacity. Empty fields look like flat panels until
focus. Fix: bump resting input border to `--glass-border` at ~0.22 (matches
the glass-panel inset), or add a subtle inner shadow on the input.

**P1-7. `Alice (offline)` in the members list while the header pill shows
online/active.** Internal inconsistency — one surface reads presence from
one source, the other falls back to "offline". Needs data-layer fix, but the
visible symptom is the member-list pill. Flag for investigation.

### P2 — nice-to-have

**P2-1. `/rooms/browse` — `Open` (ghost) and `Join` (solid primary) are
visually unequal for equal-weight actions.** "Open" is the safer path for
rooms you already belong to but reads as a tertiary link. Fix: same resting
variant, differentiate by label or icon only.

**P2-2. Message grouping.** The timeline renders a full
avatar/name/timestamp header for every message including consecutive ones
from the same author. Standard chat convention groups same-author bursts.
Lighter perceived density with no information lost.

**P2-3. `/settings/sessions` table spacing.** Columns stretch across the
whole panel, leaving awkward gaps. Either shrink the panel to ~800px wide or
collapse `Last active`/`Created` into stacked relative labels.

**P2-4. Session dates use raw `toLocaleString`.** `4/20/2026, 4:06:27 PM`
is accurate but unfriendly. `Last active` should be relative ("just now", "2
minutes ago"), `Created` absolute and short.

**P2-5. `/settings/password` container is wider than its form.**
Inputs cap at ~430px but the glass panel fills to ~800px, creating a sea of
empty panel to the right of each field. Either narrow the panel or add
right-side context (password strength meter, session-revoke summary).

**P2-6. Hierarchy on the login card — "Forgot password?" sits inside the
password field's help-text slot; `Create one` sits in a footer paragraph
below the CTA.** Both are navigational escapes, but they're styled
differently. Align them into one "need help" row under the submit.

### P3 — observational (no action proposed)

- Sakura petals cluster at the top edge on initial screenshot frame — this
  is the `@keyframes sakura-drift` entry state, not a bug. In normal
  browsing the staggered drift looks fine. Worth noting so future screenshot
  runs don't chase it.
- Instrument Serif display headlines are a strong, memorable choice. Do not
  change. (Noted as the thing worth protecting across any refactor here.)
- Glass-panel backdrop-filter blur is honored in both Chromium and Firefox;
  no fallback needed.

---

## Tokens flagged (not touched)

Per brief, `globals.css` tokens are not to be redefined in this pass. Items
that could eventually be addressed at the token layer instead of inline:

- `--glass-border` in dark (`rgba(196, 181, 253, 0.12)`) is genuinely too low
  for resting input borders — consider ~`0.22` to match the inset shadow
  value already used on `.glass-panel`.
- Light-theme `--text-lo` (`#6B6283`) is fine for body but not for display
  numerics. A future token could introduce `--text-mi` between `hi` and
  `lo` so admin/metric surfaces can climb one step without jumping to full
  `--text-hi`.

Flagging here, not silently changing.

---

## Recommended next step

Attack **P0-1 first** (admin layout). It's one new file, zero token churn,
and it unblocks any judge walking the authenticated surfaces top-to-bottom.
Then **P0-2** (federation contrast) because it's literally unreadable in
light. After those two, pause and re-screenshot — those two alone change the
read of the admin surface substantially, and the remaining P1s are
independent.

After P0, the highest-leverage P1 batch is `P1-1` + `P1-2` + `P1-3` —
they're all header/composer polish that a judge sees every single page and
they share a common theme ("make the interactive things look interactive
in both modes").
