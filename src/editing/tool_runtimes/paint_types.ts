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
 * Consumer-owned paint compute contract (TM-315 migration).
 *
 * These types used to live in `@zettaai/edit-session`
 * (`tools/painting/paint-compute.adapter.ts`). The library no longer ships
 * tools — the consumer owns the painting kernels (`PaintingCompute`), the
 * batch shape they produce, and the apply path (`paint_batch_apply.ts`) that
 * writes a batch through an `Edit`. The only library types referenced here are
 * the stable chunk/layer primitives the `Edit` write protocol itself uses.
 */

import type {
  ChunkCoord,
  ChunkId,
  ChunkSubregion,
  ChunkVoxelBuffer,
  LayerId,
  LayerMetadata,
  ReadonlyChunkVoxelBuffer,
  Resolution,
  SessionVoxelBounds,
} from "@zettaai/edit-session";

/**
 * Default fraction of in-band image voxels required to paint a target voxel
 * when the target resolution is coarser than the image resolution (TM-339).
 * `0.5` = majority. See {@link PaintingMaskConfig.coverageThreshold}.
 */
export const DEFAULT_COVERAGE_THRESHOLD = 0.5;

export interface PaintingMaskConfig {
  readonly imageLayerId: LayerId;
  /**
   * Resolution at which to read `imageLayerId` for thresholding. May differ
   * from the brush's `targetResolution` — e.g. mask at 32 nm while painting
   * at 16 nm. The host must ensure this resolution is pinned for
   * `imageLayerId`; nothing pins on its behalf.
   */
  readonly imageResolution: Resolution;
  readonly thresholdLow: number;
  readonly thresholdHigh: number;
  /**
   * Fraction (0, 1] of the image voxels a target voxel covers that must fall
   * inside `[thresholdLow, thresholdHigh]` for that target voxel to be painted
   * (TM-339). Only has an effect when the target resolution is COARSER than
   * `imageResolution` (so one target voxel covers a block of >1 image voxels);
   * at equal/finer target resolution the block is a single voxel and the test
   * reduces to the plain in-band check. `0.5` = majority, `1.0` = every covered
   * voxel in-band, →0 = any covered voxel in-band. Optional for back-compat
   * with persisted configs; absent ⇒ {@link DEFAULT_COVERAGE_THRESHOLD}.
   */
  readonly coverageThreshold?: number;
  readonly minComponentSize: number;
  readonly binaryClosing: number;
  readonly filterComponentsFirst: boolean;
}

export interface BrushApplyInput {
  readonly targetLayerId: LayerId;
  readonly targetResolution: Resolution;
  readonly metadata: LayerMetadata;
  /** Voxel position in `targetResolution` voxel coordinates. May be fractional. */
  readonly voxelPosition: readonly [number, number, number];
  readonly radius: number;
  readonly value: number | bigint;
  readonly mask?: PaintingMaskConfig;
  /**
   * `LayerMetadata` for `mask.imageLayerId`, resolved by the caller from the
   * host's per-layer metadata. Populated whenever `mask` is populated AND the
   * image layer's metadata is available; undefined otherwise. Compute
   * implementations that read `mask` should use `maskMetadata` to look up
   * `scaleFor(maskMetadata, mask.imageResolution)` for voxel size + chunk shape.
   */
  readonly maskMetadata?: LayerMetadata;
  /**
   * The resolutions the host opened (and preloads/pins) for `mask.imageLayerId`
   * in THIS session. When present and `mask.imageResolution` is not among them,
   * compute falls back to an unmasked stroke instead of cold-reading an
   * un-pinned scale from the layer's full datasource pyramid — a defense in
   * depth behind the host's restore-time repair (TM-350). Absent ⇒ no check
   * (back-compat with `PaintCompute` mocks and direct callers).
   */
  readonly maskAllowedResolutions?: readonly Resolution[];
  /** Lazy reader for adjacent chunk content at the target (layer, resolution). */
  readonly readChunk: (chunkId: ChunkId) => Promise<ReadonlyChunkVoxelBuffer>;
  /**
   * Cross-layer reader (e.g. for the mask layer named by
   * `PaintingMaskConfig.imageLayerId`). Routes through the host's chunk source
   * baseline read with no per-layer binding. Compute implementations that
   * ignore `mask` need not call it.
   */
  readonly readChunkAt: (
    layerId: LayerId,
    resolution: Resolution,
    chunkId: ChunkId,
  ) => Promise<ReadonlyChunkVoxelBuffer>;
}

export interface BrushStrokeInput
  extends Omit<BrushApplyInput, "voxelPosition"> {
  readonly from: readonly [number, number, number];
  readonly to: readonly [number, number, number];
  /**
   * Intermediate waypoints between `from` and `to` (oldest first), present
   * when the host coalesced several pointer positions into one stroke
   * segment. Implementations should rasterize the polyline
   * `from → …via → to` as one footprint so post-processing (e.g. morphology)
   * runs once over the union. Absent / empty => plain `from → to` segment.
   */
  readonly via?: readonly (readonly [number, number, number])[];
  /** Spacing between successive stamps along the interpolated line, in voxels at targetResolution. */
  readonly stepVoxels: number;
}

/**
 * Flood-fill connectivity mode (TM-269).
 *
 * - `"2d"`: 4-connected flood confined to the seed's XY slice (Z fixed). A
 *   circle drawn on one section fills only that section's interior — empty
 *   space enclosed on the slice is a finite component, and an open region is
 *   walled by the session bounds.
 * - `"3d"`: 6-connected flood propagating across sections (Z). The original
 *   behavior.
 */
