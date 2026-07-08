# Design

Visual system for the **edit-session UI** (topbar + tool panels) in
`zettaai-neuroglancer`. It does not redefine Neuroglancer's own viewer styling;
it governs the Zetta editing additions and is implemented as a token layer in
`src/editing/ui/editing_theme.css` (`--nge-*` custom properties on `:root`).

## Theme

Dark, to sit inside Neuroglancer's viewer chrome. A single accent blue carries
selection, focus, and active states; everything else is a neutral grey ramp.
Strategy: **Restrained** — tinted-neutral surfaces plus one accent.

## Color

Values are hex (the surrounding codebase and Neuroglancer are hex; exact
chrome-match beats perceptual-space novelty here). Defined once as tokens.

| Role                      | Token                                  | Value                             |
| ------------------------- | -------------------------------------- | --------------------------------- |
| Control surface           | `--nge-control-bg`                     | `#26282c`                         |
| Control/ghost hover       | `--nge-control-bg-hover`               | `#34373d`                         |
| Inert surface             | `--nge-control-bg-inert`               | `#202225`                         |
| Slider rail               | `--nge-rail`                           | `#3a3f4b`                         |
| Overlay bg (modal/dialog) | `--nge-overlay-bg`                     | `#1a1a1a`                         |
| Overlay bg elevated       | `--nge-overlay-bg-elev`                | `#232323`                         |
| Overlay border            | `--nge-overlay-border`                 | `#3a3a3a`                         |
| Overlay border soft       | `--nge-overlay-border-soft`            | `#2a2a2a`                         |
| Border                    | `--nge-border`                         | `#3a3d43`                         |
| Border (strong)           | `--nge-border-strong`                  | `#4a4e55`                         |
| Divider                   | `--nge-divider`                        | `#2f2f2f`                         |
| Text (primary)            | `--nge-text`                           | `#e6e8ec`                         |
| Text (label)              | `--nge-text-muted`                     | `#cfd3da`                         |
| Text (help/secondary)     | `--nge-text-subtle`                    | `#aab1bb`                         |
| Text (faint/mono)         | `--nge-text-faint`                     | `#8b929c`                         |
| Accent                    | `--nge-accent`                         | `#3b82f6`                         |
| Accent hover              | `--nge-accent-hover`                   | `#5a96f8`                         |
| Accent tint (active bg)   | `--nge-accent-tint`                    | `#2c3a5a`                         |
| Accent fg on tint (icon)  | `--nge-accent-fg-soft`                 | `#9cc3ff`                         |
| Accent border (active)    | `--nge-accent-border`                  | `#6fa8ff`                         |
| Accent strong (white-fg)  | `--nge-accent-strong`                  | `#2563eb`                         |
| Accent strong hover       | `--nge-accent-strong-hover`            | `#1d4ed8`                         |
| Accent fg (on fill)       | `--nge-accent-fg`                      | `#ffffff`                         |
| Focus ring                | `--nge-accent-ring`                    | `#93c5fd`                         |
| Danger (inline text)      | `--nge-danger`                         | `#f56565`                         |
| Danger bg                 | `--nge-danger-bg`                      | `rgba(245,101,101,.12)`           |
| Danger strong (white-fg)  | `--nge-danger-strong`                  | `#dc2626`                         |
| Danger strong hover       | `--nge-danger-strong-hover`            | `#b91c1c`                         |
| Warning (badge)           | `--nge-warning`                        | `#d97706`                         |
| Warning surface           | `--nge-warning-bg` / `-border` / `-fg` | `#4a3a1c` / `#8a6a2a` / `#ffd591` |

The accent set is one deliberate blue ramp with distinct roles (base, hover,
tint, on-tint icon, active border, focus ring), replacing the near-duplicate
blues that were scattered one-off across the old stylesheets. Help/secondary
text was lifted from `#9ca3af`/`#8b929c` to `#aab1bb` to clear AA on the dark
panel.

**`-strong` steps carry white text.** The base `--nge-accent` (`#3b82f6`) is for
borders, tints, and focus rings (UI-component contrast, 3:1); a white label on
it only reaches ~3.3:1. Filled buttons with white labels (primary modal/dialog
actions) use `--nge-accent-strong` (5.17:1) instead. Likewise `--nge-danger` is
a light red for inline error text and borders on the dark panels (4.9:1 as text
on the lightest control surface), where white-on-fill would fail; destructive
**filled** buttons use `--nge-danger-strong` (`#dc2626`, 4.83:1). Both `-strong`
ramps were promoted out of the confirm dialog's old private palette so the
dialog, the session-entry modal, and the panels share one source.

**One error red.** Danger is a single red hue family: `--nge-danger` (`#f56565`)
for inline text/borders/focus on dark, `--nge-danger-strong` (`#dc2626`) for
white-on-fill. The earlier coral (`#f0795a`) inline tone was retired so error
means red everywhere; the memory meter's over-budget color aliases to
`--nge-danger` (it was already that red), unifying panels, modal, and dialog.

**Overlay surfaces** (`--nge-overlay-bg` / `-bg-elev` / `-border` / `-border-soft`)
are the floating-dialog ramp, intentionally darker than the inline control
surfaces. The confirm dialog and the session-entry modal both consume them, so
the two read as one system.

## Typography

