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

export const PUBLISH_INFERENCE_RESULT_RPC_ID = "inference/publish";
export const DELETE_INFERENCE_RESULT_RPC_ID = "inference/delete";
export const CHECK_INFERENCE_RESULT_RPC_ID = "inference/check";
export const INFERENCE_TILE_RPC_ID = "inference/tile";
/** Fixed display chunks, independent of model prediction context geometry. */
export const LIVE_INFERENCE_TILE_SHAPE_ZYX = [16, 60, 60] as const;

/** Per ChunkManager; authoritative tensors + serialized metadata, not render caches. */
export const INFERENCE_RESULT_MEMORY_LIMIT = 512 * 1024 * 1024;
export const INFERENCE_METADATA_MEMORY_LIMIT = 1024 * 1024;
export const INFERENCE_CHANNELS = 4;

export type InferenceJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly InferenceJsonValue[]
  | { readonly [key: string]: InferenceJsonValue };

export interface InferenceResult {
  /** Batch-one NCDHW, X fastest; no batch dimension in the stored volume. */
  readonly data: Float32Array;
  /** Omitted by legacy four-channel publications. */
  readonly channels?: number;
  readonly shapeZYX: readonly number[];
  /** Integer origin in the OUTPUT voxel grid, not a physical translation. */
  readonly originZYX: readonly number[];
  readonly spacingZYX: readonly number[];
  readonly axisNamesZYX: readonly string[];
  /** Neuroglancer units, e.g. "m", "nm", or "" (unitless). */
  readonly unitsZYX: readonly string[];
  readonly provenance: InferenceJsonValue;
}

export interface InferenceResultInfo {
  readonly channels: number;
  readonly shapeZYX: readonly number[];
  readonly originZYX: readonly number[];
  readonly spacingZYX: readonly number[];
  readonly axisNamesZYX: readonly string[];
  readonly unitsZYX: readonly string[];
  /** Immutable JSON text: never included in the URL or viewer state. */
  readonly provenanceJson: string;
  readonly byteLength: number;
}

export class VolumeSourceParameters {
  resultId: string;
  static RPC_ID = "inference/VolumeChunkSource";
}

export function missingInferenceResult(resultId: string): Error {
  return new Error(
    `Inference result ${resultId} is unavailable (disposed or from another session). Rerun inference.`,
  );
}

export function parseInferenceUrl(url: string): string {
  const match = /^inference:\/\/([a-zA-Z0-9_-]+)$/.exec(url);
  if (match === null) throw new Error("Invalid inference result URL");
  return match[1];
}

/** Validate and snapshot metadata before allocating or transferring any tensor. */
export function getInferenceResultInfo(
  result: InferenceResult,
): InferenceResultInfo {
  const { data, shapeZYX } = result;
  if (!(data instanceof Float32Array)) {
    throw new Error("Inference data must be Float32Array NCDHW");
  }
  const info = getInferenceMetadataInfo(result);
  const elements = shapeZYX.reduce((a, b) => a * b, info.channels);
  if (!Number.isSafeInteger(elements * Float32Array.BYTES_PER_ELEMENT)) {
    throw new Error("Inference tensor byte count must be a safe integer");
  }
  if (elements !== data.length) {
    throw new Error(
      "Inference data length does not match channel count and NCDHW shape",
    );
  }
  return Object.freeze({
    ...info,
    byteLength: info.byteLength + data.byteLength,
  });
}

