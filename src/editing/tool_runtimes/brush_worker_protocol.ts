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
 * Wire protocol shared by the brush worker pool (main thread) and the brush
 * worker handler (TM-322 phase 3 step 2).
 *
 * A job rasterizes one chunk-tile of an unmasked stroke directly into a
 * `SharedArrayBuffer`-backed chunk buffer (the edit overlay's `slot.data`). The
 * buffer is shared, never transferred, so the result carries no voxel data —
 * only the chunk-local bbox of what was written (for `commitWrites`). This
 * module is dependency-free at runtime (no `@zettaai/edit-session`) so it bundles
 * cleanly into the worker.
 */

import type {
  RasterizedSubregion,
  Vec3,
  VoxelView,
} from "#src/editing/tool_runtimes/paint_rasterize.js";

/** Voxel data types the brush can write (mirrors the library's `VoxelDataType`). */
export type BrushVoxelDataType =
  | "uint8"
  | "int8"
  | "uint16"
  | "int16"
  | "uint32"
  | "int32"
  | "float32"
  | "uint64";

/** Index of the current generation word in the control `Int32Array`. */
export const GENERATION_INDEX = 0;

/**
 * One tile of work: rasterize `points` (radius, value) into the chunk whose
 * `slot.data` lives at `[byteOffset, byteOffset + elementCount*bytes)` of the
 * shared `dataBuffer`. The worker reconstructs the same typed-array view and
 * writes in place. It cooperatively stops if the shared `controlBuffer`'s
 * generation word no longer equals `generation` (the stroke was superseded).
 */
export interface BrushRasterizeJob {
  readonly dataBuffer: SharedArrayBuffer;
  readonly byteOffset: number;
  readonly elementCount: number;
  readonly voxelDataType: BrushVoxelDataType;
  readonly points: readonly Vec3[];
  readonly radius: number;
  readonly value: number | bigint;
  readonly chunkOrigin: Vec3;
  readonly chunkSize: Vec3;
  /** `Int32Array` control word; `[GENERATION_INDEX]` is the live generation. */
  readonly controlBuffer: SharedArrayBuffer;
  readonly generation: number;
}

/** Main thread → worker. */
export interface BrushRasterizeRequest {
  readonly id: number;
  readonly job: BrushRasterizeJob;
}

/** Worker → main thread. `written === null` means nothing committable (miss/canceled). */
export type BrushRasterizeResult =
  | { readonly id: number; readonly written: RasterizedSubregion | null }
  | { readonly id: number; readonly error: string };

/** Reconstruct the chunk's typed-array view over the shared buffer. */
export function viewForJob(job: BrushRasterizeJob): VoxelView {
  const { dataBuffer: b, byteOffset: o, elementCount: n } = job;
  switch (job.voxelDataType) {
    case "uint8":
      return new Uint8Array(b, o, n);
    case "int8":
      return new Int8Array(b, o, n);
    case "uint16":
      return new Uint16Array(b, o, n);
    case "int16":
      return new Int16Array(b, o, n);
    case "uint32":
      return new Uint32Array(b, o, n);
    case "int32":
      return new Int32Array(b, o, n);
    case "float32":
      return new Float32Array(b, o, n);
    case "uint64":
      return new BigUint64Array(b, o, n);
  }
}
