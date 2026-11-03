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

import { WithParameters } from "#src/chunk_manager/backend.js";
import {
  VolumeSourceParameters,
  WATERSHED_TILE_RPC_ID,
} from "#src/datasource/watershed/base.js";
import type { VolumeChunk } from "#src/sliceview/volume/backend.js";
import { VolumeChunkSource } from "#src/sliceview/volume/backend.js";
import { registerSharedObject } from "#src/worker_rpc.js";

@registerSharedObject()
export class WatershedVolumeChunkSource extends WithParameters(
  VolumeChunkSource,
  VolumeSourceParameters,
) {
  sourceQueueLevel = 1;

  async download(chunk: VolumeChunk, signal: AbortSignal) {
    signal.throwIfAborted();
    // computeChunkBounds uses scratch storage and includes baseVoxelOffset.
    // Frontend snapshots are indexed locally; capture local bounds before await.
    const lowerXYZ = Array.from(
      this.computeChunkBounds(chunk),
      (x, i) => x - this.spec.baseVoxelOffset[i],
    );
    const sizeXYZ = Array.from(chunk.chunkDataSize!);
    const data = await this.rpc!.promiseInvoke<Uint32Array>(
      WATERSHED_TILE_RPC_ID,
      {
        chunkManager: this.chunkManager.rpcId,
        resultId: this.parameters.resultId,
        lowerXYZ,
        sizeXYZ,
      },
      { signal },
    );
    signal.throwIfAborted();
    if (
      !(data instanceof Uint32Array) ||
      data.length !== sizeXYZ.reduce((a, b) => a * b, 1)
    ) {
      throw new Error("Invalid watershed tile data");
    }
    chunk.data = data;
  }
}
