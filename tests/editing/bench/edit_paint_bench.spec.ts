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
 * Edit-session paint benchmark (TM-317 follow-up).
 *
 * Loads the BUILT prod bundle (served fresh by `serve_dist.mjs` with COOP/COEP —
 * no dev-server/HMR) with the project ngState below, which carries an
 * `editSession` block, so the host AUTO-OPENS the session (EM image + seg_uint8
 * target, region ~5000×3700, brush+mask preset). The harness then sweeps brush
 * sizes for three cases (masked brush, unmasked brush, eraser), tabulating
 * per-size cost from `__paintProfiler`.
 *
 * Run:  npm run bench:paint   (builds the prod bundle, then runs this)
 *
 * ⚠ Benchmark, not a gating test. Needs access to the `gs://` buckets in the
 * state (auth as in the portal) + WebGL2 + pyodide (the static server provides
 * COEP). Pointer dispatch and settle waits are best-effort — see `// TUNE:`
 * markers here and in `src/editing/benchmarks/edit_paint_bench.ts`.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";

// Project ngState (provided). Its `editSession` block auto-opens the session.
const VIEWER_STATE = {
  dimensions: { x: [1.6e-8, "m"], y: [1.6e-8, "m"], z: [4e-8, "m"] },
  position: [46832.21484375, 47814.0546875, 920.5],
  crossSectionScale: 2.2818807653288458,
  crossSectionDepth: -5.62704868806956,
  projectionOrientation: [
    -0.02896018885076046, -0.14331857860088348, 0.04050016030669212,
    0.9884234070777893,
  ],
  projectionScale: 12625.85619814712,
  layers: [
    {
      type: "image",
      source: "precomputed://gs://stroeh_sem_mouse_retina/image/v2",
      tab: "source",
      name: "EM",
    },
    {
      type: "segmentation",
      source: "precomputed://gs://sergiy_exp/vlad/samples/seg_uint8",
      tab: "source",
      segments: [],
      name: "seg_uint8",
    },
  ],
  showScaleBar: false,
  selectedLayer: { visible: true, layer: "seg_uint8" },
  layout: "xy",
  selection: {},
  editSession: {
    layers: [
      { layerId: "EM", resolutions: ["16x16x40"], writable: false },
      { layerId: "seg_uint8", resolutions: ["16x16x40"], writable: true },
    ],
    region: {
      lo: [44194.93359375, 46102.61328125, 920.5],
      hi: [49199.3828125, 49815.15625, 921.5],
      dimensions: { x: [1.6e-8, "m"], y: [1.6e-8, "m"], z: [4e-8, "m"] },
    },
    tooling: {
      activeToolId: "painting.brush",
      painting: {
        targetLayerId: "seg_uint8",
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
  },
};

const SIZES = [5, 51, 251, 501, 751, 1025];

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
}

/** A boxed section header so each cell's profiler block is easy to find. */
function cellBlock(r: BenchRow): string {
  const head =
    `\n══════════════════════════════════════════════════════════════════\n` +
    ` ${r.case}  ·  brush ${r.size}  (r=${r.radius})\n` +
    `══════════════════════════════════════════════════════════════════`;
  const body = r.summary
    ? r.summary
    : `(no profiler output)${r.error ? `  ERR=${r.error}` : ""}`;
  return `${head}\n${body}`;
}

const CASES = ["masked-brush", "unmasked-brush", "eraser"] as const;

test("edit-session paint benchmark (masked / unmasked / eraser × sizes)", async ({
  page,
}) => {
  page.on("console", (msg) => {
    const t = msg.text();
    if (
      /paint-scheduler|paint-profile|editPaintBench|pyodide|error|warn/i.test(t)
    ) {
      console.log(`[page] ${t}`);
    }
  });
  // Detect the navigation that destroyed the context last time.
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) console.log(`[nav] → ${frame.url()}`);
  });
  page.on("load", () => console.log(`[load] ${page.url()}`));

  const stateUrl = `/#!${encodeURIComponent(JSON.stringify(VIEWER_STATE))}`;
  await page.goto(stateUrl, { waitUntil: "domcontentloaded" });

  // Wait for the viewer + the auto-opened session + the harness hooks.
  await page.waitForFunction(
    () => {
      const v = (window as any).viewer;
      if (typeof (window as any).__editPaintBenchStep !== "function")
        return false;
      return v?.editSessionHost?.activeSession?.value !== undefined;
    },
    undefined,
    { timeout: 5 * 60 * 1000 },
  );

  // Diagnostics first (one short evaluate): session/mask/canvas usable?
  const diag = await page.evaluate(
    async () => await (window as any).__editPaintBenchPrepare({}),
  );
  console.log("\n[bench] prepare diag: " + JSON.stringify(diag, null, 2));

  // Fail FAST with an actionable message rather than 18 ERR rows. The usual
  // cause is a STALE/broken dev-server bundle (HMR "Reload prevented" on a
  // compile error → the page runs an old bundle): restart the dev-server and
  // make sure the tree compiles (`npx tsc --noEmit`).
  if (!diag.sessionActive || diag.error || diag.dispatchTarget === "none") {
    throw new Error(
      "edit-paint-bench setup not usable — likely a stale/broken dev-server " +
        "bundle. Restart `npm run dev-server` (and ensure `tsc` is clean), then " +
        "re-run. diag=" +
        JSON.stringify(diag),
    );
  }
  if (!diag.crossOriginIsolated) {
    console.warn(
      "[bench] crossOriginIsolated=false — masked case will use the main-thread " +
        "fallback (no pyodide worker). Check dev-server COOP/COEP headers.",
    );
  }

  // Warm the EM/target chunks (and pyodide) so the measured strokes don't pay a
  // cold `gs://` chunkRead that collapses the stroke to one segment.
  console.log("[bench] warming data (chunks + pyodide)…");
  const warm = await page.evaluate(
    async () =>
      await (window as any).__editPaintBenchWarmup({ warmupStamps: 8 }),
  );
  console.log(`[bench] warmup done: ${JSON.stringify(warm)}`);

  const rows: BenchRow[] = [];
  let aborted: string | undefined;
  outer: for (const c of CASES) {
    for (const size of SIZES) {
      let row: BenchRow & { maskedComputeRan?: boolean; strokeFired?: boolean };
      try {
        row = (await page.evaluate(
          async (arg) => await (window as any).__editPaintBenchStep(arg),
          { case: c, size },
        )) as BenchRow;
      } catch (e) {
        aborted = `${c} size=${size}: ${e instanceof Error ? e.message : String(e)}`;
        console.log(`[bench] ABORT at ${aborted}`);
        break outer;
      }
      rows.push(row);
      const md = (row as { maskedComputeRan?: boolean }).maskedComputeRan;
      const sf = (row as { strokeFired?: boolean }).strokeFired;
      const mb = row.timings["P.w.maskBuild(py)"];
      console.log(
        `[bench] ${c.padEnd(14)} size=${String(size).padStart(4)}  ` +
          `strokeFired=${sf} maskedCompute=${md} ` +
          `maskBuild=${mb === undefined ? "-" : mb.toFixed(1)} ` +
          `footprint=${row.counters["voxels.footprintBbox"] ?? "-"} ` +
          `painted=${row.counters["voxels.painted"] ?? "-"}` +
          (row.error ? `  ERR=${row.error}` : ""),
      );
    }
  }

  await page
    .evaluate(() => (window as any).__editPaintBenchFinish?.())
    .catch(() => {});

  // Primary output: the full sectioned profiler block per {case × size}, exactly
  // as the in-app console prints it (params · BLOCKS-UI · ①..⑥ sections · counts).
  const report = rows.map(cellBlock).join("\n");
  console.log(
    "\n\n##################  EDIT-SESSION PAINT BENCHMARK  ##################\n" +
      report +
      "\n",
  );
  mkdirSync("test-results", { recursive: true });
  writeFileSync(path.join("test-results", "edit_paint_bench.txt"), report);
  writeFileSync(
    path.join("test-results", "edit_paint_bench.json"),
    JSON.stringify({ diag, aborted, rows }, null, 2),
  );

  // Soft assertions — surface problems without hard-failing the benchmark.
  if (aborted !== undefined) {
    console.warn(`[bench] aborted early (navigation/context lost): ${aborted}`);
  }
  expect(rows.length).toBeGreaterThan(0);
});
