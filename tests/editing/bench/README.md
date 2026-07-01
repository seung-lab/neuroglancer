# Edit-session paint benchmark

A Playwright benchmark that drives a real edit session in the built app and
sweeps brush sizes for three cases — **masked brush** (threshold + morphology),
**unmasked brush**, **eraser** — measuring per-size cost from `__paintProfiler`.

Runs against the **local fake-gcs fixtures** (TM-331) — no live `gs://`, no auth,
reproducible. Shares its boot path (`fixtures → fake-gcs → route-rewrite →
buildNgState → warmup`) with the correctness suite via
`tests/editing/harness/e2e_setup.ts`; the perf scenario is defined in
`edit_paint_bench.spec.ts` (`PERF_SCENARIO`) on the large `perf_*` fixtures
(2048², room for the radius-up-to-512 sweep). Generate first:
`uv run testdata/editing/generate.py`.

## Run

Portal-style variants (mirror `test:e2e` / `:headed` / `:ui`):

```bash
npm run bench:paint          # headless (fast, CI) — build + run
npm run bench:paint:headed   # REAL browser window — captures the ④ RENDER phase
npm run bench:paint:ui       # Playwright UI mode (inspect/step the run)
npm run bench:paint:run      # skip the build (dist/client already fresh)
```

Each `{case × brush size}` is its **own test** — a tree in the UI
(`masked-brush › brush 1025`, `unmasked-brush › brush 5`, …), runnable and
inspectable individually, with the full sectioned `__paintProfiler` block
attached to each. The expensive setup (load · session · pyodide boot · chunk
warmup) runs **once per worker** in `beforeAll`; every test then drives a single
stroke on the shared page.

**Use `:headed` for fully-real numbers.** Headless chromium does not run the
render loop, so `frameDraw` / `gpu.upload` / `mirror.fuse` (the ④ RENDER phase
and render-driven commit costs) are absent — only a headed (visible) browser
draws frames. The `0.stroke(total)` span is also gone on the newer `worker-mask`
masked path (so ⑤ SPANS shows only `handleInput`) — that matches the real
profiler.

Before measuring, the harness **warms the data** (8 max-radius stamps across the
band) so the target/image chunks are resident and pyodide is booted. Otherwise
the first measured segment pays a cold `chunkRead`, which — longer than the move
pacing — makes `latestWins` drop every other move and collapse the stroke to ONE
segment (no per-segment numbers).

`bench:paint` **builds the prod bundle** (`build:zetta`), then Playwright starts
a **fresh static server** (`serve_dist.mjs`, port 9777, `reuseExistingServer:
false`) that serves `dist/client` with `COOP: same-origin` + `COEP:
require-corp` → `crossOriginIsolated` → SAB + self-hosted pyodide. **No webpack
dev-server / no HMR**, so the page never recompiles or reloads mid-run (the
stale-bundle / mid-stroke-reload problem the dev-server had). The spec boots a
`fake-gcs-server` over the generated fixtures and route-rewrites
`storage.googleapis.com` onto it, so `buildNgState`'s `precomputed://gs://…`
sources resolve locally.

Output: a table in stdout + `test-results/edit_paint_bench.json`.

Needs the **generated fixtures** (`uv run testdata/editing/generate.py`) +
WebGL2. Benchmark, **not a gating test** (perf-regression baseline comparison is
TM-331 Phase 3). Rebuild (`npm run bench:paint`, or `npm run bench:paint:build`)
after changing any `src/` used by the harness — the static server serves the
built bundle, not live source.

## Pieces

- `src/editing/tool_runtimes/paint_profiler.ts` — `snapshot()` / `resetWindow()`
  (reusable; read live buckets without printing). ✅ unit-verified.
- `src/editing/benchmarks/edit_paint_bench.ts` — in-app harness, attached as
  `window.__editPaintBench(opts?)`. Drives synthetic pointer strokes on the slice
  canvas through the full stack (scheduler → pyodide → commit → GPU).
- `tests/editing/bench/edit_paint_bench.spec.ts` — the Playwright runner (state
  URL, waits, table + JSON).
- `playwright.bench.config.ts` — dev-server `webServer` + headless WebGL flags.

## `// TUNE:` points (need a live dev-server + GPU to dial in)

The end-to-end run cannot be executed/verified offline. Expect to adjust:

1. **Fixtures generated** — `uv run testdata/editing/generate.py` must have run so
   the `perf_*` buckets exist and fake-gcs can serve them. If a layer doesn't
   load, the session won't auto-open and the harness fast-fails with a clear
   message. (No `gs://` auth is needed — the data is local.)
