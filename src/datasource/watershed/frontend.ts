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
import {
  type LiveWatershedInfo,
  type WatershedResultInfo,
  copyWatershedResultChunk,
  getLiveWatershedInfo,
  getWatershedResultInfo,
  MeshSourceParameters,
  missingWatershedResult,
  parseWatershedUrl,
  validateLiveWatershedChunkBounds,
  VolumeSourceParameters,
  WATERSHED_RESULT_MEMORY_LIMIT,
  WATERSHED_MESH_RPC_ID,
  WATERSHED_TILE_RPC_ID,
  type WatershedMeshState,
  type WatershedMeshSnapshot,
} from "#src/datasource/watershed/base.js";
import { MeshSource } from "#src/mesh/frontend.js";
import { SharedWatchableValue } from "#src/shared_watchable_value.js";
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
import { StatusMessage, statusMessages } from "#src/status.js";
import { raceWithAbort } from "#src/util/abort.js";
import { RefCounted } from "#src/util/disposable.js";
import * as matrix from "#src/util/matrix.js";
import { getRandomHexString } from "#src/util/random.js";
import { scaleByExp10, supportedUnits } from "#src/util/si_units.js";
import { registerWatershedAttachment } from "#src/watershed/attachment.js";
import type { WatershedResult } from "#src/watershed/base.js";
import type { LiveWatershed } from "#src/watershed/live.js";
import { WatershedMeshSelection } from "#src/watershed/mesh_selection.js";
import { WatershedParametersState } from "#src/watershed/parameters.js";
import type { WatershedRecipe } from "#src/watershed/recipe.js";
import {
  parseWatershedRecipe,
  WATERSHED_RECIPE_URL,
} from "#src/watershed/recipe.js";
import type { restoreWatershedRecipe } from "#src/watershed/restore.js";
import { registerPromiseRPC } from "#src/worker_rpc.js";

interface PublishedResult {
  readonly info: WatershedResultInfo | LiveWatershedInfo;
  readonly byteLength: number;
  data?: Uint32Array;
  live?: LiveWatershed;
  removeInvalidation?: () => void;
  readonly sources: Set<WatershedVolumeChunkSource>;
  readonly meshSources: Map<string, WatershedMeshSource>;
  invalidatingSources?: boolean;
}

interface Session {
  readonly results: Map<string, PublishedResult>;
  bytes: number;
  disposed: boolean;
}

const sessions = new WeakMap<ChunkManager, Session>();

// Initial UI publications are reused only by object identity, never saved JSON.
const recipePublications = new WeakMap<
  object,
  {
    url: string;
    globalCoordinateSpace: GetDataSourceOptions["globalCoordinateSpace"];
  }
>();

export function makeWatershedRecipeSource(
  publication: { url: string },
  recipe: WatershedRecipe,
  globalCoordinateSpace: GetDataSourceOptions["globalCoordinateSpace"],
): { url: string; state: WatershedRecipe } {
  recipePublications.set(recipe, {
    url: publication.url,
    globalCoordinateSpace,
  });
  return { url: WATERSHED_RECIPE_URL, state: recipe };
}

function invalidateResultSources(entry: PublishedResult) {
  if (entry.invalidatingSources) return;
  entry.invalidatingSources = true;
  try {
    // Observers may dispose the publication during invalidation. Finish the
    // captured sources even if disposal clears the collections, without
    // invalidating them recursively through disposeResult.
    const volumeSources = Array.from(entry.sources);
    const meshSources = Array.from(entry.meshSources.values());
    for (const source of volumeSources) {
      if (!source.wasDisposed) source.invalidateCache();
    }
    for (const source of meshSources) {
      if (!source.wasDisposed) source.invalidateFor(entry.live?.epoch ?? -1);
    }
  } finally {
    entry.invalidatingSources = false;
  }
}

function disposeResult(session: Session, resultId: string) {
  const entry = session.results.get(resultId);
  if (entry === undefined) return;
  session.results.delete(resultId);
  session.bytes -= entry.byteLength;
  // Handles and source disposers can outlive the publication. Release its input.
  entry.data = undefined;
  const live = entry.live;
  entry.live = undefined;
  entry.removeInvalidation?.();
  entry.removeInvalidation = undefined;
  try {
    live?.dispose();
  } finally {
    invalidateResultSources(entry);
    entry.sources.clear();
    entry.meshSources.clear();
  }
}

