/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { VoxelTriple } from "#src/editing/tool_runtimes/mask_coord.js";

export type ImageScalar = ArrayLike<number> | ArrayLike<bigint>;

export interface MaskBuffer {
  readonly data: Uint8Array;
  readonly shape: VoxelTriple;
}

function linear(shape: VoxelTriple, x: number, y: number, z: number): number {
  return x + shape[0] * (y + shape[1] * z);
}

/**
 * Build a 1/0 mask buffer by thresholding `imageValues` (in row-major
 * (x, y, z) order, shape = `shape`) against an inclusive band
 * `[low, high]`. For BigUint64Array inputs, the threshold band is
 * compared via `Number(value)` — precision loss above 2^53 is acceptable
 * for thresholding (and uint64 mask images are rejected upstream).
 */
export function computeThresholdMask(
  imageValues: ImageScalar,
  shape: VoxelTriple,
  thresholdLow: number,
  thresholdHigh: number,
): MaskBuffer {
  const total = shape[0] * shape[1] * shape[2];
  if (imageValues.length !== total) {
    throw new Error(
      `mask_compute: imageValues length ${imageValues.length} != shape volume ${total}`,
    );
  }
  const data = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    const raw = imageValues[i];
    const v = typeof raw === "bigint" ? Number(raw) : raw;
    data[i] = v >= thresholdLow && v <= thresholdHigh ? 1 : 0;
  }
  return { data, shape };
}

/**
 * 3D binary closing: `iterations` rounds of 6-connected dilation followed
 * by `iterations` rounds of 6-connected erosion. Matches scipy
 * `binary_closing(iterations=N, structure=cross3d)`. `iterations === 0` is
 * a no-op (returns `mask` unchanged).
 *
 * Voxels outside the buffer are treated as 0 for dilation and 0 for
 * erosion — equivalent to "border = false" — so morphology near the
 * window edge is approximate. The caller supplies a halo big enough to
 * cover the stamp footprint at `iterations` voxels of padding.
 */
export function binaryClose3D(
  mask: MaskBuffer,
  iterations: number,
): MaskBuffer {
  if (iterations <= 0) return mask;
  let current = mask.data;
  const shape = mask.shape;
  for (let i = 0; i < iterations; i++) {
    current = dilate6(current, shape);
  }
  for (let i = 0; i < iterations; i++) {
    current = erode6(current, shape);
  }
  return { data: current, shape };
}

function dilate6(src: Uint8Array, shape: VoxelTriple): Uint8Array {
  const [sx, sy, sz] = shape;
  const dst = new Uint8Array(src.length);
  for (let z = 0; z < sz; z++) {
    for (let y = 0; y < sy; y++) {
      for (let x = 0; x < sx; x++) {
        const i = linear(shape, x, y, z);
        if (src[i] === 1) {
          dst[i] = 1;
          continue;
        }
        // Set 1 if any 6-connected neighbor is 1.
        if (x > 0 && src[i - 1] === 1) {
          dst[i] = 1;
          continue;
        }
        if (x + 1 < sx && src[i + 1] === 1) {
          dst[i] = 1;
          continue;
        }
        if (y > 0 && src[i - sx] === 1) {
          dst[i] = 1;
          continue;
        }
        if (y + 1 < sy && src[i + sx] === 1) {
          dst[i] = 1;
          continue;
        }
        if (z > 0 && src[i - sx * sy] === 1) {
          dst[i] = 1;
          continue;
        }
        if (z + 1 < sz && src[i + sx * sy] === 1) {
          dst[i] = 1;
        }
      }
    }
  }
  return dst;
}

function erode6(src: Uint8Array, shape: VoxelTriple): Uint8Array {
  const [sx, sy, sz] = shape;
  const dst = new Uint8Array(src.length);
  for (let z = 0; z < sz; z++) {
    for (let y = 0; y < sy; y++) {
      for (let x = 0; x < sx; x++) {
        const i = linear(shape, x, y, z);
        if (src[i] !== 1) continue;
        // Border voxels: any out-of-bounds neighbor treated as 0 ⇒ erode.
        if (x === 0 || src[i - 1] !== 1) continue;
        if (x + 1 === sx || src[i + 1] !== 1) continue;
        if (y === 0 || src[i - sx] !== 1) continue;
        if (y + 1 === sy || src[i + sx] !== 1) continue;
        if (z === 0 || src[i - sx * sy] !== 1) continue;
        if (z + 1 === sz || src[i + sx * sy] !== 1) continue;
        dst[i] = 1;
      }
    }
  }
  return dst;
}

