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

import { requestAsyncComputation } from "#src/async_computation/request.js";
import {
  validateWatershedOptions,
  validateWatershedShape,
  type WatershedOptions,
  type WatershedResult,
} from "#src/watershed/base.js";
import type { PreparedAffinityInput } from "#src/watershed/input.js";
import { watershedComputation } from "#src/watershed/request.js";

export async function computeWatershed(
  input: PreparedAffinityInput,
  lowerXYZ: readonly number[],
  shapeXYZ: readonly number[],
  channelsXYZ: readonly number[],
  options: WatershedOptions,
  signal: AbortSignal,
): Promise<WatershedResult> {
  const combinedSignal = AbortSignal.any([signal, input.signal]);
  combinedSignal.throwIfAborted();
  input.assertValid();
  const shape = [...shapeXYZ];
  const lower = [...lowerXYZ];
  const channels = [...channelsXYZ];
  const parameters = { ...options };
  const voxels = validateWatershedShape(shape);
  validateWatershedOptions(parameters);
  if (
    lower.length !== 3 ||
    lower.some(
      (x, i) =>
        !Number.isSafeInteger(x) ||
        x < input.lowerBoundXYZ[i] ||
        x + shape[i] > input.upperBoundXYZ[i],
    )
  )
    throw new Error("Watershed ROI must be inside the native source bounds");
  if (
    channels.length !== 3 ||
    new Set(channels).size !== 3 ||
    channels.some(
      (c) => !Number.isInteger(c) || c < 0 || c >= input.channelCount,
    )
  )
    throw new Error(
      "Watershed needs three distinct in-bounds affinity channels",
    );
  const affinities = await input.readRegion(
    lower,
    shape,
    channels,
    combinedSignal,
  );
  combinedSignal.throwIfAborted();
  input.assertValid();
  // Own the transferable, even if a custom input returned a shared/subarray buffer.
  const owned = Float32Array.from(affinities);
  // Keep the live queue's slot until an already-running synchronous kernel
  // finishes. Its consumer cancels immediately, independently of this promise.
  const data = await requestAsyncComputation(
    watershedComputation,
    combinedSignal,
    [owned.buffer],
    owned,
    shape,
    parameters,
  );
  combinedSignal.throwIfAborted();
  input.assertValid();
  if (!(data instanceof Uint32Array) || data.length !== voxels)
    throw new Error("Invalid watershed worker output");
  return {
    data,
    shapeXYZ: shape,
    offsetXYZ: lower.map((x, i) => x + input.originXYZ[i]),
    spacingXYZ: [...input.spacingXYZ],
    unitsXYZ: [...input.unitsXYZ],
  };
}