export type FillMode = "2d" | "3d";

/** Progress report emitted as a progressive fill flushes (TM-269). */
export interface FillProgress {
  /** Voxels written so far (monotonic across the operation). */
  readonly voxelsWritten: number;
}

export interface FillInput {
  readonly targetLayerId: LayerId;
  readonly targetResolution: Resolution;
  readonly metadata: LayerMetadata;
  readonly seedVoxelPosition: readonly [number, number, number];
  readonly value: number | bigint;
  /** Connectivity mode — see {@link FillMode}. */
  readonly mode: FillMode;
  /**
   * Voxel bounds (half-open: `lo` inclusive, `hi` exclusive) the flood must not
   * cross — the session region at `targetResolution`. The flood is walled by
   * these, so an open 2D region terminates instead of expanding to the cap.
   */
  readonly bounds: SessionVoxelBounds;
  /** Optional cap; implementations report `truncated` on the result. */
  readonly maxVoxels?: number;
  readonly readChunk: (chunkId: ChunkId) => Promise<ReadonlyChunkVoxelBuffer>;
  /**
   * Apply a partial batch as the flood progresses (time-sliced). Called zero or
   * more times before the final returned batch; each call hands off the voxels
   * accumulated since the previous flush. The flood `await`s this so the caller
   * can write + yield a frame (keeping the UI responsive). The final remainder
   * is still returned from `fill` for the caller to apply.
   */
  readonly onFlush?: (batch: PaintWriteBatch) => Promise<void>;
  /** Progress callback fired after each flush. */
  readonly onProgress?: (progress: FillProgress) => void;
  /** Aborts the flood; `fill` rejects with the signal's reason when aborted. */
  readonly signal?: AbortSignal;
  /**
   * Override the progressive-flush cadence in ms (default ~12). Mainly a test
   * seam: `0` flushes after essentially every step so progressive behavior is
   * deterministic without depending on wall-clock timing.
   */
  readonly flushIntervalMs?: number;
  /**
   * Override the portable memory budget (bytes) the flood's visited bitmaps may
   * reach before it stops with a `truncated: "out-of-memory"` result, used only
   * where Chrome's `performance.memory` is unavailable. Mainly a test seam.
   */
  readonly memoryBudgetBytes?: number;
}

export interface PaintChunkWrite {
  readonly chunkId: ChunkId;
  readonly chunkCoord: ChunkCoord;
  readonly subregion: ChunkSubregion;
  /**
   * Dense voxel block of size `subregion.size` and the target layer's voxel
   * data type. The apply path writes these voxels into the chunk slot at
   * `subregion.origin`.
   */
  readonly values: ChunkVoxelBuffer;
  /**
   * Optional gating mask the same shape as `values` (one byte per voxel).
   * Non-zero entries are written; zero entries are skipped. Absent => write
   * every voxel in `values`.
   */
  readonly valueMask?: Uint8Array;
}

export interface PaintWriteBatch {
  readonly targetLayerId: LayerId;
  readonly targetResolution: Resolution;
  readonly chunks: readonly PaintChunkWrite[];
  readonly truncated?: {
    readonly reason: "max-voxels" | "out-of-bounds" | "out-of-memory";
    readonly voxelsWritten: number;
  };
}

/**
 * A masked-brush footprint resolved to a dense per-voxel mask on one z-slice
 * (TM-317 Phase B). `mask` is `1` where the brush should paint, dense and
 * x-fastest over `[loTx, loTx+maskW) × [loTy, loTy+maskH)` at z = `cz`, in
 * GLOBAL target voxel coordinates — the exact output of the pyodide
 * whole-pipeline compute. The worker pool stamps `value` into the overlay SAB
 * slots where the mask bit is set, so the main thread does neither the
 * sample-back nor the slot write.
 */
export interface StrokeFootprintMask {
  readonly loTx: number;
  readonly loTy: number;
  readonly maskW: number;
  readonly maskH: number;
  readonly cz: number;
  readonly mask: Uint8Array;
}

export interface PaintCompute {
  /** Single brush stamp centred at `voxelPosition`. */
  applyBrush(input: BrushApplyInput): Promise<PaintWriteBatch>;
  /** Interpolated brush stamps along a line from `from` to `to`. */
  applyBrushStroke(input: BrushStrokeInput): Promise<PaintWriteBatch>;
  /**
   * Connected-component fill seeded at `seedVoxelPosition`. 2D (seed slice) or
   * 3D depending on `input.mode`; progressive + cancelable (TM-269).
   */
  fill(input: FillInput): Promise<PaintWriteBatch>;
  /**
   * Compute the masked-brush footprint mask for a stroke via the pyodide
   * whole-pipeline, WITHOUT scattering it into a write batch — for the
   * worker-SAB apply route (TM-317 Phase B). Returns `null` when the stroke is
   * not eligible for that route (no mask, 1-voxel brush, z-varying path, the
   * pyodide worker is not ready, or the worker call failed), so the caller
   * falls back to the byte-identical `applyBrushStroke` + main-thread apply.
   * Optional so existing `PaintCompute` mocks need not implement it.
   */
  computeMaskedStrokeFootprint?(
    input: BrushStrokeInput,
  ): Promise<StrokeFootprintMask | null>;
}