/**
 * Zero out 6-connected components whose voxel count is strictly less than
 * `minSize`. Operates in place on `mask.data`. `minSize <= 1` is a no-op
 * (every nonzero voxel is its own component of size >= 1).
 */
export function filterComponentsByMinSize(
  mask: MaskBuffer,
  minSize: number,
): void {
  if (minSize <= 1) return;
  const { data, shape } = mask;
  const [sx, sy, sz] = shape;
  const visited = new Uint8Array(data.length);
  const queue: number[] = [];
  for (let start = 0; start < data.length; start++) {
    if (data[start] !== 1 || visited[start] === 1) continue;
    // BFS this component.
    visited[start] = 1;
    queue.length = 0;
    queue.push(start);
    let head = 0;
    while (head < queue.length) {
      const idx = queue[head++];
      const z = Math.floor(idx / (sx * sy));
      const y = Math.floor((idx - z * sx * sy) / sx);
      const x = idx - z * sx * sy - y * sx;
      if (x > 0) {
        const n = idx - 1;
        if (data[n] === 1 && visited[n] === 0) {
          visited[n] = 1;
          queue.push(n);
        }
      }
      if (x + 1 < sx) {
        const n = idx + 1;
        if (data[n] === 1 && visited[n] === 0) {
          visited[n] = 1;
          queue.push(n);
        }
      }
      if (y > 0) {
        const n = idx - sx;
        if (data[n] === 1 && visited[n] === 0) {
          visited[n] = 1;
          queue.push(n);
        }
      }
      if (y + 1 < sy) {
        const n = idx + sx;
        if (data[n] === 1 && visited[n] === 0) {
          visited[n] = 1;
          queue.push(n);
        }
      }
      if (z > 0) {
        const n = idx - sx * sy;
        if (data[n] === 1 && visited[n] === 0) {
          visited[n] = 1;
          queue.push(n);
        }
      }
      if (z + 1 < sz) {
        const n = idx + sx * sy;
        if (data[n] === 1 && visited[n] === 0) {
          visited[n] = 1;
          queue.push(n);
        }
      }
    }
    if (queue.length < minSize) {
      for (let j = 0; j < queue.length; j++) {
        data[queue[j]] = 0;
      }
    }
  }
}

export interface MaskPipelineInput {
  readonly imageValues: ImageScalar;
  readonly shape: VoxelTriple;
  readonly thresholdLow: number;
  readonly thresholdHigh: number;
  readonly binaryClosing: number;
  readonly minComponentSize: number;
  /**
   * When false (default): threshold → close → component filter. When true:
   * component filter → close → threshold. Operationally, the field-name
   * "first" refers to the component-filter pass running before threshold:
   * the unthresholded image is binarized as `value > 0`, components are
   * filtered by size, the kept components are then thresholded per-voxel
   * against the band. v1 semantics — documented limitation: with
   * `filterComponentsFirst=true`, the `value > 0` foreground definition
   * is fixed and not user-configurable. (Future work could expose a
   * separate "presence" threshold.)
   */
  readonly filterComponentsFirst: boolean;
}

/**
 * Run the full mask pipeline. Returns a fresh `Uint8Array` shaped like
 * `input.shape`, with 1 where the voxel should be painted and 0 elsewhere.
 */
export function applyMaskPipeline(input: MaskPipelineInput): MaskBuffer {
  if (input.filterComponentsFirst) {
    // Presence: value > 0.
    const presence = computeThresholdMask(
      input.imageValues,
      input.shape,
      Number.MIN_VALUE,
      Number.POSITIVE_INFINITY,
    );
    let working = presence;
    if (input.minComponentSize > 1) {
      filterComponentsByMinSize(working, input.minComponentSize);
    }
    if (input.binaryClosing > 0) {
      working = binaryClose3D(working, input.binaryClosing);
    }
    // Now AND the kept presence with the threshold band per voxel.
    const banded = computeThresholdMask(
      input.imageValues,
      input.shape,
      input.thresholdLow,
      input.thresholdHigh,
    );
    for (let i = 0; i < banded.data.length; i++) {
      banded.data[i] = banded.data[i] & working.data[i];
    }
    return banded;
  }

  let working = computeThresholdMask(
    input.imageValues,
    input.shape,
    input.thresholdLow,
    input.thresholdHigh,
  );
  if (input.binaryClosing > 0) {
    working = binaryClose3D(working, input.binaryClosing);
  }
  if (input.minComponentSize > 1) {
    filterComponentsByMinSize(working, input.minComponentSize);
  }
  return working;
}
