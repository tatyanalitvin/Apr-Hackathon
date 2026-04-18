# Design system — fill this in on day 0

> Copy one column from the table in `.claude/skills/ui-design/SKILL.md` and commit to it.

## Direction

<!-- e.g. "Technical — Geist Mono + Inter, zinc neutrals, single accent = cyan-500" -->

## Type scale

- Display: `text-5xl font-semibold tracking-tight`
- H1: `text-3xl font-semibold`
- H2: `text-xl font-medium`
- Body: `text-base leading-relaxed`
- Small: `text-sm text-muted-foreground`

## Spacing rhythm

- Between sections: `py-16 md:py-24`
- Between cards: `gap-6`
- Inside cards: `p-6`

## Color tokens (do not use raw hex in components)

- Primary: `<pick one>` (e.g. `cyan-500`)
- Accent: `<pick one>`
- Destructive: `red-500`
- Background: `zinc-50` / `zinc-950` (dark)
- Text: `zinc-900` / `zinc-50`

## Motion

- Standard: `transition-colors duration-150`
- Emphasis: `transition-all duration-300 ease-out`
- No auto-playing animations > 1s.

## Accessibility floor

- Keyboard reachable everywhere.
- Focus rings visible (`focus-visible:ring-2 focus-visible:ring-primary`).
- Contrast ≥ 4.5:1 on body, 3:1 on large text.
- Every icon-only button has `aria-label`.
