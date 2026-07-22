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

import { decodeDracoMesh } from "#src/async_computation/decode_draco_request.js";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import {
  WithParameters,
  withChunkManager,
  Chunk,
  ChunkSource,
} from "#src/chunk_manager/backend.js";
import { ChunkPriorityTier, ChunkState } from "#src/chunk_manager/base.js";
import type {
  ChunkedGraphChunkSpecification,
  HttpSource,
} from "#src/datasource/calcada/base.js";
import {
  getGrapheneFragmentKey,
  GRAPHENE_MESH_NEW_SEGMENT_RPC_ID,
  CALCADA_BULK_LINK_RPC_ID,
  ChunkedGraphSourceParameters,
  VolumeChunkSourceParameters as CalcadaVolumeChunkSourceParameters,
  VolumeChunkEncoding,
  MeshSourceParameters,
  CHUNKED_GRAPH_LAYER_RPC_ID,
  CHUNKED_GRAPH_RENDER_LAYER_UPDATE_SOURCES_RPC_ID,
  RENDER_RATIO_LIMIT,
  isBaseSegmentId,
  parseGrapheneError,
  getHttpSource,
} from "#src/datasource/calcada/base.js";
import { decodeManifestChunk } from "#src/datasource/precomputed/backend.js";
import { WithSharedKvStoreContextCounterpart } from "#src/kvstore/backend.js";
import type { KvStoreWithPath, ReadResponse } from "#src/kvstore/index.js";
import { readKvStore } from "#src/kvstore/index.js";
import type { FragmentChunk, ManifestChunk } from "#src/mesh/backend.js";
import { assignMeshFragmentData, MeshSource } from "#src/mesh/backend.js";
import type { DisplayDimensionRenderInfo } from "#src/navigation_state.js";
import type {
  RenderedViewBackend,
  RenderLayerBackendAttachment,
} from "#src/render_layer_backend.js";
import { RenderLayerBackend } from "#src/render_layer_backend.js";
import { withSegmentationLayerBackendState } from "#src/segmentation_display_state/backend.js";
import type { SharedWatchableValue } from "#src/shared_watchable_value.js";
import type { SliceViewChunkSourceBackend } from "#src/sliceview/backend.js";
import { deserializeTransformedSources } from "#src/sliceview/backend.js";
import { decodeCompressedSegmentationChunk } from "#src/sliceview/backend_chunk_decoders/compressed_segmentation.js";
import { decodeRawChunk } from "#src/sliceview/backend_chunk_decoders/raw.js";
import type {
  SliceViewProjectionParameters,
  TransformedSource,
} from "#src/sliceview/base.js";
import type { VolumeChunk } from "#src/sliceview/volume/backend.js";
import {
  VolumeChunkSource,
  computeChunkBounds,
} from "#src/sliceview/volume/backend.js";
import { Uint64Set } from "#src/uint64_set.js";
import { vec3Key } from "#src/util/geom.js";
import { HttpError } from "#src/util/http_request.js";
import { parseUint64, verifyStringArray } from "#src/util/json.js";
import { Signal } from "#src/util/signal.js";
import { withSharedVisibility } from "#src/visibility_priority/backend.js";
import type { RPC } from "#src/worker_rpc.js";
import { registerSharedObject, registerRPC } from "#src/worker_rpc.js";

function downloadFragmentWithSharding(
  fragmentKvStore: KvStoreWithPath,
  fragmentId: string,
  signal: AbortSignal,
): Promise<ReadResponse> {
  if (fragmentId && fragmentId.charAt(0) === "~") {
    const parts = fragmentId.substring(1).split(":");
    const byteRange = { offset: Number(parts[1]), length: Number(parts[2]) };
    return readKvStore(
      fragmentKvStore.store,
      `${fragmentKvStore.path}initial/${parts[0]}`,
      { signal, byteRange, throwIfMissing: true },
    );
  }
  return readKvStore(
    fragmentKvStore.store,
    `${fragmentKvStore.path}dynamic/${fragmentId}`,
    { signal, throwIfMissing: true },
  );
}

function downloadFragment(
  fragmentKvStore: KvStoreWithPath,
  fragmentId: string,
  parameters: MeshSourceParameters,
  signal: AbortSignal,
): Promise<ReadResponse> {
  if (parameters.sharding) {
    return downloadFragmentWithSharding(fragmentKvStore, fragmentId, signal);
  } else {
    return readKvStore(
      fragmentKvStore.store,
      `${fragmentKvStore.path}${fragmentId}`,
      { signal, throwIfMissing: true },
    );
  }
}

