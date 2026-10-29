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

import { ChunkManager, WithParameters } from "#src/chunk_manager/backend.js";
import { ChunkPriorityTier, ChunkState } from "#src/chunk_manager/base.js";
import type { InferenceResultInfo } from "#src/datasource/inference/base.js";
import {
  CHECK_INFERENCE_RESULT_RPC_ID,
  copyInferenceResultChunk,
  DELETE_INFERENCE_RESULT_RPC_ID,
  getInferenceResultInfo,
  getInferenceMetadataInfo,
  INFERENCE_TILE_RPC_ID,
  LIVE_INFERENCE_TILE_SHAPE_ZYX,
  INFERENCE_RESULT_MEMORY_LIMIT,
  missingInferenceResult,
  PUBLISH_INFERENCE_RESULT_RPC_ID,
  VolumeSourceParameters,
} from "#src/datasource/inference/base.js";
import type { VolumeChunk } from "#src/sliceview/volume/backend.js";
import { VolumeChunkSource } from "#src/sliceview/volume/backend.js";
import { abortPromise } from "#src/util/abort.js";
import {
  registerPromiseRPC,
  registerRPC,
  registerSharedObject,
  type RPC,
} from "#src/worker_rpc.js";

interface StoredResult {
  readonly data?: Float32Array;
  readonly info: InferenceResultInfo;
}
interface ResultStore {
  results: Map<string, StoredResult>;
  bytes: number;
}
const stores = new WeakMap<ChunkManager, ResultStore>();

function getStore(manager: ChunkManager): ResultStore {
  let store = stores.get(manager);
  if (store !== undefined) return store;
  store = { results: new Map(), bytes: 0 };
  stores.set(manager, store);
  const capturedStore = store;
  manager.registerDisposer(() => {
    capturedStore.results.clear();
    capturedStore.bytes = 0;
    stores.delete(manager);
  });
  return store;
}

function requireResult(manager: ChunkManager, resultId: string): StoredResult {
  const result = stores.get(manager)?.results.get(resultId);
  if (result === undefined) throw missingInferenceResult(resultId);
  return result;
}

registerPromiseRPC(PUBLISH_INFERENCE_RESULT_RPC_ID, async function (x) {
  const manager = this.get(x.chunkManager);
  if (!(manager instanceof ChunkManager) || manager.wasDisposed) {
    throw new Error("Inference ChunkManager is unavailable; rerun inference");
  }
  if (typeof x.resultId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(x.resultId)) {
    throw new Error("Invalid inference result ID");
  }
  const info = x.live
    ? getInferenceMetadataInfo(x.result)
    : getInferenceResultInfo(x.result);
  if (
    x.live &&
    info.shapeZYX.some((x, i) => x % LIVE_INFERENCE_TILE_SHAPE_ZYX[i] !== 0)
  )
    throw new Error("Live inference domain must contain full tiles");
  const store = getStore(manager);
  if (store.results.has(x.resultId))
    throw new Error("Inference result already published");
  if (store.bytes + info.byteLength > INFERENCE_RESULT_MEMORY_LIMIT) {
    throw new Error(
      "Inference results exceed the 512 MiB session memory limit; dispose old results first",
    );
  }
  // RPC transferred a private, exact-sized frontend snapshot. Never expose or
  // transfer this buffer again: downloads always allocate separate chunk data.
  const data: Float32Array | undefined = x.live ? undefined : x.result.data;
  if (data !== undefined && data.byteLength !== data.buffer.byteLength) {
    throw new Error(
      "Inference publication must transfer an exact-sized buffer",
    );
  }
  store.results.set(x.resultId, { info, data });
  store.bytes += info.byteLength;
  return { value: undefined };
});

registerRPC(DELETE_INFERENCE_RESULT_RPC_ID, function (x) {
  const manager = this.get(x.chunkManager) as ChunkManager | undefined;
  if (manager === undefined) return;
  const store = stores.get(manager);
  const result = store?.results.get(x.resultId);
  if (result === undefined) return;
  store!.results.delete(x.resultId);
  store!.bytes -= result.info.byteLength;
});

registerPromiseRPC(CHECK_INFERENCE_RESULT_RPC_ID, async function (x) {
  requireResult(this.get(x.chunkManager), x.resultId);
  return { value: undefined };
});

@registerSharedObject()
export class InferenceVolumeChunkSource extends WithParameters(
  VolumeChunkSource,
  VolumeSourceParameters,
) {
  // Separate capacity from native source downloads (level 0). A full set of
  // derived downloads must never consume the slots needed to read their inputs.
  sourceQueueLevel = 1;
  private readonly live: boolean;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.live =
      requireResult(this.chunkManager, this.parameters.resultId).data ===
      undefined;
    if (this.live) {
      this.registerDisposer(
        this.chunkManager.recomputeChunkPrioritiesLate.add(() => {
          // Ordinary downloads can complete after demotion. Model jobs are costly:
          // abort demand-lost jobs explicitly, without caching an AbortError as FAILED.
          for (const chunk of this.chunks.values()) {
            if (
              chunk.state !== ChunkState.DOWNLOADING ||
              chunk.newPriorityTier !== ChunkPriorityTier.RECENT
            )
              continue;
            const abort = chunk.downloadAbortController!;
            chunk.downloadAbortController = undefined;
            abort.abort(
              new DOMException(
                "Live tile is no longer requested",
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
    if (
      this.live &&
      !stores.get(this.chunkManager)?.results.has(this.parameters.resultId)
    ) {
      // Stop/delete invalidates cached data before the removed view's demand
      // necessarily reaches this worker. Let the scheduler cancel that transient
      // obsolete request, rather than caching a missing-result failure. A live
      // publication is never resurrected and no data is assigned on this path.
      await abortPromise(signal);
      return;
    }
    const { data, info } = requireResult(
      this.chunkManager,
      this.parameters.resultId,
    );
    // computeChunkBounds uses shared temporary storage. Never retain it across await.
    const lower = Float32Array.from(this.computeChunkBounds(chunk));
    let output: Float32Array;
    if (data === undefined) {
      const gridZYX = Array.from(chunk.chunkGridPosition).slice(0, 3).reverse();
      output = await this.rpc!.promiseInvoke<Float32Array>(
        INFERENCE_TILE_RPC_ID,
        {
          chunkManager: this.chunkManager.rpcId,
          resultId: this.parameters.resultId,
          gridZYX,
        },
        { signal },
      );
      if (
        !(output instanceof Float32Array) ||
        output.length !==
          LIVE_INFERENCE_TILE_SHAPE_ZYX.reduce<number>(
            (a, b) => a * b,
            info.channels,
          )
      )
        throw new Error("Invalid live inference tile data");
      requireResult(this.chunkManager, this.parameters.resultId);
    } else {
      output = copyInferenceResultChunk(
        data,
        info.shapeZYX,
        lower,
        chunk.chunkDataSize!,
        info.channels,
      );
    }
    signal.throwIfAborted();
    chunk.data = output;
  }
}
