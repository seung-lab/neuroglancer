# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ZettaAI fork of google/neuroglancer that adds a voxel edit-session layer:
session controls plus per-tool panels (brush, eraser, fill, threshold, z-extrapolation,
correspondence) for editing segmentation layers. Embedded in the Zetta AI portal.
Product context: `PRODUCT.md`; editing-UI visual system: `DESIGN.md`.

Two kinds of code live here:

- **Upstream neuroglancer** — most of `src/`. Refactoring or reorganizing it is fine
  when it serves a better architecture.
- **Zetta-owned** — `src/editing/`, `src/datasource/calcada/`, `tests/editing/`,
  `config/`, and the Zetta markdown docs in `docs/` (`TESTING.md`, …).

Edit-session domain logic (lifecycle, write protocol, undo history) lives in
`@zettaai/edit-session` — a separate repo (`voxel-editor`). This repo hosts and adapts
it (`src/editing/edit_session_host.ts`, `src/editing/adapters/`). Rendering, UI, and
datasource integration belong here; session/write-protocol logic belongs in the library.

## Development Commands

```bash
npm run dev-server        # dev server on http://localhost:3008 (README's 8080 is stale)
npm run build:zetta       # production build WITH the Zetta defines
npm run typecheck         # tsc --noEmit
npm run lint:check        # oxlint AND eslint — both must pass
npm run format:check      # prettier check (format:fix to write)
npm test                  # vitest, all projects (node, jsdom, browser)
npx vitest run <file>     # single test file
npx vitest run -t "name"  # single test by name
npm run e2e / npm run perf  # Playwright; rebuilds the bundle + regenerates fixtures first
```

- `npm i` requires GitHub Packages auth for the `@zettaai` scope (`.npmrc`; token via
  `NODE_AUTH_TOKEN`). Node >= 22.
- `build:zetta` and `dev-server` inject the `STATE_SERVERS` and `CUSTOM_BINDINGS`
  defines from `config/*.json`. Plain `npm run build` omits them: state servers are
  absent and segmentation-tool hotkeys silently require Shift+key.
- CI gate on every PR, in order: `lint:check` → `format:check` → `typecheck` →
  `npm test` → build. Playwright e2e/perf do NOT run in CI — run them locally when
  touching editing code paths.
- e2e/perf fixtures require `uv` (`testdata/editing/generate.py`, served via fake-gcs —
  deterministic, no live `gs://` access).

## Imports and TypeScript

- Relative imports (`./`, `../`) are banned in `src/` (ESLint-enforced). Use the
  `#src/...` aliases from package.json `imports`.
- Type-only imports must use `import type` (enforced).

## UI Architecture

The editing UI establishes the target pattern for ALL UI in this repo:

- **Components** are Preact JSX (`jsxImportSource: "preact"`) — see `src/editing/ui/`.
- **Mount seam**: components mount into upstream neuroglancer through an interop seam,
  not scattered through upstream widget code.
- **Logic** lives in a host layer (e.g. `src/editing/edit_session_host.ts`) or a
  similar seam — components stay presentational.

New features must be written in this approach. Upstream's direct-DOM widget style is
legacy: do not extend it; legacy UI will be migrated to this pattern over time.

## File Structure Rules

These rules apply to all new code and all refactoring.

### Rule 1: Domain-First Structure

Each folder is named after its business responsibility, never its technical role.
`src/editing/` children follow this: `raster/`, `region/`, `cursor/`, `tool_runtimes/`,
`adapters/` — not `components/` or `helpers/`.

### Rule 2: Banned Folder Names

Banned at every nesting level:

> `components/` `hooks/` `types/` `constants/` `helpers/` `utils/` `services/` `contexts/` `actions/`

### Rule 3: Banned File Names

Banned at every nesting level:

> `types.ts` `interfaces.ts` `constants.ts` `helpers.ts` `utils.ts` `reducer.ts` `index.ts` used as an internal barrel

