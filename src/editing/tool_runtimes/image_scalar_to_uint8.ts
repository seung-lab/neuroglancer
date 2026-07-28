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
 * @file Normalize an image slice to `uint8` for the `propagate_mask` protocol.
 *
 * The backend consumes `image_dtype: "uint8"`, but a session's image layer may
 * be `uint16`, `float32`, a signed integer type, etc. This maps each scalar
 * onto `[0, 255]`:
 *  - `uint8` passes straight through (a copy, so the result owns its bytes);
 *  - integer types scale linearly across their representable range, with signed
 *    types shifted so their minimum lands on 0;
 *  - `float32` is assumed already normalized to `[0, 1]` (matching the old voxel
 *    editor) and scaled up, clamped to the byte range.
 *
 * `uint64` cannot be normalized meaningfully and is rejected — the same layers
 * that are unusable as mask images upstream.
 */

import type { VoxelDataType } from "@zettaai/edit-session";

import { voxelDataTypeRange } from "#src/editing/tool_runtimes/mask_coord.js";

/** Thrown when an image layer's data type cannot be normalized to `uint8`. */
export class UnsupportedImageDataTypeError extends Error {
  constructor(readonly dataType: VoxelDataType) {
    super(
      `Z-extrapolation cannot use a ${dataType} image layer; ` +
        `an 8/16/32-bit or float32 image is required.`,
    );
    this.name = "UnsupportedImageDataTypeError";
  }
}

/**
 * Convert an image slice of the given `dataType` into a `uint8` slice, voxel for
 * voxel (same length, same layout).
 *
 * @throws {UnsupportedImageDataTypeError} for `uint64`.
 */
export function imageScalarToUint8(
  values: ArrayLike<number>,
  dataType: VoxelDataType,
): Uint8Array {
  if (dataType === "uint8") {
    return Uint8Array.from(values);
  }

  const out = new Uint8Array(values.length);

  if (dataType === "float32") {
    for (let i = 0; i < values.length; i++) {
      out[i] = clampToByte(Math.round(values[i] * 255));
    }
    return out;
  }

  const range = voxelDataTypeRange(dataType);
  if (range === null) {
    throw new UnsupportedImageDataTypeError(dataType); // uint64
  }
  const { min, max } = range;
  const span = max - min;
  for (let i = 0; i < values.length; i++) {
    out[i] = clampToByte(Math.round(((values[i] - min) / span) * 255));
  }
  return out;
}

function clampToByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}