async function decodeDracoFragmentChunk(
  chunk: FragmentChunk,
  response: Uint8Array,
  signal: AbortSignal,
) {
  // Decode Draco on the async-computation worker pool rather than inline on the
  // chunk worker: a neuron's many per-piece fragments then decode in parallel
  // across the pool and off the thread that also runs 2D chunk decode and
  // equivalence updates.
  const { data: rawMesh } = await requestAsyncComputation(
    decodeDracoMesh,
    signal,
    [response.buffer],
    response,
  );
  assignMeshFragmentData(chunk, rawMesh);
}

// Module-level reference to active ChunkedGraphLayers — used by
// CalcadaVolumeChunkSource.download to build piece→root equivalences from
// the LUT trailer of each chunk. Tracking the LAYER (not just its
// equivalences) lets us read the layer's current branchId at download time
// and skip layers whose branch doesn't match the chunk's branch — without
// this filter, a main-branch chunk would link its LUT into a branch
// layer's equivalences and (because of the "skip if piece already in
// disjoint set" guard) the branch's own LUT would be silently dropped.
const allActiveChunkedGraphLayers = new Set<ChunkedGraphLayer>();

// Decoder map for calcada chunk formats
const calcadaChunkDecoders = new Map<
  VolumeChunkEncoding,
  (chunk: VolumeChunk, signal: AbortSignal, data: ArrayBuffer) => Promise<void>
>();
calcadaChunkDecoders.set(
  VolumeChunkEncoding.COMPRESSED_SEGMENTATION,
  decodeCompressedSegmentationChunk,
);
calcadaChunkDecoders.set(VolumeChunkEncoding.RAW, decodeRawChunk);

// fetchLutTrailer fetches the standalone piece→root LUT trailer for a chunk
// from calcada (…/precomputed_rp/{scale}/{bounds}?lut_only=true).
async function fetchLutTrailer(
  src: HttpSource,
  chunkPath: string,
  branchQuery: string,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await src.fetchOkImpl(
    `${src.baseUrl}${chunkPath}?lut_only=true${branchQuery}`,
    { signal },
  );
  return response.arrayBuffer();
}

// parseLutTrailer parses the LUT trailer format
// [N × (piece u64 LE, root u64 LE)][N as u32 LE] into parallel arrays.
function parseLutTrailer(buffer: ArrayBuffer): {
  pieces: BigUint64Array;
  roots: BigUint64Array;
} {
  const empty = { pieces: new BigUint64Array(0), roots: new BigUint64Array(0) };
  const byteLen = buffer.byteLength;
  if (byteLen < 4) return empty;
  const view = new DataView(buffer);
  const count = view.getUint32(byteLen - 4, true);
  if (count === 0 || count * 16 + 4 > byteLen) return empty;
  const start = byteLen - (count * 16 + 4);
  const pieces = new BigUint64Array(count);
  const roots = new BigUint64Array(count);
  for (let i = 0; i < count; i++) {
    const offset = start + i * 16;
    pieces[i] = view.getBigUint64(offset, true);
    roots[i] = view.getBigUint64(offset + 8, true);
  }
  return { pieces, roots };
}

// linkChunkEquivalences feeds piece→root pairs into each matching layer's
// segmentEquivalences — identical to the LUT-trailer path (see download), so
// root colouring of the whole visible volume is preserved without selection.
function linkChunkEquivalences(
  pieces: BigUint64Array,
  roots: BigUint64Array,
  branchId: number,
) {
  for (const layer of allActiveChunkedGraphLayers) {
    if (layer.branchId.value !== branchId) continue;
    const equivs = layer.segmentEquivalences;
    const pairs: bigint[] = [];
    const n = Math.min(pieces.length, roots.length);
    for (let i = 0; i < n; i++) {
      const pieceId = pieces[i];
      const rootId = roots[i];
      if (pieceId === 0n || rootId === 0n) continue;
      if (!equivs.disjointSets.has(pieceId)) {
        equivs.disjointSets.link(rootId, pieceId);
        pairs.push(rootId, pieceId);
      }
    }
    if (pairs.length > 0 && equivs.rpc) {
      const buf = new BigUint64Array(pairs);
      equivs.rpc.invoke(
        CALCADA_BULK_LINK_RPC_ID,
        { id: equivs.rpcId, pairs: buf.buffer },
        [buf.buffer],
      );
    }
  }
}

