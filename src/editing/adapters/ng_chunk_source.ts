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
  ChunkReadAbortedError,
  ChunkReadFailedError,
  contentRefFromBuffer,
} from "@zettaai/edit-session";

import type { ChunkManager, Chunk } from "#src/chunk_manager/frontend.js";
import { makeChunkGridPosition } from "#src/editing/adapters/ng_chunk_grid.js";
import { resolutionFor } from "#src/editing/adapters/ng_layer_metadata_source.js";
import type { ChunkLoadProgressState } from "#src/editing/adapters/session_chunk_preloader.js";
import { SessionChunkPreloader } from "#src/editing/adapters/session_chunk_preloader.js";
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
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import { WatchableValue } from "#src/trackable_value.js";
import { DataType } from "#src/util/data_type.js";

/**
 * Adapter that exposes neuroglancer's per-layer volumetric chunk storage
 * through the edit-session library's flat `(layerId, resolution, chunkId)`
 * coordinate space. Pin / release operations are tracked per active session
 * (the library guarantees one session active at a time); baseline reads route
 * through `SliceViewChunkSource.fetchChunk`, which awaits chunk arrival via
 * the existing chunk pipeline without blocking the main thread.
 */
export class NgChunkSource implements LibraryChunkSource {
  private currentSessionId: SessionId | undefined;
  private preloader: SessionChunkPreloader | undefined;
  private preloadAbort: AbortController | undefined;
  private preloadProgressUnsub: (() => void) | undefined;
  /**
   * Background preload progress for the active session, surfaced to the editing
   * topbar. Stable across sessions (the per-session `SessionChunkPreloader`
   * forwards into it); resets to `idle` on release.
   */
  readonly chunkLoadProgress = new WatchableValue<ChunkLoadProgressState>({
    kind: "idle",
  });
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

  /**
   * Client-retained copy of the bytes the host has SAVED this page-session
   * (TM-352). `readBaselineChunk` consults it after `commitTarget` and before
   * the datasource, so a re-entry reads the saved state without evicting the
   * rendered chunk. Host-lifetime (survives session exit within the page; gone
   * on reload). Also holds each chunk's content hash for save verification.
   */
  private readonly savedBaseline = new SavedBaselineStore();

  constructor(
    private readonly layerManager: LayerManager,
    _chunkManager: ChunkManager,
  ) {
    void _chunkManager;
  }

  /**
   * Record the bytes just written for `(layerId, resolution, chunkId)` as the
   * client's authoritative saved copy + its content hash (TM-352). Called by the
   * host right after a save write. The bytes are COPIED (detached from any
   * pooled / overlay storage).
   */
  recordSavedBaseline(
    layerId: LayerId,
    resolution: Resolution,
    chunkId: ChunkId,
    bytes: ReadonlyChunkVoxelBuffer,
  ): void {
    this.savedBaseline.set(
      savedBaselineKey(layerId, resolution, chunkId),
      bytes,
    );
  }

  /** Content hash of the saved bytes for a chunk, for read-back comparison. */
  getSavedBaselineHash(
    layerId: LayerId,
    resolution: Resolution,
    chunkId: ChunkId,
  ): string | undefined {
    return this.savedBaseline.get(savedBaselineKey(layerId, resolution, chunkId))
      ?.hash;
  }

  /**
   * The client's stable saved copy of a chunk's bytes — used to RE-SEND on a
   * "Retry" after an unconfirmed save (the library is already rebaselined, so we
   * resend from here, not the overlay).
   */
  getSavedBytes(
    layerId: LayerId,
    resolution: Resolution,
    chunkId: ChunkId,
  ): ReadonlyChunkVoxelBuffer | undefined {
    return this.savedBaseline.get(savedBaselineKey(layerId, resolution, chunkId))
      ?.bytes;
  }

  /**
   * Drop the entire client-retained saved-baseline cache (TM-352). Called on
   * session exit: the saved bytes are a WITHIN-SESSION checkpoint (the snapshot
   * the user pressed "Save" on), useful while the session is alive for
   * verification, retry, and no-blink re-paint. After the session ends, keeping
   * them would let a stale snapshot shadow the backend on re-entry — reverting
   * the visible canvas and risking a silent overwrite of a concurrent external
   * edit. Re-entry must reconcile with the backend instead, so we clear here and
   * pair this with {@link invalidateDatasourceChunks}.
   */
  clearSavedBaseline(): void {
    this.savedBaseline.clear();
  }

