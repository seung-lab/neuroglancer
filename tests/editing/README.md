# Edit-session test suite

Tests for the edit-session painting stack (scheduler → pointer→voxel → pyodide
compute → commit → GPU → save). Conventions (tiers, naming, vocabulary) are in
[`docs/TESTING.md`](../../docs/TESTING.md); this is the suite-specific guide.

## Layout

```
unit/          *.spec.ts  — fast, isolated (Vitest). Compute matrices
               (painting_compute, painting_compute_matrix, patch_readback),
               adapters/, overlay/, local_patch_store, locked_writable_matrix,
               harness-helper tests (build_ng_state, gcs_route).
integration/   *.spec.ts  — EditSessionHost wiring (edit_session, edit_session_host).
e2e/           *.e2e.ts   — Playwright correctness on the built app.
perf/          *.perf.ts  — Playwright paint benchmark.
fakes/         FakeViewer / FakeLayerManager / FakeLogger.
harness/       drivers (no *.spec): e2e_setup, build_ng_state, gcs_route,
               fake_gcs_fixtures, serve_dist.
```

## Run

```bash
npm test                 # unit + integration (+ browser) — the gate
npm run e2e[:headed|:ui] # correctness e2e (fixtures + build + run)
npm run perf[:headed]    # paint benchmark
npm run test:fixtures    # (re)generate the precomputed fixtures only
```

## Reproducible datasource (e2e + perf)

Both Playwright suites run against **local fake-gcs fixtures** — no live `gs://`,
no auth, deterministic. The boot path is shared in `harness/e2e_setup.ts`:

```
testdata/editing/manifest.json ──generate.py──▶ precomputed buckets + fixtures.json
        │
        ▼  harness/fake_gcs_fixtures.mjs (free port, reaped on exit)
   fake-gcs-server ──harness/gcs_route.ts──▶ rewrite storage.googleapis.com → local
        │
        ▼  harness/build_ng_state.ts (scenario → ngState + editSession)
   built app (serve_dist.mjs, COOP/COEP → SAB + pyodide) auto-opens the session
        │
        ▼  harness/e2e_setup.ts: openScenarioPage + warmupPaintPath
   deterministic stamp → __editPaintBench read-back → assert
```

Fixtures are generated (not committed) — see
[`testdata/editing/README.md`](../../testdata/editing/README.md) for the manifest + generator.
One Playwright config (`playwright.editing.config.ts`) with two projects: `e2e`, `perf`.

## Correctness read-back (`__editPaintBench*`)

The in-app harness (`src/editing/benchmarks/edit_paint_bench.ts`) can read back
**what got painted** so an e2e can assert correctness, not just timing. After a
stroke the painted voxels live in the target layer's overlay `LocalPatchStore`;
the read-back (`src/editing/benchmarks/patch_readback.ts`, unit-verified in
`unit/patch_readback.spec.ts`) summarizes them into a count, absolute bbox,
distinct values, a sample, and a stable `signature` (FNV-1a over the sorted
`x,y,z=value` set) — same inputs ⇒ same signature.

Window API:

- `__editPaintBenchStampReadback(input?)` → summary `+ strokeFired` — drives ONE
  deterministic stamp at a fixed panel position, then reads back. `input`:
  `{ masked?, radius?, erase?, fracX?, fracY?, clearFirst?, prime?, originOffset? }`.
- `__editPaintBenchReadback(opts?)` → read the current target overlay.
- `__editPaintBenchClearTarget()` → drop the target's patches between stamps.

`originOffset` (= the target scale's `voxelOffset`) makes the read-back report
ABSOLUTE global voxels, comparable to the edit region.

## e2e correctness (`e2e/edit_paint.e2e.ts`)

Per scenario: warm the paint path → save a before/after/full-page **screenshot**
for manual review (`test-results/correctness/`, attached to the report) → drive a
deterministic stamp → assert painted count, value, absolute region-containment
(the offset axis end-to-end), determinism, and erase. Scenarios exercise data
axes the in-memory matrix can't reach (offset, encodings, multi-res).

## perf benchmark (`perf/edit_paint.perf.ts`)

Sweeps brush sizes × {masked, unmasked, eraser} on the large `perf_*` fixture
(2048², room for radius up to 512), measuring per-size cost from
`__paintProfiler`. Each `{case × size}` is its own test (a tree in the UI).

- **Use `:headed` for fully-real numbers** — headless chromium does not run the
  render loop, so `frameDraw` / `gpu.upload` / `mirror.fuse` (the RENDER phase)
  are absent.
- Before measuring, the harness warms the data (8 max-radius stamps) so chunks
  are resident and pyodide is booted.
- Output: a table in stdout + `test-results/edit_paint_bench.json`.
- Perf-regression **baseline comparison** (committed baselines + tolerance) is a
  follow-up (TM-331 Phase 3).

## `// TUNE:` points (dial in on a live GPU)

The Playwright suites can't be verified offline. Expect to adjust:

1. **Fixtures generated** — `npm run test:fixtures` (fast-fails with a clear
   message if a layer can't load).
2. **WebGL flags** (`playwright.editing.config.ts`) if the canvas stays black.
3. **Pointer dispatch / settle** — `harness/e2e_setup.ts` warmup +
   `edit_paint_bench.ts` `waitForSettle` / `waitForPaintStable` / priming, if
   stamps don't register or read-back races the async overlay write.
