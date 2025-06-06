/**
 * @license
 * Copyright 2019 Google Inc.
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

import type { RawPartitionedMeshData, RawMeshData } from "#src/mesh/backend.js";

let decodeResult: RawPartitionedMeshData | Error | undefined = undefined;
let numPartitions = 0;

let wasmModule: WebAssembly.Instance | undefined;

const libraryEnv = {
  emscripten_notify_memory_growth: (memoryIndex: number) => {
    memoryIndex;
  },
  neuroglancer_draco_receive_decoded_mesh: (
    numFaces: number,
    numVertices: number,
    indicesPointer: number,
    vertexPositionsPointer: number,
    subchunkOffsetsPointer: number,
  ) => {
    const numIndices = numFaces * 3;
    const memory = wasmModule!.exports.memory as WebAssembly.Memory;
    const indices = new Uint32Array(
      memory.buffer,
      indicesPointer,
      numIndices,
    ).slice();
    const vertexPositions = new Uint32Array(
      memory.buffer,
      vertexPositionsPointer,
      3 * numVertices,
    ).slice();
    const subChunkOffsets = new Uint32Array(
      memory.buffer,
      subchunkOffsetsPointer,
      numPartitions + 1,
    ).slice();
    const mesh: RawPartitionedMeshData = {
      indices,
      vertexPositions,
      subChunkOffsets,
    };
    decodeResult = mesh;
  },
  proc_exit: (code: number) => {
    throw `proc exit: ${code}`;
  },
};
let dracoModulePromise: Promise<WebAssembly.Instance> | undefined;

function getDracoModulePromise() {
  if (dracoModulePromise == undefined) {
    dracoModulePromise = (async () => {
      const m = (wasmModule = (
        await WebAssembly.instantiateStreaming(
          fetch(new URL("./neuroglancer_draco.wasm", import.meta.url)),
          {
            env: libraryEnv,
            wasi_snapshot_preview1: libraryEnv,
          },
        )
      ).instance);
      (m.exports._initialize as Function)();
      return m;
    })();
  }
  return dracoModulePromise;
}

export async function decodeDracoPartitioned(
  buffer: Uint8Array,
  vertexQuantizationBits: number,
  partition: boolean,
  skipDequantization: boolean,
): Promise<RawPartitionedMeshData> {
  const m = await getDracoModulePromise();
  const offset = (m.exports.malloc as Function)(buffer.byteLength);
  const heap = new Uint8Array((m.exports.memory as WebAssembly.Memory).buffer);
  heap.set(buffer, offset);
  numPartitions = partition ? 8 : 1;

  try {
    // Use normalized coordinates function for Precomputed meshes
    const code = (m.exports.neuroglancer_draco_decode as Function)(
      offset,
      buffer.byteLength,
      partition,
      vertexQuantizationBits,
      skipDequantization,
    );
    if (code === 0) {
      const r = decodeResult;
      decodeResult = undefined;
      if (r instanceof Error) throw r;
      // Convert vertex positions to Float32Array when skipDequantization = false
      if (!skipDequantization && r!.vertexPositions instanceof Uint32Array) {
        r!.vertexPositions = new Float32Array(r!.vertexPositions.buffer);
      }
      return r!;
    }
    throw new Error(`Failed to decode draco mesh: ${code}`);
  } finally {
    // C++ will handle freeing all memory (input buffer and coordinate array)
  }
}

/**
 * Decode a Draco mesh with world coordinate octant centers.
 * Used by Graphene meshes which store vertices in world space.
 */
export async function decodeDracoPartitionedWithOctantCenter(
  buffer: Uint8Array,
  partition: boolean,
  octantCenterX?: number,
  octantCenterY?: number,
  octantCenterZ?: number,
): Promise<RawPartitionedMeshData> {
  const m = await getDracoModulePromise();
  const offset = (m.exports.malloc as Function)(buffer.byteLength);
  const heap = new Uint8Array((m.exports.memory as WebAssembly.Memory).buffer);
  heap.set(buffer, offset);
  numPartitions = partition ? 8 : 1;

  let coordsOffset = 0;

  try {
    if (partition) {
      if (octantCenterX === undefined || octantCenterY === undefined || octantCenterZ === undefined) {
        throw new Error("NotImplemented: Partitioned meshes require octant center coordinates");
      }
      
      // Allocate memory for the coordinate array
      coordsOffset = (m.exports.malloc as Function)(12); // 3 * 4 bytes
      const floatBuffer = new Float32Array([octantCenterX, octantCenterY, octantCenterZ]);
      const uint32View = new Uint32Array(floatBuffer.buffer);
      const coordsHeap = new Uint32Array((m.exports.memory as WebAssembly.Memory).buffer);
      coordsHeap.set(uint32View, coordsOffset / 4);
    } else {
      // For non-partitioned meshes, use dummy coordinates (they won't be used)
      coordsOffset = (m.exports.malloc as Function)(12); // 3 * 4 bytes
      const floatBuffer = new Float32Array([0, 0, 0]);
      const uint32View = new Uint32Array(floatBuffer.buffer);
      const coordsHeap = new Uint32Array((m.exports.memory as WebAssembly.Memory).buffer);
      coordsHeap.set(uint32View, coordsOffset / 4);
    }

    const code = (m.exports.neuroglancer_draco_decode_world_coords as Function)(
      offset,
      buffer.byteLength,
      partition,
      coordsOffset,
    );

    if (code === 0) {
      const r = decodeResult;
      decodeResult = undefined;
      if (r instanceof Error) throw r;
      // Graphene meshes are already in world space (float32), no conversion needed
      return r!;
    }
    throw new Error(`Failed to decode draco mesh: ${code}`);
  } finally {
    // C++ will handle freeing all memory (input buffer and coordinate array)
  }
}

export async function decodeDraco(buffer: Uint8Array): Promise<RawMeshData> {
  const m = await getDracoModulePromise();
  const offset = (m.exports.malloc as Function)(buffer.byteLength);
  const heap = new Uint8Array((m.exports.memory as WebAssembly.Memory).buffer);
  heap.set(buffer, offset);

  try {
    const code = (m.exports.neuroglancer_draco_decode as Function)(
      offset,
      buffer.byteLength,
      false,
      0,
      false,
    );
    if (code === 0) {
      const r = decodeResult;
      decodeResult = undefined;
      if (r instanceof Error) throw r;
      r!.vertexPositions = new Float32Array(r!.vertexPositions.buffer);
      return r!;
    }
    throw new Error(`Failed to decode draco mesh: ${code}`);
  } finally {
    // C++ input_deleter will handle freeing the input buffer
  }
}
