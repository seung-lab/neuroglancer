/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type {
  ChunkCoord,
  ChunkId,
  ChunkSource as LibraryChunkSource,
  ChunkVoxelBuffer,
  LayerId,
  OverlayCoord,
  ReadonlyChunkVoxelBuffer,
  Resolution,
  SessionId,
} from "@zettaai/edit-session";
import {
  ChunkId as ChunkIdFactory,
  ChunkPinFailedError,
  ChunkReadAbortedError,
  ChunkReadFailedError,
} from "@zettaai/edit-session";

import type { ChunkManager, Chunk } from "#src/chunk_manager/frontend.js";
import { resolutionFor } from "#src/editing/adapters/ng_layer_metadata_source.js";
import type { LayerManager, UserLayer } from "#src/layer/index.js";
import type { LoadedLayerDataSource } from "#src/layer/layer_data_source.js";
import { decodeChannels } from "#src/sliceview/compressed_segmentation/decode_common.js";
import type { SliceViewSingleResolutionSource } from "#src/sliceview/frontend.js";
import type {
  VolumeChunkSpecification,
  VolumeSourceOptions,
} from "#src/sliceview/volume/base.js";
import type {
  MultiscaleVolumeChunkSource,
  VolumeChunk,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import { DataType } from "#src/util/data_type.js";

/**
 * Adapter that exposes neuroglancer's per-layer volumetric chunk storage
 * through the edit-session library's flat `(layerId, resolution, chunkId)`
 * coordinate space. Pin / release operations are tracked per active session
 * (the library guarantees one session active at a time); baseline reads route
 * through `SliceViewChunkSource.fetchChunk`, which awaits chunk arrival via
 * the existing chunk pipeline without blocking the main thread.
 */
interface PinnedChunkRecord {
  readonly source: VolumeChunkSource;
  readonly key: string;
  readonly chunk: VolumeChunk;
}

export class NgChunkSource implements LibraryChunkSource {
  private currentSessionId: SessionId | undefined;
  private currentPinnedChunks: PinnedChunkRecord[] = [];
  /**
   * Optional handle to the host's committed-buffer store. When set, baseline
   * reads consult it before falling through to the data source — committed
   * chunks from a previous session become the starting state for the next
   * session's overlay. Wired by `EditSessionHost` at construction time.
   */
  commitTarget:
    | {
        getChunk(
          layerId: LayerId,
          resolution: string,
          chunkId: string,
        ): { bytes: ReadonlyChunkVoxelBuffer } | undefined;
      }
    | undefined;

  constructor(
    private readonly layerManager: LayerManager,
    _chunkManager: ChunkManager,
  ) {
    void _chunkManager;
  }

  async pinChunks(
    coords: readonly OverlayCoord[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) {
      this.releaseTrackedPins();
      throw signal.reason;
    }
    // Group coords by (layerId, resolution) so we resolve the source once per
    // group.
    const groups = groupByLayerAndResolution(coords);
    for (const group of groups) {
      if (signal?.aborted) {
        this.releaseTrackedPins();
        throw signal.reason;
      }
      let source: VolumeChunkSource;
      try {
        source = this.resolveVolumeChunkSource(group.layerId, group.resolution);
      } catch (cause) {
        const reason =
          cause instanceof Error ? cause : new Error(String(cause));
        throw new ChunkPinFailedError(group.coords, reason);
      }
      for (const coord of group.coords) {
        const chunkCoord = ChunkIdFactory.toCoord(coord.chunkId);
        const key = chunkKeyForSource(source, chunkCoord);
        const chunk = source.chunks.get(key) as VolumeChunk | undefined;
        if (chunk !== undefined) {
          source.chunkManager.markChunkPermanent(source, key, true);
          this.currentPinnedChunks.push({ source, key, chunk });
        }
        // Missing-from-cache chunks are not a pin failure: pinChunks only
        // records intent. The library will call readBaselineChunk later,
        // which triggers loading via the normal chunk pipeline.
      }
    }
    // Stash the session id once any coord-bearing call comes in; releasePins
    // uses it to assert the lifecycle.
    if (coords.length > 0 && this.currentSessionId === undefined) {
      this.currentSessionId = sessionIdFromCoord(coords[0]);
    }
  }

  releasePins(sessionId: SessionId): void {
    if (
      this.currentSessionId !== undefined &&
      this.currentSessionId !== sessionId
    ) {
      // Mismatched release for a session we didn't track. Library contract
      // guarantees one session at a time; nothing to do.
      return;
    }
    this.releaseTrackedPins();
    this.currentSessionId = undefined;
  }

  async readBaselineChunk(
    layerId: LayerId,
    resolution: Resolution,
    chunkId: ChunkId,
    chunkCoord: ChunkCoord,
    signal?: AbortSignal,
  ): Promise<ReadonlyChunkVoxelBuffer> {
    const coord: OverlayCoord = { layerId, resolution, chunkId };
    if (signal?.aborted) {
      throw new ChunkReadAbortedError(coord);
    }
    // If a previous session committed this chunk (in-memory, client-side
    // only), use the committed bytes as the baseline so the new session's
    // overlay starts on top of the user's pending changes. Without this,
    // painting on top of a previously-committed voxel would silently revert
    // it to the raw data-source value when PatchMirror writes the new
    // chunk buffer (the overlay's "current" view never knew about the
    // commit).
    const committed = this.commitTarget?.getChunk(layerId, resolution, chunkId);
    if (committed !== undefined) {
      return committed.bytes;
    }
    let source: VolumeChunkSource;
    try {
      source = this.resolveVolumeChunkSource(layerId, resolution);
    } catch (cause) {
      throw new ChunkReadFailedError(coord, cause);
    }
    const chunkGridPosition = makeChunkGridPosition(source, chunkCoord);
    const fetchSignal = signal ?? new AbortController().signal;
    let data: ChunkVoxelBuffer;
    try {
      data = await source.fetchChunk(
        chunkGridPosition,
        (chunk: Chunk) => {
          const raw = (chunk as unknown as { data?: ChunkVoxelBuffer | null })
            .data;
          if (raw == null) {
            // Treat empty chunks as all-zero baselines (see comment below).
            return makeZeroFilledChunkBuffer(source);
          }
          // Neuroglancer transcodes uint32/uint64 SEGMENTATION volumes to the
          // compressed-segmentation format for GPU rendering, so `chunk.data` is
          // the COMPRESSED block (a small Uint32Array), not the per-voxel values
          // the edit library expects. Decode it back to a dense, per-voxel
          // buffer; otherwise the library writes 8 bytes/voxel past the end of
          // the tiny compressed buffer (`offset is out of bounds`) and the
          // baseline values are garbage. Plain (non-transcoded) chunks are
          // snapshotted as-is — `fetchChunk` only guarantees `chunk.data` inside
          // this callback, so we clone for a stable view.
          if (source.spec.compressedSegmentationBlockSize !== undefined) {
            return decodeCompressedSegmentationChunk(source, raw);
          }
          return cloneTypedArray(raw);
        },
        { signal: fetchSignal },
      );
    } catch {
      if (signal?.aborted) {
        throw new ChunkReadAbortedError(coord);
      }
      // Sparse data sources (most precomputed segmentations) only store
      // chunks that actually contain non-zero voxels; the rest 404. From the
      // editing layer's perspective an absent chunk means "no segments here"
      // which the user expects to be able to paint into. Treat any
      // (non-abort) fetch failure as an all-zero baseline so the brush can
      // proceed.
      return wrapAsReadonlyBuffer(makeZeroFilledChunkBuffer(source));
    }
    return wrapAsReadonlyBuffer(data);
  }

  private releaseTrackedPins(): void {
    for (const { source, key } of this.currentPinnedChunks) {
      source.chunkManager.markChunkPermanent(source, key, false);
    }
    this.currentPinnedChunks.length = 0;
  }

  private resolveVolumeChunkSource(
    layerId: LayerId,
    resolution: Resolution,
  ): VolumeChunkSource {
    const managedLayer = this.layerManager.getLayerByName(layerId);
    if (managedLayer === undefined) {
      throw new Error(`layer-not-found:${layerId}`);
    }
    const userLayer: UserLayer | null = managedLayer.layer;
    if (userLayer === null) {
      throw new Error(`layer-not-loaded:${layerId}`);
    }
    const found = findFirstVolumetricSubsource(userLayer);
    if (found === undefined) {
      throw new Error(`no-volumetric-data-source:${layerId}`);
    }
    const { volume, loadState } = found;
    const modelResolutionNm = extractModelResolutionNm(loadState);
    const sources = enumerateScaleSources(volume);
    for (const single of sources) {
      const voxelSizeNm = computeVoxelSizeNm(
        single.chunkSource.spec,
        single.chunkToMultiscaleTransform,
        modelResolutionNm,
      );
      if (resolutionFor(voxelSizeNm) === resolution) {
        return single.chunkSource;
      }
    }
    throw new Error(`no-matching-scale:${layerId}@${resolution}`);
  }
}

interface CoordGroup {
  readonly layerId: LayerId;
  readonly resolution: Resolution;
  readonly coords: OverlayCoord[];
}

function groupByLayerAndResolution(
  coords: readonly OverlayCoord[],
): CoordGroup[] {
  const groups = new Map<string, CoordGroup>();
  for (const coord of coords) {
    const key = `${coord.layerId}|${coord.resolution}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        layerId: coord.layerId,
        resolution: coord.resolution,
        coords: [],
      };
      groups.set(key, group);
    }
    (group.coords as OverlayCoord[]).push(coord);
  }
  return Array.from(groups.values());
}

function chunkKeyForSource(
  source: VolumeChunkSource,
  chunkCoord: ChunkCoord,
): string {
  const grid = makeChunkGridPosition(source, chunkCoord);
  return grid.join();
}

function makeChunkGridPosition(
  source: VolumeChunkSource,
  chunkCoord: ChunkCoord,
): Float32Array {
  const rank = source.spec.rank;
  const grid = new Float32Array(rank);
  grid[0] = chunkCoord.x;
  if (rank > 1) grid[1] = chunkCoord.y;
  if (rank > 2) grid[2] = chunkCoord.z;
  // Any extra dimensions (e.g. channel) stay at 0; the library's ChunkCoord
  // is 3D and assumes per-channel chunks are not addressed separately.
  return grid;
}

interface VolumetricFound {
  readonly volume: MultiscaleVolumeChunkSource;
  readonly loadState: LoadedLayerDataSource;
}

function findFirstVolumetricSubsource(
  userLayer: UserLayer,
): VolumetricFound | undefined {
  for (const layerDataSource of userLayer.dataSources) {
    const loadState = layerDataSource.loadState;
    if (loadState === undefined) continue;
    if ("error" in loadState && loadState.error !== undefined) continue;
    const loaded = loadState as LoadedLayerDataSource;
    for (const subsource of loaded.subsources) {
      const volume = subsource.subsourceEntry.subsource.volume;
      if (volume !== undefined) {
        return { volume, loadState: loaded };
      }
    }
  }
  return undefined;
}

function extractModelResolutionNm(
  loadState: LoadedLayerDataSource,
): readonly [number, number, number] {
  const outputSpace = loadState.dataSource.modelTransform.outputSpace;
  const { scales, units } = outputSpace;
  const result: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3 && i < scales.length; ++i) {
    const scale = scales[i];
    const unit = units[i];
    result[i] = unit === "m" ? scale * 1e9 : scale;
  }
  return result;
}

function enumerateScaleSources(
  volume: MultiscaleVolumeChunkSource,
): SliceViewSingleResolutionSource<VolumeChunkSource>[] {
  const rank = volume.rank;
  const displayRank = Math.min(rank, 3);
  const multiscaleToViewTransform = new Float32Array(displayRank * rank);
  for (let i = 0; i < displayRank; ++i) {
    multiscaleToViewTransform[i * displayRank + i] = 1;
  }
  const modelChannelDimensionIndices: number[] = rank > 3 ? [3] : [];
  const options: VolumeSourceOptions = {
    multiscaleToViewTransform,
    displayRank,
    modelChannelDimensionIndices,
  };
  // `getSources` returns `result[orientation][scale]`. Take the first
  // orientation's full scale list — same convention as the SliceView and
  // as `NgLayerMetadataSource.collectAllScaleSources`.
  const sourcesByOrientation = volume.getSources(options);
  return sourcesByOrientation[0] ?? [];
}

function computeVoxelSizeNm(
  spec: VolumeChunkSpecification,
  chunkToMultiscaleTransform: Float32Array,
  modelResolutionNm: readonly [number, number, number],
): readonly [number, number, number] {
  const rank = spec.rank;
  const stride = rank + 1;
  const result: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; ++i) {
    const relativeScale = chunkToMultiscaleTransform[stride * i + i] || 1;
    result[i] = modelResolutionNm[i] * relativeScale;
  }
  return result;
}

function cloneTypedArray(buf: ChunkVoxelBuffer): ChunkVoxelBuffer {
  // Each ChunkVoxelBuffer variant supports .slice() returning the same kind.
  return (buf as { slice(): ChunkVoxelBuffer }).slice();
}

/**
 * Allocate an all-zero voxel buffer matching the source's chunk shape and
 * data type. Used when the underlying data source is sparse: a missing
 * chunk semantically means "no segments here" / "value 0 everywhere", and
 * the editing layer should let the brush paint into it.
 */
function makeZeroFilledChunkBuffer(
  source: VolumeChunkSource,
): ChunkVoxelBuffer {
  const { chunkDataSize, dataType } = source.spec;
  // `chunkDataSize` is 4D `[x, y, z, channels]` for volumes — the channel
  // count is folded into the last component.
  let voxelCount = 1;
  for (let i = 0; i < chunkDataSize.length; ++i) {
    voxelCount *= chunkDataSize[i];
  }
  switch (dataType) {
    case DataType.UINT8:
      return new Uint8Array(voxelCount);
    case DataType.INT8:
      return new Int8Array(voxelCount);
    case DataType.UINT16:
      return new Uint16Array(voxelCount);
    case DataType.INT16:
      return new Int16Array(voxelCount);
    case DataType.UINT32:
      return new Uint32Array(voxelCount);
    case DataType.INT32:
      return new Int32Array(voxelCount);
    case DataType.UINT64:
      return new BigUint64Array(voxelCount);
    case DataType.FLOAT32:
      return new Float32Array(voxelCount);
    default:
      // Fallback: untyped bytes. Library readers tolerate the union; we
      // size for a single byte per voxel which is the safest minimum.
      return new Uint8Array(voxelCount);
  }
}

/**
 * Decode a compressed-segmentation chunk (`chunk.data` is the compressed block)
 * into a dense per-voxel buffer of the source's data type. NG transcodes
 * uint32/uint64 segmentation to this format for rendering; the edit library
 * needs the raw per-voxel values. `decodeChannels` is NG's CPU decoder; it runs
 * once per chunk per session (the overlay caches the materialized slot), so the
 * per-voxel cost is paid lazily and only for edited chunks.
 */
function decodeCompressedSegmentationChunk(
  source: VolumeChunkSource,
  data: ChunkVoxelBuffer,
): ChunkVoxelBuffer {
  const { chunkDataSize, dataType, compressedSegmentationBlockSize } =
    source.spec;
  if (compressedSegmentationBlockSize === undefined) {
    return cloneTypedArray(data);
  }
  let voxelCount = 1;
  for (let i = 0; i < chunkDataSize.length; ++i) {
    voxelCount *= chunkDataSize[i];
  }
  const out =
    dataType === DataType.UINT64
      ? new BigUint64Array(voxelCount)
      : new Uint32Array(voxelCount);
  // `decodeChannels` indexes `chunkDataSize[3]` for the channel count, but the
  // spec's `chunkDataSize` is 3D `[x, y, z]` here. Segmentation (the only thing
  // NG transcodes to compressed-segmentation) is single-channel, so pass an
  // explicit 4D shape with one channel; otherwise `chunkDataSize[3]` is
  // undefined and the decoder throws on a NaN expected length.
  const chunkDataSize4d = [
    chunkDataSize[0],
    chunkDataSize[1],
    chunkDataSize[2],
    1,
  ];
  decodeChannels(
    out,
    data as Uint32Array,
    0,
    chunkDataSize4d,
    compressedSegmentationBlockSize,
  );
  return out as ChunkVoxelBuffer;
}

function wrapAsReadonlyBuffer(
  data: ChunkVoxelBuffer,
): ReadonlyChunkVoxelBuffer {
  return {
    byteLength: data.byteLength,
    asView(): ChunkVoxelBuffer {
      return data;
    },
  };
}

function sessionIdFromCoord(_coord: OverlayCoord): SessionId | undefined {
  // The library's `pinChunks` contract does not pass a SessionId. We leave
  // this returning undefined and rely on `releasePins` to clear state on
  // any subsequent release call (the library guarantees exactly one session
  // at a time, see edit-session.runtime.ts:313, :513).
  return undefined;
}