function getSession(chunkManager: ChunkManager): Session {
  if (
    chunkManager.wasDisposed ||
    chunkManager.refCount === 0 ||
    chunkManager.rpc === null
  ) {
    throw new Error("Cannot publish watershed to a disposed ChunkManager");
  }
  let session = sessions.get(chunkManager);
  if (session !== undefined) return session;
  session = { results: new Map(), bytes: 0, disposed: false };
  sessions.set(chunkManager, session);
  const capturedSession = session;
  chunkManager.registerDisposer(() => {
    capturedSession.disposed = true;
    for (const resultId of capturedSession.results.keys()) {
      disposeResult(capturedSession, resultId);
    }
    capturedSession.bytes = 0;
    sessions.delete(chunkManager);
  });
  return session;
}

function requireResult(
  chunkManager: ChunkManager,
  resultId: string,
): PublishedResult {
  const session = sessions.get(chunkManager);
  const entry = session?.results.get(resultId);
  if (session?.disposed || entry === undefined) {
    throw missingWatershedResult(resultId);
  }
  if (entry.live !== undefined) {
    try {
      entry.live.signal.throwIfAborted();
      entry.live.assertValid();
    } catch {
      disposeResult(session!, resultId);
      throw missingWatershedResult(resultId);
    }
  }
  return entry;
}

// A separate scope ensures handles never capture the caller's result or array.
function makePublication(session: Session, resultId: string) {
  return {
    url: `watershed://${resultId}`,
    dispose: () => disposeResult(session, resultId),
  };
}

/**
 * Synchronously publish a private UINT32 snapshot without retaining/detaching the
 * caller's data. Only fresh tile copies cross RPC. URLs are session-local, not a
 * shareable recipe, and expire on dispose() or ChunkManager teardown.
 * Remove dependent layers before disposal; chunk-cache invalidation is async.
 */
export function publishWatershedResult(
  chunkManager: ChunkManager,
  result: WatershedResult,
): { url: string; dispose(): void } {
  const session = getSession(chunkManager);
  const data = result.data;
  const info = getWatershedResultInfo({
    data,
    shapeXYZ: result.shapeXYZ,
    offsetXYZ: result.offsetXYZ,
    spacingXYZ: result.spacingXYZ,
    unitsXYZ: result.unitsXYZ,
  });
  const dataBytes = data.byteLength;
  const byteLength =
    dataBytes + new TextEncoder().encode(JSON.stringify(info)).byteLength;
  if (session.bytes + byteLength > WATERSHED_RESULT_MEMORY_LIMIT) {
    throw new Error(
      "Watershed results exceed the 128 MiB session memory limit; dispose old results first",
    );
  }
  const snapshot = new Uint32Array(data);
  if (snapshot.byteLength !== dataBytes) {
    throw new Error("Watershed data changed while publishing");
  }
  let resultId: string;
  do {
    resultId = getRandomHexString();
  } while (session.results.has(resultId));
  session.results.set(resultId, {
    info,
    byteLength,
    data: snapshot,
    sources: new Set(),
    meshSources: new Map(),
  });
  session.bytes += byteLength;
  return makePublication(session, resultId);
}

/**
 * Synchronous metadata-only publication. Takes lifetime ownership of live,
 * including on failure. The producer retains one bounded completed regional
 * UINT32 result, not a private per-tile cache; display chunks are only transport
 * copies in the ordinary chunk cache. Regional changes invalidate all dependent
 * chunk caches but keep the URL alive. Only a lifetime abort, explicit disposal,
 * or ChunkManager teardown expires the URL.
 */
export function publishLiveWatershed(
  chunkManager: ChunkManager,
  live: LiveWatershed,
): { url: string; dispose(): void } {
  let session: Session | undefined;
  let resultId: string | undefined;
  try {
    session = getSession(chunkManager);
    live.signal.throwIfAborted();
    live.assertValid();
    const info = getLiveWatershedInfo(live.info);
    const byteLength = new TextEncoder().encode(
      JSON.stringify(info),
    ).byteLength;
    if (session.bytes + byteLength > WATERSHED_RESULT_MEMORY_LIMIT) {
      throw new Error(
        "Watershed results exceed the 128 MiB session memory limit; dispose old results first",
      );
    }
    do {
      resultId = getRandomHexString();
    } while (session.results.has(resultId));
    const entry: PublishedResult = {
      info,
      byteLength,
      live,
      sources: new Set(),
      meshSources: new Map(),
    };
    session.results.set(resultId, entry);
    session.bytes += byteLength;
    const capturedSession = session;
    const capturedId = resultId;
    const retire = () => disposeResult(capturedSession, capturedId);
    const removeChanged = live.changed.add(() =>
      invalidateResultSources(entry),
    );
    entry.removeInvalidation = () => {
      removeChanged();
      live.signal.removeEventListener("abort", retire);
    };
    live.signal.addEventListener("abort", retire, { once: true });
    live.signal.throwIfAborted();
    return makePublication(session, resultId);
  } catch (error) {
    if (session !== undefined && resultId !== undefined) {
      disposeResult(session, resultId);
    } else {
      live.dispose();
    }
    throw error;
  }
}

