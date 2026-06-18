/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Worker-pool stroke pipeline (TM-322 phase 3 step 3).
 *
 * Orchestrates an unmasked stroke segment (single z-slice, radius ≥ 1) across
 * the chunk tiles it covers: materialize each chunk's SharedArrayBuffer-backed
 * working buffer (`edit.beginWrite`), dispatch a rasterize job per chunk to the
 * brush worker pool (writes in place, zero-copy), and `commitWrites` each tile
 * as its worker completes (per-tile GPU updates). The segment resolves only
 * when every tile has settled, preserving the bridge's one-in-flight coalescing.
 *
 * A shared generation word folds in cancellation/staleness (TM-323): bumping it
 * makes in-flight workers bail cooperatively and causes any late tile to be
 * discarded instead of committed — so a superseded stroke (undo / cancel / tool
 * switch / resolution change) can never write after the fact.
 *
 * Only used when cross-origin isolation makes `SharedArrayBuffer` available; the
 * caller falls back to the synchronous main-thread path otherwise.
 */

import type {
  Edit,
  LayerMetadata,
  SessionVoxelBounds,
  WriteTarget,
} from "@zettaai/edit-session";
import { ChunkId, scaleFor } from "@zettaai/edit-session";

import { sharedArrayBufferAvailable } from "#src/editing/adapters/ng_chunk_buffer_allocator.js";
import {
  notePaintedSubBox,
  takePaintedSubBox,
} from "#src/editing/overlay/painted_subbox_registry.js";
import {
  requestBrushMaskStamp,
  requestBrushRasterize,
  warmBrushWorkerPool,
} from "#src/editing/tool_runtimes/brush_worker_pool.js";
import type { BrushVoxelDataType } from "#src/editing/tool_runtimes/brush_worker_protocol.js";
import { GENERATION_INDEX } from "#src/editing/tool_runtimes/brush_worker_protocol.js";
import type { Vec3 } from "#src/editing/tool_runtimes/paint_rasterize.js";
import type { StrokeFootprintMask } from "#src/editing/tool_runtimes/paint_types.js";

/** A chunk the stroke footprint overlaps. */
export interface ChunkTile {
  readonly coord: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
  /** Global voxel coordinate of the chunk's local (0,0,0). */
  readonly origin: Vec3;
}

/**
 * The chunk tiles an unmasked single-z stroke footprint overlaps, clipped to the
 * session bounds. Per-segment bounding boxes (point ± floor(radius), matching
 * the rasterize kernel) are unioned so a thin diagonal does not enumerate the
 * empty chunks of its bounding rectangle. Pure / unit-tested.
 */
export function chunksForStroke(
  points: readonly Vec3[],
  radius: number,
  chunkSize: readonly [number, number, number],
  bounds?: SessionVoxelBounds,
  // Chunk-grid origin in global voxels (NG's `voxel_offset`). The chunk grid is
  // anchored on it (`chunkIndex = floor((voxel - offset) / chunkSize)`), so tile
  // ids and origins match the library's `ChunkId` and the rendered chunks for a
  // volume with a non-zero offset. Defaults to zero (offset-free volumes).
  voxelOffset: readonly [number, number, number] = [0, 0, 0],
): ChunkTile[] {
  if (points.length === 0) return [];
  const r = Math.max(0, Math.floor(radius));
  const [csx, csy, csz] = chunkSize;
  const [offX, offY, offZ] = voxelOffset;
  const cz = Math.floor(points[0][2]);
  if (bounds !== undefined && (cz < bounds.loZ || cz >= bounds.hiZ)) return [];
  const gz = Math.floor((cz - offZ) / csz);

  const seen = new Set<string>();
  const tiles: ChunkTile[] = [];
  const segCount = points.length === 1 ? 1 : points.length - 1;
  for (let s = 0; s < segCount; s++) {
    const a = points[s];
    const b = points.length === 1 ? a : points[s + 1];
    let loX = Math.floor(Math.min(a[0], b[0])) - r;
    let hiX = Math.ceil(Math.max(a[0], b[0])) + r;
    let loY = Math.floor(Math.min(a[1], b[1])) - r;
    let hiY = Math.ceil(Math.max(a[1], b[1])) + r;
    if (bounds !== undefined) {
      loX = Math.max(loX, bounds.loX);
      hiX = Math.min(hiX, bounds.hiX - 1);
      loY = Math.max(loY, bounds.loY);
      hiY = Math.min(hiY, bounds.hiY - 1);
    }
    if (loX > hiX || loY > hiY) continue;
    const gyLo = Math.floor((loY - offY) / csy);
    const gyHi = Math.floor((hiY - offY) / csy);
    const gxLo = Math.floor((loX - offX) / csx);
    const gxHi = Math.floor((hiX - offX) / csx);
    for (let gy = gyLo; gy <= gyHi; gy++) {
      for (let gx = gxLo; gx <= gxHi; gx++) {
        const key = `${gx},${gy},${gz}`;
        if (seen.has(key)) continue;
        seen.add(key);
        tiles.push({
          coord: { x: gx, y: gy, z: gz },
          origin: [gx * csx + offX, gy * csy + offY, gz * csz + offZ],
        });
      }
    }
  }
  return tiles;
}