/**
 * Backend volume chunk source for calcada that handles /precomputed_rp/ responses.
 * Downloads chunks, strips the piece→root LUT trailer, feeds LUT to equivalences,
 * and decodes the remaining bytes as standard compressed_segmentation.
 */
@registerSharedObject()
export class CalcadaVolumeChunkSource extends WithParameters(
  WithSharedKvStoreContextCounterpart(VolumeChunkSource),
  CalcadaVolumeChunkSourceParameters,
) {
  chunkDecoder = calcadaChunkDecoders.get(this.parameters.encoding)!;
  kvStore = this.sharedKvStoreContext.kvStoreContext.getKvStore(
    this.parameters.url,
  );

  async download(chunk: VolumeChunk, signal: AbortSignal): Promise<void> {
    const { kvStore } = this;
    const chunkPosition = this.computeChunkBounds(chunk);
    const chunkDataSize = chunk.chunkDataSize!;
    const chunkPath =
      `${chunkPosition[0]}-${chunkPosition[0] + chunkDataSize[0]}_` +
      `${chunkPosition[1]}-${chunkPosition[1] + chunkDataSize[1]}_` +
      `${chunkPosition[2]}-${chunkPosition[2] + chunkDataSize[2]}`;

    // Live-state path (no time-travel / non-default branch): take the
    // normal kvstore code path so caching and request batching keep
    // working unchanged.
    const { timestampMs, branchId } = this.parameters;
    const timeTravel = !!timestampMs && timestampMs > 0;

    // Main + branch (no time-travel): redirect voxels — calcada resolves the
    // exact object (base / per-branch overlay) and 302s the client straight to
    // the public bucket — AND fetch the piece→root LUT trailer from calcada in
    // parallel. Feeds the same per-chunk equivalences (root colouring of the
    // whole visible volume) with no heavy client-side decode.
    if (!timeTravel) {
      const httpStore = kvStore.store as any; // ReadableHttpKvStore (calcada _rp)
      const lutSource = getHttpSource(
        this.sharedKvStoreContext.kvStoreContext,
        this.parameters.lutUrl,
      );
      // Voxels: calcada _rp redirects to the public bucket by default (base or
      // per-branch overlay); fetchOkImpl follows the 302 to GCS.
      const voxelQuery = branchId && branchId > 0 ? `?branch_id=${branchId}` : "";
      const lutBranchQuery =
        branchId && branchId > 0 ? `&branch_id=${branchId}` : "";
      const voxelUrl = `${httpStore.baseUrl}${kvStore.path}${chunkPath}${voxelQuery}`;
      const [voxelResp, lutBuffer] = await Promise.all([
        httpStore.fetchOkImpl(voxelUrl, { signal }), // follows the 302 → GCS
        fetchLutTrailer(lutSource, chunkPath, lutBranchQuery, signal),
      ]);
      if (!voxelResp.ok) return;
      const rawChunk = await voxelResp.arrayBuffer();
      await this.chunkDecoder(chunk, signal, rawChunk);
      const { pieces, roots } = parseLutTrailer(lutBuffer);
      if (pieces.length > 0) {
        linkChunkEquivalences(pieces, roots, branchId);
      }
      return;
    }

    let fullBuffer: ArrayBuffer;
    {
      // Time-travel / branch path: kvstore would URL-encode `?` in the path,
      // which would put `timestamp=…` into the bbox segment and break the
      // backend parser. Bypass the kvstore and issue a direct fetch using
      // the same HTTP fetcher the kvstore would have used.
      // The runtime kvstore is a ReadableHttpKvStore but the generic type is
      // not statically visible here, so we cast through `any` for the field
      // accesses we need (baseUrl, fetchOkImpl). Reads are protocol-safe.
      const httpStore = kvStore.store as any;
      const query: string[] = [];
      if (timestampMs && timestampMs > 0) {
        query.push(`timestamp=${timestampMs / 1000}`);
      }
      if (branchId && branchId > 0) {
        query.push(`branch_id=${branchId}`);
      }
      const url = `${httpStore.baseUrl}${kvStore.path}${chunkPath}?${query.join("&")}`;
      const response = await httpStore.fetchOkImpl(url, { signal });
      if (!response.ok) return;
      fullBuffer = await response.arrayBuffer();
    }

    // Extract LUT trailer: last 4 bytes = N (uint32 LE), then N × 16 bytes of (piece, root) pairs
    const fullView = new DataView(fullBuffer);
    const byteLen = fullBuffer.byteLength;

    if (byteLen < 4) {
      await this.chunkDecoder(chunk, signal, fullBuffer);
      return;
    }

    const lutCount = fullView.getUint32(byteLen - 4, true);
    const lutByteSize = lutCount * 16 + 4;

    if (lutCount === 0 || lutByteSize > byteLen) {
      console.warn(
        `[calcada chunk] NO LUT: bbox=${chunkPath} byteLen=${byteLen} lutCount=${lutCount}`,
      );
      await this.chunkDecoder(chunk, signal, fullBuffer);
      return;
    }

    // Split: chunk data + LUT trailer
    const chunkData = fullBuffer.slice(0, byteLen - lutByteSize);
    const lutStart = byteLen - lutByteSize;

    // Build equivalences BEFORE decoding chunk so they're ready when
    // the chunk renders. Only update layers whose current branchId
    // matches this chunk's parameters.branchId — otherwise a main-branch
    // chunk poisons a branch layer's equivalences (piece→main_root) and
    // the branch layer's own chunk LUT is silently skipped by the
    // "already in disjoint set" guard, leaving the branch displayed as
    // the main view.
    for (const layer of allActiveChunkedGraphLayers) {
      if (layer.branchId.value !== branchId) continue;
      const equivs = layer.segmentEquivalences;
      const pairs: bigint[] = [];
      for (let i = 0; i < lutCount; i++) {
        const offset = lutStart + i * 16;
        const pieceId = fullView.getBigUint64(offset, true);
        const rootId = fullView.getBigUint64(offset + 8, true);
        if (pieceId === 0n || rootId === 0n) continue;
        if (!equivs.disjointSets.has(pieceId)) {
          equivs.disjointSets.link(rootId, pieceId);
          pairs.push(rootId, pieceId);
        }
      }
      if (pairs.length > 0 && equivs.rpc) {
        const buf = new BigUint64Array(pairs);
        equivs.rpc.invoke(
          CALCADA_BULK_LINK_RPC_ID,
          {
            id: equivs.rpcId,
            pairs: buf.buffer,
          },
          [buf.buffer],
        );
      }
    }

    // Decode chunk data (piece_ids in compressed_segmentation)
    await this.chunkDecoder(chunk, signal, chunkData);
  }
}

