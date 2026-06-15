# Edit-session paint benchmark

A Playwright benchmark that drives a real edit session in the dev-server app and
sweeps brush sizes for three cases — **masked brush** (threshold + morphology),
**unmasked brush**, **eraser** — measuring per-size cost from `__paintProfiler`.

## Run

Portal-style variants (mirror `test:e2e` / `:headed` / `:ui`):

```bash
npm run bench:paint          # headless (fast, CI) — build + run
npm run bench:paint:headed   # REAL browser window — captures the ④ RENDER phase
npm run bench:paint:ui       # Playwright UI mode (inspect/step the run)
npm run bench:paint:run      # skip the build (dist/client already fresh)
```

**Use `:headed` for fully-real numbers.** Headless chromium does not run the
render loop, so `frameDraw` / `gpu.upload` / `mirror.fuse` (the ④ RENDER phase
and render-driven commit costs) are absent — only a headed (visible) browser
draws frames. The `0.stroke(total)` span is also gone on the newer `worker-mask`
masked path (so ⑤ SPANS shows only `handleInput`) — that matches the real
profiler.

Before measuring, the harness **warms the data** (8 max-radius stamps across the
band) so the EM/target chunks are resident. Otherwise the first measured segment
pays a multi-second cold `gs://` `chunkRead`, which — longer than the move pacing
— makes `latestWins` drop every other move and collapse the stroke to ONE
segment (no per-segment numbers).

Portal-style (`zetta-ai-portal/e2e`): `bench:paint` **builds the prod bundle**
(`build:zetta`), then Playwright starts a **fresh static server**
(`serve_dist.mjs`, port 9777, `reuseExistingServer: false`) that serves
`dist/client` with `COOP: same-origin` + `COEP: require-corp` →
`crossOriginIsolated` → SAB + self-hosted pyodide. **No webpack dev-server / no
HMR**, so the page never recompiles or reloads mid-run (the stale-bundle /
mid-stroke-reload problem the dev-server had).

It opens headless chromium with software WebGL2, loads the project ngState (EM
image + `seg_uint8` target, region ~5000×3700, brush+mask preset). The state
carries an `editSession` block so the host **auto-opens the session** — the
harness waits for it, then paints. Output: a table in stdout +
`test-results/edit_paint_bench.json`.

Needs **access to the `gs://` buckets in the state** (auth as in the portal) +
WebGL2. Benchmark, **not a gating test**. Rebuild (`npm run bench:paint`, or
`npm run bench:paint:build`) after changing any `src/` used by the harness — the
static server serves the built bundle, not live source.

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

1. **Bucket access** to the `gs://` sources in `VIEWER_STATE` — the built app
   must be able to read `gs://stroeh_sem_mouse_retina/...` and
   `gs://sergiy_exp/...` (auth as in the portal). If a layer doesn't load, the
   session won't auto-open and the harness fast-fails with a clear message.
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