/**
 * Master switch for the worker write path (TM-322 / TM-317 Phase B).
 *
 * RE-ENABLED. Phase A profiling (with the GPU mirror bounded to the committed
 * sub-box and baseline IO prefetched) showed the residual main-thread tax for
 * MASKED strokes is `scatter` (sample-back) + `writeRegion` (slot scatter) —
 * ~84% of BLOCKS-UI. Both move off-thread here: the masked footprint mask is
 * stamped into the SAB chunk slots by the worker pool (`stampMaskedFootprint`),
 * and unmasked strokes rasterize off-thread as before (`paintSegment`).
 *
 * Robustness (fixes the earlier 1-dab/no-line regression): a worker that fails
 * to boot or rejects no longer hangs the stroke — the pool surfaces the error
 * (`brush_worker_pool` `onerror`/`failPool`), `paintSegment`/`stampMaskedFootprint`
 * supersede in-flight tiles and rethrow, and the caller (`painting_tools`) falls
 * back to the synchronous main-thread compute for that segment. A non-shared
 * slot buffer is also guarded against (writes would otherwise land in a
 * structured-clone copy and be lost — the original silent-data-loss cause).
 */
const WORKER_PATH_ENABLED = true;

/**
 * Consecutive worker-path stroke failures before the path latches OFF for the
 * session. A transient first-stroke hiccup (e.g. a one-off worker-bundle load
 * error) must NOT disable the off-thread path for the whole session — the caller
 * falls back per stroke and we retry the next one; only a genuinely broken
 * worker (this many failures in a row, with no successful stroke between)
 * latches off. A single success resets the counter.
 */
const MAX_CONSECUTIVE_WORKER_FAILURES = 3;

/**
 * Owns the generation word and drives unmasked stroke segments across the brush
 * worker pool. One instance per painting session.
 */
export class PaintStrokePipeline {
  private readonly controlBuffer: SharedArrayBuffer | undefined;
  private readonly control: Int32Array | undefined;
  private generation = 0;
  /**
   * Count of CONSECUTIVE worker-path stroke failures (reset by any success).
   * `available` latches off only once this reaches
   * `MAX_CONSECUTIVE_WORKER_FAILURES`, so a transient first-stroke hiccup falls
   * back for that stroke and retries the next, rather than disabling the
   * off-thread path for the whole session.
   */
  private consecutiveFailures = 0;

  constructor() {
    if (WORKER_PATH_ENABLED && sharedArrayBufferAvailable()) {
      this.controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      this.control = new Int32Array(this.controlBuffer);
      // Pre-boot a worker so the first stroke doesn't race the bundle load.
      warmBrushWorkerPool();
    }
  }

  /** Whether the worker path is usable (enabled, cross-origin isolated, SAB present, not latched off). */
  get available(): boolean {
    return (
      this.control !== undefined &&
      this.consecutiveFailures < MAX_CONSECUTIVE_WORKER_FAILURES
    );
  }

  /** Record a clean worker stroke; clears the transient-failure counter. */
  markSucceeded(): void {
    this.consecutiveFailures = 0;
  }

  /**
   * Record a worker-path failure. The caller falls back to the synchronous path
   * for THIS stroke; only `MAX_CONSECUTIVE_WORKER_FAILURES` in a row (no success
   * between) latch the path off for the session.
   */
  markFailed(): void {
    this.consecutiveFailures += 1;
  }

  /**
   * Supersede all in-flight and pending tiles: in-flight workers bail at the
   * next row, and any returning tile is discarded rather than committed. Call
   * on cancel / undo / tool deactivate / resolution change.
   */
  invalidate(): void {
    if (this.control === undefined) return;
    this.generation = (this.generation + 1) | 0;
    Atomics.store(this.control, GENERATION_INDEX, this.generation);
  }

