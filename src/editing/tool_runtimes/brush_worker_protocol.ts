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
 * The shared chunk slot a job writes into: `slot.data` lives at
 * `[byteOffset, byteOffset + elementCount*bytes)` of the shared `dataBuffer`.
 * The worker reconstructs the typed-array view (`viewForJob`) and writes in
 * place. It cooperatively stops if the shared `controlBuffer`'s generation word
 * no longer equals `generation` (the stroke was superseded).
 */
interface BrushSlotRef {
  readonly dataBuffer: SharedArrayBuffer;
  readonly byteOffset: number;
  readonly elementCount: number;
  readonly voxelDataType: BrushVoxelDataType;
  readonly chunkOrigin: Vec3;
  readonly chunkSize: Vec3;
  /** `Int32Array` control word; `[GENERATION_INDEX]` is the live generation. */
  readonly controlBuffer: SharedArrayBuffer;
  readonly generation: number;
}

/**
 * One tile of work: rasterize the swept-capsule / polyline `points` (radius,
 * value) into the chunk slot. The unmasked-brush worker unit (TM-322).
 */
export interface BrushRasterizeJob extends BrushSlotRef {
  readonly kind: "stroke";
  readonly points: readonly Vec3[];
  readonly radius: number;
  readonly value: number | bigint;
}

/**
 * One tile of work: stamp a precomputed footprint mask into the chunk slot —
 * write `value` where the shared, read-only mask bit is set (TM-317 Phase B).
 * The mask covers `[loTx, loTx+maskW) × [loTy, loTy+maskH)` on slice `cz` in
 * GLOBAL voxel coords. `maskBuffer` is a `SharedArrayBuffer` shared (never
 * transferred) across all of a footprint's tiles — the worker only reads it.
 */
export interface BrushMaskStampJob extends BrushSlotRef {
  readonly kind: "mask";
  readonly maskBuffer: SharedArrayBuffer;
  readonly maskW: number;
  readonly maskH: number;
  readonly loTx: number;
  readonly loTy: number;
  readonly cz: number;
  readonly value: number | bigint;
}

/** Either worker unit of work. */
export type BrushWorkerJob = BrushRasterizeJob | BrushMaskStampJob;

/** Main thread → worker. */
export interface BrushWorkerRequest {
  readonly id: number;
  readonly job: BrushWorkerJob;
}

/** Worker → main thread. `written === null` means nothing committable (miss/canceled). */
export type BrushWorkerResult =
  | { readonly id: number; readonly written: RasterizedSubregion | null }
  | { readonly id: number; readonly error: string };

/** Reconstruct the chunk's typed-array view over the shared slot buffer. */
export function viewForJob(job: BrushWorkerJob): VoxelView {
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

/** Reconstruct the read-only footprint mask view over the shared mask buffer. */
export function maskViewForJob(job: BrushMaskStampJob): Uint8Array {
  return new Uint8Array(job.maskBuffer, 0, job.maskW * job.maskH);
}
