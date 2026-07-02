/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Edit-session paint benchmark (TM-331).
 *
 * Loads the BUILT prod bundle (served fresh by `serve_dist.mjs` with COOP/COEP —
 * no dev-server/HMR) against the LOCAL fake-gcs fixtures via `buildNgState` (a
 * perf scenario whose `editSession` block AUTO-OPENS the session) — reproducible,
 * no live `gs://` auth. Shares the boot path with the correctness suite
 * (`tests/editing/harness/e2e_setup.ts`).
 *
 * Each {case × brush size} is its OWN Playwright test (a tree of
 * `masked-brush › brush 1025`, …) so they show up — and can be run/inspected —
 * separately in the Playwright UI (`npm run perf --ui`). The expensive
 * setup (page load · session · pyodide boot · chunk warmup) runs ONCE per worker
 * in `beforeAll`; every test then drives a single stroke on the shared page and
 * attaches its full sectioned `__paintProfiler` block.
 *
 * Run:  npm run perf        (headless)
 *       npm run perf:headed (real window — captures the ④ RENDER phase)
 *       npm run perf --ui     (Playwright UI — per-config tests)
 *
 * ⚠ Benchmark, not a gating test. Needs the generated fixtures
 * (`uv run testdata/editing/generate.py`) + the prod build + WebGL2 + pyodide.
 * Perf-regression baseline comparison is a follow-up (TM-331 Phase 3).
 */

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import type {
  FixturesIndex,
  Scenario,
} from "#tests/editing/harness/build_ng_state.js";
import {
  loadFixturesIndex,
  openScenarioPage,
  startFixtureGcs,
  type FixtureGcs,
} from "#tests/editing/harness/e2e_setup.js";

const PORT = Number(process.env.EDITING_APP_PORT ?? 9777);

// Perf scenario: a representative EM-image + segmentation target on the LARGE
// local fixture (2048² — room for the radius-up-to-512 sweep), with the real
// threshold + morphology mask preset. Replaces the old hard-coded live-gs://
// VIEWER_STATE; `buildNgState` assembles the ngState + editSession block.
const PERF_SCENARIO: Scenario = {
  name: "perf: EM-image + seg target",
  crossSectionScale: 2.0,
  layers: [
    {
      fixtureId: "perf_img_u8_raw",
      role: "image",
      writable: false,
      name: "EM",
    },
    {
      fixtureId: "perf_seg_u64_cseg",
      role: "target",
      writable: true,
      name: "seg",
    },
  ],
  tooling: {
    activeToolId: "painting.brush",
    painting: {
      targetLayerId: "seg",
      targetResolution: "16x16x40",
      radius: 512,
      activeValue: { t: "b", v: "1" },
      eraseValue: { t: "b", v: "0" },
      mask: {
        imageLayerId: "EM",
        imageResolution: "16x16x40",
        thresholdLow: 99,
        thresholdHigh: 160,
        minComponentSize: 32,
        binaryClosing: 1,
        filterComponentsFirst: false,
      },
    },
  },
};

const SIZES = [5, 51, 251, 501, 751, 1025];
const CASES = ["masked-brush", "unmasked-brush", "eraser"] as const;

interface BenchRow {
  case: string;
  size: number;
  radius: number;
  ok: boolean;
  error?: string;
  /** Full sectioned `__paintProfiler` block for this stroke (the primary output). */
  summary: string;
  timings: Record<string, number>;
  counters: Record<string, number>;
  maskedComputeRan?: boolean;
  strokeFired?: boolean;
}

// ---------------------------------------------------------------------------
// Shared, once-per-worker setup: load the built app, wait for the auto-opened
// session, run diagnostics, warm the chunks + pyodide. All tests reuse `page`.
// ---------------------------------------------------------------------------

let page: Page;
let fakeGcs: FixtureGcs | undefined;
let fixtures: FixturesIndex | undefined;
let setupError: string | undefined;
const collected: BenchRow[] = [];

