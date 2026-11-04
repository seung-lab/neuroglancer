/**
 * @license
 * Copyright 2026 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { scaleByExp10, supportedUnits } from "#src/util/si_units.js";
import type { WatershedResult } from "#src/watershed/base.js";
import { validateWatershedShape } from "#src/watershed/base.js";

export const WATERSHED_TILE_RPC_ID = "watershed/tile";
/** Per ChunkManager; private snapshots and metadata, not render caches. */
export const WATERSHED_RESULT_MEMORY_LIMIT = 128 * 1024 * 1024;
export type WatershedResultInfo = Omit<WatershedResult, "data">;
export interface LiveWatershedInfo extends WatershedResultInfo {
  readonly chunkShapeXYZ: readonly number[];
}

export class VolumeSourceParameters {
  resultId: string;
  live?: boolean;
  static RPC_ID = "watershed/VolumeChunkSource";
}

export function missingWatershedResult(resultId: string): Error {
  return new Error(
    `Watershed result ${resultId} is unavailable (disposed or from another session). Rerun watershed.`,
  );
}

export function parseWatershedUrl(url: string): string {
  const match = /^watershed:\/\/([a-f0-9]+)$/.exec(url);
  if (match === null) throw new Error("Invalid watershed result URL");
  return match[1];
}

/** Validate detached metadata, including the units used by coordinate spaces. */
function getSpatialInfo(result: WatershedResultInfo): WatershedResultInfo {
  for (const vector of [
    result.shapeXYZ,
    result.offsetXYZ,
    result.spacingXYZ,
    result.unitsXYZ,
  ]) {
    if (!Array.isArray(vector) || vector.length !== 3) {
      throw new Error("Watershed metadata must contain XYZ triples");
    }
  }
  // Validate the copies, not mutable caller arrays. Array.from also fills holes.
  const shapeXYZ = Object.freeze(Array.from(result.shapeXYZ));
  const offsetXYZ = Object.freeze(Array.from(result.offsetXYZ));
  const spacingXYZ = Object.freeze(Array.from(result.spacingXYZ));
  const unitsXYZ = Object.freeze(Array.from(result.unitsXYZ));
  // Native-grid origins may be scaled/fractional; they are not chunk offsets.
  if (!offsetXYZ.every(Number.isFinite)) {
    throw new Error("Watershed offset must contain finite XYZ coordinates");
  }
  if (!spacingXYZ.every((x) => Number.isFinite(x) && x > 0)) {
    throw new Error("Watershed spacing must be finite and positive");
  }
  if (!unitsXYZ.every((x) => typeof x === "string" && supportedUnits.has(x))) {
    throw new Error("Unsupported watershed spatial units");
  }
  for (let i = 0; i < 3; ++i) {
    const scale = scaleByExp10(
      spacingXYZ[i],
      supportedUnits.get(unitsXYZ[i])!.exponent,
    );
    if (!Number.isFinite(scale) || scale <= 0) {
      throw new Error(
        "Watershed spacing must be finite and positive in canonical units",
      );
    }
  }
  return Object.freeze({ shapeXYZ, offsetXYZ, spacingXYZ, unitsXYZ });
}

export function getWatershedResultInfo(
  result: WatershedResult,
): WatershedResultInfo {
  if (!(result.data instanceof Uint32Array)) {
    throw new Error("Watershed data must be Uint32Array XYZ");
  }
  const info = getSpatialInfo(result);
  const voxels = validateWatershedShape(info.shapeXYZ);
  if (result.data.length !== voxels) {
    throw new Error("Watershed data length does not match XYZ shape");
  }
  return info;
}

/** Metadata only: the compute voxel limit applies to the shared viewport region,
 * not to the full output domain or to independently numbered display chunks. */
