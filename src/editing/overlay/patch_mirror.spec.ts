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
} from "@zettaai/edit-session";
import {
  ChunkId as ChunkIdFactory,
  Resolution as ResolutionCtor,
} from "@zettaai/edit-session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NgLogger } from "#src/editing/adapters/ng_logger.js";
import {
  chunkGridKey,
  LocalPatchSource,
} from "#src/editing/local_patch_source.js";
import type { LocalPatchStore } from "#src/editing/local_patch_store.js";
import { notePaintedSubBox } from "#src/editing/overlay/painted_subbox_registry.js";
import { PatchMirror } from "#src/editing/overlay/patch_mirror.js";

const LAYER = "label-scratch" as LayerId;
const RES = ResolutionCtor.from([16, 16, 45]);
const CHUNK_ID = ChunkIdFactory.fromCoord({ x: 0, y: 0, z: 0 });
const COORD: OverlayCoord = {
  layerId: LAYER,
  resolution: RES,
  chunkId: CHUNK_ID,
};
/** 2x2x1 chunk keeps the fixtures readable; the logic is size-agnostic. */
const CHUNK_DATA_SIZE = [2, 2, 1] as const;
const VOLUME = 4;
const GRID_POSITION = new Float32Array([0, 0, 0]);

function buffer(bytes: Uint8Array): ReadonlyChunkVoxelBuffer {
  return {
    byteLength: bytes.byteLength,
    asView: () => bytes,
  } as unknown as ReadonlyChunkVoxelBuffer;
}

/** Voxel values the mirror currently holds, as plain numbers. */
function mirroredValues(source: LocalPatchSource): number[] {
  const chunk = source.chunks.get(chunkGridKey(GRID_POSITION));
  if (chunk === undefined) return [];
  return Array.from(chunk.data, (v) => Number(v));
}

function mirroredMask(source: LocalPatchSource): number[] {
  const chunk = source.chunks.get(chunkGridKey(GRID_POSITION));
  if (chunk === undefined) return [];
  return Array.from(chunk.patched);
}

interface Harness {
  mirror: PatchMirror;
  source: LocalPatchSource;
  /** Simulate a paint commit: leave the sub-box hint, then fire the event. */
  commit: (hint?: { x0: number; y0: number; x1: number; y1: number }) => void;
  setOverlay: (bytes: number[]) => void;
  /** Make the next `n` baseline reads reject, as a stalled fetch would. */
  failBaselineReads: (n: number) => void;
  errors: string[];
  baselineReadCount: () => number;
  dispose: () => void;
}

function makeHarness(): Harness {
  const handlers: ((payload: { coord: OverlayCoord }) => void)[] = [];
  let overlay = new Uint8Array(VOLUME);
  const baseline = new Uint8Array(VOLUME);
  let failuresRemaining = 0;
  let baselineReads = 0;
  const errors: string[] = [];

  const session = {
    dirty: {
      on: (_event: string, cb: (payload: { coord: OverlayCoord }) => void) => {
        handlers.push(cb);
        return () => {
          const i = handlers.indexOf(cb);
          if (i >= 0) handlers.splice(i, 1);
        };
      },
    },
    overlay: {
      read: async () => buffer(overlay),
    },
    baseline: {
      perLayer: new Map([
        [
          LAYER,
          {
            metadata: {
              scales: [{ resolution: RES, chunkDataSize: CHUNK_DATA_SIZE }],
            },
          },
        ],
      ]),
    },
  } as unknown as EditSession;

  const source = new LocalPatchSource();
  const store = {
    source,
    noteChunkMutated: () => {},
  } as unknown as LocalPatchStore;

  const logger = {
    error: (_channel: string, message: string) => {
      errors.push(message);
    },
    info: () => {},
    debug: () => {},
    warn: () => {},
  } as unknown as NgLogger;

  const readBaseline = async () => {
    baselineReads++;
    if (failuresRemaining > 0) {
      failuresRemaining--;
      throw new Error("baseline fetch failed");
    }
    return buffer(baseline);
  };

  const mirror = new PatchMirror(session, LAYER, store, logger, readBaseline);

  return {
    mirror,
    source,
    commit: (hint) => {
      if (hint !== undefined) {
        notePaintedSubBox(LAYER, RES, CHUNK_ID, {
          x0: hint.x0,
          y0: hint.y0,
          z0: 0,
          x1: hint.x1,
          y1: hint.y1,
          z1: 0,
        });
      }
      for (const h of handlers) h({ coord: COORD });
    },
    setOverlay: (bytes) => {
      overlay = Uint8Array.from(bytes);
    },
    failBaselineReads: (n) => {
      failuresRemaining = n;
    },
    errors,
    baselineReadCount: () => baselineReads,
    dispose: () => {
      mirror.dispose();
      source.dispose();
    },
  };
}

