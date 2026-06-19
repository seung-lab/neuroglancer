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
  LayerId,
  OverlayCoord,
  Resolution,
} from "@zettaai/edit-session";
import { ChunkId as ChunkIdFactory } from "@zettaai/edit-session";

import {
  chunkKeyForSource,
  groupByLayerAndResolution,
  makeChunkGridPosition,
} from "#src/editing/adapters/ng_chunk_grid.js";
import type { VolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import { WatchableValue } from "#src/trackable_value.js";

/** One `(layerId, resolution)` group that failed to (fully) preload. */
export interface ChunkLoadFailure {
  readonly layerId: LayerId;
  readonly resolution: Resolution;
  readonly count: number;
}

/**
 * Progress of the background preload of all session-bbox chunks.
 *
 * - `idle`: no session / preload not running (also the reset state).
 * - `loading`: chunks are being fetched in the background; painting is allowed.
 * - `done`: every chunk has been fetched (or counted as a valid zero baseline);
 *   `failed > 0` with non-empty `failures` indicates genuinely unavailable
 *   chunks — painting still works (they zero-fill lazily on first read).
 */
export type ChunkLoadProgressState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "loading";
      readonly loaded: number;
      readonly total: number;
      readonly failed: number;
    }
  | {
      readonly kind: "done";
      readonly total: number;
      readonly failed: number;
      readonly failures: readonly ChunkLoadFailure[];
    };

/** Resolves the neuroglancer volume chunk source for a `(layer, resolution)`. */
export type ResolveVolumeChunkSource = (
  layerId: LayerId,
  resolution: Resolution,
) => VolumeChunkSource;

interface PinnedChunkRecord {
  readonly source: VolumeChunkSource;
  readonly key: string;
}

interface PreloadItem {
  readonly source: VolumeChunkSource;
  readonly key: string;
  readonly gridPosition: Float32Array;
}

/**
 * Number of chunk fetches in flight at once. Matches the brush worker pool's
 * sizing so the preload shares the machine politely with rendering / painting.
 */
function poolSize(): number {
  const cores =
    typeof navigator !== "undefined" && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4;
  return Math.max(1, Math.min(8, cores - 1));
}

/** How often, at most, to publish a progress update while loading. */
const PROGRESS_THROTTLE_MS = 100;

/**
 * Proactively downloads and pins every chunk covering the edit-session bbox.
 *
 * Created once per session by `NgChunkSource.pinChunks`. Loading runs in the
 * background with bounded concurrency via `SliceViewChunkSource.fetchChunk`,
 * which awaits chunk arrival through the existing pipeline (no main-thread
 * block) and lets us mark each chunk permanent while it is resident in system
 * memory — no JS-side byte cloning. Painting is allowed immediately; reads that
 * race the preload simply await their own fetch as before.
 */
export class SessionChunkPreloader {
  readonly progress = new WatchableValue<ChunkLoadProgressState>({
    kind: "idle",
  });

  private pinned: PinnedChunkRecord[] = [];
  private loaded = 0;
  private failed = 0;
  private total = 0;
  private readonly failures: ChunkLoadFailure[] = [];
  private lastDispatch = 0;
  private released = false;

  constructor(private readonly resolveSource: ResolveVolumeChunkSource) {}

  /**
   * Begin preloading `coords` in the background. Does not block — the returned
   * promise resolves when the pool drains, but callers (pinChunks) need not
   * await it. Aborting `signal` stops dispatching new fetches.
   */
  async start(
    coords: readonly OverlayCoord[],
    signal: AbortSignal,
  ): Promise<void> {
    const items = this.buildWorkList(coords);
    this.total = items.length + this.failed;
    if (this.total === 0) {
      this.finish();
      return;
    }
    this.publishLoading(true);
    await runWithConcurrency(items, poolSize(), signal, (item) =>
      this.fetchOne(item, signal),
    );
    if (signal.aborted) return;
    this.finish();
  }

  /**
   * Release every pinned chunk and reset progress. Idempotent. Abort of the
   * in-flight pool is driven by the caller's AbortController.
   */
  release(): void {
    if (this.released) return;
    this.released = true;
    for (const { source, key } of this.pinned) {
      source.chunkManager.markChunkPermanent(source, key, false);
    }
    this.pinned.length = 0;
    this.progress.value = { kind: "idle" };
  }

  /**
   * Resolve sources per group and flatten into a per-chunk work list. A group
   * whose source cannot be resolved is recorded as failed (non-fatal) and its
   * chunks are skipped — those reads zero-fill lazily if ever painted.
   */
  private buildWorkList(coords: readonly OverlayCoord[]): PreloadItem[] {
    const items: PreloadItem[] = [];
    for (const group of groupByLayerAndResolution(coords)) {
      let source: VolumeChunkSource;
      try {
        source = this.resolveSource(group.layerId, group.resolution);
      } catch {
        this.failed += group.coords.length;
        this.failures.push({
          layerId: group.layerId,
          resolution: group.resolution,
          count: group.coords.length,
        });
        continue;
      }
      for (const coord of group.coords) {
        const chunkCoord: ChunkCoord = ChunkIdFactory.toCoord(coord.chunkId);
        const gridPosition = makeChunkGridPosition(source, chunkCoord);
        const key = chunkKeyForSource(source, chunkCoord);
        items.push({ source, key, gridPosition });
      }
    }
    return items;
  }

  private async fetchOne(
    item: PreloadItem,
    signal: AbortSignal,
  ): Promise<void> {
    const { source, key, gridPosition } = item;
    try {
      await source.fetchChunk(
        gridPosition,
        () => {
          // `transform` runs while the chunk is resident in system memory —
          // the correct (and only safe) moment to pin it. No byte cloning:
          // the data stays owned by the chunk manager.
          source.chunkManager.markChunkPermanent(source, key, true);
          this.pinned.push({ source, key });
        },
        { signal },
      );
      this.loaded += 1;
    } catch {
      if (signal.aborted) return;
      // Sparse data sources 404 chunks with no non-zero voxels; from the
      // editing layer's perspective an absent chunk is a valid all-zero
      // baseline (see NgChunkSource.readBaselineChunk). Count it as loaded so
      // the bar completes; the lazy read zero-fills it if painted.
      this.loaded += 1;
    }
    this.publishLoading(false);
  }

  private publishLoading(force: boolean): void {
    if (this.released) return;
    const now =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    if (!force && now - this.lastDispatch < PROGRESS_THROTTLE_MS) return;
    this.lastDispatch = now;
    this.progress.value = {
      kind: "loading",
      loaded: this.loaded,
      total: this.total,
      failed: this.failed,
    };
  }

  private finish(): void {
    if (this.released) return;
    this.progress.value = {
      kind: "done",
      total: this.total,
      failed: this.failed,
      failures: this.failures.slice(),
    };
  }
}

/**
 * Run `worker` over `items` with at most `limit` concurrent invocations.
 * Resolves once every item has settled (worker never rejects — callers handle
 * their own errors). Stops launching new work once `signal` is aborted.
 */
async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  signal: AbortSignal,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners: Promise<void>[] = [];
  const launch = async (): Promise<void> => {
    while (next < items.length && !signal.aborted) {
      const item = items[next++];
      await worker(item);
    }
  };
  const count = Math.min(limit, items.length);
  for (let i = 0; i < count; ++i) {
    runners.push(launch());
  }
  await Promise.all(runners);
}
