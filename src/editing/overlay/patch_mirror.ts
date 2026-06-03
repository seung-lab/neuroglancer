/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type {
  EditSession,
  LayerId,
  OverlayCoord,
  ReadonlyChunkVoxelBuffer,
  Resolution,
} from "@zettaai/edit-session";
import { ChunkId } from "@zettaai/edit-session";

import type { NgLogger } from "#src/editing/adapters/ng_logger.js";
import type { LocalPatchStore } from "#src/editing/local_patch_store.js";
import { RefCounted } from "#src/util/disposable.js";

/**
 * Read the pristine baseline bytes for an overlay chunk — what the base
 * segmentation render layer would show absent any patches. PatchMirror
 * diffs overlay bytes against this to derive the per-voxel patched mask.
 */
export type BaselineChunkReader = (
  coord: OverlayCoord,
) => Promise<ReadonlyChunkVoxelBuffer>;

/**
 * One-way mirror that propagates dirty-chunk events from the library's
 * `EditOverlayStore` into a per-layer GPU `LocalPatchStore`. The mirror is
 * single-step (library -> GPU only) and never writes back. Created and torn
 * down by `EditSessionHost` per writable layer; coalescing of bursty writes
 * is handled inside `LocalPatchStore.scheduleGPUFlush`.
 *
 * The per-voxel patched mask is derived by comparing overlay bytes against
 * baseline bytes (the latter via `readBaseline`, which already folds in any
 * committed snapshot from a previous session). Voxels where
 * `overlay[i] !== baseline[i]` are marked patched. Voxels where the user
 * erased to the same value as baseline (e.g., erasing a baseline-0 voxel)
 * compare equal and stay unpatched — the visible result is identical to
 * "not patched", so the mask is correct in practice.
 */
export class PatchMirror extends RefCounted {
  private readonly chunkDataSizeByResolution = new Map<
    Resolution,
    readonly [number, number, number]
  >();

  constructor(
    private readonly session: EditSession,
    private readonly layerId: LayerId,
    private readonly store: LocalPatchStore,
    private readonly logger: NgLogger,
    private readonly readBaseline: BaselineChunkReader,
  ) {
    super();
    const unsubscribe = this.session.dirty.on("chunk-changed", (payload) => {
      if (payload.coord.layerId !== this.layerId) return;
      void this.syncChunk(payload.coord);
    });
    this.registerDisposer(() => unsubscribe());
  }

  private async syncChunk(coord: OverlayCoord): Promise<void> {
    const chunkKey = `${coord.layerId}|${coord.resolution}|${coord.chunkId}`;
    try {
      const chunkDataSize = this.resolveChunkDataSize(coord.resolution);
      if (chunkDataSize === undefined) {
        this.logger.error(
          "overlay",
          `PatchMirror sync failed for chunk ${chunkKey}: no chunkDataSize ` +
            `for resolution ${coord.resolution} on layer ${coord.layerId}`,
        );
        return;
      }
      const [overlayBuffer, baselineBuffer] = await Promise.all([
        this.session.overlay.read(coord),
        this.readBaseline(coord),
      ]);
      if (this.wasDisposed) return;
      const overlayData = toBigUint64Array(overlayBuffer);
      const baselineData = toBigUint64Array(baselineBuffer);
      const patched = derivePatchedMask(overlayData, baselineData);
      const { x, y, z } = ChunkId.toCoord(coord.chunkId);
      const chunkGridPosition = new Float32Array([x, y, z]);
      this.store.writeFullChunk(
        chunkGridPosition,
        chunkDataSize,
        overlayData,
        patched,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        "overlay",
        `PatchMirror sync failed for chunk ${chunkKey}: ${message}`,
      );
    }
  }

  private resolveChunkDataSize(
    resolution: Resolution,
  ): readonly [number, number, number] | undefined {
    const cached = this.chunkDataSizeByResolution.get(resolution);
    if (cached !== undefined) return cached;
    const baseline = this.session.baseline.perLayer.get(this.layerId);
    if (baseline === undefined) return undefined;
    const scale = baseline.metadata.scales.find(
      (s) => s.resolution === resolution,
    );
    if (scale === undefined) return undefined;
    const size: readonly [number, number, number] = [
      scale.chunkDataSize[0],
      scale.chunkDataSize[1],
      scale.chunkDataSize[2],
    ];
    this.chunkDataSizeByResolution.set(resolution, size);
    return size;
  }
}

function toBigUint64Array(buffer: ReadonlyChunkVoxelBuffer): BigUint64Array {
  // `LocalPatchStore` stores ONE BigUint64 per voxel (the GPU patch texture is
  // RG32UI = 64 bits per voxel). For sub-uint64 source types (uint8, uint16,
  // uint32), we widen each voxel to a BigUint64. Reinterpreting bytes as
  // BigUint64Array (the previous approach) was wrong: a 256×256×1 uint8 chunk
  // = 65 536 bytes which reinterprets to 8 192 BigUint64 elements — far short
  // of the 65 536 voxel slots LocalPatchStore expects.
  const view = buffer.asView();
  if (view instanceof BigUint64Array) {
    return view;
  }
  const out = new BigUint64Array(view.length);
  if (
    view instanceof Uint8Array ||
    view instanceof Uint16Array ||
    view instanceof Uint32Array
  ) {
    for (let i = 0; i < view.length; ++i) {
      out[i] = BigInt(view[i]);
    }
    return out;
  }
  if (
    view instanceof Int8Array ||
    view instanceof Int16Array ||
    view instanceof Int32Array
  ) {
    for (let i = 0; i < view.length; ++i) {
      // Mask off the sign bit when widening so negative values land in the
      // unsigned BigUint64 slot as their two's-complement representation.
      out[i] = BigInt(view[i] >>> 0);
    }
    return out;
  }
  throw new Error(
    `PatchMirror: unsupported voxel data type ${view.constructor.name}`,
  );
}

function derivePatchedMask(
  overlay: BigUint64Array,
  baseline: BigUint64Array,
): Uint8Array {
  if (overlay.length !== baseline.length) {
    throw new Error(
      `PatchMirror.derivePatchedMask: overlay length ${overlay.length} != ` +
        `baseline length ${baseline.length}`,
    );
  }
  const out = new Uint8Array(overlay.length);
  for (let i = 0; i < overlay.length; i++) {
    if (overlay[i] !== baseline[i]) out[i] = 1;
  }
  return out;
}