describe("PatchMirror chunk resync", () => {
  let harness: Harness;

  beforeEach(() => {
    vi.useFakeTimers();
    harness = makeHarness();
  });

  afterEach(() => {
    harness.dispose();
    vi.useRealTimers();
  });

  it("recovers voxels stranded by a failed sync on the next commit", async () => {
    // First stroke paints voxel 0, but its baseline read fails: nothing is
    // mirrored, and the sub-box hint for that commit is already consumed.
    harness.setOverlay([1, 0, 0, 0]);
    harness.failBaselineReads(1);
    harness.commit({ x0: 0, y0: 0, x1: 0, y1: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.errors.length).toBeGreaterThan(0);
    expect(mirroredValues(harness.source)).toEqual([]);

    // Second stroke paints voxel 3 and succeeds. Its hint covers voxel 3 only;
    // a bounded fuse would mirror voxel 3 and leave voxel 0 invisible for the
    // rest of the session — the reported "painting in this chunk never shows".
    harness.setOverlay([1, 0, 0, 1]);
    harness.commit({ x0: 1, y0: 1, x1: 1, y1: 1 });
    await vi.advanceTimersByTimeAsync(0);

    expect(mirroredValues(harness.source)).toEqual([1, 0, 0, 1]);
    expect(mirroredMask(harness.source)).toEqual([1, 0, 0, 1]);
  });

  it("retries a failed chunk on its own, without another commit", async () => {
    harness.setOverlay([1, 0, 0, 0]);
    harness.failBaselineReads(1);
    harness.commit({ x0: 0, y0: 0, x1: 0, y1: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(mirroredValues(harness.source)).toEqual([]);

    // No further paint: the backoff retry alone repairs the chunk.
    await vi.advanceTimersByTimeAsync(100);

    expect(mirroredValues(harness.source)).toEqual([1, 0, 0, 0]);
    expect(mirroredMask(harness.source)).toEqual([1, 0, 0, 0]);
  });

  it("gives up after exhausting retries but repairs on a later commit", async () => {
    harness.setOverlay([1, 0, 0, 0]);
    harness.failBaselineReads(99);
    harness.commit({ x0: 0, y0: 0, x1: 0, y1: 0 });
    await vi.advanceTimersByTimeAsync(5000);

    expect(
      harness.errors.some((m) => m.includes("no longer retrying chunk")),
    ).toBe(true);
    const readsAfterGivingUp = harness.baselineReadCount();

    // Reads recover; the next commit still rescans the whole chunk.
    harness.failBaselineReads(0);
    harness.setOverlay([1, 0, 0, 1]);
    harness.commit({ x0: 1, y0: 1, x1: 1, y1: 1 });
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.baselineReadCount()).toBeGreaterThan(readsAfterGivingUp);
    expect(mirroredValues(harness.source)).toEqual([1, 0, 0, 1]);
  });

  it("rescans in full when a commit lands while a sync is in flight", async () => {
    // First commit is in flight (its reads are pending) when a second commit
    // for the same chunk arrives; the in-flight fuse may not observe it.
    harness.setOverlay([1, 0, 0, 0]);
    harness.commit({ x0: 0, y0: 0, x1: 0, y1: 0 });
    harness.setOverlay([1, 0, 0, 1]);
    harness.commit({ x0: 1, y0: 1, x1: 1, y1: 1 });
    await vi.advanceTimersByTimeAsync(0);

    expect(mirroredValues(harness.source)).toEqual([1, 0, 0, 1]);
    expect(mirroredMask(harness.source)).toEqual([1, 0, 0, 1]);
  });

  it("keeps mirroring a healthy chunk with bounded scans", async () => {
    harness.setOverlay([5, 0, 0, 0]);
    harness.commit({ x0: 0, y0: 0, x1: 0, y1: 0 });
    await vi.advanceTimersByTimeAsync(0);

    expect(mirroredValues(harness.source)).toEqual([5, 0, 0, 0]);
    expect(harness.errors).toEqual([]);
  });
});
