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

import {
  DEFAULT_WATERSHED_OPTIONS,
  validateWatershedOptions,
  validateWatershedShape,
  type WatershedOptions,
} from "#src/watershed/base.js";

interface WatershedExports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  malloc(bytes: number): number;
  free(pointer: number): void;
  abiss_watershed(
    affinityPointer: number,
    affinityCount: number,
    x: number,
    y: number,
    z: number,
    high: number,
    low: number,
    size: number,
    dust: number,
    labelPointer: number,
    labelCount: number,
  ): number;
  abiss_watershed_agglomerate(
    affinityPointer: number,
    affinityCount: number,
    x: number,
    y: number,
    z: number,
    high: number,
    low: number,
    size: number,
    dust: number,
    aggThreshold: number,
    labelPointer: number,
    labelCount: number,
  ): number;
  abiss_watershed_last_error(): number;
}

let modulePromise: Promise<WatershedExports> | undefined;

async function loadModule(): Promise<WatershedExports> {
  if (modulePromise === undefined) {
    modulePromise = (async () => {
      const response = await fetch(
        new URL("./abiss/abiss_watershed.wasm", import.meta.url),
      );
      if (!response.ok)
        throw new Error(
          `Failed to load Abiss watershed WASM: HTTP ${response.status}`,
        );
      // The small standalone binary needs no JS glue, threads, COOP/COEP, or
      // particular response MIME type. It uses native WebAssembly exceptions.
      const { instance } = await WebAssembly.instantiate(
        await response.arrayBuffer(),
        { env: { emscripten_notify_memory_growth: () => {} } },
      );
      const exports = instance.exports as unknown as WatershedExports;
      exports._initialize();
      return exports;
    })().catch((error) => {
      modulePromise = undefined;
      throw error;
    });
  }
  return modulePromise;
}

/** Runs in an async-computation worker, never against a render chunk's buffer. */
export async function runWatershedWasm(
  affinities: Float32Array,
  shapeXYZ: readonly number[],
  options: WatershedOptions = DEFAULT_WATERSHED_OPTIONS,
): Promise<Uint32Array<ArrayBuffer>> {
  const voxels = validateWatershedShape(shapeXYZ);
  validateWatershedOptions(options);
  const affinityCount = 3 * voxels;
  const { maskThreshold } = options;
  const planes = maskThreshold === undefined ? 3 : 4;
  if (
    !(affinities instanceof Float32Array) ||
    affinities.length !== planes * voxels
  )
    throw new Error(
      `Watershed requires planar Float32 affinities [${planes},Z,Y,X]`,
    );
  let mask: Uint8Array | undefined;
  if (maskThreshold !== undefined) {
    // Do not hide invalid affinity probabilities by zeroing a masked voxel.
    for (let i = 0; i < affinityCount; ++i) {
      const value = affinities[i];
      if (!Number.isFinite(value) || value < 0 || value > 1)
        throw new Error(
          "Affinity values must be finite and in [0,1] before masking",
        );
    }
    mask = new Uint8Array(voxels);
    for (let i = 0; i < voxels; ++i) {
      const value = affinities[affinityCount + i];
      if (!Number.isFinite(value) || value < 0 || value > 1)
        throw new Error(
          "Watershed mask values must be finite probabilities in [0,1]",
        );
      mask[i] = Number(value < maskThreshold);
    }
  }
  const wasm = await loadModule();
  // No awaits after allocation: calls sharing one instance cannot interleave.
  let affinityPointer = 0;
  let labelPointer = 0;
  try {
    // WASM i32 exports appear signed in JS; offsets above 2 GiB are unsigned.
    affinityPointer =
      wasm.malloc(affinityCount * Float32Array.BYTES_PER_ELEMENT) >>> 0;
    labelPointer = wasm.malloc(voxels * Uint32Array.BYTES_PER_ELEMENT) >>> 0;
    if (affinityPointer === 0 || labelPointer === 0)
      throw new Error(
        "Abiss watershed WASM allocation failed; use a smaller ROI",
      );
    // malloc and the algorithm may grow memory, detaching earlier views.
    const nativeAffinities = new Float32Array(
      wasm.memory.buffer,
      affinityPointer,
      affinityCount,
    );
    nativeAffinities.set(affinities.subarray(0, affinityCount));
    if (mask !== undefined) {
      // Abiss myelin-mask semantics: remove edges touching either endpoint.
      const strides = [1, shapeXYZ[0], shapeXYZ[0] * shapeXYZ[1]];
      for (let axis = 0; axis < 3; ++axis) {
        const stride = strides[axis];
        for (let i = 0; i < voxels; ++i) {
          if (
            mask[i] === 0 ||
            (Math.floor(i / stride) % shapeXYZ[axis] !== 0 &&
              mask[i - stride] === 0)
          )
            nativeAffinities[axis * voxels + i] = 0;
        }
      }
    }
    const args = [
      affinityPointer,
      affinityCount,
      shapeXYZ[0],
      shapeXYZ[1],
      shapeXYZ[2],
      options.highThreshold,
      options.lowThreshold,
      options.sizeThreshold,
      options.dustThreshold,
    ] as const;
    const status =
      options.aggThreshold === undefined
        ? wasm.abiss_watershed(...args, labelPointer, voxels)
        : wasm.abiss_watershed_agglomerate(
            ...args,
            options.aggThreshold,
            labelPointer,
            voxels,
          );
    if (status !== 0) {
      const start = wasm.abiss_watershed_last_error() >>> 0;
      const heap = new Uint8Array(wasm.memory.buffer);
      const end = heap.indexOf(0, start);
      const message =
        start === 0 || end === -1
          ? "Unknown native error"
          : new TextDecoder().decode(heap.subarray(start, end));
      throw new Error(`Abiss watershed failed (status ${status}): ${message}`);
    }
    return new Uint32Array(wasm.memory.buffer, labelPointer, voxels).slice();
  } finally {
    if (labelPointer !== 0) wasm.free(labelPointer);
    if (affinityPointer !== 0) wasm.free(affinityPointer);
  }
}