Domain prefix + generic suffix is still banned (`brush_types.ts`, `paint_helpers.ts`).
Types live alongside the logic they describe, or in a file named for what the content
represents.

**Litmus test:** if a file name would make sense in any other project, it is wrong.
`utils.ts` could be anywhere. `patch_texture_cache.ts` could only be here.

### Rule 4: File Naming

Files use `snake_case`, matching the rest of this repo (`edit_session_host.ts`,
`pointer_event_bridge.ts`). The name must answer "what does this do in the domain?" —
never "what is this technically?"

### Rule 5: Decompose, Never Fall Back to Generic Names

If you cannot find a domain-specific name, the grouping is too broad — decompose
further. "I don't know what to call it" is a signal to think harder, never a reason
to use a banned name.

### Rule 6: Shared Code

Code used by one domain stays in that domain, even if it "feels" generic. Promote only
when a second consumer actually exists. Logic that belongs to the edit-session domain
itself goes upstream into `@zettaai/edit-session`, not duplicated here.

## Code Quality Rules

Terse, loop-heavy, manually-indexed code is how this codebase drifts toward
unreadable. Follow these by default.

### CQ1: Names are words, not abbreviations

Every local, parameter, and field is a real word. Whitelist only:
`i`/`j`/`k` (counting loops), `x`/`y`/`z`/`w` (spatial axes, and as suffixes on a
spelled-out stem: `chunkSizeX`), `ctx`, `id`, `fn`, `ok`.

```ts
// Wrong
const [csx, csy, csz] = scale.chunkDataSize;
// Right
const [chunkSizeX, chunkSizeY, chunkSizeZ] = scale.chunkDataSize;
```

### CQ2: Destructure into full names, or don't destructure

`const [sx, sy, sz] = written.size;` → `const [sizeX, sizeY, sizeZ] = written.size;`

### CQ3: Name the arithmetic

Linear-index and stride math never appears inline more than once. Compute it into a
named local or a named helper (`chunkVoxelOffset(...)`, `denseVoxelOffset(...)`).
Magic expressions repeated per loop body are banned.

### CQ4: One level of abstraction per function

A function reads top-to-bottom at a single altitude. Lift nested byte-copy loops into
named steps. For collections prefer `for...of` and array methods over index loops;
index loops are for numeric ranges.

### CQ5: Hot-path numeric kernels are the only exception

Per-voxel/per-byte inner loops on a **measured** hot path may use tight scalars and
manual indexing, if they: (1) are a small single-purpose function, (2) carry a one-line
comment saying they are a hot path and why, (3) still name their inputs per CQ1 at the
boundary. "It felt faster" is not a measurement.

## Editing UI Theming

All editing-UI colors, spacing, and radii come from the `--nge-*` tokens in
`src/editing/ui/editing_theme.css`. No hardcoded values in editing UI styles.
See `DESIGN.md`.

## Testing

The filename decides the runner and tier — never mix:

| Pattern                  | Runner                         |
| ------------------------ | ------------------------------ |
| `*.spec.ts`              | Vitest (node/jsdom)            |
| `*.browser_test.ts`      | Vitest browser (real Chromium) |
| `*.e2e.ts` / `*.perf.ts` | Playwright                     |
| `*.benchmark.ts`         | Vitest bench                   |

Zetta editing suites live in `tests/editing/` (`unit/ integration/ e2e/ perf/ fakes/
harness/`). Read `docs/TESTING.md` before writing tests.

## Repo Etiquette

- Commits: Conventional Commits with the Linear ticket — `type(scope): subject (TM-XXX)`.
  Common scopes: `editing`, `calcada`, `chunk_manager`.
- Branches: `fix/tm-xxx`, `feat/tm-xxx`.
- PRs target `dev`, not `main`. `dev` → `main` promotion is a separate step.
- Never rewrite pushed commits — add follow-up commits instead of amend/rebase/force-push.
