/**
 * @license
 * Copyright 2016 Google Inc.
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

import type { Chunk } from "#src/chunk_manager/backend.js";
import {
  SliceViewChunk,
  SliceViewChunkSourceBackend,
} from "#src/sliceview/backend.js";
import type {
  DataType,
  SliceViewChunkSpecification,
} from "#src/sliceview/base.js";
import { VOLUME_FETCH_FRESH_DECODED_CHUNK_RPC_ID } from "#src/sliceview/base.js";
import type {
  VolumeChunkSource as VolumeChunkSourceInterface,
  VolumeChunkSpecification,
} from "#src/sliceview/volume/base.js";
import type { vec3 } from "#src/util/geom.js";
import * as vector from "#src/util/vector.js";
import type { RPC, RPCPromise } from "#src/worker_rpc.js";
import { registerPromiseRPC } from "#src/worker_rpc.js";

export class VolumeChunk extends SliceViewChunk {
  source: VolumeChunkSource | null = null;
  data: ArrayBufferView | null;
  chunkDataSize: Uint32Array | null;

  initializeVolumeChunk(key: string, chunkGridPosition: vec3) {
    super.initializeVolumeChunk(key, chunkGridPosition);
    this.chunkDataSize = null;
    this.data = null;
  }

  serialize(msg: any, transfers: any[]) {
    super.serialize(msg, transfers);
    const chunkDataSize = this.chunkDataSize;
    if (chunkDataSize !== this.source!.spec.chunkDataSize) {
      msg.chunkDataSize = chunkDataSize;
    }
    const data = (msg.data = this.data);
    if (data !== null) {
      transfers.push(data!.buffer);
    }
    this.data = null;
  }

  downloadSucceeded() {
    this.systemMemoryBytes = this.gpuMemoryBytes = this.data?.byteLength ?? 0;
    super.downloadSucceeded();
  }

  freeSystemMemory() {
    this.data = null;
  }
}

interface ChunkWithGridPositionAndDataSize extends Chunk {
  chunkGridPosition: Float32Array;
  chunkDataSize: Uint32Array | null;
}

interface SliceViewChunkSpecWithOffsetAndDatatype
  extends SliceViewChunkSpecification<Uint32Array> {
  baseVoxelOffset: Float32Array;
  dataType: DataType;
}

interface ChunkSourceForChunkBounds {
  spec: SliceViewChunkSpecWithOffsetAndDatatype;
  tempChunkDataSize: Uint32Array;
  tempChunkPosition: Float32Array;
}

/**
 * Helper function for computing the voxel bounds of a chunk based on its chunkGridPosition.
 *
 * This assumes that the grid of chunk positions starts at this.baseVoxelOffset.  Chunks are
 * clipped to lie within upperVoxelBound, but are not clipped to lie within lowerVoxelBound.  (The
 * frontend code currently cannot handle chunks clipped at their lower corner, and the chunk
 * layout can generally be chosen so that lowerVoxelBound lies on a chunk boundary.)
 *
 * This sets chunk.chunkDataSize to a copy of the returned chunkDataSize if it differs from
 * source.spec.chunkDataSize; otherwise, it is set to source.spec.chunkDataSize.
 *
 * @returns A globally-allocated Vec3 containing the chunk corner position in voxel coordinates.
 * The returned Vec3 will be invalidated by any subsequent call to this method, even on a
 * different VolumeChunkSource instance.
 */
export function computeChunkBounds(
  source: ChunkSourceForChunkBounds,
  chunk: ChunkWithGridPositionAndDataSize,
) {
  const { spec, tempChunkDataSize, tempChunkPosition } = source;
  const { upperVoxelBound, rank, baseVoxelOffset } = spec;

  const origChunkDataSize = spec.chunkDataSize;
  const newChunkDataSize = tempChunkDataSize;

  // Chunk start position in voxel coordinates.
  const chunkPosition = vector.multiply(
    tempChunkPosition,
    chunk.chunkGridPosition,
    origChunkDataSize,
  );

  // Specifies whether the chunk only partially fits within the data bounds.
  let partial = false;
  for (let i = 0; i < rank; ++i) {
    const upper = Math.min(
      upperVoxelBound[i],
      chunkPosition[i] + origChunkDataSize[i],
    );
    const size = (newChunkDataSize[i] = upper - chunkPosition[i]);
    if (size !== origChunkDataSize[i]) {
      partial = true;
    }
  }

  vector.add(chunkPosition, chunkPosition, baseVoxelOffset);

  if (partial) {
    chunk.chunkDataSize = Uint32Array.from(newChunkDataSize);
  } else {
    chunk.chunkDataSize = origChunkDataSize;
  }

  return chunkPosition;
}

export class VolumeChunkSource
  extends SliceViewChunkSourceBackend
  implements VolumeChunkSourceInterface
{
  declare spec: VolumeChunkSpecification;
  tempChunkDataSize: Uint32Array;
  tempChunkPosition: Float32Array;
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    const rank = this.spec.rank;
    this.tempChunkDataSize = new Uint32Array(rank);
    this.tempChunkPosition = new Float32Array(rank);
  }

  computeChunkBounds(chunk: VolumeChunk) {
    return computeChunkBounds(this, chunk);
  }
}
VolumeChunkSource.prototype.chunkConstructor = VolumeChunk;

/**
 * Fresh download+decode of a single chunk into a THROWAWAY `VolumeChunk` that is
 * never added to `source.chunks` — so the resident (rendered) chunk and its GPU
 * texture are untouched (no eviction, no on-screen flicker). Reuses the source's
 * existing `download` (raw / compressed-segmentation / sharded all handled).
 * Returns the decoded `data` (transferable) plus the chunk's actual (possibly
 * edge-clipped) `chunkDataSize`. Used by the edit-session save read-back
 * verification (TM-352).
 */
registerPromiseRPC(
  VOLUME_FETCH_FRESH_DECODED_CHUNK_RPC_ID,
  async function (
    x: { source: number; chunkGridPosition: Float32Array },
    progressOptions,
  ): RPCPromise<{
    data: ArrayBufferView | null;
    chunkDataSize: number[] | null;
  }> {
    const source = this.get(x.source) as VolumeChunkSource;
    const chunk = source.getNewChunk_(source.chunkConstructor) as VolumeChunk;
    chunk.initializeVolumeChunk(
      x.chunkGridPosition.join(),
      x.chunkGridPosition as unknown as vec3,
    );
    const signal = progressOptions.signal ?? new AbortController().signal;
    try {
      await source.download(chunk, signal);
      const data = chunk.data;
      // `chunk.chunkDataSize` aliases `source.spec.chunkDataSize` for non-edge
      // chunks (see `computeChunkBounds`), so COPY it — transferring it would
      // detach the shared spec array. `data` is owned by this throwaway chunk,
      // so its buffer is safe to transfer.
      const chunkDataSize =
        chunk.chunkDataSize !== null ? Array.from(chunk.chunkDataSize) : null;
      chunk.data = null;
      const transfers = data !== null ? [data.buffer] : [];
      return { value: { data, chunkDataSize }, transfers };
    } finally {
      chunk.freeSystemMemory();
      chunk.dispose();
    }
  },
);
