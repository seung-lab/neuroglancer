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
 * @file Frontend-only "chunk source" for voxel edit patches.
 *
 * Despite the name, this is NOT a real `VolumeChunkSource` — it never registers
 * a worker counterpart and never participates in the standard chunk download
 * lifecycle. It's a plain in-memory map of LocalPatchChunks keyed by
 * chunkGridPosition, designed to be sampled in lockstep with a real
 * VolumeChunkSource of the same `chunkDataSize`.
 *
 * Patch chunk keys mirror VolumeChunkSource conventions:
 *   key = chunkGridPosition.join() (CSV of integer grid coords)
 * so they align with base chunks one-to-one.
 */

import { LocalPatchChunk } from "#src/editing/local_patch_chunk.js";
import { RefCounted } from "#src/util/disposable.js";
import type { vec3 } from "#src/util/geom.js";
import { NullarySignal } from "#src/util/signal.js";

export type ChunkKey = string;

export function chunkGridKey(chunkGridPosition: ArrayLike<number>): ChunkKey {
  return Array.prototype.join.call(chunkGridPosition, ",");
}

export class LocalPatchSource extends RefCounted {
  readonly chunks = new Map<ChunkKey, LocalPatchChunk>();
  readonly changed = new NullarySignal();
  /** Keys of chunks modified since the last GPU flush. */
  readonly dirtyKeys = new Set<ChunkKey>();

  /**
   * Returns the patch chunk at the given grid position, creating an empty one
   * with `chunkDataSize` if none exists yet. v1 expects all chunks within a
   * session to share the same chunkDataSize (single-resolution edits).
   */
  getOrCreateChunk(
    chunkGridPosition: ArrayLike<number>,
    chunkDataSize: ArrayLike<number>,
  ): LocalPatchChunk {
    const key = chunkGridKey(chunkGridPosition);
    let chunk = this.chunks.get(key);
    if (chunk === undefined) {
      chunk = new LocalPatchChunk([
        chunkDataSize[0],
        chunkDataSize[1],
        chunkDataSize[2],
      ] as unknown as vec3);
      this.chunks.set(key, chunk);
    }
    return chunk;
  }

  /** Returns the patch chunk at the given grid position, or undefined. */
  getChunk(chunkGridPosition: ArrayLike<number>): LocalPatchChunk | undefined {
    return this.chunks.get(chunkGridKey(chunkGridPosition));
  }

  /**
   * Atomically replace the entire voxel buffer of the chunk at
   * `chunkGridPosition`. Creates the chunk if it doesn't yet exist. Used by
   * `PatchMirror` to mirror library overlay chunks on undo/redo and any other
   * full-chunk replacement event.
   */
  writeFullChunk(
    chunkGridPosition: ArrayLike<number>,
    chunkDataSize: ArrayLike<number>,
    data: BigUint64Array,
  ): void {
    const chunk = this.getOrCreateChunk(chunkGridPosition, chunkDataSize);
    if (data.length !== chunk.data.length) {
      throw new Error(
        `LocalPatchSource.writeFullChunk: data length ${data.length} does not ` +
          `match chunk volume ${chunk.data.length} for chunkDataSize ` +
          `${Array.prototype.join.call(chunkDataSize, ",")}.`,
      );
    }
    chunk.data.set(data);
    chunk.dirty = true;
    this.dirtyKeys.add(chunkGridKey(chunkGridPosition));
  }

  /** Write a single voxel into the appropriate patch chunk. */
  writeVoxel(
    chunkGridPosition: ArrayLike<number>,
    chunkDataSize: ArrayLike<number>,
    localX: number,
    localY: number,
    localZ: number,
    value: bigint,
  ): boolean {
    const chunk = this.getOrCreateChunk(chunkGridPosition, chunkDataSize);
    const changed = chunk.writeVoxel(localX, localY, localZ, value);
    if (changed) {
      this.dirtyKeys.add(chunkGridKey(chunkGridPosition));
    }
    return changed;
  }

  /** Read a patched voxel value (0n = no patch at that position). */
  getVoxel(
    chunkGridPosition: ArrayLike<number>,
    localX: number,
    localY: number,
    localZ: number,
  ): bigint {
    const chunk = this.getChunk(chunkGridPosition);
    if (chunk === undefined) return 0n;
    return chunk.getVoxel(localX, localY, localZ);
  }

  /** Remove a single patch chunk (caller is responsible for any GPU cleanup). */
  clearChunk(key: ChunkKey): boolean {
    return this.chunks.delete(key);
  }

  /** Drop all patches. */
  clearAll(): void {
    this.chunks.clear();
    this.dirtyKeys.clear();
  }

  /** Mark all dirty keys consumed (called by render layer after GPU upload). */
  consumeDirtyKeys(): IterableIterator<ChunkKey> {
    const keys = new Set(this.dirtyKeys);
    this.dirtyKeys.clear();
    return keys.values();
  }
}