@registerSharedObject()
export class GrapheneMeshSource extends WithParameters(
  WithSharedKvStoreContextCounterpart(MeshSource),
  MeshSourceParameters,
) {
  manifestRequestCount = new Map<string, number>();
  newSegments = new Uint64Set();
  // Live branch shared from the frontend. parameters.branchId is frozen at
  // datasource creation; the dropdown branch switch mutates the frontend's
  // GrapheneState.branchId without recreating sources, so manifest requests
  // must read the live value or branch-only roots resolve against main.
  branchId: SharedWatchableValue<number> | undefined;

  manifestHttpSource = getHttpSource(
    this.sharedKvStoreContext.kvStoreContext,
    this.parameters.manifestUrl,
  );
  fragmentKvStore = this.sharedKvStoreContext.kvStoreContext.getKvStore(
    this.parameters.fragmentUrl,
  );

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    // Move calcada mesh manifest + fragment downloads to their own download
    // pool (sourceQueueLevel 1) so they never contend for the level-0 slots
    // that 2D slice chunks use. Otherwise mesh chunks — which carry a far
    // higher chunk priority than slice chunks — monopolize the shared 100-slot
    // budget after an edit and stall the 2D data the user is looking at.
    // Graphene's own mesh sources are a different class and stay on level 0.
    this.sourceQueueLevel = 1;
    this.fragmentSource.sourceQueueLevel = 1;
    if (options.branchId !== undefined) {
      this.branchId = rpc.get(options.branchId);
    }
  }

  addNewSegment(segment: bigint) {
    const { newSegments } = this;
    newSegments.add(segment);
    const TEN_MINUTES = 1000 * 60 * 10;
    setTimeout(() => {
      newSegments.delete(segment);
    }, TEN_MINUTES);
  }

  async download(chunk: ManifestChunk, signal: AbortSignal) {
    const { parameters, newSegments, manifestRequestCount } = this;
    if (isBaseSegmentId(chunk.objectId, parameters.nBitsForLayerId)) {
      return decodeManifestChunk(chunk, { fragments: [] });
    }
    const { fetchOkImpl, baseUrl } = this.manifestHttpSource;
    let manifestPath = `/manifest/${chunk.objectId}:${parameters.lod}?verify=1&prepend_seg_ids=1`;
    const branchId = this.branchId?.value ?? parameters.branchId;
    if (branchId && branchId > 0) {
      manifestPath += `&branch_id=${branchId}`;
    }
    const response = await (
      await fetchOkImpl(baseUrl + manifestPath, { signal })
    ).json();
    const chunkIdentifier = manifestPath;
    if (newSegments.has(chunk.objectId)) {
      const requestCount = (manifestRequestCount.get(chunkIdentifier) ?? 0) + 1;
      manifestRequestCount.set(chunkIdentifier, requestCount);
      setTimeout(
        () => {
          this.chunkManager.queueManager.updateChunkState(
            chunk,
            ChunkState.QUEUED,
          );
        },
        2 ** requestCount * 1000,
      );
    } else {
      manifestRequestCount.delete(chunkIdentifier);
    }
    return decodeManifestChunk(chunk, response);
  }

  async downloadFragment(chunk: FragmentChunk, signal: AbortSignal) {
    const { response } = await downloadFragment(
      this.fragmentKvStore,
      chunk.fragmentId!,
      this.parameters,
      signal,
    );
    await decodeDracoFragmentChunk(
      chunk,
      new Uint8Array(await response.arrayBuffer()),
      signal,
    );
  }

  getFragmentKey(objectKey: string | null, fragmentId: string) {
    objectKey;
    return getGrapheneFragmentKey(fragmentId);
  }
}