export function getLiveWatershedInfo(
  result: LiveWatershedInfo,
): LiveWatershedInfo {
  const info = getSpatialInfo(result);
  if (!info.shapeXYZ.every((x) => Number.isSafeInteger(x) && x > 0)) {
    throw new Error("Watershed shape must contain three positive XYZ integers");
  }
  if (info.unitsXYZ.some((x) => supportedUnits.get(x)!.exponent !== 0)) {
    throw new Error("Live watershed spatial units must be canonical");
  }
  if (
    !Array.isArray(result.chunkShapeXYZ) ||
    result.chunkShapeXYZ.length !== 3
  ) {
    throw new Error("Watershed chunk shape must contain positive XYZ integers");
  }
  const chunkShapeXYZ = Object.freeze(Array.from(result.chunkShapeXYZ));
  if (
    !chunkShapeXYZ.every((x) => Number.isSafeInteger(x) && x > 0 && x < 2 ** 32)
  ) {
    throw new Error("Watershed chunk shape must contain positive XYZ integers");
  }
  validateWatershedShape(
    chunkShapeXYZ.map((x, i) => Math.min(x, info.shapeXYZ[i])),
  );
  return Object.freeze({ ...info, chunkShapeXYZ });
}

/** Require exactly one aligned, possibly clipped local output tile. */
export function validateLiveWatershedChunkBounds(
  info: LiveWatershedInfo,
  lowerXYZ: readonly number[],
  sizeXYZ: readonly number[],
): number {
  if (
    !Array.isArray(lowerXYZ) ||
    !Array.isArray(sizeXYZ) ||
    lowerXYZ.length !== 3 ||
    sizeXYZ.length !== 3
  ) {
    throw new Error("Watershed chunk bounds must be XYZ triples");
  }
  for (let i = 0; i < 3; ++i) {
    if (
      !Number.isSafeInteger(lowerXYZ[i]) ||
      lowerXYZ[i] < 0 ||
      lowerXYZ[i] >= info.shapeXYZ[i] ||
      lowerXYZ[i] % info.chunkShapeXYZ[i] !== 0 ||
      sizeXYZ[i] !==
        Math.min(info.chunkShapeXYZ[i], info.shapeXYZ[i] - lowerXYZ[i])
    ) {
      throw new Error("Live watershed chunk is outside aligned tile bounds");
    }
  }
  return validateWatershedShape(sizeXYZ);
}

/**
 * Pack a clipped XYZ box from X-fastest storage into a fresh transferable tile.
 * The authoritative snapshot must never be transferred, even for a full tile.
 */
export function copyWatershedResultChunk(
  data: Uint32Array,
  shapeXYZ: readonly number[],
  lowerXYZ: ArrayLike<number>,
  sizeXYZ: ArrayLike<number>,
): Uint32Array {
  if (!(data instanceof Uint32Array)) {
    throw new Error("Watershed data must be Uint32Array XYZ");
  }
  if (!Array.isArray(shapeXYZ)) {
    throw new Error("Watershed shape must contain three positive XYZ integers");
  }
  const voxels = validateWatershedShape(Array.from(shapeXYZ));
  if (data.length !== voxels) {
    throw new Error("Watershed data length does not match XYZ shape");
  }
  if (lowerXYZ.length !== 3 || sizeXYZ.length !== 3) {
    throw new Error("Watershed chunk bounds must be XYZ triples");
  }
  for (let i = 0; i < 3; ++i) {
    if (
      !Number.isSafeInteger(lowerXYZ[i]) ||
      lowerXYZ[i] < 0 ||
      !Number.isSafeInteger(sizeXYZ[i]) ||
      sizeXYZ[i] <= 0 ||
      lowerXYZ[i] + sizeXYZ[i] > shapeXYZ[i]
    ) {
      throw new Error("Watershed chunk is outside result bounds");
    }
  }
  const [width, height] = shapeXYZ;
  const [x0, y0, z0] = Array.from(lowerXYZ);
  const [nx, ny, nz] = Array.from(sizeXYZ);
  const copy = new Uint32Array(nx * ny * nz);
  let offset = 0;
  for (let z = z0; z < z0 + nz; ++z) {
    for (let y = y0; y < y0 + ny; ++y) {
      const start = (z * height + y) * width + x0;
      copy.set(data.subarray(start, start + nx), offset);
      offset += nx;
    }
  }
  return copy;
}