  /**
   * Evict the given chunks from the datasource render cache so they re-download
   * fresh from the backend (TM-352). The main slice-view render path reads
   * `source.chunks` directly and never consults the saved-baseline cache, so
   * after a save the resident chunk still holds the PRE-save bytes; without this
   * eviction the canvas reverts to pre-save data on re-entry until a full page
   * reload. Used on session exit to replace the stale resident chunks with the
   * saved+verified bytes. Per-chunk eviction (no whole-source refetch storm);
   * a `(layerId, resolution)` that no longer resolves to a source is skipped.
   */
  invalidateDatasourceChunks(
    coords: readonly {
      readonly layerId: LayerId;
      readonly resolution: Resolution;
      readonly chunkCoord: ChunkCoord;
    }[],
  ): void {
    const keysBySource = new Map<VolumeChunkSource, string[]>();
    for (const { layerId, resolution, chunkCoord } of coords) {
      let source: VolumeChunkSource;
      try {
        source = this.resolveVolumeChunkSource(layerId, resolution);
      } catch {
        continue; // layer/source gone — nothing to evict
      }
      const key = makeChunkGridPosition(source, chunkCoord).join();
      const existing = keysBySource.get(source);
      if (existing === undefined) keysBySource.set(source, [key]);
      else existing.push(key);
    }
    for (const [source, keys] of keysBySource) {
      source.invalidateChunkCache(keys);
    }
  }

  async pinChunks(
    coords: readonly OverlayCoord[],
    signal?: AbortSignal,
  ): Promise<void> {
    // Tear down any preload still running for a previous session (the library
    // guarantees one session at a time, but be defensive on re-open).
    this.teardownPreload();
    if (signal?.aborted) {
      throw signal.reason;
    }
    // Stash the session id once any coord-bearing call comes in; releasePins
    // uses it to assert the lifecycle.
    if (coords.length > 0 && this.currentSessionId === undefined) {
      this.currentSessionId = sessionIdFromCoord(coords[0]);
    }

    // Kick off the background preload of every bbox chunk and resolve
    // immediately so the session goes ACTIVE and painting is allowed right
    // away. Reads that race the preload await their own fetch as before; the
    // preload simply warms (and pins) the chunk manager so later strokes don't
    // stall on a cold fetch.
    const abort = new AbortController();
    this.preloadAbort = abort;
    if (signal !== undefined) {
      if (signal.aborted) {
        abort.abort(signal.reason);
      } else {
        signal.addEventListener("abort", () => abort.abort(signal.reason), {
          once: true,
        });
      }
    }
    const preloader = new SessionChunkPreloader((layerId, resolution) =>
      this.resolveVolumeChunkSource(layerId, resolution),
    );
    this.preloader = preloader;
    this.preloadProgressUnsub = preloader.progress.changed.add(() => {
      this.chunkLoadProgress.value = preloader.progress.value;
    });
    // Intentionally not awaited: the library awaits pinChunks before ACTIVE.
    void preloader.start(coords, abort.signal);
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
    this.teardownPreload();
    this.currentSessionId = undefined;
  }

  /** Abort the in-flight preload, release its pins, and reset progress. */
  private teardownPreload(): void {
    this.preloadAbort?.abort();
    this.preloadAbort = undefined;
    this.preloadProgressUnsub?.();
    this.preloadProgressUnsub = undefined;
    this.preloader?.release();
    this.preloader = undefined;
    this.chunkLoadProgress.value = { kind: "idle" };
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
    // Then the client-retained saved bytes (TM-352): after a save we keep our
    // own copy of what was written, so a re-entry (same page, no reload) reads
    // the SAVED state as baseline instead of the datasource's stale chunk —
    // without evicting/refetching the rendered chunk (no blink). This is the
    // client's authoritative copy; it never depends on the backend being right.
    const saved = this.savedBaseline.get(
      savedBaselineKey(layerId, resolution, chunkId),
    );
    if (saved !== undefined) {
      return saved.bytes;
    }
    return this.readDatasourceBaseline(
      layerId,
      resolution,
      chunkId,
      chunkCoord,
      signal,
    );
  }