registerPromiseRPC<Uint32Array | BigUint64Array | undefined>(
  WATERSHED_TILE_RPC_ID,
  async function (x, { signal }) {
    signal ??= new AbortController().signal;
    signal.throwIfAborted();
    const manager: ChunkManager = this.get(x.chunkManager);
    let entry: PublishedResult;
    try {
      entry = requireResult(manager, x.resultId);
    } catch (error) {
      // A removed live layer can still have stale worker demand. An unavailable
      // sentinel lets the worker await scheduler cancellation, not cache FAILED.
      if (x.live === true) return { value: undefined };
      throw error;
    }
    const live = entry.live;
    if (live === undefined) {
      if (x.live === true) throw new Error("Not a live watershed source");
      const data = copyWatershedResultChunk(
        entry.data!,
        entry.info.shapeXYZ,
        x.lowerXYZ,
        x.sizeXYZ,
      );
      return { value: data, transfers: [data.buffer] };
    }
    const count = validateLiveWatershedChunkBounds(
      entry.info as LiveWatershedInfo,
      x.lowerXYZ,
      x.sizeXYZ,
    );
    const combined = AbortSignal.any([signal, live.signal]);
    try {
      const data = await raceWithAbort(
        live.readTile(x.lowerXYZ, x.sizeXYZ, combined),
        combined,
      );
      combined.throwIfAborted();
      // Recheck lifetime after computation, even if the producer ignored abort.
      requireResult(manager, x.resultId);
      if (!(data instanceof BigUint64Array) || data.length !== count) {
        throw new Error("Invalid live watershed tile data");
      }
      // A private exact-sized transfer also protects shared in-flight subscribers
      // and producer subarrays from detachment. This is never an output cache.
      const copy = BigUint64Array.from(data);
      return { value: copy, transfers: [copy.buffer] };
    } catch (error) {
      signal.throwIfAborted();
      if (
        live.signal.aborted ||
        sessions.get(manager)?.results.get(x.resultId) !== entry
      ) {
        return { value: undefined };
      }
      throw error;
    }
  },
);

registerPromiseRPC<WatershedMeshState | WatershedMeshSnapshot | undefined>(
  WATERSHED_MESH_RPC_ID,
  async function (x, { signal }) {
    signal?.throwIfAborted();
    const manager: ChunkManager = this.get(x.chunkManager);
    const entry = sessions.get(manager)?.results.get(x.resultId);
    const live = entry?.live;
    const source = entry?.meshSources.get(x.meshKey);
    if (
      live === undefined ||
      live.signal.aborted ||
      source === undefined ||
      source.wasDisposed ||
      source.state.value.generation !== x.generation
    )
      return { value: undefined };
    if (typeof x.error === "string") {
      source.reportError(x.error);
      return { value: undefined };
    }
    if (
      typeof x.objectId !== "bigint" ||
      x.objectId <= 0n ||
      x.objectId > 0xffff_ffffn ||
      !live.hasCompletedResult ||
      !source.selection?.allows(x.objectId, live.epoch)
    )
      return { value: undefined };
    if (!x.snapshot) return { value: source.state.value };
    const snapshot = live.getCompletedSnapshot();
    if (snapshot === undefined || snapshot.epoch !== source.state.value.epoch)
      return { value: undefined };
    return {
      value: {
        epoch: snapshot.epoch,
        generation: source.state.value.generation,
        lowerXYZ: snapshot.sourceRelativeLowerXYZ,
        shapeXYZ: snapshot.shapeXYZ,
        labels: snapshot.labels,
      },
      transfers: [snapshot.labels.buffer],
    };
  },
);

