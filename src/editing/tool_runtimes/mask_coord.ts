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
  // The chunk grid is anchored on the image's `voxelOffset` (the backend's
  // `voxel_offset`), so the returned chunk indices are the backend-native ones
  // the chunk source fetches — `chunkIndex = floor((globalVoxel - offset) /
  // chunkSize)`. The image voxel range here is GLOBAL (it includes the offset,
  // since it comes from the global nm frame), so without subtracting the offset
  // every fetch would land `offset/chunkSize` chunks away — the masked brush
  // would threshold against EM data from the wrong location. No-op for
  // offset-free images.
  const off = scale.voxelOffset;
  const gx0 = Math.floor((loImageVoxel[0] - off[0]) / cs[0]);
  const gy0 = Math.floor((loImageVoxel[1] - off[1]) / cs[1]);
  const gz0 = Math.floor((loImageVoxel[2] - off[2]) / cs[2]);
  // `hi` is exclusive — last chunk index is `floor((hi - 1) / cs)`.
  const gx1 = Math.floor((hiImageVoxelExclusive[0] - 1 - off[0]) / cs[0]);
  const gy1 = Math.floor((hiImageVoxelExclusive[1] - 1 - off[1]) / cs[1]);
  const gz1 = Math.floor((hiImageVoxelExclusive[2] - 1 - off[2]) / cs[2]);
  for (let gz = gz0; gz <= gz1; gz++) {
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        out.push({ x: gx, y: gy, z: gz });
      }
    }
  }
  return out;
}

/** Largest value a `uint64` voxel can hold (2^64 − 1). */
export const UINT64_MAX = 2n ** 64n - 1n;

/**
 * Inclusive value range for every `VoxelDataType` except `uint64`, whose
 * range exceeds `Number` precision and is represented by {@link UINT64_MAX}.
 * Shared frozen objects so callers (including the per-voxel write path) can
 * read a range without allocating on every lookup.
 */
const VOXEL_DATA_TYPE_RANGES: Readonly<
  Record<
    Exclude<VoxelDataType, "uint64">,
    { readonly min: number; readonly max: number }
  >
> = {
  uint8: { min: 0, max: 0xff },
  int8: { min: -0x80, max: 0x7f },
  uint16: { min: 0, max: 0xffff },
  int16: { min: -0x8000, max: 0x7fff },
  uint32: { min: 0, max: 0xffffffff },
  int32: { min: -0x80000000, max: 0x7fffffff },
  float32: { min: -Number.MAX_VALUE, max: Number.MAX_VALUE },
};

/**
 * Threshold range for a `VoxelDataType`. Returns `null` for `uint64` —
 * uint64 layers cannot be used as mask images (bigint comparisons against a
 * number threshold would lose precision).
 *
 * float32 has no fixed integer range; its bounds are `±Number.MAX_VALUE`, so
 * the caller decides how to use them (slider stops vs. plain text inputs).
 */
export function voxelDataTypeRange(
  type: VoxelDataType,
): { readonly min: number; readonly max: number } | null {
  return type === "uint64" ? null : VOXEL_DATA_TYPE_RANGES[type];
}

/**
 * Clamp a value to the representable range of `type`, so an out-of-range
 * value is pinned to the nearest bound rather than silently wrapping when
 * assigned into a typed array (e.g. `300` into `uint8` becomes `255`, not
 * `44`). Preserves bigint for `uint64` and number for every other type.
 */
export function clampToVoxelDataType(
  type: VoxelDataType,
  value: number | bigint,
): number | bigint {
  if (type === "uint64") {
    const v =
      typeof value === "bigint" ? value : BigInt(Math.trunc(Number(value)));
    return v < 0n ? 0n : v > UINT64_MAX ? UINT64_MAX : v;
  }
  const { min, max } = VOXEL_DATA_TYPE_RANGES[type];
  const n = typeof value === "bigint" ? Number(value) : value;
  return n < min ? min : n > max ? max : n;
}
