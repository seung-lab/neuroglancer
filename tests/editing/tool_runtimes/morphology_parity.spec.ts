/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

// Parity gate for TM-304: the trimmed `python_painter.py` running under
// scipy/pyodide MUST agree with the TS `applyMorphologyPipeline` it replaces,
// over randomized masks and every ordering of the pipeline. This is the test
// that justifies the swap as behavior-preserving.
//
// This suite is OPT-IN: it boots pyodide and pulls numpy/scipy wheels (network
// + a node pyodide build with resolvable assets), so it is skipped unless
// `RUN_PYODIDE_PARITY` is set. The default unit run never attempts a boot.
// Phase 0 / CI runs it with:  RUN_PYODIDE_PARITY=1 npm test -- morphology_parity

import { beforeAll, describe, expect, it } from "vitest";

import { applyMorphologyPipeline } from "#src/editing/tool_runtimes/mask_compute.js";
import type { VoxelTriple } from "#src/editing/tool_runtimes/mask_coord.js";
import PYTHON_SRC from "#src/editing/tool_runtimes/python_painter.py?raw";

interface Params {
  binaryClosing: number;
  minComponentSize: number;
  filterComponentsFirst: boolean;
}

const PARAM_GRID: Params[] = [
  { binaryClosing: 0, minComponentSize: 0, filterComponentsFirst: false },
  { binaryClosing: 1, minComponentSize: 0, filterComponentsFirst: false },
  { binaryClosing: 2, minComponentSize: 0, filterComponentsFirst: false },
  { binaryClosing: 0, minComponentSize: 4, filterComponentsFirst: false },
  { binaryClosing: 0, minComponentSize: 4, filterComponentsFirst: true },
  { binaryClosing: 2, minComponentSize: 6, filterComponentsFirst: false },
  { binaryClosing: 2, minComponentSize: 6, filterComponentsFirst: true },
];

// Deterministic LCG so failures are reproducible without a Date/Math.random seed.
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function randomMask(rng: () => number, side: number, density: number): Uint8Array {
  const data = new Uint8Array(side * side);
  for (let i = 0; i < data.length; i++) data[i] = rng() < density ? 1 : 0;
  return data;
}

const suite = process.env.RUN_PYODIDE_PARITY ? describe : describe.skip;

suite("morphology parity: pyodide scipy === TS applyMorphologyPipeline", () => {
  let applyFn: any;

  beforeAll(async () => {
    const { createRequire } = await import("node:module");
    const { dirname } = await import("node:path");
    const { pathToFileURL } = await import("node:url");
    // `import.meta.url` is an http dev-server URL under vitest, so resolve the
    // pyodide package dir from cwd to get a real on-disk indexURL for its
    // wasm/stdlib assets (otherwise pyodide.mjs resolves them to the wrong base).
    const req = createRequire(pathToFileURL(`${process.cwd()}/`));
    const indexURL = `${dirname(req.resolve("pyodide"))}/`;
    // pyodide is an opt-in test-only runtime, not a project dependency.
    // eslint-disable-next-line import/no-extraneous-dependencies
    const { loadPyodide } = await import("pyodide");
    const py = await loadPyodide({ indexURL });
    await py.loadPackage(["numpy", "scipy"]);
    py.runPython(PYTHON_SRC);
    applyFn = py.globals.get("apply_morphology");
  }, 180_000);

  function pyApply(
    mask: Uint8Array,
    shape: VoxelTriple,
    p: Params,
  ): Uint8Array {
    const out = applyFn(
      mask,
      shape[0],
      shape[1],
      shape[2],
      p.binaryClosing,
      p.minComponentSize,
      p.filterComponentsFirst,
    );
    return out instanceof Uint8Array ? out : new Uint8Array(out);
  }

  for (const side of [5, 7, 11]) {
    for (const p of PARAM_GRID) {
      it(`side=${side} bc=${p.binaryClosing} min=${p.minComponentSize} fcf=${p.filterComponentsFirst}`, () => {
        const rng = makeRng(side * 131 + p.binaryClosing * 17 + p.minComponentSize);
        const shape: VoxelTriple = [side, side, 1];
        for (let trial = 0; trial < 8; trial++) {
          const base = randomMask(rng, side, 0.35 + 0.3 * rng());
          // Pure-TS path mutates its input in place, so feed each side a copy.
          const ts = applyMorphologyPipeline({
            mask: { data: base.slice(), shape },
            binaryClosing: p.binaryClosing,
            minComponentSize: p.minComponentSize,
            filterComponentsFirst: p.filterComponentsFirst,
          }).data;
          const py = pyApply(base.slice(), shape, p);
          expect(Array.from(py)).toEqual(Array.from(ts));
        }
      });
    }
  }
});
