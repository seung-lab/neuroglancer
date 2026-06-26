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
  EditSession,
  LayerId,
  OverlayCoord,
  ReadonlyChunkVoxelBuffer,
  Resolution,
} from "@zettaai/edit-session";
import { ChunkId } from "@zettaai/edit-session";

import type { NgLogger } from "#src/editing/adapters/ng_logger.js";
import type {
  ChunkVoxelBox,
  LocalPatchChunk,
} from "#src/editing/local_patch_chunk.js";
import type { LocalPatchStore } from "#src/editing/local_patch_store.js";
import { takePaintedSubBox } from "#src/editing/overlay/painted_subbox_registry.js";
import { paintProfiler } from "#src/editing/tool_runtimes/paint_profiler.js";
import { RefCounted } from "#src/util/disposable.js";

/**
 * Read the pristine baseline bytes for an overlay chunk — what the base
 * segmentation render layer would show absent any patches. PatchMirror
 * diffs overlay bytes against this to derive the per-voxel patched mask.
 */
export type BaselineChunkReader = (
  coord: OverlayCoord,
) => Promise<ReadonlyChunkVoxelBuffer>;

/**
 * One-way mirror that propagates dirty-chunk events from the library's
 * `EditOverlayStore` into a per-layer GPU `LocalPatchStore`. The mirror is
 * single-step (library -> GPU only) and never writes back. Created and torn
 * down by `EditSessionHost` per writable layer; coalescing of bursty writes
 * is handled inside `LocalPatchStore.scheduleGPUFlush`.
 *
 * The per-voxel patched mask is derived by comparing overlay bytes against
 * baseline bytes. The baseline here MUST be the datasource render base — the
 * decoded bytes the base segmentation render layer shows from `source.chunks`
 * (via `readBaseline` → `NgChunkSource.readDatasourceBaseline`) — NOT the edit
 * baseline (saved/committed bytes). The render composites the GPU patch where
 * the mask is 1 and falls back to the datasource chunk where it is 0, so the
 * composite equals the overlay only when `patched = (overlay !== datasourceBase)`.
 * Diffing against the saved/committed bytes instead would drop just-saved voxels
 * out of the mask (they equal that baseline) and revert them to the stale
 * datasource value on screen (TM-352). Voxels where `overlay[i] !== baseline[i]`
 * are marked patched. Voxels the user erased back to the datasource value
 * compare equal and stay unpatched — the visible result is identical to "not
 * patched", so the mask is correct in practice.
 */
export class PatchMirror extends RefCounted {
  private readonly chunkDataSizeByResolution = new Map<
    Resolution,
    readonly [number, number, number]
  >();

  constructor(
    private readonly session: EditSession,
    private readonly layerId: LayerId,
    private readonly store: LocalPatchStore,
    private readonly logger: NgLogger,
    private readonly readBaseline: BaselineChunkReader,
  ) {
    super();
    const unsubscribe = this.session.dirty.on("chunk-changed", (payload) => {
      if (payload.coord.layerId !== this.layerId) return;
      // Consume the painted-sub-box hint SYNCHRONOUSLY here — this handler runs
      // synchronously from the library's `commitWrites`, so the hint for this
      // exact commit is live now and would be ambiguous if read later in the
      // async `syncChunk`. A paint write left a hint (→ bounded fuse); any other
      // commit (history replay / undo-to-baseline / save rebaseline) left none
      // (→ full-chunk scan, which those paths require). See the registry docs.
      const scanBox = takePaintedSubBox(
        payload.coord.layerId,
        payload.coord.resolution,
        payload.coord.chunkId,
      );
      void this.syncChunk(payload.coord, scanBox);
    });
    this.registerDisposer(() => unsubscribe());
  }

  private async syncChunk(
    coord: OverlayCoord,
    scanBox: ChunkVoxelBox | undefined,
  ): Promise<void> {
    const chunkKey = `${coord.layerId}|${coord.resolution}|${coord.chunkId}`;
    try {
      const chunkDataSize = this.resolveChunkDataSize(coord.resolution);
      if (chunkDataSize === undefined) {
        this.logger.error(
          "overlay",
          `PatchMirror sync failed for chunk ${chunkKey}: no chunkDataSize ` +
            `for resolution ${coord.resolution} on layer ${coord.layerId}`,
        );
        return;
      }
      const prof = paintProfiler.enabled;
      let t = prof ? performance.now() : 0;
      const [overlayBuffer, baselineBuffer] = await Promise.all([
        this.session.overlay.read(coord),
        this.readBaseline(coord),
      ]);
      if (prof) {
        paintProfiler.record("5.mirror.read(io)", performance.now() - t);
      }
      if (this.wasDisposed) return;
      const { x, y, z } = ChunkId.toCoord(coord.chunkId);
      const chunkGridPosition = new Float32Array([x, y, z]);
      const chunk = this.store.source.getOrCreateChunk(
        chunkGridPosition,
        chunkDataSize,
      );
      if (prof) t = performance.now();
      const box = fuseOverlayIntoChunk(
        chunk,
        overlayBuffer.asView(),
        baselineBuffer.asView(),
        scanBox,
      );
      if (prof) {
        paintProfiler.record("5.mirror.fuse(cpu)", performance.now() - t);
        paintProfiler.count("mirror.syncs", 1);
      }
      if (box !== null) {
        chunk.dirty = true;
        chunk.mergePendingUpload(box);
        this.store.noteChunkMutated(chunkGridPosition);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        "overlay",
        `PatchMirror sync failed for chunk ${chunkKey}: ${message}`,
      );
    }
  }