/** Live volumes validate metadata without allocating a volume-sized tensor. */
export function getInferenceMetadataInfo(
  result: Omit<InferenceResult, "data">,
): InferenceResultInfo {
  const { shapeZYX, originZYX, spacingZYX, axisNamesZYX, unitsZYX } = result;
  for (const vector of [
    shapeZYX,
    originZYX,
    spacingZYX,
    axisNamesZYX,
    unitsZYX,
  ]) {
    if (!Array.isArray(vector) || vector.length !== 3) {
      throw new Error("Inference metadata must contain ZYX triples");
    }
  }
  if (
    !shapeZYX.every((x) => Number.isSafeInteger(x) && x > 0 && x <= 2 ** 24)
  ) {
    throw new Error(
      "Inference shape must contain positive integer voxel counts <= 2^24",
    );
  }
  const channels =
    result.channels === undefined ? INFERENCE_CHANNELS : result.channels;
  if (!Number.isSafeInteger(channels) || channels <= 0) {
    throw new Error("Inference channels must be a positive safe integer");
  }
  // Live volumes allocate fixed display tiles, never a full-domain tensor.
  const tileBytes = LIVE_INFERENCE_TILE_SHAPE_ZYX.reduce<number>(
    (a, b) => a * b,
    channels * Float32Array.BYTES_PER_ELEMENT,
  );
  if (!Number.isSafeInteger(tileBytes)) {
    throw new Error("Inference tile byte count must be a safe integer");
  }
  if (!originZYX.every(Number.isSafeInteger)) {
    throw new Error(
      "Inference origin must contain safe integer output voxel indices",
    );
  }
  if (!originZYX.every((x, i) => Number.isSafeInteger(x + shapeZYX[i]))) {
    throw new Error("Inference upper voxel bounds must be safe integers");
  }
  if (!spacingZYX.every((x) => Number.isFinite(x) && x > 0)) {
    throw new Error("Inference spacing must be finite and positive");
  }
  if (
    !axisNamesZYX.every(
      (x) => typeof x === "string" && /^[a-zA-Z][a-zA-Z_0-9]*$/.test(x),
    ) ||
    new Set(axisNamesZYX).size !== 3
  ) {
    throw new Error(
      "Inference spatial axis names must be distinct global dimension names",
    );
  }
  if (!unitsZYX.every((x) => typeof x === "string" && supportedUnits.has(x))) {
    throw new Error("Unsupported inference spatial units");
  }
  for (let i = 0; i < 3; ++i) {
    const scale = scaleByExp10(
      spacingZYX[i],
      supportedUnits.get(unitsZYX[i])!.exponent,
    );
    if (!Number.isFinite(scale) || scale <= 0) {
      throw new Error(
        "Inference spacing must be finite and positive in canonical units",
      );
    }
  }
  // Reject lossy JSON serialization (undefined, NaN, typed arrays, etc.).
  function checkJson(x: InferenceJsonValue, depth = 0): void {
    if (depth > 64)
      throw new Error("Inference provenance is too deeply nested");
    if (x === null || typeof x === "string" || typeof x === "boolean") return;
    if (typeof x === "number" && Number.isFinite(x)) return;
    if (typeof x === "object") {
      if (Array.isArray(x)) {
        for (const value of x) checkJson(value, depth + 1);
        return;
      }
      if (
        Object.getPrototypeOf(x) === Object.prototype ||
        Object.getPrototypeOf(x) === null
      ) {
        for (const value of Object.values(x)) checkJson(value, depth + 1);
        return;
      }
    }
    throw new Error("Inference provenance must be JSON");
  }
  checkJson(result.provenance);
  const provenanceJson = JSON.stringify(result.provenance);
  const metadata = {
    channels,
    shapeZYX: Object.freeze([...shapeZYX]),
    originZYX: Object.freeze([...originZYX]),
    spacingZYX: Object.freeze([...spacingZYX]),
    axisNamesZYX: Object.freeze([...axisNamesZYX]),
    unitsZYX: Object.freeze([...unitsZYX]),
    provenanceJson,
  };
  const metadataBytes = new TextEncoder().encode(
    JSON.stringify(metadata),
  ).byteLength;
  if (metadataBytes > INFERENCE_METADATA_MEMORY_LIMIT) {
    throw new Error("Inference metadata exceeds the 1 MiB limit");
  }
  return Object.freeze({
    ...metadata,
    byteLength: metadataBytes,
  });
}

/**
 * Copy a clipped XYZC box from planar NCDHW storage. The fresh buffer may be
 * transferred by VolumeChunk.serialize without detaching authoritative data.
 */
export function copyInferenceResultChunk(
  data: Float32Array,
  shapeZYX: readonly number[],
  lowerXYZC: ArrayLike<number>,
  sizeXYZC: ArrayLike<number>,
  channels = INFERENCE_CHANNELS,
): Float32Array {
  if (!Number.isSafeInteger(channels) || channels <= 0)
    throw new Error("Inference channels must be a positive safe integer");
  const [depth, height, width] = shapeZYX;
  const elements = depth * height * width * channels;
  if (!Number.isSafeInteger(elements * 4) || elements !== data.length)
    throw new Error(
      "Inference data length does not match channel count and NCDHW shape",
    );
  const bounds = [width, height, depth, channels];
  if (lowerXYZC.length !== 4 || sizeXYZC.length !== 4) {
    throw new Error("Inference chunk bounds must be XYZC");
  }
  for (let i = 0; i < 4; ++i) {
    if (
      !Number.isSafeInteger(lowerXYZC[i]) ||
      lowerXYZC[i] < 0 ||
      !Number.isSafeInteger(sizeXYZC[i]) ||
      sizeXYZC[i] <= 0 ||
      lowerXYZC[i] + sizeXYZC[i] > bounds[i]
    ) {
      throw new Error("Inference chunk is outside result bounds");
    }
  }
  const [nx, ny, nz, nc] = Array.from(sizeXYZC);
  const [x0, y0, z0, c0] = Array.from(lowerXYZC);
  const out = new Float32Array(nx * ny * nz * nc);
  let offset = 0;
  for (let c = c0; c < c0 + nc; ++c) {
    for (let z = z0; z < z0 + nz; ++z) {
      for (let y = y0; y < y0 + ny; ++y) {
        const start = ((c * depth + z) * height + y) * width + x0;
        out.set(data.subarray(start, start + nx), offset);
        offset += nx;
      }
    }
  }
  return out;
}