class LeavesManyProxy {
  pendingRequests = new Map<
    string,
    [Signal<(response: any) => void>, Uint64Set, AbortController]
  >();

  constructor(private httpSource: HttpSource) {}

  getQueueSizeForBounds(bounds: string) {
    const requestsForBounds = this.pendingRequests.get(bounds);
    return requestsForBounds ? requestsForBounds[1].size : 0;
  }

  async request(
    segment: bigint,
    bounds: string,
    signal: AbortSignal,
  ): Promise<any> {
    const { pendingRequests } = this;
    let pendingRequest = pendingRequests.get(bounds);
    if (!pendingRequest) {
      const requestSignal = new Signal<(request: any) => void>();
      const abortController = new AbortController();
      const segments = new Uint64Set();
      pendingRequest = [requestSignal, segments, abortController];
      pendingRequests.set(bounds, pendingRequest);
      setTimeout(async () => {
        pendingRequests.delete(bounds);
        const { fetchOkImpl, baseUrl } = this.httpSource;
        try {
          const response = await fetchOkImpl(
            `${baseUrl}/leaves_many?int64_as_str=1&bounds=${bounds}`,
            {
              method: "POST",
              body: JSON.stringify({
                node_ids: segments.toJSON(),
              }),
              signal: abortController.signal,
            },
          ).then((res) => res.json());
          requestSignal.dispatch(response);
        } catch (e) {
          requestSignal.dispatch(e);
        }
      }, 0);
    }
    const [requestSignal, segments, abortController] = pendingRequest;
    segments.add(segment);
    signal.addEventListener("abort", () => {
      segments.delete(segment);
      if (segments.size === 0) {
        abortController.abort();
      }
    });
    return new Promise((f, r) => {
      const unregister = requestSignal.add((response) => {
        unregister();
        if (response instanceof Error) {
          r(response);
        } else {
          f(response[segment.toString()]);
        }
      });
    });
  }
}

export class ChunkedGraphChunk extends Chunk {
  chunkGridPosition: Float32Array;
  source: GrapheneChunkedGraphChunkSource | null = null;
  segment: bigint;
  leaves: BigUint64Array = new BigUint64Array(0);
  chunkDataSize: Uint32Array | null;

  initializeVolumeChunk(key: string, chunkGridPosition: Float32Array) {
    super.initialize(key);
    this.chunkGridPosition = Float32Array.from(chunkGridPosition);
  }