2. **WebGL flags** (`playwright.bench.config.ts`) if the canvas stays black /
   WebGL2 is unavailable in your headless chromium.
3. **`findDispatchTarget` / `dispatchStroke`** — selector + pointer mapping if
   strokes don't register. The stroke is a **long swept drag** (a sine zigzag
   across ~76% of the panel, `strokePoints` samples paced `strokeStepMs` apart)
   so it covers FRESH chunks and generates many segments — reproducing real
   apply/commit cost + sustained pyodide load. A tiny stationary wiggle
   under-measured `writeRegion` (~0 vs ~25 ms/seg) and the worker compute (heap
   not under pressure). Tune `strokePoints` (default 40) / `strokeStepMs`
   (default 80, ≈ worker round-trip) via the step options.
4. **`waitForSettle` / `renderFramesAfterStroke` / `warmupMs`** — increase if the
   worker round-trip / commit / GPU upload / pyodide boot need longer.

Each cell now drives a multi-second drag (≈ `strokePoints × strokeStepMs`), so
the full 18-cell sweep takes a few minutes — the per-test timeout in
`playwright.bench.config.ts` is 10 min.

The session, brush + mask preset (threshold 99–160, closing 1, minSize 32,
radius 512) come straight from the ngState's `editSession` block — no manual
session construction.

## A/B with the scheduler

The harness honors `window.__paintScheduler.mode` (`latestWins` default vs
`coalesce`). To compare, set it from the spec via `page.evaluate` before the
sweep, or run twice. `latestWins` should keep per-stroke `maskBuild` bounded as
size grows; `coalesce` reproduces the unbounded swept-capsule cost.

## Correctness read-back (TM-331, phase 2)

Beyond the perf sweep, the harness can read back **what got painted** so a spec
can assert correctness (not just timing). After a stroke the painted voxels live
in the target layer's overlay `LocalPatchStore`; the read-back summarizes them
into a count, bbox, distinct values, a small sample, and a stable `signature`
(FNV-1a over the sorted `x,y,z=value` set) — same inputs ⇒ same signature.

Window API (added alongside the bench steps):

- `__editPaintBenchReadback(opts?)` → `{ targetLayerId, paintedVoxels, chunkCount,
bbox, signature, distinctValues, sample, truncated }` — read the current target
  overlay (call it after any `__editPaintBenchStep`).
- `__editPaintBenchStampReadback(input?)` → the same summary `+ strokeFired` —
  drives ONE **deterministic** stamp at a fixed panel position (not the sweeping
  perf stroke) through the full stack, then reads back. `input`: `{ masked?,
radius?, erase?, fracX?, fracY?, clearFirst?, settleTimeoutMs? }`.
- `__editPaintBenchClearTarget()` → drop the target's patches between stamps for
  isolated read-back.

The summarizer (`src/editing/benchmarks/patch_readback.ts`) is pure and
unit-verified (`tests/editing/benchmarks/patch_readback.spec.ts`); only the
stamp/dispatch + overlay access run in the COI browser.

## Correctness e2e (`edit_paint_correctness.spec.ts`)

`npm run bench:correctness` (fixtures → build → run, config
`playwright.correctness.config.ts`) points the app at the **local fake-gcs
fixtures** (no `gs://` auth) via the route-rewrite in
`tests/editing/harness/gcs_route.ts`, builds each scenario's ngState with
`build_ng_state.ts`, drives a deterministic stamp, and asserts the read-back:
painted-voxel count, value, region-containment, and a stable signature across a
repeated stamp. Scenarios exercise the data axes the in-memory matrix can't reach
end-to-end (offset target, encodings, multi-res). See `testdata/editing/README.md`.

**Visual check (manual review).** The first test in each scenario saves
`before` / `after` / `after-fullpage` PNGs to `test-results/correctness/` (and
attaches them to the Playwright report — view with
`npm run bench:correctness:run:ui`). It uses a big radius-64 stamp at the panel
centre and **fails loudly if nothing painted**, so a blank "after" means the
stamp didn't land — usually camera framing (`crossSectionScale` in
`build_ng_state.ts` frames the region so the centre pixel is inside the session
bounds; a mis-framed small fixture maps the centre outside bounds and the write
is silently clipped) or pointer dispatch. Run headed to watch it live:
`npm run bench:correctness:run:headed`.
