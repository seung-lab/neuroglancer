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

import { validateWatershedShape } from "#src/watershed/base.js";

export const MAX_WATERSHED_MESH_VOXELS = 2 ** 21;
export const MAX_WATERSHED_MESH_TRIANGLES = 2 ** 18;
export const MAX_WATERSHED_MESH_BYTES =
  MAX_WATERSHED_MESH_TRIANGLES * 3 * (3 * 4 + 4);

interface MeshingExports {
  memory: WebAssembly.Memory;
  mc_alloc(bytes: number): number;
  mc_free(pointer: number, bytes: number): void;
  mc_extract(
    mask: number,
    maskLength: number,
    x: number,
    y: number,
    z: number,
    output: number,
    outputFloats: number,
  ): number;
}

let modulePromise: Promise<MeshingExports> | undefined;

async function loadModule(): Promise<MeshingExports> {
  if (modulePromise === undefined) {
    modulePromise = (async () => {
      const response = await fetch(
        new URL("./marching_cubes.wasm", import.meta.url),
      );
      if (!response.ok)
        throw new Error(
          `Failed to load watershed meshing WASM: HTTP ${response.status}`,
        );
      const { instance } = await WebAssembly.instantiate(
        await response.arrayBuffer(),
      );
      return instance.exports as unknown as MeshingExports;
    })().catch((error) => {
      modulePromise = undefined;
      throw error;
    });
  }
  return modulePromise;
}

/** Extracts open-ROI, voxel-local triangle soup in an async-computation worker. */
export async function extractWatershedMesh(
  mask: Uint8Array,
  shapeXYZ: readonly number[],
): Promise<{
  vertexPositions: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
}> {
  const voxels = validateWatershedShape(shapeXYZ);
  if (voxels > MAX_WATERSHED_MESH_VOXELS)
    throw new Error(
      "Watershed mesh exceeds the 2**21 voxel limit; use a smaller region for meshing",
    );
  const [x, y, z] = shapeXYZ;
  if (!(mask instanceof Uint8Array) || mask.length !== voxels)
    throw new Error(
      "Watershed meshing requires an X-fastest Uint8 mask matching XYZ shape",
    );
  // Own the validated bytes across the asynchronous module load.
  const input = mask.slice();
  for (const value of input) {
    if (value !== 0 && value !== 255)
      throw new Error("Watershed meshing mask values must be 0 or 255");
  }
  let mixedCells = 0;
  const xy = x * y;
  for (let k = 0; k < z - 1; ++k) {
    for (let j = 0; j < y - 1; ++j) {
      for (let i = 0; i < x - 1; ++i) {
        const n = (k * y + j) * x + i;
        const value = input[n];
        if (
          input[n + 1] === value &&
          input[n + x] === value &&
          input[n + x + 1] === value &&
          input[n + xy] === value &&
          input[n + xy + 1] === value &&
          input[n + xy + x] === value &&
          input[n + xy + x + 1] === value
        )
          continue;
        // The pinned classic table emits at most five triangles per mixed cell.
        if (++mixedCells * 5 > MAX_WATERSHED_MESH_TRIANGLES)
          throw new Error(
            `Watershed mesh surface budget exceeded (${MAX_WATERSHED_MESH_TRIANGLES} conservative triangles / ${MAX_WATERSHED_MESH_BYTES} output bytes); use a smaller region`,
          );
      }
    }
  }
  if (mixedCells === 0)
    return {
      vertexPositions: new Float32Array(0),
      indices: new Uint32Array(0),
    };

  const outputFloats = mixedCells * 5 * 9;
  const outputBytes = outputFloats * Float32Array.BYTES_PER_ELEMENT;
  const wasm = await loadModule();
  // No awaits below: concurrent callers sharing this instance cannot interleave.
  let maskPointer = 0;
  let outputPointer = 0;
  try {
    maskPointer = wasm.mc_alloc(voxels);
    outputPointer = wasm.mc_alloc(outputBytes);
    if (maskPointer === 0 || outputPointer === 0)
      throw new Error(
        "Watershed meshing WASM allocation failed; use a smaller region",
      );
    new Uint8Array(wasm.memory.buffer, maskPointer, voxels).set(input);
    const floats = wasm.mc_extract(
      maskPointer,
      voxels,
      x,
      y,
      z,
      outputPointer,
      outputFloats,
    );
    if (floats < 0 || floats > outputFloats || floats % 9 !== 0)
      throw new Error(`Watershed meshing WASM failed (status ${floats})`);
    // Copy before freeing/reusing native memory or allowing another extraction.
    const vertexPositions = new Float32Array(
      wasm.memory.buffer,
      outputPointer,
      floats,
    ).slice();
    const indices = new Uint32Array(floats / 3);
    for (let i = 0; i < indices.length; ++i) indices[i] = i;
    return { vertexPositions, indices };
  } finally {
    if (outputPointer !== 0) wasm.mc_free(outputPointer, outputBytes);
    if (maskPointer !== 0) wasm.mc_free(maskPointer, voxels);
  }
}
