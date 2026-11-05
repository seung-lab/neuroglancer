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

export const MAX_WATERSHED_VOXELS = 2 ** 21;

export interface WatershedOptions {
  readonly highThreshold: number;
  readonly lowThreshold: number;
  readonly sizeThreshold: number;
  readonly dustThreshold: number;
  /** Optional last-channel background mask: keep values strictly below this. */
  readonly maskThreshold?: number;
  /** Optional post-watershed mean-affinity agglomeration; zero enables it. */
  readonly aggThreshold?: number;
}

export const DEFAULT_WATERSHED_OPTIONS: WatershedOptions = Object.freeze({
  highThreshold: 0.99999,
  lowThreshold: 0.00005,
  sizeThreshold: 50,
  dustThreshold: 50,
});

export interface WatershedResult {
  /** XYZ storage, X fastest. Zero is background, positive labels are ROI-local. */
  readonly data: Uint32Array;
  readonly shapeXYZ: readonly number[];
  /** Origin in the output voxel grid; not a physical translation. */
  readonly offsetXYZ: readonly number[];
  readonly spacingXYZ: readonly number[];
  readonly unitsXYZ: readonly string[];
}

/** Keep the reproducible corresponding source available in production builds. */
export const ABISS_WATERSHED_SOURCE_URL = new URL(
  "./abiss/abiss-watershed-source.tar.gz",
  import.meta.url,
).href;
export const ABISS_WATERSHED_LICENSE_URL = new URL(
  "./abiss/LICENSE",
  import.meta.url,
).href;

export function validateWatershedShape(shapeXYZ: readonly number[]): number {
  if (
    shapeXYZ.length !== 3 ||
    !Array.from(shapeXYZ).every((x) => Number.isSafeInteger(x) && x > 0)
  ) {
    throw new Error("Watershed shape must contain three positive XYZ integers");
  }
  const voxels = shapeXYZ.reduce((a, b) => a * b, 1);
  if (!Number.isSafeInteger(voxels) || voxels > MAX_WATERSHED_VOXELS) {
    throw new Error("Watershed ROI exceeds the 2**21 voxel limit");
  }
  return voxels;
}

export function validateWatershedOptions(options: WatershedOptions): void {
  // The native ABI receives float32 thresholds. Reject values that collapse to
  // equal thresholds there, rather than passing a subtly different problem.
  const high = Math.fround(options.highThreshold);
  const low = Math.fround(options.lowThreshold);
  if (
    !Number.isFinite(options.highThreshold) ||
    !Number.isFinite(options.lowThreshold) ||
    options.lowThreshold < 0 ||
    options.highThreshold > 1 ||
    !(low < high)
  ) {
    throw new Error(
      "Watershed thresholds must satisfy 0 <= low < high <= 1 in float32",
    );
  }
  if (
    options.maskThreshold !== undefined &&
    (!Number.isFinite(options.maskThreshold) ||
      options.maskThreshold < 0 ||
      options.maskThreshold > 1)
  ) {
    throw new Error("Watershed mask threshold must be finite and in [0,1]");
  }
  if (
    options.aggThreshold !== undefined &&
    (!Number.isFinite(options.aggThreshold) ||
      options.aggThreshold < 0 ||
      options.aggThreshold > 1)
  ) {
    throw new Error(
      "Watershed agglomeration threshold must be finite and in [0,1]",
    );
  }
  for (const value of [options.sizeThreshold, options.dustThreshold]) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new Error(
        "Watershed size and dust thresholds must be uint32 integers",
      );
    }
  }
}

export function validateWatershedChannels(
  channelCount: number,
  channelsXYZ: readonly number[],
  options: WatershedOptions,
): void {
  if (
    channelsXYZ.length !== 3 ||
    Array.from(channelsXYZ).some(
      (c) => !Number.isSafeInteger(c) || c < 0 || c >= channelCount,
    )
  ) {
    throw new Error("Watershed needs three in-bounds affinity channels");
  }
  if (options.maskThreshold !== undefined) {
    if (channelCount < 4)
      throw new Error(
        "Last-channel masking requires at least four source channels",
      );
    if (channelsXYZ.includes(channelCount - 1))
      throw new Error(
        "The last input channel is a mask, not an affinity channel",
      );
  }
}