  get downloadSlots(): number {
    const { source, bounds } = this;
    if (!source || !bounds) return super.downloadSlots;
    const queueSize = source.leavesManyProxy.getQueueSizeForBounds(bounds);
    // requests that can be bundled with a prior request are considered free
    return queueSize > 0 ? 0 : super.downloadSlots;
  }

  get bounds() {
    const { source } = this;
    if (!source) return undefined;
    const chunkPosition = computeChunkBounds(source, this);
    const chunkDataSize = this.chunkDataSize!;
    return (
      `${chunkPosition[0]}-${chunkPosition[0] + chunkDataSize[0]}_` +
      `${chunkPosition[1]}-${chunkPosition[1] + chunkDataSize[1]}_` +
      `${chunkPosition[2]}-${chunkPosition[2] + chunkDataSize[2]}`
    );
  }

  initializeChunkedGraphChunk(
    key: string,
    chunkGridPosition: Float32Array,
    segment: bigint,
  ) {
    this.initializeVolumeChunk(key, chunkGridPosition);
    this.chunkDataSize = null;
    this.systemMemoryBytes = 16;
    this.gpuMemoryBytes = 0;
    this.segment = segment;
  }

  downloadSucceeded() {
    this.systemMemoryBytes = 16; // this.segment
    this.systemMemoryBytes += this.leaves.byteLength;
    this.queueManager.updateChunkState(this, ChunkState.SYSTEM_MEMORY_WORKER);
    if (this.priorityTier < ChunkPriorityTier.RECENT) {
      this.source!.chunkManager.scheduleUpdateChunkPriorities();
    }
    super.downloadSucceeded();
  }

  freeSystemMemory() {
    this.leaves = new BigUint64Array(0);
  }
}

function decodeChunkedGraphChunk(leaves: string[]) {
  return BigUint64Array.from(leaves, parseUint64);
}

@registerSharedObject()
export class GrapheneChunkedGraphChunkSource extends WithParameters(
  WithSharedKvStoreContextCounterpart(ChunkSource),
  ChunkedGraphSourceParameters,
) {
  spec: ChunkedGraphChunkSpecification;
  declare chunks: Map<string, ChunkedGraphChunk>;
  tempChunkDataSize: Uint32Array;
  tempChunkPosition: Float32Array;
  leavesManyProxy: LeavesManyProxy;

  httpSource = getHttpSource(
    this.sharedKvStoreContext.kvStoreContext,
    this.parameters.url,
  );

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.spec = options.spec;
    const rank = this.spec.rank;
    this.tempChunkDataSize = new Uint32Array(rank);
    this.tempChunkPosition = new Float32Array(rank);
    this.leavesManyProxy = new LeavesManyProxy(this.httpSource);
  }

  async download(chunk: ChunkedGraphChunk, signal: AbortSignal): Promise<void> {
    const { segment, bounds } = chunk;
    if (!bounds) return;
    const request = this.leavesManyProxy.request(segment, bounds, signal);
    await this.withErrorMessage(
      request,
      `Fetching leaves of segment ${chunk.segment} in region ${bounds}: `,
    )
      .then((res) => {
        verifyStringArray(res);
        chunk.leaves = decodeChunkedGraphChunk(res);
      })
      .catch((err) => {
        if (err instanceof Error && err.name === "AbortError") return;
        console.error(err);
      });
  }

  getChunk(chunkGridPosition: Float32Array, segment: bigint) {
    const key = `${vec3Key(chunkGridPosition)}-${segment}`;
    let chunk = <ChunkedGraphChunk>this.chunks.get(key);

    if (chunk === undefined) {
      chunk = this.getNewChunk_(ChunkedGraphChunk);
      chunk.initializeChunkedGraphChunk(key, chunkGridPosition, segment);
      this.addChunk(chunk);
    }
    return chunk;
  }

  async withErrorMessage<T>(
    promise: Promise<T>,
    errorPrefix: string,
  ): Promise<T> {
    return promise.catch(async (e) => {
      if (e instanceof HttpError && e.response) {
        const msg = await parseGrapheneError(e);
        throw new Error(`[${e.response.status}] ${errorPrefix}${msg ?? ""}`);
      }
      throw e;
    });
  }
}

interface ChunkedGraphRenderLayerAttachmentState {
  displayDimensionRenderInfo: DisplayDimensionRenderInfo;
  transformedSource?: TransformedSource<
    ChunkedGraphLayer,
    GrapheneChunkedGraphChunkSource
  >;
}

