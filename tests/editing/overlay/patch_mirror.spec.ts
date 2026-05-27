/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type {
  EditSession,
  LayerMetadata,
  OverlayCoord,
  ReadonlyChunkVoxelBuffer,
  ViewBaseline,
} from "@zetta-ai/edit-session";
import { Resolution, layerId, sessionId } from "@zetta-ai/edit-session";

import { PatchMirror } from "#src/editing/overlay/patch_mirror.js";
import { LocalPatchStore } from "#src/editing/local_patch_store.js";

import { FakeLogger } from "#tests/editing/fixtures/fake_logger.js";

const TARGET_LAYER = layerId("L1");
const RES = Resolution.from([8, 8, 40]);
const CHUNK_SIZE: readonly [number, number, number] = [4, 4, 4];

type DirtyHandler = (payload: { coord: OverlayCoord }) => void;

interface FakeSessionState {
  emitChunkChanged: (coord: OverlayCoord) => void;
  /**
   * Map from `OverlayKey` to the bytes that `overlay.read()` should resolve to.
   */
  readonly overlayBytes: Map<string, BigUint64Array>;
  readonly readCalls: Array<{ key: string }>;
}

function overlayKey(coord: OverlayCoord): string {
  return `${coord.layerId}|${coord.resolution}|${coord.chunkId}`;
}

function buildFakeSession(): {
  session: EditSession;
  state: FakeSessionState;
} {
  const handlers: DirtyHandler[] = [];
  const overlayBytes = new Map<string, BigUint64Array>();
  const readCalls: { key: string }[] = [];

  const baseline: ViewBaseline = {
    sessionId: sessionId("test-session"),
    capturedAt: 0,
    perLayer: new Map([
      [
        TARGET_LAYER,
        {
          layerId: TARGET_LAYER,
          metadata: {
            layerId: TARGET_LAYER,
            voxelDataType: "uint64",
            channels: 1,
            scales: [
              {
                resolution: RES,
                voxelSizeNm: [8, 8, 40],
                voxelOffset: [0, 0, 0],
                sizeVoxels: [1024, 1024, 1024],
                chunkDataSize: CHUNK_SIZE,
              },
            ],
          } satisfies LayerMetadata,
          selectedResolutions: [RES],
          chunkGridShapeByResolution: new Map(),
          pinnedChunksByResolution: new Map(),
        },
      ],
    ]),
  };

  const dirty = {
    on(event: string, handler: DirtyHandler) {
      if (event !== "chunk-changed") return () => {};
      handlers.push(handler);
      return () => {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      };
    },
  };

  const overlay = {
    async read(coord: OverlayCoord): Promise<ReadonlyChunkVoxelBuffer> {
      const key = overlayKey(coord);
      readCalls.push({ key });
      const bytes = overlayBytes.get(key);
      if (bytes === undefined) {
        throw new Error(`no overlay bytes for ${key}`);
      }
      return { byteLength: bytes.byteLength, asView: () => bytes };
    },
  };

  const session = {
    baseline,
    dirty,
    overlay,
  } as unknown as EditSession;

  const state: FakeSessionState = {
    emitChunkChanged(coord) {
      for (const h of handlers) h({ coord });
    },
    overlayBytes,
    readCalls,
  };

  return { session, state };
}

async function flushMicrotasks(): Promise<void> {
  // Multiple ticks: PatchMirror.syncChunk awaits a read; LocalPatchStore.writeFullChunk
  // schedules an rAF; we don't need the rAF to fire for the patch to be observable
  // since `writeFullChunk` mutates source synchronously.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("PatchMirror", () => {
  let store: LocalPatchStore;
  let logger: FakeLogger;
  let mirror: PatchMirror | undefined;

  beforeEach(() => {
    store = new LocalPatchStore();
    logger = new FakeLogger();
  });

  afterEach(() => {
    mirror?.dispose();
    mirror = undefined;
    store.dispose();
  });

  it("ignores chunk-changed events for other layers", async () => {
    const { session, state } = buildFakeSession();
    mirror = new PatchMirror(session, TARGET_LAYER, store, logger.asNgLogger());

    state.emitChunkChanged({
      layerId: layerId("OTHER"),
      resolution: RES,
      chunkId: "0,0,0",
    });
    await flushMicrotasks();
    expect(state.readCalls).toHaveLength(0);
    expect(store.countPatchedVoxels()).toBe(0);
  });

  it("propagates a chunk-changed event into LocalPatchStore.writeFullChunk", async () => {
    const { session, state } = buildFakeSession();
    mirror = new PatchMirror(session, TARGET_LAYER, store, logger.asNgLogger());

    // Provide overlay bytes for chunk (0,0,0): 4*4*4 = 64 voxels.
    const bytes = new BigUint64Array(64);
    bytes[0] = 7n;
    bytes[63] = 42n;
    const coord: OverlayCoord = {
      layerId: TARGET_LAYER,
      resolution: RES,
      chunkId: "0,0,0",
    };
    state.overlayBytes.set(overlayKey(coord), bytes);

    state.emitChunkChanged(coord);
    await flushMicrotasks();

    expect(state.readCalls).toHaveLength(1);
    // The store records (0,0,0) as patched.
    expect(store.source.chunks.size).toBe(1);
    const chunk = store.source.getChunk([0, 0, 0])!;
    expect(chunk).toBeDefined();
    expect(chunk.data[0]).toBe(7n);
    expect(chunk.data[63]).toBe(42n);
  });

  it("logs an error if overlay.read fails for a chunk", async () => {
    const { session, state } = buildFakeSession();
    mirror = new PatchMirror(session, TARGET_LAYER, store, logger.asNgLogger());

    // No overlay bytes registered — the fake's read() rejects.
    state.emitChunkChanged({
      layerId: TARGET_LAYER,
      resolution: RES,
      chunkId: "5,5,5",
    });
    await flushMicrotasks();
    expect(
      logger.logs.some(
        (l) => l.level === "error" && /PatchMirror sync failed/.test(l.message),
      ),
    ).toBe(true);
    expect(store.countPatchedVoxels()).toBe(0);
  });

  it("dispose unsubscribes from chunk-changed", async () => {
    const { session, state } = buildFakeSession();
    mirror = new PatchMirror(session, TARGET_LAYER, store, logger.asNgLogger());
    mirror.dispose();
    mirror = undefined;
    state.emitChunkChanged({
      layerId: TARGET_LAYER,
      resolution: RES,
      chunkId: "0,0,0",
    });
    await flushMicrotasks();
    expect(state.readCalls).toHaveLength(0);
  });
});
