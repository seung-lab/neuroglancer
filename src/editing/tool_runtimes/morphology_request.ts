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
}
