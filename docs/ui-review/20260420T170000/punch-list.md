# UI review — round 2 — 2026-04-20 17:00 PT

Round 2 exploratory pass after the round-1 umbrella (`feat/ui-pass`) landed.
Same rules as round 1: lavender-mist tokens in `globals.css` are off-limits,
no new deps, no pushes, local commits on a new worktree-branch set. All
captures on `feat/ui-pass` @ `a16adb4` against local `pnpm --filter web dev`
on :3000.

Baselines in `before/chrome/`:
- `dark-13-settings-account.png` / `light-13-settings-account.png`
- `dark-15-message-actions.png` / `light-15-message-actions.png`
- `dark-16-create-room.png` / `light-16-create-room.png`
- `dark-17-add-friend.png`
- `dark-18-contacts-incoming.png` (actually Friends empty — tab click didn't land; still a valid empty-state capture)
- `dark-19-contacts-blocked.png`
- `dark-20-manage-room.png` / `light-20-manage-room.png`
- `dark-21-dm-new.png`

Scope was secondary flows + modals not covered in round 1. Firefox skipped
(round-1 confirmed no engine-specific divergence; no need to re-verify).

---

## Findings

### P0 — demo-blocking

**P0-3. `Start a direct message` dialog asks for raw User ID (`usr_…`).**
`apps/web/src/components/chat/RoomClient.tsx` (or a nearby DM-start dialog)
prompts *"Enter a user ID. You must be friends and not blocked."* with a
placeholder of `usr_…`. No autocomplete, no friend picker, no username
search. Judges who find the DM panel will open this dialog and have nothing
to paste — alice/bob/carol don't expose their stable UUIDs in any surface
they can see. A user search is already wired on the backend
(`REQ-UserSearch` per git log). The dialog should accept `@username` or
show a list of friends to pick from. Minimum fix: accept `@username` (or
plain username) as well as `usr_…` ID and resolve server-side. Preferred
fix: replace the input with a combobox backed by `/api/v1/users?q=` +
friend list. Without this, the DM demo path is effectively broken.

**P0-4. Destructive buttons in dark theme ghost out — look disabled at rest.**
Repro:
- `/rooms/general` → Manage room → Members tab → any non-Alice row → the
  `Remove from room` button renders pink-on-pink-translucent. Unclear if
  clickable.
- `/settings/account` dark → the `Delete my account…` button has the same
  rendering (pale rose on dark panel).
Both use `Button variant="destructive"`. The shadcn default
`bg-destructive` resolves fine on the cream light panel but on the
`#1A1428` dark card the red loses saturation and the `disabled:opacity-50`
base rule (inherited even when not disabled if the variant already has low
contrast) flattens it further. The visual read is "disabled" for a button
that is actually live and irreversible. This is the destructive-action
equivalent of the round-1 P1-3 Send-button fix.
Fix: bump the destructive variant's resting background in dark to full
`--destructive` saturation with light foreground; optionally apply the
scoped `disabled:bg-destructive/70 disabled:text-white
disabled:opacity-100` pattern to leave disabled-state readable without
looking active. Scoped to the button (not `globals.css`).

### P1 — perception-breaking

**P1-8. Primary `Button` with `disabled={!value}` ghosts out in both
themes across every modal.** Same root cause as the round-1 composer Send
fix (P1-3), but the fix was applied only to the composer. The pattern
repeats on:
- `/contacts` → Add friend → `Send request` (pale lavender when username
  empty — looks disabled)
- `/rooms/general` → `+ New room` → `Create room` (pale when name empty)
- `/rooms/general` → Direct messages → `+ New` → `Start DM` (pale when
  User ID empty)
One generic fix: apply the P1-3 scoped disabled class
(`disabled:bg-primary/70 disabled:text-primary-foreground
disabled:opacity-100`) to the submit button in each of these dialogs. Or
consolidate into a `<SubmitButton disabled>` helper. Keep the override
local to the buttons, not `button.tsx`.

**P1-9. Message-actions popover (Reply / Delete / ×) is unstyled floating
text.** `apps/web/src/components/chat/MessageActions.tsx` renders three
text links on hover over a message, with no background card, no border,
no shadow. Against the glass-panel chat background the popover reads as
runaway text rather than an action surface. Compared to CreateRoomDialog
and ManageRoomModal — which are polished — this is the least-designed
surface in the app. Fix: wrap the menu in a small popover card
(`bg-popover border border-border rounded-md shadow-md px-2 py-1`, using
existing shadcn tokens), add icons next to Reply (↩) and Delete (🗑),
drop the `×` in favor of blurring-to-close or an Escape handler.
Alternatively swap the whole thing for `DropdownMenu` (shadcn primitive —
used elsewhere? grep first) anchored on the `⋯` trigger.

**P1-10. `/settings/account` panel much wider than its content** — same
class of defect that P2-5 already fixed on `/settings/password`.
`apps/web/src/app/settings/account/page.tsx` uses a full-width glass
panel that leaves ~500px of empty space to the right of every action.
The page has only two tiny actions (Export / Delete) so the empty panel
feels institutional. Fix: narrow to `max-w-2xl` or `max-w-lg`, OR add a
"Danger zone" summary / export history block to the right.

**P1-11. Dark-theme inputs in dialogs/modals still have barely-visible
resting borders.** Round-1 P1-6 fix was explicitly scoped to auth pages.
But the same near-invisible `--glass-border` @ 0.12 bites in:
- CreateRoomDialog → Description textarea
- AddFriendDialog → Message textarea
- Start-DM dialog → User ID input (before focus)
- Any other `<Input>` / `<Textarea>` instance with default styles in
  dark.
Fix (choose one, same decision matrix as P1-6):
- **Option A (low blast radius):** add `dark:border-[rgba(196,181,253,0.22)]`
  to each offending Input/Textarea — matches what auth pages got.
- **Option B (principled):** modify `apps/web/src/components/ui/input.tsx`
  and `textarea.tsx` to bump the default dark border opacity. This is a
  shadcn primitive change and would ripple, but this is the second time
  the issue has appeared — probably the right place. Flag loudly in
  commit body.
Prefer B this round — the pattern has recurred, and the globals tokens
are off-limits so the primitive is the next-cleanest lever.

### P2 — polish

**P2-7. CreateRoomDialog uses native OS `<input type="radio">` for the
Public/Private visibility choice.** In light theme the selected radio is
system blue, which clashes with the lavender primary. In dark the
unselected radio has a harsh white border ring. Swap to the shadcn
`RadioGroup` primitive (check `apps/web/src/components/ui/` for
radio-group.tsx — it may already be there from a prior add). Takes the
form from "HTML form from 2002" to "designed".

**P2-8. ManageRoomModal → Members tab → `Ban` is visually indistinct
from `Make admin`.** Both look like identical secondary buttons
side-by-side but one is benign (elevate) and one is serious (exile).
No visual hierarchy difference — relies entirely on the user reading the
label. Fix: render `Ban` with a red text color or a destructive-outline
variant (red border, transparent bg, red text on hover fill). Keep
`Make admin` as default secondary.

**P2-9. Members table in ManageRoomModal only shows the Owner role for
Alice — the `ROLE` column is empty for every other row.** Other members
have no role badge (they're "member" but nothing renders). Either hide
the ROLE column when there's nothing to show, or render a muted
`Member` pill so the column carries its weight.

**P2-10. Member list in the right sidebar shows every user as "offline"
including Alice herself** (who is clearly online per the header pill).
This is the round-1 P1-7 bug still outstanding — the fix was deferred
with a TODO. Flagging here again to keep it on the radar; not a new
finding, just a continued-stale data-layer issue.

**P2-11. `Sent` + `Incoming` + `Blocked` tab headers in `/contacts`
don't show a count badge.** With no counts it's not obvious whether
there's anything to click into. Add a small `PendingBadge` (already
exists at `apps/web/src/components/contacts/PendingBadge.tsx`) to the
`Incoming` tab when `incomingCount > 0`. Low-hanging fruit.

### P3 — observational

- "Static route" indicator from Next.js dev mode appears in every
  screenshot bottom-left. It's dev-only, strips in prod build — not a
  real finding, just noting so future review passes don't chase it.
- The × close control inside the MessageActions popover is a typography
  glyph, not a styled button. Semantically it's a button with `aria`
  label, so a11y is fine, but visually it's the smallest tap target on
  the page.

---

## Tokens / primitives touched (flagging, not changing)

- `apps/web/src/components/ui/button.tsx` — destructive variant is a
  likely target for **P0-4**. Prefer a scoped className override on the
  individual destructive button if feasible; otherwise modifying the
  variant's `dark:` rule is acceptable with a commit-body note.
- `apps/web/src/components/ui/input.tsx` + `textarea.tsx` — target for
  **P1-11 Option B**. This would be the first primitive-level change of
  the UI pass. Worth doing if approved.
- `apps/web/src/components/ui/radio-group.tsx` — **P2-7** needs this
  primitive. Confirm it's present; if not, scope creep — fall back to
  styled native radios.
- No proposed changes to `globals.css` tokens.

---

## Recommended next step

If approved, attack **P0-3 first** (DM user-ID prompt). It's the single
demo-blocking usability issue — every other P0/P1 is visual polish.
Minimum viable: accept `@username` in the existing input and resolve
server-side. Full fix: combobox with friend list.

Then **P0-4** + **P1-8** as one concern group ("make the primary and
destructive buttons look live when they're live") — same class of fix,
same files, one parallel agent.

**P1-9** (message actions popover) and **P1-11** (dark dialog input
borders) are independent; run in parallel worktrees.

P2s can wait or ride along with agents already touching the same files.
