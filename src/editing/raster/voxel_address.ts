/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { PatchedSegmentationRenderLayer } from "#src/editing/patched_segmentation_renderlayer.js";
import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import type { MouseSelectionState } from "#src/layer/index.js";
import { getChunkPositionFromCombinedGlobalLocalPositions } from "#src/render_coordinate_transform.js";

export interface VoxelAddress {
  /** Integer chunk grid position (3 elements). */
  chunkGridPosition: Float32Array;
  /** Integer voxel offset within the chunk (3 elements, < chunkDataSize). */
  localOffset: Uint32Array;
  /** Chunk data size for the chunk that contains this voxel. */
  chunkDataSize: Uint32Array;
}

/**
 * Resolves the mouse's global position to a voxel address inside the
 * segmentation layer's patched render-layer chunk grid. Returns undefined if
 * the layer is not ready (transform missing, no chunk drawn yet, or position
 * lies outside the loaded grid).
 */
export function resolveVoxelAddress(
  layer: SegmentationUserLayer,
  patchedLayer: PatchedSegmentationRenderLayer,
  mouseState: MouseSelectionState,
): VoxelAddress | undefined {
  if (!mouseState.active) return undefined;
  // Pick the highest-resolution source visible to the patched render layer.
  // visibleSourcesList is sorted by chunkToLayerTransformDet (smallest first),
  // so element 0 is the finest scale.
  const visible = patchedLayer.visibleSourcesList;
  if (visible.length === 0) return undefined;
  const { source, chunkTransform } = visible[0];
  const chunkDataSize = source.spec.chunkDataSize;
  const rank = chunkDataSize.length;
  // Compute layer-local chunk-space voxel position.
  const chunkPosition = new Float32Array(
    chunkTransform.modelTransform.unpaddedRank,
  );
  if (
    !getChunkPositionFromCombinedGlobalLocalPositions(
      chunkPosition,
      mouseState.unsnappedPosition,
      layer.localPosition.value,
      chunkTransform.layerRank,
      chunkTransform.combinedGlobalLocalToChunkTransform,
    )
  ) {
    return undefined;
  }
  // chunkGridPosition matches the FULL source rank (so its key joins
  // identically to `chunk.chunkGridPosition.join(",")` in the render layer);
  // localOffset is fixed at 3 elements (x, y, z within the chunk) — that's
  // all the patch texture is indexed by.
  const chunkGridPosition = new Float32Array(rank);
  const localOffset = new Uint32Array(3);
  for (let i = 0; i < rank; ++i) {
    const v = Math.floor(chunkPosition[i] ?? 0);
    const sz = chunkDataSize[i] || 1;
    const grid = Math.floor(v / sz);
    chunkGridPosition[i] = grid;
    if (i < 3) localOffset[i] = v - grid * sz;
  }
  return { chunkGridPosition, localOffset, chunkDataSize };
}
