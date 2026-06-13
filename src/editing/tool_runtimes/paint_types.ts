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
} from "@zettaai/edit-session";

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

export interface FillInput {
  readonly targetLayerId: LayerId;
  readonly targetResolution: Resolution;
  readonly metadata: LayerMetadata;
  readonly seedVoxelPosition: readonly [number, number, number];
  readonly value: number | bigint;
  /** Optional cap; implementations report `truncated` on the result. */
  readonly maxVoxels?: number;
  readonly readChunk: (chunkId: ChunkId) => Promise<ReadonlyChunkVoxelBuffer>;
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
    readonly reason: "max-voxels" | "out-of-bounds";
    readonly voxelsWritten: number;
  };
}

export interface PaintCompute {
  /** Single brush stamp centred at `voxelPosition`. */
  applyBrush(input: BrushApplyInput): Promise<PaintWriteBatch>;
  /** Interpolated brush stamps along a line from `from` to `to`. */
  applyBrushStroke(input: BrushStrokeInput): Promise<PaintWriteBatch>;
  /** 3D connected-component fill seeded at `seedVoxelPosition`. */
  fill3d(input: FillInput): Promise<PaintWriteBatch>;
}
