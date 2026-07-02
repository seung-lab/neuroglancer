# Testing conventions

How tests are organized in this repo. **This is a fork of upstream neuroglancer** —
upstream conventions are kept as-is (to avoid merge pain); the Zetta editing
suite adds a small, explicit layer on top. When in doubt, match the nearest
existing test.

## Tiers (what a test proves)

| Tier            | Proves                                                  | Runner                                       | Speed |
| --------------- | ------------------------------------------------------- | -------------------------------------------- | ----- |
| **unit**        | one module in isolation, no I/O/DOM/app                 | Vitest (node/jsdom)                          | ms    |
| **integration** | several modules together, still no real app             | Vitest (node/jsdom)                          | ms    |
| **browser**     | needs real WebGL/DOM, not the full app                  | Vitest (browser)                             | s     |
| **e2e**         | the full built app against a real/reproduced datasource | Playwright                                   | min   |
| **perf**        | timing / regression                                     | Vitest bench (micro) **or** Playwright (app) | s–min |

## Naming — the filename tells you the runner + tier

| Suffix                                      | Runner           | Tier               |
| ------------------------------------------- | ---------------- | ------------------ |
| `*.spec.ts`                                 | Vitest (node)    | unit / integration |
| `*.browser_test.ts`                         | Vitest (browser) | browser            |
| `*.benchmark.ts` / `*.browser_benchmark.ts` | Vitest bench     | perf (micro)       |
| `*.e2e.ts`                                  | Playwright       | e2e                |
| `*.perf.ts`                                 | Playwright       | perf (app)         |

**No `*.spec.ts` is ever a Playwright test.** Playwright files are `*.e2e.ts` /
`*.perf.ts`, so Vitest's `tests/**/*.spec.ts` glob never picks them up (no
excludes needed).

## Support-code vocabulary

- **fixtures** — static test data (files, ngStates, generated volumes).
- **fakes** — in-code test doubles (`FakeViewer`, `FakeLayerManager`, …).
- **harness** — code that _drives_ the system under test (page openers, setup,
  the in-app `__editPaintBench*` surface, the static server).
- **generators** — produce fixtures (e.g. `testdata/editing/generate.py`).

## Where things live

Upstream (leave as-is):

- `src/**/*.spec.ts` — colocated unit tests.
- `tests/**` mirroring `src/` — `*.spec.ts`, `*.browser_test.ts`.
- `tests/fixtures/` — shared cross-feature fixtures/fakes (MSW, gl, http, kvstore).
- `tests/example_project_test/` — the example-project screenshot harness.
- `build_tools/vitest/` — test-infra servers (fake-gcs bin, test-data server,
  ngauth, python tools) wired into `vitest.workspace.ts`.

Zetta editing suite (feature-first, tier as subfolder):

```
tests/editing/
  unit/          *.spec.ts  — compute matrices, adapters, overlay, patch store, harness-helper tests
  integration/   *.spec.ts  — EditSessionHost wiring
  e2e/           *.e2e.ts   — Playwright correctness (built app + fake-gcs fixtures)
  perf/          *.perf.ts  — Playwright paint benchmark
  fakes/         FakeViewer / FakeLayerManager / FakeLogger
  harness/       e2e_setup, build_ng_state, gcs_route, fake_gcs, serve_dist  (drivers only, no *.spec)
  README.md      — the suite guide
testdata/editing/  manifest.json + generate.py → generated precomputed fixtures
```

## Commands

```bash
# Vitest — the gate (unit + integration + browser)
npm test                 # run once
npm run test:watch
npm run test:ui
npm run test:bench       # vitest micro-benchmarks (*.benchmark.ts)

# Playwright editing suite (built app + local fake-gcs fixtures)
npm run test:fixtures    # generate the precomputed fixtures (uv + tensorstore)
npm run e2e              # fixtures + build + correctness e2e   (--project e2e)
npm run e2e:headed       # …with a visible browser
npm run e2e:ui           # …Playwright UI mode
npm run perf             # fixtures + build + paint benchmark   (--project perf)
npm run perf:headed
```

`e2e*` / `perf*` all rebuild the prod bundle + regenerate fixtures first (no
stale-bundle surprises). One Playwright config, two projects:
`playwright.editing.config.ts`. See `tests/editing/README.md` for the details.
