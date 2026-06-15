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
  type MorphologyTimings,
} from "#src/editing/tool_runtimes/morphology_request.js";
import PYTHON_SRC from "#src/editing/tool_runtimes/python_painter.py?raw";
import type { RPC, RPCPromise } from "#src/worker_rpc.js";
import { registerPromiseRPC } from "#src/worker_rpc.js";

/**
 * Pyodide is self-hosted (TM-322): cross-origin isolation
 * (`Cross-Origin-Embedder-Policy: require-corp`, required for
 * `SharedArrayBuffer`) forbids streaming it from the jsDelivr CDN, so the core
 * runtime + numpy/scipy/openblas wheels are served same-origin from `pyodide/`
 * next to this worker bundle (emitted by `CopyRspackPlugin`; see
 * `rspack.config.js`). `loadPyodide({ indexURL })` then pulls the wheels from
 * that same-origin base.
 *
 * The base is derived from the worker's own URL via `globalThis.location` so it
 * resolves correctly under the portal proxy's base path — NOT
 * `new URL(..., import.meta.url)`, which rspack would try to resolve as a
 * build-time module/asset.
 */
const PYODIDE_INDEX_URL = new URL("pyodide/", globalThis.location.href).href;
const PYODIDE_MODULE_URL = `${PYODIDE_INDEX_URL}pyodide.mjs`;

/** Heap watermark above which we ask the client to reinit (ported from old worker). */
const HEAP_WATERMARK_BYTES = 500 * 1024 * 1024;

/**
 * Returns python `bytes`, which cross the FFI as a pyodide `PyProxy` —
 * see `extractMask` for the conversion contract.
 */
type ApplyMorphologyFn = (
  maskBytes: Uint8Array,
  sx: number,
  sy: number,
  sz: number,
  binaryClosing: number,
  minComponentSize: number,
  filterComponentsFirst: boolean,
) => unknown;

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
    // Sample BEFORE awaiting pyodideReady so queue time and boot time split:
    // a cold/rebooted worker otherwise reports its multi-second boot as
    // "queue wait".
    const receivedAtEpochMs = Date.now();
    const bootWaitStart = performance.now();
    await pyodideReady;
    const bootWaitMs = performance.now() - bootWaitStart;
    if (signal?.aborted) throw signal.reason;
    const [sx, sy, sz] = req.shape;
    const callStart = performance.now();
    const out = applyFn!(
      req.mask,
      sx,
      sy,
      sz,
      req.binaryClosing,
      req.minComponentSize,
      req.filterComponentsFirst,
    );
    const workerCallMs = performance.now() - callStart;
    const convertStart = performance.now();
    const mask = extractMask(out);
    const convertOutMs = performance.now() - convertStart;
    const timings = readLastTimings(workerCallMs, bootWaitMs, convertOutMs, {
      receivedAtEpochMs,
      postedAtEpochMs: req.postedAtEpochMs,
    });
    return {
      value: {
        mask,
        heapPressure: heapBytes() >= HEAP_WATERMARK_BYTES,
        ...(timings !== undefined ? { timings } : {}),
        respondedAtEpochMs: Date.now(),
      },
      transfers: [mask.buffer],
    };
  },
);

/**
 * Convert `apply_morphology`'s return value (python `bytes`) into a JS
 * Uint8Array. Pyodide hands buffers across the FFI as a `PyProxy`; the ONLY
 * acceptable conversion is the FFI's buffer copy (`toJs()` — a memcpy).
 * Passing the proxy to `new Uint8Array(proxy)` "works" but goes through the
 * array-like constructor path: one python FFI call PER ELEMENT — 0.3–1.1 s
 * for a brush-1024 mask, which dominated the whole round-trip (it hid in the
 * gap between scipy finishing and the response posting). The proxy must
 * also be `destroy()`ed, or every multi-MB `bytes` lingers in the pyodide
 * heap until GC and drives the heap-pressure worker reinit.
 */
function extractMask(out: unknown): Uint8Array {
  if (out instanceof Uint8Array) return out;
  if (out instanceof ArrayBuffer) return new Uint8Array(out);
  const proxy = out as { toJs?: () => unknown; destroy?: () => void };
  if (typeof proxy?.toJs !== "function") {
    throw new Error(
      "morphology worker: apply_morphology returned an unsupported type",
    );
  }
  try {
    const converted = proxy.toJs!();
    if (converted instanceof Uint8Array) return converted;
    if (converted instanceof ArrayBuffer) return new Uint8Array(converted);
    throw new Error(
      "morphology worker: PyProxy.toJs() yielded an unsupported type",
    );
  } finally {
    proxy.destroy?.();
  }
}

/**
 * Pull the phase timings `apply_morphology` stashed in the python global
 * `last_timings_json`. Defensive: a parse failure must never fail the paint
 * call — timings are diagnostics only.
 */
function readLastTimings(
  workerCallMs: number,
  bootWaitMs: number,
  convertOutMs: number,
  queue: { receivedAtEpochMs: number; postedAtEpochMs: number | undefined },
): MorphologyTimings | undefined {
  try {
    const raw = pyodide.runPython("last_timings_json") as string;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" ? v : 0);
    return {
      marshalInMs: num(parsed.marshalInMs),
      closingMs: num(parsed.closingMs),
      componentsMs: num(parsed.componentsMs),
      marshalOutMs: num(parsed.marshalOutMs),
      workerCallMs,
      bootWaitMs,
      convertOutMs,
      ...(queue.postedAtEpochMs !== undefined
        ? {
            requestQueueMs: Math.max(
              0,
              queue.receivedAtEpochMs - queue.postedAtEpochMs,
            ),
          }
        : {}),
    };
  } catch {
    return undefined;
  }
}
