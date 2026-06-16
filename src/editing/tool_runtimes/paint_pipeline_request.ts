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
 * Shared request/response contract for the pyodide **whole-pipeline** paint
 * compute (TM-317).
 *
 * Where {@link MorphologyRequest} (`morphology_request.ts`) offloads ONLY the
 * post-threshold morphology and keeps resample/threshold/sample-back on the
 * main thread, this request moves the entire masked-brush compute — resample
 * to image space, threshold band, circle/swept-capsule footprint, binary
 * closing, and connected-component filtering — into a single numpy/scipy pass
 * in the pyodide worker (matching the old voxel editor's `apply_brush`). The
 * main thread only assembles a footprint-bounded, native-dtype EM image slab
 * (one transfer in) and scatters the returned footprint mask into the existing
 * paint-batch/commit path (one transfer out).
 *
 * Imported by BOTH the main-thread client (`morphology_client.ts`) and the
 * worker handler (`morphology_handler.ts`), so it must stay free of any
 * neuroglancer imports that pull in DOM/GL — keep it bundle-portable.
 *
 * The worker mirrors the current main-thread masked compute in
 * `painting_compute.ts::stampShape2DMasked` (and its TS twin
 * `paint_pipeline_ts.ts`). The current main-thread path is retained as a
 * fallback when the worker is not yet ready or is unavailable.
 */

/** RPC method name for the whole-pipeline paint compute. */
export const PAINT_PIPELINE_RPC = "painting.applyPipeline";

/**
 * RPC method name for the readiness probe. Resolves once pyodide has booted
 * (numpy + scipy loaded). The client uses it to gate the whole-pipeline path
 * behind a non-blocking "worker ready" check so the cold-init window falls
 * back to the main-thread compute instead of stalling on the boot await.
 */
export const PAINT_PIPELINE_READY_RPC = "painting.ready";

/**
 * Non-`uint64` voxel data types. uint64 image layers cannot be thresholded
 * against a number band and are rejected upstream (`resolveMaskContext`), so
 * the image slab is always one of these. Kept as a string literal union so the
 * worker can map it to a numpy dtype without importing `@zettaai/edit-session`.
 */
export type PaintPipelineDataType =
  | "uint8"
  | "int8"
  | "uint16"
  | "int16"
  | "uint32"
  | "int32"
  | "float32";

/**
 * A native-dtype image slab. Concrete typed array whose element type matches
 * {@link PaintPipelineRequest.imageDataType}; its backing buffer is transferred
 * to the worker.
 */
export type ImageSlab =
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array;

export interface PaintPipelineRequest {
  /**
   * Footprint-bounded EM image slab for a single z-slice, in the image layer's
   * native dtype, row-major (x fastest) over the image-voxel region
   * `[loImageX, loImageX + imageShape[0]) × [loImageY, loImageY + imageShape[1])`.
   * Its backing `ArrayBuffer` is transferred to the worker, so the caller must
   * not reuse it after dispatch.
   */
  readonly image: ImageSlab;
  /** Image slab dimensions `[iSx, iSy]` (single z-slice). */
  readonly imageShape: readonly [number, number];
  readonly imageDataType: PaintPipelineDataType;
  /** Image-voxel origin of the slab (so the worker maps target → slab-local). */
  readonly loImageX: number;
  readonly loImageY: number;

  /** Target footprint origin in target-resolution voxel coords. */
  readonly loTx: number;
  readonly loTy: number;
  /** Target footprint dimensions `[tSx, tSy]`. */
  readonly targetShape: readonly [number, number];

  /**
   * target→image nm ratios per axis (`targetVoxelSizeNm / imageVoxelSizeNm`).
   * `sz` is used only to clarify intent; the worker resamples a single z-slice
   * computed by the caller, so only `sx`/`sy` affect the in-plane gather.
   */
  readonly sxRatio: number;
  readonly syRatio: number;
  readonly szRatio: number;

  /** Inclusive threshold band `[low, high]` (in image native units). */
  readonly thresholdLow: number;
  readonly thresholdHigh: number;

  /**
   * Footprint geometry: the swept-capsule polyline points in ABSOLUTE
   * target voxel coordinates (un-floored, matching the main-thread
   * `segmentDistanceSq` inputs), flattened as `[x0, y0, x1, y1, …]`. A single
   * point (length 2) is a disk; two points a capsule; more a polyline union.
   */
  readonly pathPoints: Float64Array;
  /** Brush radius in target voxels (already `floor`ed by the caller). */
  readonly radius: number;

  /** Binary-closing iterations; `0` skips closing. */
  readonly binaryClosing: number;
  /** Minimum connected-component voxel count; `<= 1` skips filtering. */
  readonly minComponentSize: number;
  /** `true`: filter components → close. `false`: close → filter components. */
  readonly filterComponentsFirst: boolean;

  /**
   * `Date.now()` on the client at dispatch — the one clock shared by both
   * threads, so the handler can measure transit + queue time. Diagnostics only.
   */
  readonly postedAtEpochMs?: number;
}

/**
 * Per-call worker-side phase timings (python `perf_counter` + worker-JS
 * `performance.now`). Mirrors {@link MorphologyTimings} but split for the
 * whole-pipeline stages.
 */
export interface PaintPipelineTimings {
  /** JS→python buffer copy + numpy array construction. */
  readonly marshalInMs: number;
  /** Resample (index arrays + `np.ix_` gather) + threshold + footprint gate. */
  readonly maskBuildMs: number;
  /** scipy `binary_closing`. 0 when closing is disabled. */
  readonly closingMs: number;
  /** scipy `label` + size filter. 0 when min-component-size is disabled. */
  readonly componentsMs: number;
  /** Result `astype(uint8).tobytes()`. */
  readonly marshalOutMs: number;
  /** Whole pyodide call as seen from worker JS (includes JS↔py bridging). */
  readonly workerCallMs: number;
  /** PyProxy(bytes) → Uint8Array conversion in worker JS. */
  readonly convertOutMs: number;
  /** Message transit + worker event-loop queue. Absent when no timestamp. */
  readonly requestQueueMs?: number;
  /** Time awaiting the pyodide boot promise (~0 warm; multi-second cold). */
  readonly bootWaitMs: number;
}

export interface PaintPipelineResponse {
  /**
   * Processed footprint mask, `Uint8Array` of length `tSx * tSy`, row-major
   * (x fastest), 1 = paint. Buffer transferred to the caller.
   */
  readonly mask: Uint8Array;
  /** Worker pyodide heap crossed its watermark → client should reinit on idle. */
  readonly heapPressure: boolean;
  readonly timings?: PaintPipelineTimings;
  /** `Date.now()` on the worker just before posting (response queue split). */
  readonly respondedAtEpochMs?: number;
}