export class WatershedMeshSource extends WithParameters(
  MeshSource,
  MeshSourceParameters,
) {
  readonly state = this.registerDisposer(
    SharedWatchableValue.make<WatershedMeshState>(this.chunkManager.rpc!, {
      epoch: 0,
      generation: 0,
    }),
  );
  selection: WatershedMeshSelection | undefined;
  private status: StatusMessage | undefined;

  constructor(...args: ConstructorParameters<typeof MeshSource>) {
    super(...args);
    this.registerDisposer(() => this.clearError());
  }

  initializeCounterpart(rpc: NonNullable<MeshSource["rpc"]>, options: any) {
    options.state = this.state.addCounterpartRef();
    super.initializeCounterpart(rpc, options);
  }

  getChunk(x: any) {
    const chunk = super.getChunk(x);
    if (
      chunk.fragmentIds.some((id) => id !== String(this.state.value.generation))
    )
      chunk.fragmentIds = [];
    return chunk;
  }

  private clearError() {
    if (this.status !== undefined && statusMessages.has(this.status))
      this.status.dispose();
    this.status = undefined;
  }

  reportError(error: string) {
    if (this.status === undefined || !statusMessages.has(this.status))
      this.status = new StatusMessage();
    this.status.setErrorMessage(`Watershed meshing: ${error}`);
  }

  invalidateFor(epoch: number) {
    if (this.wasDisposed) return;
    this.clearError();
    this.state.value = { epoch, generation: this.state.value.generation + 1 };
    if (this.wasDisposed) return;
    // Stop drawing old GPU fragments immediately, before worker-side eviction.
    for (const chunk of this.chunks.values()) chunk.fragmentIds = [];
    this.invalidateCache();
    if (this.wasDisposed) return;
    this.fragmentSource.invalidateCache();
    this.chunkManager.chunkQueueManager.visibleChunksChanged.dispatch();
  }
}

export class WatershedVolumeChunkSource extends WithParameters(
  VolumeChunkSource,
  VolumeSourceParameters,
) {}

export class WatershedMultiscaleVolumeChunkSource extends MultiscaleVolumeChunkSource {
  private readonly lifetime = new RefCounted();

  registerDisposer(dispose: () => void) {
    return this.lifetime.registerDisposer(dispose);
  }

  dispose() {
    if (!this.lifetime.wasDisposed) this.lifetime.dispose();
  }

  constructor(
    chunkManager: ChunkManager,
    public readonly resultId: string,
    public readonly info: WatershedResultInfo | LiveWatershedInfo,
  ) {
    super(chunkManager);
  }
  get dataType() {
    return "chunkShapeXYZ" in this.info ? DataType.UINT64 : DataType.UINT32;
  }
  get volumeType() {
    return VolumeType.SEGMENTATION;
  }
  get rank() {
    return 3;
  }

  getSources(_volumeSourceOptions: VolumeSourceOptions) {
    const entry = requireResult(this.chunkManager, this.resultId);
    const spec = makeVolumeChunkSpecification({
      rank: 3,
      dataType: this.dataType,
      chunkDataSize:
        "chunkShapeXYZ" in this.info
          ? Uint32Array.from(this.info.chunkShapeXYZ)
          : Uint32Array.from(this.info.shapeXYZ, (x) => Math.min(x, 32)),
      upperVoxelBound: Float32Array.from(this.info.shapeXYZ),
      // Translation belongs in the model transform, not chunk lookup bounds.
      baseVoxelOffset: new Float32Array(3),
    });
    const chunkSource = this.chunkManager.getChunkSource(
      WatershedVolumeChunkSource,
      {
        spec,
        parameters: { resultId: this.resultId, live: entry.live !== undefined },
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
          chunkToMultiscaleTransform: matrix.createIdentity(Float32Array, 4),
        },
      ],
    ];
  }
}

export class WatershedDataSourceProvider implements DataSourceProvider {
  get scheme() {
    return "watershed";
  }
  get description() {
    return "Viewport watershed recipe or session-local result";
  }

  async get(options: GetDataSourceOptions): Promise<DataSource> {
    options.signal.throwIfAborted();
    let url = options.url;
    let recipe: WatershedRecipe | undefined;
    let owned: Awaited<ReturnType<typeof restoreWatershedRecipe>> | undefined;
    if (url === WATERSHED_RECIPE_URL) {
      const hint =
        options.state !== null && typeof options.state === "object"
          ? recipePublications.get(options.state)
          : undefined;
      recipe = parseWatershedRecipe(options.state);
      let seeded = false;
      if (
        hint !== undefined &&
        hint.globalCoordinateSpace === options.globalCoordinateSpace
      ) {
        try {
          requireResult(
            options.registry.chunkManager,
            parseWatershedUrl(hint.url),
          );
          url = hint.url;
          recipePublications.delete(options.state);
          seeded = true;
        } catch {
          // Deleted publications reconstruct just like copied recipes.
        }
      }
      if (!seeded) {
        const { restoreWatershedRecipe } = await import(
          "#src/watershed/restore.js"
        );
        options.signal.throwIfAborted();
        owned = await restoreWatershedRecipe(options, recipe);
        url = owned.url;
      }
    }
    try {
      options.signal.throwIfAborted();
      return this.getPublished(options, url, owned, recipe);
    } catch (error) {
      owned?.dispose();
      throw error;
    }
  }

