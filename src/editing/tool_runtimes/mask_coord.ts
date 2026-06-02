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
  ChunkCoord,
  ScaleMetadata,
  VoxelDataType,
} from "@zettaai/edit-session";

export type VoxelTriple = readonly [number, number, number];

/**
 * Nearest-neighbor convert a voxel coord from the target (paint) resolution
 * into the image (mask) resolution. Supports any target:image ratio; common
 * cases: image coarser than target (multiple target voxels map to one image
 * voxel) and image finer than target (one target voxel maps inside a single
 * image voxel via floor).
 */
export function targetToImageVoxel(
  targetVoxel: VoxelTriple,
  targetVoxelSizeNm: VoxelTriple,
  imageVoxelSizeNm: VoxelTriple,
): readonly [number, number, number] {
  return [
    Math.floor((targetVoxel[0] * targetVoxelSizeNm[0]) / imageVoxelSizeNm[0]),
    Math.floor((targetVoxel[1] * targetVoxelSizeNm[1]) / imageVoxelSizeNm[1]),
    Math.floor((targetVoxel[2] * targetVoxelSizeNm[2]) / imageVoxelSizeNm[2]),
  ];
}

/**
 * Enumerate image chunk coords covering a closed-open voxel region
 * `[lo, hi)` at the image scale. Returns a list of `ChunkCoord`s whose
 * union of voxel extents covers the region.
 */
export function imageChunksCovering(
  loImageVoxel: VoxelTriple,
  hiImageVoxelExclusive: VoxelTriple,
  scale: ScaleMetadata,
): ChunkCoord[] {
  const out: ChunkCoord[] = [];
  if (
    hiImageVoxelExclusive[0] <= loImageVoxel[0] ||
    hiImageVoxelExclusive[1] <= loImageVoxel[1] ||
    hiImageVoxelExclusive[2] <= loImageVoxel[2]
  ) {
    return out;
  }
  const cs = scale.chunkDataSize;
  const gx0 = Math.floor(loImageVoxel[0] / cs[0]);
  const gy0 = Math.floor(loImageVoxel[1] / cs[1]);
  const gz0 = Math.floor(loImageVoxel[2] / cs[2]);
  // `hi` is exclusive — last chunk index is `floor((hi - 1) / cs)`.
  const gx1 = Math.floor((hiImageVoxelExclusive[0] - 1) / cs[0]);
  const gy1 = Math.floor((hiImageVoxelExclusive[1] - 1) / cs[1]);
  const gz1 = Math.floor((hiImageVoxelExclusive[2] - 1) / cs[2]);
  for (let gz = gz0; gz <= gz1; gz++) {
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        out.push({ x: gx, y: gy, z: gz });
      }
    }
  }
  return out;
}

/**
 * Threshold range for a `VoxelDataType`. Returns `null` for `uint64` —
 * uint64 layers cannot be used as mask images (bigint comparisons against a
 * number threshold would lose precision).
 *
 * float32 has no fixed range; the caller decides (use Number.MIN/MAX_VALUE
 * as the slider stops, or fall back to text inputs).
 */
export function voxelDataTypeRange(
  type: VoxelDataType,
): { readonly min: number; readonly max: number } | null {
  switch (type) {
    case "uint8":
      return { min: 0, max: 0xff };
    case "int8":
      return { min: -0x80, max: 0x7f };
    case "uint16":
      return { min: 0, max: 0xffff };
    case "int16":
      return { min: -0x8000, max: 0x7fff };
    case "uint32":
      return { min: 0, max: 0xffffffff };
    case "int32":
      return { min: -0x80000000, max: 0x7fffffff };
    case "float32":
      return { min: -Number.MAX_VALUE, max: Number.MAX_VALUE };
    case "uint64":
      return null;
  }
}
