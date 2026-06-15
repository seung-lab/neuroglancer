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
 * Live-pyodide cross-check for the whole-pipeline masked compute (TM-317).
 *
 * Boots a REAL pyodide (numpy + scipy) from the self-hosted runtime in
 * `dist/client/pyodide` and asserts that `python_painter.py::apply_paint_pipeline`
 * returns a footprint mask byte-identical to the `runPaintPipelineTS` twin used
 * by the routing parity matrix. This closes the "is the worker truly
 * bit-identical to the twin" gap that the mocked matrix spec cannot.
 *
 * Resilient by design: if pyodide fails to boot (wheels missing in a stripped
 * CI checkout, etc.) the suite SKIPS rather than fails, so it never blocks the
 * build — the mocked matrix spec remains the always-on guard.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import type { PaintPipelineRequest } from "#src/editing/tool_runtimes/paint_pipeline_request.js";
import { runPaintPipelineTS } from "#src/editing/tool_runtimes/paint_pipeline_ts.js";
import PYTHON_SRC from "#src/editing/tool_runtimes/python_painter.py?raw";

// Self-hosted pyodide runtime (core + numpy/scipy/openblas wheels), as served
// in production. Resolved from the repo root so the test is CWD-independent.
const PYODIDE_DIR = path.resolve(
  import.meta.dirname,
  "../../../dist/client/pyodide",
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pyodide: any = null;
let bootError: unknown = null;

beforeAll(async () => {
  if (!existsSync(path.join(PYODIDE_DIR, "pyodide.mjs"))) {
    bootError = new Error(`pyodide runtime not found at ${PYODIDE_DIR}`);
    return;
  }
  try {
    // ESM import needs a URL; node-pyodide's `indexURL` needs a plain
    // filesystem path (it reads asm/stdlib/wheels via `fs`).
    const moduleUrl = pathToFileURL(path.join(PYODIDE_DIR, "pyodide.mjs")).href;
    const { loadPyodide } = await import(/* @vite-ignore */ moduleUrl);
    pyodide = await loadPyodide({
      indexURL: PYODIDE_DIR + path.sep,
      packages: ["numpy", "scipy"],
    });
    pyodide.runPython(PYTHON_SRC);
  } catch (e) {
    bootError = e;
    pyodide = null;
  }
}, 180000);

afterAll(() => {
  pyodide = null;
});

// ---------------------------------------------------------------------------
// Request fixtures
// ---------------------------------------------------------------------------

function imageValueAt(x: number, y: number): number {
  const m = (((x * 7 + y * 13) % 81) + 81) % 81;
  return 80 + m; // 80..160, straddles the [90,150] band
}

interface ReqOpts {
  loTx?: number;
  loTy?: number;
  tSx?: number;
  tSy?: number;
  sxRatio?: number;
  syRatio?: number;
  thresholdLow?: number;
  thresholdHigh?: number;
  pathPoints?: number[];
  radius?: number;
  binaryClosing?: number;
  minComponentSize?: number;
  filterComponentsFirst?: boolean;
}

/** Build a self-consistent request + its native image slab from `imageValueAt`. */
function makeRequest(o: ReqOpts): PaintPipelineRequest {
  const loTx = o.loTx ?? 100;
  const loTy = o.loTy ?? 100;
  const tSx = o.tSx ?? 29;
  const tSy = o.tSy ?? 29;
  const sxRatio = o.sxRatio ?? 1;
  const syRatio = o.syRatio ?? 1;
  // Image-voxel region the footprint projects to (matches the main thread).
  const loImageX = Math.floor(loTx * sxRatio);
  const loImageY = Math.floor(loTy * syRatio);
  const maxIx = Math.floor((loTx + tSx - 1) * sxRatio);
  const maxIy = Math.floor((loTy + tSy - 1) * syRatio);
  const iSx = maxIx - loImageX + 1;
  const iSy = maxIy - loImageY + 1;
  const image = new Uint8Array(iSx * iSy);
  for (let j = 0; j < iSy; j++) {
    for (let i = 0; i < iSx; i++) {
      image[i + iSx * j] = imageValueAt(loImageX + i, loImageY + j);
    }
  }
  const pts =
    o.pathPoints ?? [loTx + tSx / 2, loTy + tSy / 2, loTx + tSx / 2, loTy + tSy / 2];
  return {
    image,
    imageShape: [iSx, iSy],
    imageDataType: "uint8",
    loImageX,
    loImageY,
    loTx,
    loTy,
    targetShape: [tSx, tSy],
    sxRatio,
    syRatio,
    szRatio: 1,
    thresholdLow: o.thresholdLow ?? 90,
    thresholdHigh: o.thresholdHigh ?? 150,
    pathPoints: new Float64Array(pts),
    radius: o.radius ?? 14,
    binaryClosing: o.binaryClosing ?? 0,
    minComponentSize: o.minComponentSize ?? 1,
    filterComponentsFirst: o.filterComponentsFirst ?? false,
  };
}

/** Invoke the live python `apply_paint_pipeline` for `req`. */
function runPython(req: PaintPipelineRequest): Uint8Array {
  const fn = pyodide.globals.get("apply_paint_pipeline");
  try {
    const out = fn(
      req.image,
      req.imageShape[0],
      req.imageShape[1],
      req.imageDataType,
      req.loImageX,
      req.loImageY,
      req.loTx,
      req.loTy,
      req.targetShape[0],
      req.targetShape[1],
      req.sxRatio,
      req.syRatio,
      req.thresholdLow,
      req.thresholdHigh,
      req.pathPoints,
      req.radius,
      req.binaryClosing,
      req.minComponentSize,
      req.filterComponentsFirst,
    );
    try {
      const js = out.toJs() as Uint8Array;
      return js instanceof Uint8Array ? js : new Uint8Array(js);
    } finally {
      out.destroy?.();
    }
  } finally {
    fn.destroy?.();
  }
}

const CASES: Array<{ name: string; opts: ReqOpts }> = [];
for (const binaryClosing of [0, 1, 3]) {
  for (const minComponentSize of [1, 32]) {
    for (const filterComponentsFirst of [false, true]) {
      CASES.push({
        name: `closing=${binaryClosing} minSize=${minComponentSize} fcf=${filterComponentsFirst}`,
        opts: { binaryClosing, minComponentSize, filterComponentsFirst },
      });
    }
  }
}
CASES.push({
  name: "capsule stroke",
  opts: {
    pathPoints: [104, 108, 126, 120],
    radius: 11,
    binaryClosing: 1,
    minComponentSize: 6,
  },
});
CASES.push({
  name: "polyline",
  opts: {
    pathPoints: [102, 104, 116, 110, 128, 124],
    radius: 9,
    binaryClosing: 2,
    minComponentSize: 4,
    filterComponentsFirst: true,
  },
});
CASES.push({
  name: "anisotropic coarse image (sxRatio 0.5)",
  opts: { sxRatio: 0.5, syRatio: 0.5, radius: 16, binaryClosing: 1, minComponentSize: 6 },
});
CASES.push({
  name: "anisotropic fine image (sxRatio 2)",
  opts: { sxRatio: 2, syRatio: 2, radius: 12, binaryClosing: 3, minComponentSize: 8 },
});
CASES.push({
  name: "threshold edge band [90,150] tightened to [120,120]",
  opts: { thresholdLow: 120, thresholdHigh: 120, radius: 14 },
});
// x-clip stress geometries (TM-317 perf rework): the per-stripe x-window must be
// an exact superset for diagonal / near-axis capsules and steep polylines.
CASES.push({
  name: "long diagonal capsule (x-clip)",
  opts: { loTx: 100, loTy: 100, tSx: 240, tSy: 240, pathPoints: [120, 120, 320, 320], radius: 18, binaryClosing: 1, minComponentSize: 6 },
});
CASES.push({
  name: "near-vertical capsule (x-clip)",
  opts: { loTx: 100, loTy: 100, tSx: 80, tSy: 300, pathPoints: [130, 120, 138, 380], radius: 16 },
});
CASES.push({
  name: "near-horizontal capsule (x-clip)",
  opts: { loTx: 100, loTy: 100, tSx: 300, tSy: 80, pathPoints: [120, 130, 380, 138], radius: 16 },
});
CASES.push({
  name: "steep zigzag polyline (x-clip)",
  opts: { loTx: 100, loTy: 100, tSx: 240, tSy: 320, pathPoints: [120, 120, 300, 200, 130, 300, 320, 380], radius: 13, binaryClosing: 2, minComponentSize: 8, filterComponentsFirst: true },
});

describe("apply_paint_pipeline live pyodide == TS twin (TM-317)", () => {
  beforeAll(() => {
    if (pyodide === null) {
      // Surface why it is skipping, once.
      console.warn(
        "[paint_pipeline_live] pyodide unavailable — skipping live cross-check:",
        bootError,
      );
    }
  });

  for (const { name, opts } of CASES) {
    it(`matches twin — ${name}`, (ctx) => {
      if (pyodide === null) {
        ctx.skip();
        return;
      }
      const req = makeRequest(opts);
      const fromPython = runPython(req);
      const fromTwin = runPaintPipelineTS(req);
      expect(fromPython.length).toBe(fromTwin.length);
      expect(Array.from(fromPython)).toEqual(Array.from(fromTwin));
    });
  }
});
