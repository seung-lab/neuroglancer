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
 * Worker-side handler for the pyodide morphology compute (TM-304).
 *
 * Registers the `morphology.apply` promise-RPC and boots one pyodide instance
 * (numpy + scipy) at module load. The RPC handshake (`sendReady()` in
 * `worker_rpc_context.js`) only means the channel is up — pyodide boot is async
 * and much slower — so every request awaits the module-level `pyodideReady`
 * promise before computing. The main-thread `RPC(worker, waitUntilReady=true)`
 * queue absorbs the cold start.
 */

import {
  MORPHOLOGY_APPLY_RPC,
  type MorphologyRequest,
  type MorphologyResponse,
} from "#src/editing/tool_runtimes/morphology_request.js";
import PYTHON_SRC from "#src/editing/tool_runtimes/python_painter.py?raw";
import type { RPC, RPCPromise } from "#src/worker_rpc.js";
import { registerPromiseRPC } from "#src/worker_rpc.js";

/**
 * Self-hosted pyodide assets, copied to `<output>/pyodide/` by the rspack
 * `CopyRspackPlugin` (see `rspack.config.js`) and served same-origin under the
 * iframe.
 *
 * The base is `self.location.href` — the worker script's actual served URL —
 * NOT `import.meta.url`. Under rspack's worker code-splitting, a bare
 * `import.meta.url` inside a worker module resolves to a `file://` source path
 * (only the `new Worker(new URL(...))` creation site is rewritten), which would
 * make these fetches fail. `self.location` is the real http(s) URL of the
 * running worker, so `pyodide/` resolves next to the bundle regardless of the
 * proxy path the portal serves us under.
 */
const PYODIDE_INDEX_URL = new URL("pyodide/", self.location.href).href;
const PYODIDE_MODULE_URL = new URL("pyodide/pyodide.mjs", self.location.href)
  .href;

/** Heap watermark above which we ask the client to reinit (ported from old worker). */
const HEAP_WATERMARK_BYTES = 500 * 1024 * 1024;

type ApplyMorphologyFn = (
  maskBytes: Uint8Array,
  sx: number,
  sy: number,
  sz: number,
  binaryClosing: number,
  minComponentSize: number,
  filterComponentsFirst: boolean,
) => Uint8Array | ArrayBuffer;

// Typed loosely as `any` to avoid a hard dependency on `@types/pyodide`; the
// surface we touch (`runPython`, `globals.get`, `_module.HEAPU8`) is stable.
let pyodide: any = null;
let applyFn: ApplyMorphologyFn | null = null;

const pyodideReady: Promise<void> = (async () => {
  // Phase-0 integration point: the dynamic import is left for the runtime
  // (not bundled) so the self-hosted `pyodide.mjs` is fetched from the iframe
  // origin. `webpackIgnore` is honored by rspack.
  const { loadPyodide } = await import(
    /* webpackIgnore: true */ PYODIDE_MODULE_URL
  );
  pyodide = await loadPyodide({
    indexURL: PYODIDE_INDEX_URL,
    packages: ["numpy", "scipy"],
  });
  pyodide.runPython(PYTHON_SRC);
  applyFn = pyodide.globals.get("apply_morphology") as ApplyMorphologyFn;
})();

function heapBytes(): number {
  return pyodide?._module?.HEAPU8?.byteLength ?? 0;
}

registerPromiseRPC<MorphologyResponse>(
  MORPHOLOGY_APPLY_RPC,
  async function (
    this: RPC,
    req: MorphologyRequest,
    { signal },
  ): RPCPromise<MorphologyResponse> {
    await pyodideReady;
    if (signal?.aborted) throw signal.reason;
    const [sx, sy, sz] = req.shape;
    const out = applyFn!(
      req.mask,
      sx,
      sy,
      sz,
      req.binaryClosing,
      req.minComponentSize,
      req.filterComponentsFirst,
    );
    const mask = out instanceof Uint8Array ? out : new Uint8Array(out);
    return {
      value: { mask, heapPressure: heapBytes() >= HEAP_WATERMARK_BYTES },
      transfers: [mask.buffer],
    };
  },
);
