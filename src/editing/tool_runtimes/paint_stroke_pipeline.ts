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
import { requestBrushRasterize } from "#src/editing/tool_runtimes/brush_worker_pool.js";
import type { BrushVoxelDataType } from "#src/editing/tool_runtimes/brush_worker_protocol.js";
import { GENERATION_INDEX } from "#src/editing/tool_runtimes/brush_worker_protocol.js";
import type { Vec3 } from "#src/editing/tool_runtimes/paint_rasterize.js";

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
): ChunkTile[] {
  if (points.length === 0) return [];
  const r = Math.max(0, Math.floor(radius));
  const [csx, csy, csz] = chunkSize;
  const cz = Math.floor(points[0][2]);
  if (bounds !== undefined && (cz < bounds.loZ || cz >= bounds.hiZ)) return [];
  const gz = Math.floor(cz / csz);

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
    for (let gy = Math.floor(loY / csy); gy <= Math.floor(hiY / csy); gy++) {
      for (let gx = Math.floor(loX / csx); gx <= Math.floor(hiX / csx); gx++) {
        const key = `${gx},${gy},${gz}`;
        if (seen.has(key)) continue;
        seen.add(key);
        tiles.push({
          coord: { x: gx, y: gy, z: gz },
          origin: [gx * csx, gy * csy, gz * csz],
        });
      }
    }
  }
  return tiles;
}

/**
 * Owns the generation word and drives unmasked stroke segments across the brush
 * worker pool. One instance per painting session.
 */
export class PaintStrokePipeline {
  private readonly controlBuffer: SharedArrayBuffer | undefined;
  private readonly control: Int32Array | undefined;
  private generation = 0;

  constructor() {
    if (sharedArrayBufferAvailable()) {
      this.controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      this.control = new Int32Array(this.controlBuffer);
    }
  }

  /** Whether the worker path is usable (cross-origin isolated / SAB present). */
  get available(): boolean {
    return this.control !== undefined;
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
    const chunkSize = scaleFor(metadata, target.resolution).chunkDataSize;
    const bounds = edit.sessionVoxelBoundsFor({
      layerId: target.layerId,
      resolution: target.resolution,
      chunkId: ChunkId.fromCoord({ x: 0, y: 0, z: 0 }),
    });
    const tiles = chunksForStroke(points, radius, chunkSize, bounds);
    const voxelDataType = metadata.voxelDataType as BrushVoxelDataType;

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
        const written = await requestBrushRasterize({
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
        edit.withBatch(() => edit.commitWrites(slot, written));
      }),
    );
  }
}
