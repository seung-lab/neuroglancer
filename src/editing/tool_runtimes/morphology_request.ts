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
 * Shared request/response contract for the pyodide morphology worker (TM-304).
 *
 * Imported by BOTH the main-thread client (`morphology_client.ts`) and the
 * worker handler (`morphology_handler.ts`), so it must stay free of any
 * neuroglancer imports that pull in DOM/GL — keep it bundle-portable.
 *
 * The worker mirrors `mask_compute.ts`'s `applyMorphologyPipeline` using
 * `scipy.ndimage` (see `python_painter.py`). The TS path is retained as a
 * fallback when the worker is unavailable.
 */

/** RPC method name. Single source of truth for both ends of the channel. */
export const MORPHOLOGY_APPLY_RPC = "morphology.apply";

export interface MorphologyRequest {
  /**
   * 1/0 mask, row-major (x, y, z) with x fastest, length must equal
   * `shape[0] * shape[1] * shape[2]`. Its backing `ArrayBuffer` is transferred
   * to the worker, so the caller must not reuse it after dispatch.
   */
  readonly mask: Uint8Array;
  readonly shape: readonly [number, number, number];
  /** Binary-closing iterations; `0` skips closing. */
  readonly binaryClosing: number;
  /** Minimum connected-component voxel count; `<= 1` skips filtering. */
  readonly minComponentSize: number;
  /**
   * `true`: filter components → close. `false`: close → filter components.
   * Matches `MorphologyPipelineInput.filterComponentsFirst`.
   */
  readonly filterComponentsFirst: boolean;
  /**
   * `Date.now()` on the client at dispatch. `Date.now()` is the one clock
   * shared by both threads (`performance.now()` origins differ), so the
   * handler can measure how long the request sat in transit + the worker's
   * event loop. Millisecond precision — diagnostics only.
   */
  readonly postedAtEpochMs?: number;
}

/**
 * Per-call phase timings measured INSIDE the worker (python `perf_counter` +
 * worker-JS `performance.now`). Unlike the main-thread profiler's awaited
 * buckets these cannot include main-thread scheduling or RPC queueing, so
 * they split the true per-call cost into marshalling vs scipy compute.
 */
export interface MorphologyTimings {
  /** JS→python buffer copy + numpy array construction (`to_py`/`frombuffer`). */
  readonly marshalInMs: number;
  /** scipy `binary_closing`. 0 when closing is disabled. */
  readonly closingMs: number;
  /** scipy `label` + size filter. 0 when min-component-size is disabled. */
  readonly componentsMs: number;
  /** Result `astype(uint8).tobytes()`. */
  readonly marshalOutMs: number;
  /** Whole pyodide call as seen from worker JS (includes JS↔py bridging). */
  readonly workerCallMs: number;
  /**
   * PyProxy(bytes) → Uint8Array conversion in worker JS (`toJs()` memcpy +
   * `destroy()`). Kept visible so a conversion regression can't hide in the
   * request/response gap again.
   */
  readonly convertOutMs: number;
  /**
   * Handler entry `Date.now()` minus `MorphologyRequest.postedAtEpochMs`:
   * message transit + time queued in the worker's event loop. Absent when
   * the request carried no timestamp.
   */
  readonly requestQueueMs?: number;
  /**
   * Time this call spent awaiting the pyodide boot promise. ~0 on a warm
   * worker; multi-second after a (re)boot — e.g. the post-heap-pressure
   * reinit — which otherwise masquerades as queue time.
   */
  readonly bootWaitMs: number;
}

export interface MorphologyResponse {
  /** Processed 1/0 mask, same shape/layout as the request. Buffer transferred. */
  readonly mask: Uint8Array;
  /**
   * Set when the worker's pyodide heap has crossed its watermark. The client
   * uses this to terminate + lazily recreate the worker once it goes idle
   * (memory-pressure reinit, ported from the old `pyodide.bridge.ts`).
   */
  readonly heapPressure: boolean;
  /** Absent only if the worker failed to collect timings (defensive). */
  readonly timings?: MorphologyTimings;
  /**
   * `Date.now()` on the worker just before posting this response. The client
   * subtracts it from its own `Date.now()` at receipt to measure how long
   * the response sat waiting for the MAIN thread's event loop — the
   * decisive split between "worker was slow" and "main thread was busy".
   */
  readonly respondedAtEpochMs?: number;
}