try {
  fixtures = loadFixturesIndex();
} catch (e) {
  setupError = e instanceof Error ? e.message : String(e);
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(8 * 60 * 1000);
  if (setupError !== undefined) return;
  try {
    fakeGcs = await startFixtureGcs();
    page = await openScenarioPage(browser, {
      scenario: PERF_SCENARIO,
      fixtures: fixtures!,
      fakeGcsUrl: fakeGcs.url,
      appPort: PORT,
    });

    const diag = await page.evaluate(
      async () => await (window as any).__editPaintBenchPrepare({}),
    );
    console.log("\n[bench] prepare diag: " + JSON.stringify(diag, null, 2));
    if (!diag.sessionActive || diag.error || diag.dispatchTarget === "none") {
      throw new Error(
        "setup not usable (stale/broken bundle? fixtures generated? canvas?). diag=" +
          JSON.stringify(diag),
      );
    }
    if (!diag.crossOriginIsolated) {
      console.warn(
        "[bench] crossOriginIsolated=false — masked case falls back to the " +
          "main-thread compute (no pyodide worker). Check COOP/COEP.",
      );
    }

    console.log("[bench] warming data (chunks + pyodide)…");
    const warm = await page.evaluate(
      async () =>
        await (window as any).__editPaintBenchWarmup({ warmupStamps: 8 }),
    );
    console.log(`[bench] warmup done: ${JSON.stringify(warm)}`);
  } catch (e) {
    setupError = e instanceof Error ? e.message : String(e);
    console.error(`[bench] SETUP FAILED: ${setupError}`);
  }
});

test.afterAll(async () => {
  if (page !== undefined) {
    await page

      .evaluate(() => (window as any).__editPaintBenchFinish?.())
      .catch(() => {});
    if (collected.length > 0) {
      mkdirSync("test-results", { recursive: true });
      writeFileSync(
        path.join("test-results", "edit_paint_bench.txt"),
        collected.map(blockFor).join("\n"),
      );
      writeFileSync(
        path.join("test-results", "edit_paint_bench.json"),
        JSON.stringify(collected, null, 2),
      );
    }
    await page.close().catch(() => {});
  }
  await fakeGcs?.[Symbol.asyncDispose]?.();
});

/** Boxed header + the full profiler block for a row. */
function blockFor(r: BenchRow): string {
  const head =
    `\n══════════════════════════════════════════════════════════════════\n` +
    ` ${r.case}  ·  brush ${r.size}  (r=${r.radius})\n` +
    `══════════════════════════════════════════════════════════════════`;
  const body = r.summary
    ? r.summary
    : `(no profiler output)${r.error ? `  ERR=${r.error}` : ""}`;
  return `${head}\n${body}`;
}

// ---------------------------------------------------------------------------
// One test per {case × size} — a tree in the Playwright UI.
// ---------------------------------------------------------------------------

for (const c of CASES) {
  test.describe(c, () => {
    for (const size of SIZES) {
      const radius = (size - 1) / 2;
      test(`brush ${size} (r=${radius})`, async () => {
        test.skip(setupError !== undefined, `setup failed: ${setupError}`);

        const row = (await page.evaluate(
          async (arg) => await (window as any).__editPaintBenchStep(arg),
          { case: c, size },
        )) as BenchRow;
        collected.push(row);

        const block = blockFor(row);
        console.log(block);
        await test.info().attach(`${c}-brush${size}.txt`, {
          body: row.summary || `(no output)${row.error ? ` ${row.error}` : ""}`,
          contentType: "text/plain",
        });

        // Green = a real measurement; red = errored or produced nothing.
        expect(row.error ?? "", `step error: ${row.error}`).toBe("");
        expect(
          row.summary.length,
          "no profiler output (stroke did not register?)",
        ).toBeGreaterThan(0);
      });
    }
  });
}