  private getPublished(
    options: GetDataSourceOptions,
    url: string,
    owned?: Awaited<ReturnType<typeof restoreWatershedRecipe>>,
    recipe?: WatershedRecipe,
  ): DataSource {
    const resultId = parseWatershedUrl(url);
    const chunkManager = options.registry.chunkManager;
    const entry = requireResult(chunkManager, resultId);
    const { info, live } = entry;
    const names = ["x", "y", "z"];
    const units: string[] = [];
    const scales = new Float64Array(3);
    for (let i = 0; i < 3; ++i) {
      const unit = supportedUnits.get(info.unitsXYZ[i])!;
      units.push(unit.unit);
      scales[i] = scaleByExp10(info.spacingXYZ[i], unit.exponent);
    }
    const inputSpace = makeCoordinateSpace({
      rank: 3,
      names,
      units,
      scales,
      boundingBoxes: [
        makeIdentityTransformedBoundingBox({
          lowerBounds: new Float64Array(3),
          upperBounds: Float64Array.from(info.shapeXYZ),
        }),
      ],
    });
    const outputSpace = makeCoordinateSpace({ rank: 3, names, units, scales });
    const transform = matrix.createIdentity(Float64Array, 4);
    transform.set(info.offsetXYZ, 12);
    const volume = new WatershedMultiscaleVolumeChunkSource(
      chunkManager,
      resultId,
      info,
    );
    const mesh =
      live === undefined
        ? undefined
        : chunkManager.getChunkSource(WatershedMeshSource, {
            parameters: { resultId, meshKey: getRandomHexString() },
          });
    if (mesh !== undefined && live !== undefined) {
      entry.meshSources.set(mesh.parameters.meshKey, mesh);
      mesh.state.value = { epoch: live.epoch, generation: 0 };
      volume.registerDisposer(() => mesh.dispose());
      volume.registerDisposer(() =>
        entry.meshSources.delete(mesh.parameters.meshKey),
      );
    }
    if (owned !== undefined) volume.registerDisposer(owned.dispose);
    if (owned !== undefined || mesh !== undefined) {
      let detachAttachment: (() => void) | undefined;
      volume.registerDisposer(() => detachAttachment?.());
      volume.registerDisposer(
        registerWatershedAttachment(volume, (layer) => {
          detachAttachment?.();
          const detach = owned?.attach(layer);
          const selection =
            live !== undefined && mesh !== undefined
              ? new WatershedMeshSelection(live, layer)
              : undefined;
          if (
            mesh !== undefined &&
            selection !== undefined &&
            live !== undefined
          ) {
            mesh.selection = selection;
            mesh.invalidateFor(live.epoch);
          }
          const remove = selection?.changed.add(() => {
            if (mesh !== undefined && !mesh.wasDisposed && live !== undefined)
              mesh.invalidateFor(live.signal.aborted ? -1 : live.epoch);
          });
          let attached = true;
          const cleanup = () => {
            if (!attached) return;
            attached = false;
            if (detachAttachment === cleanup) detachAttachment = undefined;
            remove?.();
            if (mesh !== undefined && mesh.selection === selection)
              mesh.selection = undefined;
            selection?.dispose();
            if (mesh !== undefined && !mesh.wasDisposed)
              mesh.invalidateFor(
                live?.signal.aborted ? -1 : (live?.epoch ?? -1),
              );
            detach?.();
          };
          detachAttachment = cleanup;
          return cleanup;
        }),
      );
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
      state:
        recipe !== undefined && live !== undefined
          ? new WatershedParametersState(recipe, (next) =>
              live.setParameters(next.channelsXYZ, next.options, next.halo),
            )
          : undefined,
      canonicalUrl:
        options.url === WATERSHED_RECIPE_URL
          ? WATERSHED_RECIPE_URL
          : `watershed://${resultId}`,
      canChangeModelSpaceRank: false,
      modelTransform: {
        rank: 3,
        sourceRank: 3,
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
        ...(mesh === undefined
          ? []
          : [{ id: "meshes", default: true, subsource: { mesh } }]),
      ],
    };
  }
}
