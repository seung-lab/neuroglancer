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
 * @file Top-level voxel patch store owned by an `EditSessionHost`-per-layer slot.
 *
 * One LocalPatchStore per writable segmentation layer, holding a single
 * LocalPatchSource for the active resolution. Multi-resolution support and
 * IndexedDB persistence are deferred to a later iteration.
 */

import {
  chunkGridKey,
  LocalPatchSource,
} from "#src/editing/local_patch_source.js";
import type { DebouncedFunction } from "#src/util/animation_frame_debounce.js";
import { animationFrameDebounce } from "#src/util/animation_frame_debounce.js";
import { RefCounted } from "#src/util/disposable.js";
import { NullarySignal } from "#src/util/signal.js";

export class LocalPatchStore extends RefCounted {
  readonly source: LocalPatchSource;
  readonly changed = new NullarySignal();
  private readonly flushDebounced: DebouncedFunction;

  constructor() {
    super();
    this.source = this.registerDisposer(new LocalPatchSource());
    this.flushDebounced = animationFrameDebounce(() => {
      this.changed.dispatch();
    });
  }

  /**
   * Coalesce many voxel writes within a single animation frame into one
   * `changed` dispatch (which will be the redraw trigger in Phase 1).
   */
  scheduleGPUFlush(): void {
    this.flushDebounced();
  }

  /**
   * Synchronously fire `changed` (and cancel any pending debounced flush).
   * Used for non-drag operations such as fill, where there is no drag-rate
   * burst of writes.
   */
  flushImmediately(): void {
    this.flushDebounced.cancel();
    this.changed.dispatch();
  }

  /**
   * Atomically replace a whole chunk's voxel buffer and schedule a GPU flush;
   * used by `PatchMirror` to mirror library DirtyTracker chunk events.
   * `patched` is the per-voxel mask; see `LocalPatchSource.writeFullChunk`
   * for the default-when-omitted behavior.
   */
  writeFullChunk(
    chunkGridPosition: ArrayLike<number>,
    chunkDataSize: ArrayLike<number>,
    data: BigUint64Array,
    patched?: Uint8Array,
  ): void {
    this.source.writeFullChunk(chunkGridPosition, chunkDataSize, data, patched);
    this.scheduleGPUFlush();
  }

  /**
   * Record that `PatchMirror` mutated a chunk's buffers in place (fused
   * diff/widen path) and schedule the coalesced GPU flush. The chunk's own
   * `pendingUpload` carries the stale sub-box for the texture cache.
   */
  noteChunkMutated(chunkGridPosition: ArrayLike<number>): void {
    this.source.dirtyKeys.add(chunkGridKey(chunkGridPosition));
    this.scheduleGPUFlush();
  }

  /** Drop every patch in this store. */
  clearAll(): void {
    this.source.clearAll();
    this.flushImmediately();
  }

  /**
   * Drop a single patched chunk by grid position. Used when discarding an
   * active edit session: chunks dirtied during the session that have NO
   * committed snapshot to revert to need their patch removed so the base
   * layer renders through.
   */
  clearChunk(chunkGridPosition: ArrayLike<number>): void {
    if (this.source.clearChunk(chunkGridKey(chunkGridPosition))) {
      this.scheduleGPUFlush();
    }
  }

  /** Convenience: count total patches across all chunks. Used by tests/UI. */
  countPatchedVoxels(): number {
    let n = 0;
    for (const chunk of this.source.chunks.values()) {
      n += chunk.countPatchedVoxels();
    }
    return n;
  }
}