  private resolveChunkDataSize(
    resolution: Resolution,
  ): readonly [number, number, number] | undefined {
    const cached = this.chunkDataSizeByResolution.get(resolution);
    if (cached !== undefined) return cached;
    const baseline = this.session.baseline.perLayer.get(this.layerId);
    if (baseline === undefined) return undefined;
    const scale = baseline.metadata.scales.find(
      (s) => s.resolution === resolution,
    );
    if (scale === undefined) return undefined;
    const size: readonly [number, number, number] = [
      scale.chunkDataSize[0],
      scale.chunkDataSize[1],
      scale.chunkDataSize[2],
    ];
    this.chunkDataSizeByResolution.set(resolution, size);
    return size;
  }
}

type NumericVoxelView =
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | Int8Array
  | Int16Array
  | Int32Array;

function isNumericVoxelView(view: ArrayBufferView): view is NumericVoxelView {
  return (
    view instanceof Uint8Array ||
    view instanceof Uint16Array ||
    view instanceof Uint32Array ||
    view instanceof Int8Array ||
    view instanceof Int16Array ||
    view instanceof Int32Array
  );
}

/**
 * Fused widen + diff + write: one pass over the chunk that updates
 * `chunk.data` (the BigUint64 GPU mirror) and `chunk.patched`
 * (`overlay !== baseline`) in place, and returns the chunk-local bbox of
 * voxels whose mirrored state actually changed — or `null` when the chunk is
 * already up to date.
 *
 * `LocalPatchStore` stores ONE BigUint64 per voxel (the GPU patch texture is
 * RG32UI = 64 bits per voxel). For sub-uint64 source types the previous
 * implementation widened via a `BigInt()` call per voxel into a fresh
 * BigUint64Array (plus a second widened baseline array and a third diff
 * array) — the dominant per-chunk CPU cost. Here the numeric path instead
 * writes the `(lo32, hi32)` pair directly through a Uint32Array view of
 * `chunk.data` (little-endian: low word first, matching the RG32UI upload
 * layout), so no BigInt and no temporary allocations are involved. Signed
 * types widen via `>>> 0` — the same two's-complement representation
 * `BigInt(v >>> 0)` produced before.
 */
export function fuseOverlayIntoChunk(
  chunk: LocalPatchChunk,
  overlayView: ArrayBufferView & { length: number },
  baselineView: ArrayBufferView & { length: number },
  // P2 (TM-317): when present, only this chunk-local box is scanned — it is a
  // superset of the voxels the firing commit touched, and only touched voxels
  // can change the mirror state, so the (data, patched) updates and the
  // returned change-bbox are byte-identical to a full-chunk scan. Absent →
  // full chunk (history replay / undo-to-baseline / save rebaseline, which can
  // change voxels anywhere and so must scan everything).
  scanBox?: ChunkVoxelBox,
): ChunkVoxelBox | null {
  const volume = chunk.data.length;
  if (overlayView.length !== volume || baselineView.length !== volume) {
    throw new Error(
      `PatchMirror.fuseOverlayIntoChunk: overlay length ${overlayView.length} ` +
        `/ baseline length ${baselineView.length} != chunk volume ${volume}`,
    );
  }
  const [sx, sy, sz] = chunk.chunkDataSize;
  // Scan range, clamped to the chunk. A scanBox is chunk-local and already
  // within bounds, but clamp defensively so a malformed hint can never index
  // out of the chunk.
  const x0 = scanBox === undefined ? 0 : Math.max(0, scanBox.x0);
  const y0 = scanBox === undefined ? 0 : Math.max(0, scanBox.y0);
  const z0 = scanBox === undefined ? 0 : Math.max(0, scanBox.z0);
  const x1 = scanBox === undefined ? sx - 1 : Math.min(sx - 1, scanBox.x1);
  const y1 = scanBox === undefined ? sy - 1 : Math.min(sy - 1, scanBox.y1);
  const z1 = scanBox === undefined ? sz - 1 : Math.min(sz - 1, scanBox.z1);
  const patched = chunk.patched;
  let minX = sx;
  let minY = sy;
  let minZ = sz;
  let maxX = -1;
  let maxY = -1;
  let maxZ = -1;
  if (
    overlayView instanceof BigUint64Array &&
    baselineView instanceof BigUint64Array
  ) {
    const data = chunk.data;
    for (let z = z0; z <= z1; z++) {
      for (let y = y0; y <= y1; y++) {
        let i = (z * sy + y) * sx + x0;
        for (let x = x0; x <= x1; x++, i++) {
          const v = overlayView[i];
          const p = v !== baselineView[i] ? 1 : 0;
          if (data[i] === v && patched[i] === p) continue;
          data[i] = v;
          patched[i] = p;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
        }
      }
    }
  } else if (
    isNumericVoxelView(overlayView) &&
    isNumericVoxelView(baselineView)
  ) {
    const u32 = new Uint32Array(
      chunk.data.buffer,
      chunk.data.byteOffset,
      volume * 2,
    );
    for (let z = z0; z <= z1; z++) {
      for (let y = y0; y <= y1; y++) {
        let i = (z * sy + y) * sx + x0;
        for (let x = x0; x <= x1; x++, i++) {
          const lo = overlayView[i] >>> 0;
          const p = overlayView[i] !== baselineView[i] ? 1 : 0;
          if (u32[2 * i] === lo && u32[2 * i + 1] === 0 && patched[i] === p) {
            continue;
          }
          u32[2 * i] = lo;
          u32[2 * i + 1] = 0;
          patched[i] = p;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
        }
      }
    }
  } else {
    throw new Error(
      `PatchMirror: unsupported voxel data type ` +
        `${overlayView.constructor.name} / ${baselineView.constructor.name}`,
    );
  }
  if (maxZ < 0) return null;
  return { x0: minX, y0: minY, z0: minZ, x1: maxX, y1: maxY, z1: maxZ };
}
