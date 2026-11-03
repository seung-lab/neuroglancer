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
  LiveWatershedInfo,
  WatershedResultInfo,
} from "#src/datasource/watershed/base.js";
import {
  copyWatershedResultChunk,
  getLiveWatershedInfo,
  getWatershedResultInfo,
  missingWatershedResult,
  parseWatershedUrl,
  validateLiveWatershedChunkBounds,
  VolumeSourceParameters,
  WATERSHED_RESULT_MEMORY_LIMIT,
  WATERSHED_TILE_RPC_ID,
} from "#src/datasource/watershed/base.js";
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
import { raceWithAbort } from "#src/util/abort.js";
import * as matrix from "#src/util/matrix.js";
import { getRandomHexString } from "#src/util/random.js";
import { scaleByExp10, supportedUnits } from "#src/util/si_units.js";
import type { WatershedResult } from "#src/watershed/base.js";
import type { LiveWatershed } from "#src/watershed/live.js";
import { registerPromiseRPC } from "#src/worker_rpc.js";

interface PublishedResult {
  readonly info: WatershedResultInfo | LiveWatershedInfo;
  readonly byteLength: number;
  data?: Uint32Array;
  live?: LiveWatershed;
  removeInvalidation?: () => void;
  readonly sources: Set<WatershedVolumeChunkSource>;
}

interface Session {
  readonly results: Map<string, PublishedResult>;
  bytes: number;
  disposed: boolean;
}

const sessions = new WeakMap<ChunkManager, Session>();

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
    for (const source of entry.sources) {
      if (!source.wasDisposed) source.invalidateCache();
    }
    entry.sources.clear();
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
  });
  session.bytes += byteLength;
  return makePublication(session, resultId);
}

/**
 * Synchronous metadata-only publication. Takes lifetime ownership of live,
 * including on failure; no output tiles are retained outside the normal chunk
 * cache. A source invalidation expires the URL and invalidates every dependent
 * chunk cache, just like explicit disposal or ChunkManager teardown.
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
    };
    session.results.set(resultId, entry);
    session.bytes += byteLength;
    const capturedSession = session;
    const capturedId = resultId;
    const invalidate = () => disposeResult(capturedSession, capturedId);
    live.signal.addEventListener("abort", invalidate, { once: true });
    entry.removeInvalidation = () =>
      live.signal.removeEventListener("abort", invalidate);
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

export class WatershedVolumeChunkSource extends WithParameters(
  VolumeChunkSource,
  VolumeSourceParameters,
) {}

export class WatershedMultiscaleVolumeChunkSource extends MultiscaleVolumeChunkSource {
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
    return "Session-local live watershed or snapshot (not shareable)";
  }

  async get(options: GetDataSourceOptions): Promise<DataSource> {
    options.signal.throwIfAborted();
    const resultId = parseWatershedUrl(options.url);
    const chunkManager = options.registry.chunkManager;
    const { info } = requireResult(chunkManager, resultId);
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
    return {
      canonicalUrl: `watershed://${resultId}`,
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
            volume: new WatershedMultiscaleVolumeChunkSource(
              chunkManager,
              resultId,
              info,
            ),
          },
        },
      ],
    };
  }
}
