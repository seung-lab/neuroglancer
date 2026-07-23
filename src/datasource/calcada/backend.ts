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
import type { ShardedKvStore } from "#src/datasource/precomputed/sharded.js";
import { getShardedKvStoreIfApplicable } from "#src/datasource/precomputed/sharded.js";
import { decodeDracoPartitioned } from "#src/mesh/draco/index.js";
import { WithSharedKvStoreContextCounterpart } from "#src/kvstore/backend.js";
import type { KvStoreWithPath, ReadResponse } from "#src/kvstore/index.js";
import { readKvStore } from "#src/kvstore/index.js";
import type {
  FragmentChunk,
  ManifestChunk,
  RawMeshData,
} from "#src/mesh/backend.js";
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

// A neuroglancer_multilod_draco per-object manifest, parsed from the bytes the
// sharded kvstore returns for a piece id (the Draco blob sits immediately
// before it in the shard). Layout matches igneous/tensorstore output; see the
// `_parse_multilod_manifest` reference in scripts/ts_server.py.
interface MultilodLod {
  numFragments: number;
  // Fragment grid positions, stored column-major (all X, then all Y, then all
  // Z). Fragment i is (positions[i], positions[n+i], positions[2n+i]).
  positions: Uint32Array;
  // Cumulative byte offsets into the Draco blob, length numFragments + 1.
  fragOffsets: number[];
}

interface MultilodManifest {
  chunkShape: [number, number, number];
  gridOrigin: [number, number, number];
  numLods: number;
  vertexOffsets: [number, number, number][];
  lods: MultilodLod[];
  totalDracoSize: number;
}

function parseMultilodManifest(buf: ArrayBuffer): MultilodManifest {
  const dv = new DataView(buf);
  let off = 0;
  const readVec3f = (): [number, number, number] => {
    const v: [number, number, number] = [
      dv.getFloat32(off, true),
      dv.getFloat32(off + 4, true),
      dv.getFloat32(off + 8, true),
    ];
    off += 12;
    return v;
  };
  const chunkShape = readVec3f();
  const gridOrigin = readVec3f();
  const numLods = dv.getUint32(off, true);
  off += 4;
  off += 4 * numLods; // lod_scales (unused: LOD 0 scale is 1)
  const vertexOffsets: [number, number, number][] = [];
  for (let i = 0; i < numLods; i++) vertexOffsets.push(readVec3f());
  const numFragmentsPerLod = new Uint32Array(numLods);
  for (let i = 0; i < numLods; i++) {
    numFragmentsPerLod[i] = dv.getUint32(off, true);
    off += 4;
  }
  const lods: MultilodLod[] = [];
  let globalByteOffset = 0;
  for (let lod = 0; lod < numLods; lod++) {
    const n = numFragmentsPerLod[lod];
    const positions = new Uint32Array(n * 3);
    for (let k = 0; k < n * 3; k++) {
      positions[k] = dv.getUint32(off, true);
      off += 4;
    }
    const fragOffsets: number[] = [globalByteOffset];
    for (let i = 0; i < n; i++) {
      const size = dv.getUint32(off, true);
      off += 4;
      fragOffsets.push(fragOffsets[fragOffsets.length - 1] + size);
    }
    globalByteOffset = fragOffsets[fragOffsets.length - 1];
    lods.push({ numFragments: n, positions, fragOffsets });
  }
  return {
    chunkShape,
    gridOrigin,
    numLods,
    vertexOffsets,
    lods,
    totalDracoSize: globalByteOffset,
  };
}