  /**
   * Read ONLY the datasource render base for a chunk — the decoded bytes the
   * base segmentation render layer shows from `source.chunks`, with NO
   * `commitTarget` / `savedBaseline` short-circuit.
   *
   * This is what {@link PatchMirror} must diff the overlay against to build the
   * per-voxel patched mask. The render composites the GPU patch where
   * `patched === 1` and falls back to the datasource chunk where `patched === 0`
   * — so the composite equals the overlay if and only if
   * `patched = (overlay !== datasourceBase)`. Diffing against the edit baseline
   * ({@link readBaselineChunk}, which returns the saved/committed bytes) instead
   * breaks that invariant the moment the edit baseline diverges from the
   * resident datasource chunk (i.e. right after a save, before the datasource
   * cache is refreshed on exit): the saved voxels then compare equal to the
   * baseline, drop out of the mask, and revert to the stale datasource value on
   * screen (TM-352).
   */
  async readDatasourceBaseline(
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
    let source: VolumeChunkSource;
    try {
      source = this.resolveVolumeChunkSource(layerId, resolution);
    } catch (cause) {
      throw new ChunkReadFailedError(coord, cause);
    }
    const chunkGridPosition = makeChunkGridPosition(source, chunkCoord);
    return fetchBaselineWithRetry(source, coord, chunkGridPosition, signal);
  }

  /**
   * Fresh-read one chunk from the backend, decoded to per-voxel values, WITHOUT
   * evicting the resident/rendered chunk (TM-352 save verification). Routes
   * through `VolumeChunkSource.fetchFreshDecodedChunk` (a throwaway backend
   * download that never enters the chunk cache) and applies the SAME
   * `decodeBaselineChunk` as the baseline read, so the representation matches the
   * saved overlay bytes for a content-hash compare. Returns `undefined` when the
   * `(layerId, resolution)` no longer resolves to a source.
   */
  async readFreshDecoded(
    layerId: LayerId,
    resolution: Resolution,
    chunkCoord: ChunkCoord,
    signal?: AbortSignal,
  ): Promise<ReadonlyChunkVoxelBuffer | undefined> {
    let source: VolumeChunkSource;
    try {
      source = this.resolveVolumeChunkSource(layerId, resolution);
    } catch {
      return undefined;
    }
    const grid = makeChunkGridPosition(source, chunkCoord);
    const { data } = await source.fetchFreshDecodedChunk(
      grid,
      signal ?? new AbortController().signal,
    );
    const decoded = decodeBaselineChunk(source, { data } as unknown as Chunk);
    return wrapAsReadonlyBuffer(decoded);
  }

