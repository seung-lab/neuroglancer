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

import { NullarySignal } from "#src/util/signal.js";

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
  /**
   * Dispatched whenever the committed-chunk store is mutated (accept,
   * clearLayer, clearAll). The "Pending Changes" panel subscribes to this
   * to refresh its layer list + chunk counts.
   */
  readonly changed = new NullarySignal();

  get accepted(): ReadonlyMap<string, CommittedChunk> {
    return this.store;
  }

  /**
   * Lookup a specific committed chunk. Used by `NgChunkSource` to merge
   * in-memory commits into baseline reads for subsequent sessions.
   */
  getChunk(
    layerId: LayerId,
    resolution: string,
    chunkId: string,
  ): CommittedChunk | undefined {
    return this.store.get(commitKey(layerId, resolution, chunkId));
  }

  /** Number of committed chunks for the given layer. */
  countLayerChunks(layerId: LayerId): number {
    const prefix = `${layerId}|`;
    let count = 0;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) count += 1;
    }
    return count;
  }

  /** All layer ids that currently have committed chunks. */
  pendingLayerIds(): readonly LayerId[] {
    const seen = new Set<LayerId>();
    for (const chunk of this.store.values()) {
      seen.add(chunk.layerId);
    }
    return [...seen];
  }

  /** All committed chunks for the given layer. */
  layerChunks(layerId: LayerId): readonly CommittedChunk[] {
    const out: CommittedChunk[] = [];
    const prefix = `${layerId}|`;
    for (const [key, chunk] of this.store) {
      if (key.startsWith(prefix)) out.push(chunk);
    }
    return out;
  }

  async accept(
    payload: CommitPayload,
    _signal?: AbortSignal,
  ): Promise<CommitResult> {
    let mutated = false;
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
      mutated = true;
    }
    if (mutated) this.changed.dispatch();
    return { status: "accepted" };
  }

  /** Remove every accepted chunk for the given layer. */
  clearLayer(layerId: LayerId): void {
    const prefix = `${layerId}|`;
    let mutated = false;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        mutated = true;
      }
    }
    if (mutated) this.changed.dispatch();
  }

  /** Remove every accepted chunk. */
  clearAll(): void {
    if (this.store.size === 0) return;
    this.store.clear();
    this.changed.dispatch();
  }
}
