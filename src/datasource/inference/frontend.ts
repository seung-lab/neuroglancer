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

import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { WithParameters } from "#src/chunk_manager/frontend.js";
import {
  makeCoordinateSpace,
  makeIdentityTransformedBoundingBox,
} from "#src/coordinate_transform.js";
import type {
  DataSource,
  DataSourceProvider,
  GetDataSourceOptions,
} from "#src/datasource/index.js";
import type {
  InferenceResult,
  InferenceResultInfo,
} from "#src/datasource/inference/base.js";
import {
  CHECK_INFERENCE_RESULT_RPC_ID,
  DELETE_INFERENCE_RESULT_RPC_ID,
  getInferenceResultInfo,
  INFERENCE_TILE_RPC_ID,
  LIVE_INFERENCE_TILE_SHAPE_ZYX,
  INFERENCE_RESULT_MEMORY_LIMIT,
  missingInferenceResult,
  parseInferenceUrl,
  PUBLISH_INFERENCE_RESULT_RPC_ID,
  VolumeSourceParameters,
} from "#src/datasource/inference/base.js";
import type { LiveInference } from "#src/inference/live.js";
import type { InferenceRecipe } from "#src/inference/recipe.js";
import {
  INFERENCE_RECIPE_URL,
  parseInferenceRecipe,
} from "#src/inference/recipe.js";
import type { VolumeSourceOptions } from "#src/sliceview/volume/base.js";
import {
  DataType,
  makeVolumeChunkSpecification,
  VolumeType,
} from "#src/sliceview/volume/base.js";
import {
  MultiscaleVolumeChunkSource,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import { RefCounted } from "#src/util/disposable.js";
import * as matrix from "#src/util/matrix.js";
import { getRandomHexString } from "#src/util/random.js";
import { scaleByExp10, supportedUnits } from "#src/util/si_units.js";
import { registerPromiseRPC } from "#src/worker_rpc.js";

interface PublishedResult {
  info: InferenceResultInfo;
  ready: boolean;
  sources: Set<InferenceVolumeChunkSource>;
  live?: LiveInference;
}

interface Session {
  results: Map<string, PublishedResult>;
  bytes: number;
  disposed: boolean;
}

const sessions = new WeakMap<ChunkManager, Session>();

// An identity-only hint for the initial UI publication, never persisted. JSON
// restoration (even in this viewer) reconstructs an independently owned result.
const recipePublications = new WeakMap<object, string>();

export function makeInferenceRecipeSource(
  publication: { url: string },
  recipe: InferenceRecipe,
): { url: string; state: InferenceRecipe } {
  recipePublications.set(recipe, publication.url);
  return { url: INFERENCE_RECIPE_URL, state: recipe };
}

function getSession(chunkManager: ChunkManager): Session {
  let session = sessions.get(chunkManager);
  if (session !== undefined) return session;
  if (chunkManager.wasDisposed || chunkManager.rpc === null) {
    throw new Error("Cannot publish inference to a disposed ChunkManager");
  }
  session = { results: new Map(), bytes: 0, disposed: false };
  sessions.set(chunkManager, session);
  const capturedSession = session;
  const rpc = chunkManager.rpc;
  const managerId = chunkManager.rpcId;
  chunkManager.registerDisposer(() => {
    capturedSession.disposed = true;
    for (const [resultId, result] of capturedSession.results) {
      result.live?.dispose();
      rpc.invoke(DELETE_INFERENCE_RESULT_RPC_ID, {
        chunkManager: managerId,
        resultId,
      });
    }
    capturedSession.results.clear();
    capturedSession.bytes = 0;
  });
  return session;
}

function requireResult(
  chunkManager: ChunkManager,
  resultId: string,
): PublishedResult {
  const session = sessions.get(chunkManager);
  const result = session?.results.get(resultId);
  if (session?.disposed || result === undefined || !result.ready) {
    throw missingInferenceResult(resultId);
  }
  return result;
}

/**
 * Publish a snapshot, without detaching or retaining the caller's array. Only
 * metadata remains on the frontend; the worker owns the authoritative tensor.
 * The URL is valid only for this ChunkManager until dispose() or viewer teardown.
 * Remove dependent image layers before disposing; disposal invalidates their
 * chunk caches asynchronously. Render caches use the normal chunk-manager budget.
 */
export async function publishInferenceResult(
  chunkManager: ChunkManager,
  result: InferenceResult,
): Promise<{ url: string; dispose(): void }> {
  return publishSource(chunkManager, result);
}

/** Metadata-only publication: output tensors are computed only by chunk demand. */
export function publishLiveInference(
  chunkManager: ChunkManager,
  live: LiveInference,
): Promise<{ url: string; dispose(): void }> {
  return publishSource(chunkManager, undefined, live);
}

async function publishSource(
  chunkManager: ChunkManager,
  result?: InferenceResult,
  live?: LiveInference,
): Promise<{ url: string; dispose(): void }> {
  const session = getSession(chunkManager);
  if (session.disposed) throw new Error("Inference session has been disposed");
  const info = live?.info ?? getInferenceResultInfo(result!);
  if (session.bytes + info.byteLength > INFERENCE_RESULT_MEMORY_LIMIT) {
    throw new Error(
      "Inference results exceed the 512 MiB session memory limit; dispose old results first",
    );
  }
  const resultId = getRandomHexString();
  const entry: PublishedResult = {
    info,
    ready: false,
    sources: new Set(),
    live,
  };
  // Reserve before awaiting the worker, so concurrent publications are bounded.
  session.results.set(resultId, entry);
  session.bytes += info.byteLength;
  const rpc = chunkManager.rpc!;
  const managerId = chunkManager.rpcId;
  let active = true;
  const dispose = () => {
    if (!active) return;
    active = false;
    live?.dispose();
    if (session.results.delete(resultId)) session.bytes -= info.byteLength;
    rpc.invoke(DELETE_INFERENCE_RESULT_RPC_ID, {
      chunkManager: managerId,
      resultId,
    });
    for (const source of entry.sources) {
      if (!source.wasDisposed) source.invalidateCache();
    }
    entry.sources.clear();
  };
  try {
    // Snapshot even if RPC is queued waiting for worker startup. Transfer only
    // this private copy, never the input buffer or a chunk of authoritative data.
    const data =
      result === undefined ? undefined : Float32Array.from(result.data);
    await rpc.promiseInvoke(
      PUBLISH_INFERENCE_RESULT_RPC_ID,
      {
        chunkManager: managerId,
        resultId,
        live: live !== undefined,
        result: {
          data,
          channels: info.channels,
          shapeZYX: info.shapeZYX,
          originZYX: info.originZYX,
          spacingZYX: info.spacingZYX,
          axisNamesZYX: info.axisNamesZYX,
          unitsZYX: info.unitsZYX,
          provenance: JSON.parse(info.provenanceJson),
        },
      },
      { transfers: data === undefined ? [] : [data.buffer] },
    );
    if (session.disposed) throw missingInferenceResult(resultId);
    entry.ready = true;
    return { url: `inference://${resultId}`, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

registerPromiseRPC(INFERENCE_TILE_RPC_ID, async function (x, { signal }) {
  const entry = requireResult(this.get(x.chunkManager), x.resultId);
  if (entry.live === undefined) throw new Error("Not a live inference source");
  const data = await entry.live.readTile(
    x.gridZYX,
    signal ?? new AbortController().signal,
  );
  signal?.throwIfAborted();
  requireResult(this.get(x.chunkManager), x.resultId);
  // Subscribers may share an in-flight result: transfer a private tile snapshot.
  const copy = Float32Array.from(data);
  return { value: copy, transfers: [copy.buffer] };
});

export class InferenceVolumeChunkSource extends WithParameters(
  VolumeChunkSource,
  VolumeSourceParameters,
) {}

export class InferenceMultiscaleVolumeChunkSource extends MultiscaleVolumeChunkSource {
  // The multiscale base has no lifetime API. Recipe volumes have an explicit
  // lifetime, also ended by LayerDataSource's cancellation signal on deletion.
  private readonly lifetime = new RefCounted();

  registerDisposer(dispose: () => void) {
    return this.lifetime.registerDisposer(dispose);
  }

  dispose() {
    if (!this.lifetime.wasDisposed) this.lifetime.dispose();
  }

  constructor(
    chunkManager: ChunkManager,
    public resultId: string,
    public info: InferenceResultInfo,
  ) {
    super(chunkManager);
  }
  get dataType() {
    return DataType.FLOAT32;
  }
  get volumeType() {
    return VolumeType.IMAGE;
  }
  get rank() {
    return 4;
  }

  getSources(_volumeSourceOptions: VolumeSourceOptions) {
    const entry = requireResult(this.chunkManager, this.resultId);
    const size = [...this.info.shapeZYX].reverse();
    size.push(this.info.channels);
    // Fixed bounded XYZ tiles with all channels, independent of view orientation.
    const spec = makeVolumeChunkSpecification({
      rank: 4,
      dataType: DataType.FLOAT32,
      chunkDataSize:
        entry.live === undefined
          ? Uint32Array.of(
              Math.min(size[0], 32),
              Math.min(size[1], 32),
              Math.min(size[2], 32),
              this.info.channels,
            )
          : Uint32Array.of(
              ...[...LIVE_INFERENCE_TILE_SHAPE_ZYX].reverse(),
              this.info.channels,
            ),
      upperVoxelBound: Float32Array.from(size),
    });
    const chunkSource = this.chunkManager.getChunkSource(
      InferenceVolumeChunkSource,
      {
        spec,
        parameters: { resultId: this.resultId },
      },
    );
    if (!entry.sources.has(chunkSource)) {
      entry.sources.add(chunkSource);
      chunkSource.registerDisposer(() => entry.sources.delete(chunkSource));
    }
    return [
      [
        {
          chunkSource,
          chunkToMultiscaleTransform: matrix.createIdentity(Float32Array, 5),
        },
      ],
    ];
  }
}

export class InferenceDataSourceProvider implements DataSourceProvider {
  get scheme() {
    return "inference";
  }
  get description() {
    return "Shareable inference recipe or legacy session-local result";
  }

  async get(options: GetDataSourceOptions): Promise<DataSource> {
    options.signal.throwIfAborted();
    const chunkManager = options.registry.chunkManager;
    let url = options.url;
    let owned: { url: string; dispose(): void } | undefined;
    if (url === INFERENCE_RECIPE_URL) {
      // Look up the ORIGINAL state object: validation deliberately returns a
      // detached snapshot. The hint is usable only within this ChunkManager.
      const seededUrl =
        options.state !== null && typeof options.state === "object"
          ? recipePublications.get(options.state)
          : undefined;
      if (seededUrl !== undefined) recipePublications.delete(options.state);
      const recipe = parseInferenceRecipe(options.state);
      let seeded = false;
      if (seededUrl !== undefined) {
        try {
          requireResult(chunkManager, parseInferenceUrl(seededUrl));
          url = seededUrl;
          seeded = true;
        } catch {
          // Deleted publications and other viewers must reconstruct normally.
        }
      }
      if (!seeded) {
        const { restoreInferenceRecipe } = await import(
          "#src/inference/restore.js"
        );
        options.signal.throwIfAborted();
        owned = await restoreInferenceRecipe(options, recipe);
        url = owned.url;
      }
    }
    try {
      options.signal.throwIfAborted();
      return await this.getPublished(options, url, owned);
    } catch (error) {
      owned?.dispose();
      throw error;
    }
  }

  private async getPublished(
    options: GetDataSourceOptions,
    url: string,
    owned?: { dispose(): void },
  ): Promise<DataSource> {
    const resultId = parseInferenceUrl(url);
    const chunkManager = options.registry.chunkManager;
    const { info } = requireResult(chunkManager, resultId);
    await chunkManager.rpc!.promiseInvoke(
      CHECK_INFERENCE_RESULT_RPC_ID,
      {
        chunkManager: chunkManager.rpcId,
        resultId,
      },
      { signal: options.signal },
    );
    options.signal.throwIfAborted();
    requireResult(chunkManager, resultId);
    const shape = [...info.shapeZYX].reverse();
    shape.push(info.channels);
    const names = [...info.axisNamesZYX].reverse();
    names.push("c^");
    const units: string[] = [];
    const scales = new Float64Array(4);
    for (let i = 0; i < 3; ++i) {
      const unit = supportedUnits.get(info.unitsZYX[2 - i])!;
      units.push(unit.unit);
      scales[i] = scaleByExp10(info.spacingZYX[2 - i], unit.exponent);
    }
    units.push("");
    scales[3] = 1;
    const box = {
      lowerBounds: new Float64Array(4),
      upperBounds: Float64Array.from(shape),
    };
    const inputSpace = makeCoordinateSpace({
      rank: 4,
      names,
      units,
      scales,
      boundingBoxes: [makeIdentityTransformedBoundingBox(box)],
    });
    const outputSpace = makeCoordinateSpace({ rank: 4, names, units, scales });
    const transform = matrix.createIdentity(Float64Array, 5);
    for (let i = 0; i < 3; ++i) transform[20 + i] = info.originZYX[2 - i];
    const volume = new InferenceMultiscaleVolumeChunkSource(
      chunkManager,
      resultId,
      info,
    );
    if (owned !== undefined) {
      volume.registerDisposer(() => owned.dispose());
      const dispose = () => volume.dispose();
      options.signal.addEventListener("abort", dispose, { once: true });
      chunkManager.registerDisposer(dispose);
      volume.registerDisposer(() => {
        options.signal.removeEventListener("abort", dispose);
        if (chunkManager.refCount !== 0)
          chunkManager.unregisterDisposer(dispose);
      });
    }
    return {
      canonicalUrl:
        options.url === INFERENCE_RECIPE_URL
          ? INFERENCE_RECIPE_URL
          : `inference://${resultId}`,
      canChangeModelSpaceRank: false,
      modelTransform: {
        rank: 4,
        sourceRank: 4,
        inputSpace,
        outputSpace,
        transform,
      },
      subsources: [
        {
          id: "default",
          default: true,
          subsource: {
            volume,
          },
        },
      ],
    };
  }
}