  /**
   * Rasterize one unmasked stroke segment across its chunk tiles, committing
   * each as its worker finishes. Resolves when all tiles have settled.
   * Precondition: `available` is true; caller passes an unmasked, single-z,
   * radius ≥ 1 polyline.
   */
  async paintSegment(
    edit: Edit,
    target: WriteTarget,
    metadata: LayerMetadata,
    points: readonly Vec3[],
    radius: number,
    value: number | bigint,
  ): Promise<void> {
    const controlBuffer = this.controlBuffer;
    if (controlBuffer === undefined || points.length === 0) return;
    const generation = this.generation;
    const scale = scaleFor(metadata, target.resolution);
    const chunkSize = scale.chunkDataSize;
    const bounds = edit.sessionVoxelBoundsFor({
      layerId: target.layerId,
      resolution: target.resolution,
      chunkId: ChunkId.fromCoord({ x: 0, y: 0, z: 0 }),
    });
    const tiles = chunksForStroke(
      points,
      radius,
      chunkSize,
      bounds,
      scale.voxelOffset,
    );
    const voxelDataType = metadata.voxelDataType as BrushVoxelDataType;

    try {
      await Promise.all(
        tiles.map(async (tile) => {
          const slot = await edit.beginWrite({
            layerId: target.layerId,
            resolution: target.resolution,
            chunkId: ChunkId.fromCoord(tile.coord),
          });
          // Superseded while materializing → drop (the edit will be discarded).
          if (this.generation !== generation) return;
          const data = slot.data;
          assertSharedSlot(data);
          const written = await requestBrushRasterize({
            kind: "stroke",
            dataBuffer: data.buffer as SharedArrayBuffer,
            byteOffset: data.byteOffset,
            elementCount: data.length,
            voxelDataType,
            points,
            radius,
            value,
            chunkOrigin: tile.origin,
            chunkSize,
            controlBuffer,
            generation,
          });
          // Nothing covered, or superseded after compute → no commit.
          if (written === null || this.generation !== generation) return;
          commitTile(edit, target, tile.coord, slot, written);
        }),
      );
    } catch (e) {
      // A worker failure (failed bundle, deserialization, reject) must not leave
      // the stroke half-applied or hung: supersede every in-flight tile so none
      // commits late, then rethrow so the caller falls back to the synchronous
      // path for this segment. Re-stamping the same footprint there is
      // idempotent (same value at the same voxels) and undo-safe (one Edit).
      this.invalidate();
      throw e;
    }
  }

  /**
   * Stamp a precomputed masked-brush footprint mask across its chunk tiles via
   * the worker pool, committing each tile as its worker finishes (TM-317 Phase
   * B). The footprint mask (1 = paint) is computed in pyodide
   * (`PaintingCompute.computeMaskedStrokeFootprint`); here we only enumerate the
   * chunks it covers and dispatch the off-thread stamp, so the main thread is
   * spared both the sample-back (`scatter`) and the slot write (`writeRegion`).
   *
   * Precondition: `available` is true. The mask is copied ONCE into a shared,
   * read-only buffer reused by every tile (no per-tile structured-clone copy).
   * On any worker/SAB failure, supersedes in-flight tiles and rethrows so the
   * caller falls back to the synchronous masked apply.
   */
  async stampMaskedFootprint(
    edit: Edit,
    target: WriteTarget,
    metadata: LayerMetadata,
    footprint: StrokeFootprintMask,
    value: number | bigint,
  ): Promise<void> {
    const controlBuffer = this.controlBuffer;
    if (controlBuffer === undefined) return;
    const generation = this.generation;
    const scale = scaleFor(metadata, target.resolution);
    const chunkSize = scale.chunkDataSize;
    const bounds = edit.sessionVoxelBoundsFor({
      layerId: target.layerId,
      resolution: target.resolution,
      chunkId: ChunkId.fromCoord({ x: 0, y: 0, z: 0 }),
    });
    const { loTx, loTy, maskW, maskH, cz, mask } = footprint;
    const tiles = chunksForBox(
      loTx,
      loTy,
      maskW,
      maskH,
      cz,
      chunkSize,
      bounds,
      scale.voxelOffset,
    );
    if (tiles.length === 0) return;
    const voxelDataType = metadata.voxelDataType as BrushVoxelDataType;
    // Share the mask read-only across all tiles (one copy, never transferred).
    const maskBuffer = new SharedArrayBuffer(mask.length);
    new Uint8Array(maskBuffer).set(mask);

    try {
      await Promise.all(
        tiles.map(async (tile) => {
          const slot = await edit.beginWrite({
            layerId: target.layerId,
            resolution: target.resolution,
            chunkId: ChunkId.fromCoord(tile.coord),
          });
          if (this.generation !== generation) return;
          const data = slot.data;
          assertSharedSlot(data);
          const written = await requestBrushMaskStamp({
            kind: "mask",
            dataBuffer: data.buffer as SharedArrayBuffer,
            byteOffset: data.byteOffset,
            elementCount: data.length,
            voxelDataType,
            maskBuffer,
            maskW,
            maskH,
            loTx,
            loTy,
            cz,
            value,
            chunkOrigin: tile.origin,
            chunkSize,
            controlBuffer,
            generation,
          });
          if (written === null || this.generation !== generation) return;
          commitTile(edit, target, tile.coord, slot, written);
        }),
      );
    } catch (e) {
      this.invalidate();
      throw e;
    }
  }
}

