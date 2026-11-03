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
import type { WatershedResultInfo } from "#src/datasource/watershed/base.js";
import {
  copyWatershedResultChunk,
  getWatershedResultInfo,
  missingWatershedResult,
  parseWatershedUrl,
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
import * as matrix from "#src/util/matrix.js";
import { getRandomHexString } from "#src/util/random.js";
import { scaleByExp10, supportedUnits } from "#src/util/si_units.js";
import type { WatershedResult } from "#src/watershed/base.js";
import { registerPromiseRPC } from "#src/worker_rpc.js";

interface PublishedResult {
  readonly info: WatershedResultInfo;
  readonly byteLength: number;
  data: Uint32Array | undefined;
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
  for (const source of entry.sources) {
    if (!source.wasDisposed) source.invalidateCache();
  }
  entry.sources.clear();
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
): PublishedResult & { data: Uint32Array } {
  const session = sessions.get(chunkManager);
  const entry = session?.results.get(resultId);
  if (session?.disposed || entry === undefined || entry.data === undefined) {
    throw missingWatershedResult(resultId);
  }
  return entry as PublishedResult & { data: Uint32Array };
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

registerPromiseRPC(WATERSHED_TILE_RPC_ID, async function (x, { signal }) {
  signal?.throwIfAborted();
  const entry = requireResult(this.get(x.chunkManager), x.resultId);
  const data = copyWatershedResultChunk(
    entry.data,
    entry.info.shapeXYZ,
    x.lowerXYZ,
    x.sizeXYZ,
  );
  return { value: data, transfers: [data.buffer] };
});

export class WatershedVolumeChunkSource extends WithParameters(
  VolumeChunkSource,
  VolumeSourceParameters,
) {}

export class WatershedMultiscaleVolumeChunkSource extends MultiscaleVolumeChunkSource {
  constructor(
    chunkManager: ChunkManager,
    public readonly resultId: string,
    public readonly info: WatershedResultInfo,
  ) {
    super(chunkManager);
  }
  get dataType() {
    return DataType.UINT32;
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
      dataType: DataType.UINT32,
      chunkDataSize: Uint32Array.from(this.info.shapeXYZ, (x) =>
        Math.min(x, 32),
      ),
      upperVoxelBound: Float32Array.from(this.info.shapeXYZ),
      // Translation belongs in the model transform, not chunk lookup bounds.
      baseVoxelOffset: new Float32Array(3),
    });
    const chunkSource = this.chunkManager.getChunkSource(
      WatershedVolumeChunkSource,
      { spec, parameters: { resultId: this.resultId } },
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
    return "Session-local watershed snapshot (not shareable)";
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
