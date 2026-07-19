# Design — theme "Sage"

The visual system for Flâneur, written down so a second theme is a variable
swap rather than a rewrite. Everything lives in `app/globals.css`.

Derived from a pair of editorial newsletter templates the user supplied: warm
paper, sage green, a high-contrast display serif, tiny wide-tracked uppercase
labels, dark pill buttons, hairline rules, and an arch motif.

---

## Tokens

All in `:root`. **A new theme should only need to redefine these.**

| Token | Sage | Role |
|---|---|---|
| `--bg` | `#ece8dd` | page, warm paper |
| `--surface` | `#fbf9f4` | cards |
| `--ink` | `#1f1e1b` | text, and the button fill |
| `--ink-soft` | `#605c53` | body copy, secondary |
| `--ink-faint` | `#928d82` | meta, inactive tabs |
| `--line` | `#dcd6c6` | hairlines, card borders |
| `--line-strong` | `#c3bda9` | tab bar top, quiet button borders |
| `--accent` | `#7c8065` | sage: active tab, focus, meter |
| `--accent-deep` | `#5f6350` | links (darker, for contrast on paper) |
| `--accent-wash` | `rgba(124,128,101,.12)` | selected background |
| `--sage-tint` | `#dfe0d2` | the camera arch |
| `--blush` | `#e0bfad` | warm highlight, currently unused |
| `--on-ink` | `#f7f5ef` | text ON the dark pill |
| `--good/--warn/--bad` | greens/ambers/reds | verdict text |
| `--good-bg/-line` etc. | tints | verdict chips, warnings |
| `--radius` | `6px` | cards — nearly square, editorial |
| `--radius-pill` | `999px` | buttons |
| `--display` | `"Didot", …` | display serif |

**Deliberately NOT tokenised:** the cropper and lightbox chrome is hard `#000` /
`#fff`. A photo viewer should be black in every theme — tinting it would put a
colour cast next to the photo being judged.

---

## Type

- **Display serif** (`--display`) for `h1/h2/h3` only. Didot leads the stack
  because it ships on iOS and macOS and is the face the reference uses.
- **Sans for body**, at ordinary sizes. The references set everything in serif;
  this app is used one-handed in a shop, and misreading a price is the failure
  it exists to prevent — including its own type.
- **The label**: `text-transform: uppercase`, `letter-spacing: .14em`,
  `.62rem`, weight 600. Applied by selector to `.field span`, `.usage-table th`,
  `.cropper-title`, `.verdict-label`.
- `.masthead p` is the same idea at `.18em` — the standfirst under the title.
- **Card body copy is `.88rem` and `--ink-soft`.** At the browser default it
  out-shouted the headings it was explaining.

## Shape

- Cards nearly square (`6px`), hairline border, almost no shadow.
- Buttons are **pills**, near-black, tracked uppercase.
  - Black rather than sage on purpose: on a sage-and-cream page the darkest
    element is where the eye goes, and that should be the action, not the
    chrome. Sage carries *state*, where it does not compete.
  - `.btn.block.alt` drops the uppercase tracking — long labels like "Undo crop
    — pick a different product" are unreadable as tracked caps on a phone.
- **The arch** is the motif: the camera button, `.preview`, and list thumbnails
  all use `999px 999px r r`.
  - The camera glyph is nudged *below* centre (`padding-top`). An arch carries
    its weight in the dome, so a box-centred glyph reads as riding high.
  - Padding moves the glyph by **half** its value — it shrinks the box the glyph
    is centred in. `8px` of padding is a `4px` drop.

---

## Adding a second theme

The CSS is ready for it; the app is not wired for switching yet. Shortest path:

1. Move the `:root` block to `:root, [data-theme="sage"]`.
2. Add `[data-theme="<name>"] { … }` redefining the tokens above.
3. Set `data-theme` on `<html>` in `app/layout.tsx`, from a stored preference.
4. Persist the choice in `user_settings` (the table already exists and takes an
   arbitrary jsonb blob, so no migration).
5. Update `themeColor` in `layout.tsx` per theme, or it will not match on the
   iOS Home Screen.

**What a new theme cannot change by tokens alone**, because it is structural:
the arch radii, the uppercase tracking, and the serif/sans split. A theme that
wants soft rounded cards and no arches is a second set of rules, not a palette.

**Check contrast when swapping.** `--ink-faint` on `--bg` is the weakest pair in
this theme and is already close to the floor for small text; a lighter
background will push it under.
