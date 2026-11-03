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
import { ChunkPriorityTier, ChunkState } from "#src/chunk_manager/base.js";
import {
  VolumeSourceParameters,
  WATERSHED_TILE_RPC_ID,
} from "#src/datasource/watershed/base.js";
import type { VolumeChunk } from "#src/sliceview/volume/backend.js";
import { VolumeChunkSource } from "#src/sliceview/volume/backend.js";
import { abortPromise } from "#src/util/abort.js";
import { registerSharedObject, type RPC } from "#src/worker_rpc.js";

@registerSharedObject()
export class WatershedVolumeChunkSource extends WithParameters(
  VolumeChunkSource,
  VolumeSourceParameters,
) {
  // Native input (0) and live inference (1) must remain schedulable while
  // watershed waits for them. Output still uses ordinary chunk cache budgets.
  sourceQueueLevel = 2;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    if (this.parameters.live) {
      this.registerDisposer(
        this.chunkManager.recomputeChunkPrioritiesLate.add(() => {
          for (const chunk of this.chunks.values()) {
            if (
              chunk.state !== ChunkState.DOWNLOADING ||
              chunk.newPriorityTier !== ChunkPriorityTier.RECENT
            )
              continue;
            // Clear before aborting: a demand-lost job must not become FAILED.
            const abort = chunk.downloadAbortController!;
            chunk.downloadAbortController = undefined;
            abort.abort(
              new DOMException(
                "Live watershed tile is no longer requested",
                "AbortError",
              ),
            );
            this.chunkManager.queueManager.updateChunkState(
              chunk,
              ChunkState.QUEUED,
            );
          }
        }),
      );
    }
  }

  async download(chunk: VolumeChunk, signal: AbortSignal) {
    signal.throwIfAborted();
    // computeChunkBounds uses scratch storage and includes baseVoxelOffset.
    // Frontend tiles are indexed locally; capture local bounds before await.
    const lowerXYZ = Array.from(
      this.computeChunkBounds(chunk),
      (x, i) => x - this.spec.baseVoxelOffset[i],
    );
    const sizeXYZ = Array.from(chunk.chunkDataSize!);
    const data = await this.rpc!.promiseInvoke<
      Uint32Array | BigUint64Array | undefined
    >(
      WATERSHED_TILE_RPC_ID,
      {
        chunkManager: this.chunkManager.rpcId,
        resultId: this.parameters.resultId,
        live: this.parameters.live === true,
        lowerXYZ,
        sizeXYZ,
      },
      { signal },
    );
    signal.throwIfAborted();
    if (this.parameters.live && data === undefined) {
      // Disposal/invalidation may precede removal of the old layer's demand.
      // Wait for the scheduler to cancel, without fabricating output or FAILED.
      await abortPromise(signal);
      return;
    }
    const DataArray = this.parameters.live ? BigUint64Array : Uint32Array;
    if (
      !(data instanceof DataArray) ||
      data.length !== sizeXYZ.reduce((a, b) => a * b, 1)
    ) {
      throw new Error("Invalid watershed tile data");
    }
    chunk.data = data;
  }
}