  /**
   * One read-back attempt for the save verification (TM-352): fresh-read the
   * chunk and compare its content hash to the bytes we recorded as saved for it.
   * Returns `true` only on a confirmed match. Throws on a read error (the caller
   * retries); returns `false` on a value mismatch or when there is no recorded
   * saved hash / no resolvable source.
   */
  async confirmChunkPersisted(
    layerId: LayerId,
    resolution: Resolution,
    chunkId: ChunkId,
    chunkCoord: ChunkCoord,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const savedHash = this.getSavedBaselineHash(layerId, resolution, chunkId);
    if (savedHash === undefined) return false;
    const readBack = await this.readFreshDecoded(
      layerId,
      resolution,
      chunkCoord,
      signal,
    );
    if (readBack === undefined) return false;
    return contentRefFromBuffer(readBack.asView()).hash === savedHash;
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

/**
 * A baseline fetch is retried before being surfaced as a hard read failure: a
 * transient network/RPC hiccup must NOT be mistaken for an empty chunk (see
 * `fetchBaselineWithRetry`). Total attempts, and the backoff before each retry
 * — the array has one entry fewer than `BASELINE_FETCH_ATTEMPTS` so the final
 * attempt has no trailing wait.
 */
const BASELINE_FETCH_ATTEMPTS = 3;
const BASELINE_FETCH_BACKOFF_MS: readonly number[] = [50, 150];

/**
 * Snapshot a fetched chunk into a baseline voxel buffer. The outcome taxonomy
 * has only ONE empty-baseline case:
 *   • `chunk.data == null` after a SUCCESSFUL fetch: the chunk is sparse /
 *     absent. The kvStore read returns `undefined` for a 404/403 and the volume
 *     download leaves `data` null without throwing (see
 *     `PrecomputedVolumeChunkSource.download` and `handleThrowIfMissing`). This
 *     is the only definitive "no voxels here" signal, so we zero-fill it and
 *     let the brush paint into it.
 *   • a THROWN error never reaches here — it's handled by the retry loop in
 *     `fetchBaselineWithRetry`; a genuine fetch failure is NEVER an empty chunk.
 */
function decodeBaselineChunk(
  source: VolumeChunkSource,
  chunk: Chunk,
): ChunkVoxelBuffer {
  const raw = (chunk as unknown as { data?: ChunkVoxelBuffer | null }).data;
  if (raw == null) {
    return makeZeroFilledChunkBuffer(source);
  }
  // Neuroglancer transcodes uint32/uint64 SEGMENTATION volumes to the
  // compressed-segmentation format for GPU rendering, so `chunk.data` is the
  // COMPRESSED block (a small Uint32Array), not the per-voxel values the edit
  // library expects. Decode it back to a dense, per-voxel buffer; otherwise the
  // library writes 8 bytes/voxel past the end of the tiny compressed buffer
  // (`offset is out of bounds`) and the baseline values are garbage. Plain
  // (non-transcoded) chunks are snapshotted as-is — `fetchChunk` only
  // guarantees `chunk.data` inside this callback, so we clone for a stable view.
  if (source.spec.compressedSegmentationBlockSize !== undefined) {
    return decodeCompressedSegmentationChunk(source, raw);
  }
  return cloneTypedArray(raw);
}

/**
 * Read a chunk's baseline bytes, retrying on a genuine fetch error and then
 * propagating it as `ChunkReadFailedError` rather than masking it as a
 * false-empty baseline. Masking the error would silently corrupt the session:
 * a full ERASE over a false-empty baseline produces no byte difference, so the
 * chunk never goes dirty, the Save button stays disabled, and the erasure is
 * lost on reload; a PAINT drops the real underlying voxels on save. A sparse /
 * absent chunk is NOT an error — it resolves with null data and zero-fills via
 * `decodeBaselineChunk`. Exported for unit testing.
 */
export async function fetchBaselineWithRetry(
  source: VolumeChunkSource,
  coord: OverlayCoord,
  chunkGridPosition: Float32Array,
  signal: AbortSignal | undefined,
): Promise<ReadonlyChunkVoxelBuffer> {
  const fetchSignal = signal ?? new AbortController().signal;
  let lastError: unknown;
  for (let attempt = 0; attempt < BASELINE_FETCH_ATTEMPTS; ++attempt) {
    if (signal?.aborted) {
      throw new ChunkReadAbortedError(coord);
    }
    try {
      const data = await source.fetchChunk(
        chunkGridPosition,
        (chunk: Chunk) => decodeBaselineChunk(source, chunk),
        { signal: fetchSignal },
      );
      return wrapAsReadonlyBuffer(data);
    } catch (cause) {
      if (signal?.aborted) {
        throw new ChunkReadAbortedError(coord);
      }
      lastError = cause;
      const backoffMs = BASELINE_FETCH_BACKOFF_MS[attempt];
      if (backoffMs !== undefined) {
        await delayWithAbort(backoffMs, signal);
      }
    }
  }
  // Retries exhausted on a genuine error. Surface it instead of silently
  // returning a false-empty baseline.
  console.warn(
    `[edit-session:overlay] baseline fetch failed for ` +
      `${coord.layerId}@resolution${coord.resolution}:${coord.chunkId} after ` +
      `${BASELINE_FETCH_ATTEMPTS} attempts; propagating as a read failure`,
    lastError,
  );
  throw new ChunkReadFailedError(coord, lastError);
}

/**
 * Resolve after `ms`, or early if `signal` aborts — it always RESOLVES (never
 * rejects). The caller re-checks `signal.aborted` at the top of its retry loop
 * and throws the appropriate `ChunkReadAbortedError` there, so this helper
 * stays a plain delay with no error semantics of its own.
 */
function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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

/** `(layerId, resolution, chunkId)` key for the saved-baseline store. */
function savedBaselineKey(
  layerId: LayerId,
  resolution: Resolution,
  chunkId: ChunkId,
): string {
  return `${layerId}|${resolution}|${chunkId}`;
}

interface SavedBaselineEntry {
  readonly bytes: ReadonlyChunkVoxelBuffer;
  readonly hash: string;
}

/**
 * Bounded (FIFO) client-side store of saved chunk bytes + their content hash
 * (TM-352). Detaches the bytes it is given so it owns a stable copy that
 * `readBaselineChunk` can hand back without the caller mutating it.
 */
class SavedBaselineStore {
  private readonly entries = new Map<string, SavedBaselineEntry>();
  constructor(private readonly capacity = 512) {}

  set(key: string, bytes: ReadonlyChunkVoxelBuffer): void {
    const view = bytes.asView();
    const copied = (view as unknown as { slice(): ChunkVoxelBuffer }).slice();
    const entry: SavedBaselineEntry = {
      bytes: { byteLength: copied.byteLength, asView: () => copied },
      hash: contentRefFromBuffer(copied).hash,
    };
    this.entries.delete(key); // refresh FIFO order
    this.entries.set(key, entry);
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  get(key: string): SavedBaselineEntry | undefined {
    return this.entries.get(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
