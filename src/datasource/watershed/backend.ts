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

import { requestAsyncComputation } from "#src/async_computation/request.js";
import { WithParameters } from "#src/chunk_manager/backend.js";
import { ChunkPriorityTier, ChunkState } from "#src/chunk_manager/base.js";
import {
  MeshSourceParameters,
  VolumeSourceParameters,
  WATERSHED_MESH_RPC_ID,
  WATERSHED_TILE_RPC_ID,
  type WatershedMeshSnapshot,
  type WatershedMeshState,
} from "#src/datasource/watershed/base.js";
import {
  assignMeshFragmentData,
  MeshSource,
  type FragmentChunk,
  type ManifestChunk,
} from "#src/mesh/backend.js";
import type { SharedWatchableValue } from "#src/shared_watchable_value.js";
import type { VolumeChunk } from "#src/sliceview/volume/backend.js";
import { VolumeChunkSource } from "#src/sliceview/volume/backend.js";
import { abortPromise } from "#src/util/abort.js";
import { watershedMeshComputation } from "#src/watershed/mesh_request.js";
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

// Keep at most one physical extraction (and its temporary snapshot) in this
// chunk worker. Aborting a synchronous WASM call cannot release its memory early.
let meshQueue = Promise.resolve();

@registerSharedObject()
export class WatershedMeshSource extends WithParameters(
  MeshSource,
  MeshSourceParameters,
) {
  sourceQueueLevel = 2;
  private readonly state: SharedWatchableValue<WatershedMeshState>;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.fragmentSource.sourceQueueLevel = 2;
    this.state = this.registerDisposer(
      rpc.getRef<SharedWatchableValue<WatershedMeshState>>(options.state),
    );
  }

  private request(
    objectId: bigint,
    generation: number,
    signal: AbortSignal,
    snapshot = false,
    error?: string,
  ) {
    return this.rpc!.promiseInvoke<
      WatershedMeshState | WatershedMeshSnapshot | undefined
    >(
      WATERSHED_MESH_RPC_ID,
      {
        chunkManager: this.chunkManager.rpcId,
        ...this.parameters,
        generation,
        objectId,
        snapshot,
        error,
      },
      { signal },
    );
  }

  async download(chunk: ManifestChunk, signal: AbortSignal) {
    const { generation } = this.state.value;
    const result = await this.request(chunk.objectId, generation, signal);
    signal.throwIfAborted();
    // Empty manifests are invalidated on readiness, selection, or epoch changes.
    chunk.fragmentIds =
      result !== undefined && generation === this.state.value.generation
        ? [String(generation)]
        : [];
  }

  downloadFragment(chunk: FragmentChunk, signal: AbortSignal): Promise<void> {
    const generation = Number(chunk.fragmentId);
    const objectId = chunk.manifestChunk!.objectId;
    const task = meshQueue.then(async () => {
      signal.throwIfAborted();
      if (generation !== this.state.value.generation)
        throw new DOMException("Watershed mesh changed", "AbortError");
      const snapshot = await this.request(objectId, generation, signal, true);
      signal.throwIfAborted();
      if (
        snapshot === undefined ||
        !("labels" in snapshot) ||
        generation !== this.state.value.generation
      )
        throw new DOMException("Watershed mesh changed", "AbortError");
      const { labels, shapeXYZ, lowerXYZ } = snapshot;
      const mask = new Uint8Array(labels.length);
      const label = Number(objectId);
      for (let i = 0; i < labels.length; ++i)
        if (labels[i] === label) mask[i] = 255;
      const mesh = await requestAsyncComputation(
        watershedMeshComputation,
        signal,
        [mask.buffer],
        mask,
        shapeXYZ,
      );
      signal.throwIfAborted();
      if (generation !== this.state.value.generation)
        throw new DOMException("Watershed mesh changed", "AbortError");
      for (let i = 0; i < mesh.vertexPositions.length; ++i) {
        const local = mesh.vertexPositions[i];
        const offset = lowerXYZ[i % 3];
        const placed = local + offset;
        if (placed - offset !== local || Math.fround(placed) !== placed) {
          throw new Error(
            "Watershed mesh float32 placement precision exceeded",
          );
        }
        mesh.vertexPositions[i] = placed;
      }
      assignMeshFragmentData(chunk, mesh);
    });
    meshQueue = task.catch(() => {});
    return task.catch(async (error) => {
      if (
        !signal.aborted &&
        !(error instanceof DOMException && error.name === "AbortError") &&
        generation === this.state.value.generation
      ) {
        await this.request(objectId, generation, signal, false, String(error));
      }
      throw error;
    });
  }
}
