# Design

Visual system for the **edit-session UI** (topbar + tool panels) in
`neuroglancer-calcada`. It does not redefine Neuroglancer's own viewer styling;
it governs the Calcada editing additions and is implemented as a token layer in
`src/editing/ui/editing_theme.css` (`--nge-*` custom properties on `:root`).

## Theme

Dark, to sit inside Neuroglancer's viewer chrome. A single accent blue carries
selection, focus, and active states; everything else is a neutral grey ramp.
Strategy: **Restrained** — tinted-neutral surfaces plus one accent.

## Color

Values are hex (the surrounding codebase and Neuroglancer are hex; exact
chrome-match beats perceptual-space novelty here). Defined once as tokens.

| Role                      | Token                    | Value                  |
| ------------------------- | ------------------------ | ---------------------- |
| Control surface           | `--nge-control-bg`       | `#26282c`              |
| Control hover             | `--nge-control-bg-hover` | `#2f3137`              |
| Inert surface             | `--nge-control-bg-inert` | `#202225`              |
| Slider rail               | `--nge-rail`             | `#3a3f4b`              |
| Border                    | `--nge-border`           | `#3a3d43`              |
| Border (strong)           | `--nge-border-strong`    | `#4a4e55`              |
| Divider                   | `--nge-divider`          | `#2f2f2f`              |
| Text (primary)            | `--nge-text`             | `#e6e8ec`              |
| Text (label)              | `--nge-text-muted`       | `#cfd3da`              |
| Text (help/secondary)     | `--nge-text-subtle`      | `#aab1bb`              |
| Text (faint/mono)         | `--nge-text-faint`       | `#8b929c`              |
| Accent                    | `--nge-accent`           | `#3b82f6`              |
| Accent hover              | `--nge-accent-hover`     | `#5a96f8`              |
| Accent tint (selected bg) | `--nge-accent-tint`      | `#2c3a5a`              |
| Focus ring                | `--nge-accent-ring`      | `#93c5fd`              |
| Danger                    | `--nge-danger`           | `#f0795a`              |
| Danger bg                 | `--nge-danger-bg`        | `rgba(240,121,90,.12)` |

The accent ramp replaces four near-duplicate blues that were scattered across
the old stylesheets. Help/secondary text was lifted from `#9ca3af`/`#8b929c` to
`#aab1bb` to clear AA on the dark panel.

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
  never reverted.

## Layout

Panels are fixed-width side panels (`min-width: 240px`) mounted by
Neuroglancer's `SidePanelManager`. Rows stack vertically; the Brush "Advanced"
mask section is an indented nested group revealed by its toggle.

## Motion

`--nge-transition: 150ms ease` on color/background/transform only. Every
transition has a `prefers-reduced-motion: reduce` fallback. No page-load
choreography; motion conveys state, nothing else.

## Known follow-ups (deliberately out of current scope)

- Topbar (`editing_topbar.css`) still uses hardcoded colors; migrate it onto
  the same tokens.
- Brush/Eraser/Fill remain three panels; a unified panel with a tool switch and
  grouped "Target"/"Settings" sections was considered and deferred.
