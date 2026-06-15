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
 * Consumer-owned paint apply path (TM-315 migration).
 *
 * Writes a `PaintWriteBatch` (produced by `PaintingCompute`) into the session
 * through an `Edit`. The library used to own this (`applyPaintBatch` +
 * `writeBlockIntoSlot`); now the consumer owns the tools, so it owns the apply.
 *
 * Each `PaintChunkWrite` is confined to a single chunk (chunk-local
 * `subregion`). We translate it to the chunk's GLOBAL voxel box and hand it to
 * `Edit.writeRegion`, which is the library's single region-clip enforcement
 * point: it clips the box to the session bounds, materializes only the covered
 * (and pinned) chunk via `beginWrite`, copies the dense block honoring the
 * optional `valueMask`, and commits the written subregion. A block that falls
 * entirely outside the session region is dropped before any `beginWrite` — the
 * same cross-boundary safety the old `writeBlockIntersectsBounds` provided.
 *
 * Does NOT record history — the caller (a stroke = one `Edit`) decides when to
 * `record()` / `discard()`.
 */

import type { Edit, WriteTarget } from "@zettaai/edit-session";
import { ChunkId } from "@zettaai/edit-session";

import {
  notePaintedSubBox,
  takePaintedSubBox,
} from "#src/editing/overlay/painted_subbox_registry.js";
import { paintProfiler } from "#src/editing/tool_runtimes/paint_profiler.js";
import type { PaintWriteBatch } from "#src/editing/tool_runtimes/paint_types.js";

export async function applyPaintBatch(
  edit: Edit,
  batch: PaintWriteBatch,
  chunkSize: readonly [number, number, number],
): Promise<void> {
  const target: WriteTarget = {
    layerId: batch.targetLayerId,
    resolution: batch.targetResolution,
  };
  const [csx, csy, csz] = chunkSize;
  const prof = paintProfiler.enabled;
  const t0 = prof ? performance.now() : 0;
  let appliedChunks = 0;

  for (const w of batch.chunks) {
    const [ox, oy, oz] = w.subregion.origin;
    const [sxv, syv, szv] = w.subregion.size;
    const box = {
      origin: [
        w.chunkCoord.x * csx + ox,
        w.chunkCoord.y * csy + oy,
        w.chunkCoord.z * csz + oz,
      ] as readonly [number, number, number],
      size: w.subregion.size,
    };
    // P2 (TM-317): record the chunk-local box this write is about to commit so
    // the GPU mirror (`PatchMirror`) can bound its fuse to the touched sub-box
    // instead of re-scanning the whole chunk. The `chunk-changed` handler
    // consumes this synchronously DURING `writeRegion` (the emit is synchronous
    // from `commitWrites`); if the write is skipped (clipped to bounds / fully
    // masked → no event), we drop the orphaned hint right after. Empty sub-boxes
    // never produce a write — skip them.
    const chunkId = ChunkId.fromCoord(w.chunkCoord);
    const recorded = sxv > 0 && syv > 0 && szv > 0;
    if (recorded) {
      notePaintedSubBox(target.layerId, target.resolution, chunkId, {
        x0: ox,
        y0: oy,
        z0: oz,
        x1: ox + sxv - 1,
        y1: oy + syv - 1,
        z1: oz + szv - 1,
      });
    }
    await edit.writeRegion(
      target,
      w.values,
      box,
      w.valueMask !== undefined ? { valueMask: w.valueMask } : undefined,
    );
    // Drop any hint the synchronous commit handler did not consume (the write
    // was skipped), so a stale hint can never bound a later non-paint commit.
    if (recorded) {
      takePaintedSubBox(target.layerId, target.resolution, chunkId);
    }
    appliedChunks++;
  }

  if (prof) {
    paintProfiler.record(
      "overlay.paint.apply.writeRegion",
      performance.now() - t0,
    );
    paintProfiler.count("overlay.paint.apply.chunks", appliedChunks);
  }
}
