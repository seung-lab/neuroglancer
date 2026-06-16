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
 * Painted-sub-box hint registry (P2, TM-317).
 *
 * Bridges the paint apply path (`applyPaintBatch`, and the worker stroke
 * pipeline) to the GPU mirror (`PatchMirror`). The library's `chunk-changed`
 * event carries only `{ coord }` — not the box a write touched — so the mirror
 * would otherwise have to re-scan the WHOLE chunk on every commit to derive the
 * per-voxel patched mask. A paint write knows exactly which chunk-local box it
 * touched, so it records that box here right before `commitWrites`; the mirror
 * reads it (synchronously, at event time) to bound its fuse to that sub-box.
 *
 * ### Why this is correct (and can never wrongly bound a scan)
 *
 * `chunk-changed` is emitted SYNCHRONOUSLY from `commitWrites` (see the
 * library's `EventBus.emit`; `withBatch`'s signal coalescing does not defer it).
 * So the lifecycle of a hint is tight and race-free under the single-flight
 * paint gate:
 *
 *  1. the writer calls `notePaintedSubBox` immediately before `writeRegion`;
 *  2. if the write commits, the mirror's handler runs DURING `writeRegion` and
 *     `takePaintedSubBox` removes + returns the hint for THAT commit;
 *  3. if the write is skipped (fully clipped to bounds / fully masked out), no
 *     event fires, so the writer calls `takePaintedSubBox` itself afterwards to
 *     drop the now-orphaned hint.
 *
 * A hint therefore never outlives the single `writeRegion` that produced it. A
 * commit with NO hint (history-replay / undo-to-baseline, save rebaseline, any
 * non-paint source) falls back to a full-chunk scan — exactly what those paths
 * need (a full-chunk replay can clear patched bits anywhere in the chunk). The
 * box recorded is a SUPERSET of the voxels the write changed (the library only
 * shrinks it by bounds/mask clipping), and only changed voxels alter the mirror
 * state, so bounding the scan to it is byte-identical to a full scan.
 */

import type { LayerId, Resolution } from "@zettaai/edit-session";

import type { ChunkVoxelBox } from "#src/editing/local_patch_chunk.js";

/** Keyed by the same `layerId|resolution|chunkId` tuple the mirror sees. */
const pending = new Map<string, ChunkVoxelBox>();

function keyOf(
  layerId: LayerId,
  resolution: Resolution,
  chunkId: string,
): string {
  return `${layerId}|${resolution}|${chunkId}`;
}

/**
 * Record the chunk-local box a paint write is about to commit. Overwrites any
 * existing hint for the chunk (a batch coalesces to one write per chunk, so
 * there is at most one live hint per chunk). Call immediately before the
 * `writeRegion` / `commitWrites` that touches the chunk.
 */
export function notePaintedSubBox(
  layerId: LayerId,
  resolution: Resolution,
  chunkId: string,
  box: ChunkVoxelBox,
): void {
  pending.set(keyOf(layerId, resolution, chunkId), box);
}

/**
 * Remove and return the hint for a chunk, or `undefined` if none is recorded.
 * The mirror calls this synchronously when it receives `chunk-changed`; the
 * writer calls it after a (possibly skipped) `writeRegion` to drop an
 * orphaned hint. Idempotent.
 */
export function takePaintedSubBox(
  layerId: LayerId,
  resolution: Resolution,
  chunkId: string,
): ChunkVoxelBox | undefined {
  const key = keyOf(layerId, resolution, chunkId);
  const box = pending.get(key);
  if (box !== undefined) pending.delete(key);
  return box;
}