/**
 * Throw if a slot's working buffer is not a `SharedArrayBuffer`. The worker
 * writes in place through the shared buffer; a plain `ArrayBuffer` would be
 * structured-cloned to the worker and its writes silently lost (the original
 * "drag paints nothing" cause). `available` already requires cross-origin
 * isolation + the SAB allocator, so this is defense-in-depth that converts a
 * misconfiguration into a clean fallback instead of silent data loss.
 */
function assertSharedSlot(data: { buffer: ArrayBufferLike }): void {
  if (!(data.buffer instanceof SharedArrayBuffer)) {
    throw new Error(
      "brush worker: overlay slot is not SharedArrayBuffer-backed " +
        "(the SAB chunk allocator is not wired or the context is not " +
        "cross-origin isolated) — falling back to the main-thread path.",
    );
  }
}

/** Record the painted sub-box for the GPU mirror (P2) and commit the tile. */
function commitTile(
  edit: Edit,
  target: WriteTarget,
  coord: { x: number; y: number; z: number },
  slot: Parameters<Edit["commitWrites"]>[0],
  written: { origin: Vec3; size: Vec3 },
): void {
  const [ox, oy, oz] = written.origin;
  const [sx, sy, sz] = written.size;
  const chunkId = ChunkId.fromCoord(coord);
  // The `chunk-changed` handler consumes this synchronously inside commitWrites.
  notePaintedSubBox(target.layerId, target.resolution, chunkId, {
    x0: ox,
    y0: oy,
    z0: oz,
    x1: ox + sx - 1,
    y1: oy + sy - 1,
    z1: oz + sz - 1,
  });
  edit.withBatch(() => edit.commitWrites(slot, written));
  // Drop any hint the handler did not consume (defensive; commitWrites always
  // fires the event here, so this is normally a no-op).
  takePaintedSubBox(target.layerId, target.resolution, chunkId);
}

/**
 * Chunk tiles a single-z footprint box `[loTx, loTx+w) × [loTy, loTy+h)` at
 * `cz` overlaps, clipped to the session bounds. Mirrors `chunksForStroke`'s
 * grid/clip logic for the masked footprint (whose shape is a dense mask, not a
 * swept capsule).
 */
function chunksForBox(
  loTx: number,
  loTy: number,
  w: number,
  h: number,
  cz: number,
  chunkSize: readonly [number, number, number],
  bounds?: SessionVoxelBounds,
  voxelOffset: readonly [number, number, number] = [0, 0, 0],
): ChunkTile[] {
  const [csx, csy, csz] = chunkSize;
  const [offX, offY, offZ] = voxelOffset;
  if (bounds !== undefined && (cz < bounds.loZ || cz >= bounds.hiZ)) return [];
  const gz = Math.floor((cz - offZ) / csz);
  let loX = loTx;
  let hiX = loTx + w - 1;
  let loY = loTy;
  let hiY = loTy + h - 1;
  if (bounds !== undefined) {
    loX = Math.max(loX, bounds.loX);
    hiX = Math.min(hiX, bounds.hiX - 1);
    loY = Math.max(loY, bounds.loY);
    hiY = Math.min(hiY, bounds.hiY - 1);
  }
  if (loX > hiX || loY > hiY) return [];
  const tiles: ChunkTile[] = [];
  const gyLo = Math.floor((loY - offY) / csy);
  const gyHi = Math.floor((hiY - offY) / csy);
  const gxLo = Math.floor((loX - offX) / csx);
  const gxHi = Math.floor((hiX - offX) / csx);
  for (let gy = gyLo; gy <= gyHi; gy++) {
    for (let gx = gxLo; gx <= gxHi; gx++) {
      tiles.push({
        coord: { x: gx, y: gy, z: gz },
        origin: [gx * csx + offX, gy * csy + offY, gz * csz + offZ],
      });
    }
  }
  return tiles;
}