// Decode every LOD-`targetLod` Draco fragment of a piece, dequantize+position
// into voxel coordinates, and merge into a single mesh. The mesh source's
// transform (voxel→physical) is applied downstream. Returns undefined when the
// piece has no drawable geometry at this LOD. Mirrors ts_server's
// `_decode_merge_encode_lod`, minus the re-encode (we hand raw arrays to the
// renderer instead of round-tripping through Draco).
async function decodeMultilodPieceMesh(
  manifest: MultilodManifest,
  dracoBlob: ArrayBuffer,
  vertexQuantizationBits: number,
  targetLod: number,
): Promise<RawMeshData | undefined> {
  if (manifest.totalDracoSize === 0 || targetLod >= manifest.numLods) {
    return undefined;
  }
  const lodInfo = manifest.lods[targetLod];
  const n = lodInfo.numFragments;
  if (n === 0) return undefined;
  const qMax = 2 ** vertexQuantizationBits - 1;
  const [csx, csy, csz] = manifest.chunkShape;
  const [gox, goy, goz] = manifest.gridOrigin;
  const [vox, voy, voz] = manifest.vertexOffsets[targetLod];
  const lodScale = 2 ** targetLod;
  const dracoU8 = new Uint8Array(dracoBlob);
  const vertGroups: Float32Array[] = [];
  const idxGroups: Uint32Array[] = [];
  let vertexCount = 0;
  for (let i = 0; i < n; i++) {
    const start = lodInfo.fragOffsets[i];
    const end = lodInfo.fragOffsets[i + 1];
    if (end <= start) continue;
    const decoded = await decodeDracoPartitioned(
      dracoU8.subarray(start, end),
      vertexQuantizationBits,
      /*partition=*/ false,
      /*skipDequantization=*/ true,
    );
    const raw = decoded.vertexPositions as Uint32Array; // quantized [0, qMax]
    const indices = decoded.indices as Uint32Array;
    if (indices.length === 0) continue;
    const nv = raw.length / 3;
    const fx = lodInfo.positions[i];
    const fy = lodInfo.positions[n + i];
    const fz = lodInfo.positions[2 * n + i];
    const verts = new Float32Array(nv * 3);
    for (let v = 0; v < nv; v++) {
      verts[v * 3] = gox + vox + csx * lodScale * (fx + raw[v * 3] / qMax);
      verts[v * 3 + 1] =
        goy + voy + csy * lodScale * (fy + raw[v * 3 + 1] / qMax);
      verts[v * 3 + 2] =
        goz + voz + csz * lodScale * (fz + raw[v * 3 + 2] / qMax);
    }
    const shifted = new Uint32Array(indices.length);
    for (let k = 0; k < indices.length; k++) shifted[k] = indices[k] + vertexCount;
    vertexCount += nv;
    vertGroups.push(verts);
    idxGroups.push(shifted);
  }
  if (vertGroups.length === 0) return undefined;
  const totalVerts = vertGroups.reduce((a, b) => a + b.length, 0);
  const totalIdx = idxGroups.reduce((a, b) => a + b.length, 0);
  const vertexPositions = new Float32Array(totalVerts);
  const indices = new Uint32Array(totalIdx);
  let vOff = 0;
  for (const g of vertGroups) {
    vertexPositions.set(g, vOff);
    vOff += g.length;
  }
  let iOff = 0;
  for (const g of idxGroups) {
    indices.set(g, iOff);
    iOff += g.length;
  }
  return { vertexPositions, indices };
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
// segmentEquivalences so the whole visible volume colours by root without a
// selection. Only layers whose current branchId matches the chunk's branchId
// are updated — otherwise a main-branch chunk poisons a branch layer's
// equivalences (piece→main_root) and the branch layer's own chunk LUT is
// silently skipped by the "already in disjoint set" guard, leaving the branch
// displayed as the main view.
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
  // HTTP source for the ?lut_only=true trailer fetches — same scale-dir URL
  // as the voxel kvstore, resolved once instead of per download().
  lutSource = getHttpSource(
    this.sharedKvStoreContext.kvStoreContext,
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

    // Voxels: calcada _rp 302-redirects to the public bucket (base / per-branch
    // overlay / time-travel generation); fetchOkImpl follows the redirect to
    // GCS. The mapping comes from a parallel ?lut_only=true trailer.
    const { timestampMs, branchId } = this.parameters;
    const httpStore = kvStore.store as any;
    const q: string[] = [];
    if (timestampMs && timestampMs > 0) q.push(`timestamp=${timestampMs / 1000}`);
    if (branchId && branchId > 0) q.push(`branch_id=${branchId}`);
    const voxelUrl = `${httpStore.baseUrl}${kvStore.path}${chunkPath}${q.length ? `?${q.join("&")}` : ""}`;
    const lutQuery = q.length ? `&${q.join("&")}` : "";
    let voxelResp: Response;
    let lutBuffer: ArrayBuffer | undefined;
    try {
      [voxelResp, lutBuffer] = await Promise.all([
        httpStore.fetchOkImpl(voxelUrl, { signal }),
        // Best-effort: voxels don't depend on the LUT (it only affects root
        // colouring), so a failed trailer fetch must not blank the chunk.
        fetchLutTrailer(this.lutSource, chunkPath, lutQuery, signal).catch((e) => {
          if (e instanceof Error && e.name === "AbortError") throw e;
          return undefined;
        }),
      ]);
    } catch (e) {
      // 404 => chunk has no data; render empty (matches kvstore read=undefined).
      if (e instanceof HttpError && e.status === 404) return;
      throw e;
    }
    const rawChunk = await voxelResp.arrayBuffer();
    // Link equivalences before decoding so they're ready when the chunk renders.
    if (lutBuffer !== undefined) {
      const { pieces, roots } = parseLutTrailer(lutBuffer);
      if (pieces.length > 0) linkChunkEquivalences(pieces, roots, branchId);
    }
    await this.chunkDecoder(chunk, signal, rawChunk);
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
  // Read per-piece multilod-draco meshes straight from the sharded mesh store.
  // The sharded reader issues byte-range reads against {mesh_dir}/{shard}.shard,
  // which calcada 302-redirects to the public bucket — so the mesh bytes never
  // pass through calcada. undefined for legacy unsharded meshes (dynamic path).
  shardedKvStore: ShardedKvStore | undefined = getShardedKvStoreIfApplicable(
    this,
    this.fragmentKvStore,
    this.parameters.sharding,
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
    const { shardedKvStore } = this;
    if (shardedKvStore === undefined) {
      // Legacy unsharded mesh: fetch the whole per-piece Draco object.
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
      return;
    }

    // Sharded multilod-draco: read the piece's manifest, then the Draco blob
    // that precedes it in the shard, decode + place client-side.
    const pieceId = BigInt(chunk.fragmentId!.replace(/:0$/, ""));
    const readResult = await shardedKvStore.readWithShardInfo(pieceId, {
      signal,
    });
    if (readResult === undefined) return; // missing piece → empty fragment
    const { response: manifestResponse, shardInfo } = readResult;
    const manifest = parseMultilodManifest(
      await manifestResponse.response.arrayBuffer(),
    );
    if (manifest.totalDracoSize === 0) return;

    const dracoResponse = await readKvStore(
      this.fragmentKvStore.store,
      shardInfo.shardPath,
      {
        signal,
        byteRange: {
          offset: shardInfo.offset - manifest.totalDracoSize,
          length: manifest.totalDracoSize,
        },
        throwIfMissing: true,
        strictByteRange: true,
      },
    );
    const rawMesh = await decodeMultilodPieceMesh(
      manifest,
      await dracoResponse.response.arrayBuffer(),
      this.parameters.vertexQuantizationBits,
      this.parameters.lod,
    );
    if (rawMesh !== undefined) {
      assignMeshFragmentData(chunk, rawMesh);
    }
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