One family — a system UI stack (`--nge-font`: `system-ui, -apple-system,
"Segoe UI", Roboto, ...`), replacing the generic `sans-serif` default — plus a
mono stack (`--nge-font-mono`) for resolution/ID readouts. Sizes: `12px` body
(`--nge-text-size`), `11px` secondary (`--nge-text-size-sm`), `10px` uppercase
unit labels. No display fonts; product UI needs none.

## Spacing & Radius

- Spacing scale: `--nge-space-1..6` = `4 / 6 / 8 / 10 / 12 / 16 px`.
- Radius: `--nge-radius-sm` `4px`, `--nge-radius-md` `6px`,
  `--nge-radius-pill` `999px`.

## Control height ladder

A deliberate three-step ladder keyed to surface density, all tokenized so the
topbar and dialog can no longer drift off on hardcoded values:

- `--nge-control-h-compact` `24px` — dense topbar row controls.
- `--nge-control-h` `28px` — panel inputs, selects, buttons (the default).
- `--nge-control-h-lg` `32px` — prominent modal/dialog action buttons.

## Components

- **Parameter row** (`.neuroglancer-tool-panel-row`): label left, control
  right-aligned to a shared edge. Control box: `28px` tall, `120px` wide,
  `--nge-control-bg` on `--nge-border`.
- **Inputs / selects**: one hover (border-strong) and one focus treatment
  (accent ring + accent border). Native widget chrome rendered dark via
  `color-scheme: dark`.
- **Sliders**: one visual language everywhere — a `5px` rail with a `16px`
  white thumb ringed in accent. The Brush "Size" range and the dual-handle
  Threshold now match.
- **Toggle** (`role="switch"`): `38×20` pill, accent when on.
- **Validation**: invalid inputs get `aria-invalid` → danger border + tinted
  fill, with an inline `role="alert"` message; the typed value is preserved,
  never reverted. See the draft pattern below.

## Numeric & text input — the draft pattern

Every editable numeric/text field uses the **draft pattern**, implemented once
in the canonical component `ParamInput`
(`src/editing/ui/tool_settings/param_input.tsx`). The rule:

- **While the field is focused, the user owns the text.** Never block a
  keystroke, never reformat, never revert. Empty and intermediate strings —
  including a bare `0` — are always allowed so the user can clear the field and
  retype from scratch.
- **Validate visually only while typing** (`aria-invalid`); never mutate the
  value.
- **Parse / clamp / normalise and commit on blur or Enter** — never
  per-keystroke. All clamping (odd-snapping a brush size, `≥ 0`, range limits)
  lives in the caller's `parse`, so it runs on commit only. An invalid or empty
  field restores the last committed value on blur, never leaving a broken state.
- **The sync from external state into the draft is focus-guarded**
  (`document.activeElement !== input`). This is non-negotiable: the panels
  re-render constantly, and without the guard those re-renders overwrite the
  draft mid-edit — the original "can't clear the input / can't type 0" bug.

Do **not** bind a control directly to a parsed number and clamp/revert in
`onChange`; that is exactly the anti-pattern `ParamInput` replaces. New numeric
or free-entry inputs must use `ParamInput` (supplying a `parse`), not a raw
`<input>`.

## Layout

Panels are fixed-width side panels (`min-width: 240px`) mounted by
Neuroglancer's `SidePanelManager`. Rows stack vertically; the Brush "Advanced"
mask section is an indented nested group revealed by its toggle.

## Layout stability

The UI is static in place: elements never move, resize, or push their
neighbors on a state change unless the movement itself carries meaning.
State renders into reserved space:

- A button that gains a spinner (e.g. Save while saving) keeps its
  dimensions — the spinner's box is reserved up front, the button never
  grows and never pushes the adjacent button.
- Status icons (e.g. "loaded") occupy a fixed slot; they toggle via
  visibility/opacity, not by inserting into the flow and shifting siblings.
- Swapping content in place (label ↔ spinner, icon ↔ icon) happens inside a
  fixed-size container.

## Motion

`--nge-transition: 150ms ease` on color/background/transform only. Every
transition has a `prefers-reduced-motion: reduce` fallback. No page-load
choreography; motion conveys state, nothing else.

## Coverage

Tokenized: the tool panels (Brush/Eraser/Fill) and their shared controls, the
dual-handle threshold, the toggle switch, the fast-tooltip, and the editing
**topbar** (`editing_topbar.css`) — buttons, tool/history icons, the Save-all
button + unsaved badge, the saving state, and the Edit/Exit anchor. The topbar
also gained a visible `:focus-visible` ring on every button (previously none)
and hover transitions.

The **confirm dialog** and the **session-entry modal** are now on the shared
tokens too: the dialog consumes `--nge-*` directly (its private
`--neuroglancer-confirm-*` palette is gone), and the modal keeps its local token
names but sources the shared roles (accent, the `-strong` steps, overlay
surfaces, primary/faint text) from `--nge-*` with the prior literals as
fallbacks. Both import `editing_theme.css` as a side effect so the `:root`
tokens are present even when no panel is mounted.

## Known follow-ups (deliberately out of current scope)

- Brush/Eraser/Fill remain three panels; a unified panel with a tool switch and
  grouped "Target"/"Settings" sections was considered and deferred.
- A few one-off values remain un-tokenized (fast-tooltip bg/fg, slider-thumb
  fill + shadow, the topbar unsaved-badge font size).