@registerSharedObject(CHUNKED_GRAPH_LAYER_RPC_ID)
export class ChunkedGraphLayer extends withSegmentationLayerBackendState(
  withSharedVisibility(withChunkManager(RenderLayerBackend)),
) {
  source: GrapheneChunkedGraphChunkSource;
  localPosition: SharedWatchableValue<Float32Array>;
  leafRequestsActive: SharedWatchableValue<boolean>;
  nBitsForLayerId: SharedWatchableValue<number>;
  branchId: SharedWatchableValue<number>;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.source = this.registerDisposer(
      rpc.getRef<GrapheneChunkedGraphChunkSource>(options.source),
    );
    this.localPosition = rpc.get(options.localPosition);
    this.leafRequestsActive = rpc.get(options.leafRequestsActive);
    this.nBitsForLayerId = rpc.get(options.nBitsForLayerId);
    this.branchId = rpc.get(options.branchId);

    // Register this layer so CalcadaVolumeChunkSource.download can apply
    // the chunk's piece→root LUT trailer to the matching layer's
    // equivalences. Matching is by branchId — see download() for the
    // rationale.
    allActiveChunkedGraphLayers.add(this);
    this.registerDisposer(() => {
      allActiveChunkedGraphLayers.delete(this);
    });

    this.registerDisposer(
      this.chunkManager.recomputeChunkPriorities.add(() => {
        this.updateChunkPriorities();
      }),
    );
  }

  attach(
    attachment: RenderLayerBackendAttachment<
      RenderedViewBackend,
      ChunkedGraphRenderLayerAttachmentState
    >,
  ): void {
    const scheduleUpdateChunkPriorities = () =>
      this.chunkManager.scheduleUpdateChunkPriorities();
    const { view } = attachment;
    attachment.registerDisposer(scheduleUpdateChunkPriorities);
    attachment.registerDisposer(
      view.projectionParameters.changed.add(scheduleUpdateChunkPriorities),
    );
    attachment.registerDisposer(
      view.visibility.changed.add(scheduleUpdateChunkPriorities),
    );
    attachment.state = {
      displayDimensionRenderInfo:
        view.projectionParameters.value.displayDimensionRenderInfo,
    };
  }

  // Used for the sliceview to set a limit on when to
  // make get_leaves to the ChunkedGraph
  get renderRatioLimit() {
    return RENDER_RATIO_LIMIT;
  }

  private updateChunkPriorities() {
    const { chunkManager } = this;
    chunkManager.registerLayer(this);
    for (const attachment of this.attachments.values()) {
      const { view } = attachment;
      if (view.visibility.value === Number.NEGATIVE_INFINITY) {
        continue;
      }
      const attachmentState =
        attachment.state! as ChunkedGraphRenderLayerAttachmentState;
      const { transformedSource: tsource } = attachmentState;
      if (!tsource) {
        continue;
      }
      const projectionParameters = view.projectionParameters
        .value as SliceViewProjectionParameters;
      const pixelSize = projectionParameters.pixelSize * 1.1;
      const smallestVoxelSize = tsource.effectiveVoxelSize;
      this.leafRequestsActive.value =
        this.renderRatioLimit >= pixelSize / Math.min(...smallestVoxelSize);
      return;
    }
  }
}

registerRPC(CHUNKED_GRAPH_RENDER_LAYER_UPDATE_SOURCES_RPC_ID, function (x) {
  const view = this.get(x.view) as RenderedViewBackend;
  const layer = this.get(x.layer) as ChunkedGraphLayer;
  const attachment = layer.attachments.get(
    view,
  )! as RenderLayerBackendAttachment<
    RenderedViewBackend,
    ChunkedGraphRenderLayerAttachmentState
  >;
  attachment.state!.transformedSource = deserializeTransformedSources<
    SliceViewChunkSourceBackend,
    ChunkedGraphLayer
  >(this, x.sources, layer)[0][0] as unknown as TransformedSource<
    ChunkedGraphLayer,
    GrapheneChunkedGraphChunkSource
  >;
  attachment.state!.displayDimensionRenderInfo = x.displayDimensionRenderInfo;
  layer.chunkManager.scheduleUpdateChunkPriorities();
});

registerRPC(GRAPHENE_MESH_NEW_SEGMENT_RPC_ID, function (x) {
  const obj = <GrapheneMeshSource>this.get(x.rpcId);
  obj.addNewSegment(x.segment);
});
