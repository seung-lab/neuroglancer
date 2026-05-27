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
  ChunkVoxelBuffer,
  CommitPayload,
  CommitResult,
  CommittedChunk,
  CommitTarget,
  LayerId,
  ReadonlyChunkVoxelBuffer,
} from "@zetta-ai/edit-session";

/**
 * Build the composite key used by `NgCommitTarget.accepted`. Mirrors the
 * library's `OverlayKey` shape but is local to the adapter so we don't
 * couple the host to an internal library encoding.
 */
function commitKey(
  layerId: LayerId,
  resolution: string,
  chunkId: string,
): string {
  return `${layerId}|${resolution}|${chunkId}`;
}

/**
 * Copy the bytes of `source` into a new typed array of the same kind. The
 * library hands us a `ReadonlyChunkVoxelBuffer` whose backing `asView()`
 * buffer may belong to the overlay store; we must not retain a reference
 * to it (see contract in `commit.target.ts:6-10`).
 */
function copyBytes(source: ReadonlyChunkVoxelBuffer): ChunkVoxelBuffer {
  const view = source.asView();
  // `slice()` is defined on every typed-array variant and returns a fresh
  // typed array of the same concrete type with copied contents.
  return (view as unknown as { slice(): ChunkVoxelBuffer }).slice();
}

/**
 * In-memory `CommitTarget` that accumulates the most recently committed
 * chunk for every `(layerId, resolution, chunkId)` triple in the session.
 * Backing storage for the eventual save: `NgSaveTarget` (and the host) reads
 * `accepted` to build the `SavePayload`. v1 never rejects.
 */
export class NgCommitTarget implements CommitTarget {
  private readonly store = new Map<string, CommittedChunk>();

  get accepted(): ReadonlyMap<string, CommittedChunk> {
    return this.store;
  }

  async accept(
    payload: CommitPayload,
    _signal?: AbortSignal,
  ): Promise<CommitResult> {
    for (const chunk of payload.chunks) {
      const copiedView = copyBytes(chunk.bytes);
      const byteLength = copiedView.byteLength;
      const detachedBytes: ReadonlyChunkVoxelBuffer = {
        byteLength,
        asView: () => copiedView,
      };
      const detached: CommittedChunk = {
        layerId: chunk.layerId,
        resolution: chunk.resolution,
        chunkId: chunk.chunkId,
        chunkCoord: chunk.chunkCoord,
        contentRef: chunk.contentRef,
        bytes: detachedBytes,
      };
      this.store.set(
        commitKey(chunk.layerId, chunk.resolution, chunk.chunkId),
        detached,
      );
    }
    return { status: "accepted" };
  }

  /** Remove every accepted chunk for the given layer. Used on session close. */
  clearLayer(layerId: LayerId): void {
    const prefix = `${layerId}|`;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  /** Remove every accepted chunk. Used on host disposal. */
  clearAll(): void {
    this.store.clear();
  }
}
