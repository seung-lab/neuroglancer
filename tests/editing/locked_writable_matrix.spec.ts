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
 * Locked / writable layer matrix (TM-331, phase 1).
 *
 * The edit-session "writable vs locked" axis — and especially *varying counts*
 * of each — drives three distinct consumer-side seams. This file sweeps the
 * counts through all three in fast Vitest (no app / GPU / `gs://`):
 *
 *   1. `NgSessionLockAdapter` — opening a session data-source-locks EVERY
 *      session layer (writable AND locked; `edit_session_host.ts:985`), so
 *      `isLayerDataSourceLocked` is set membership regardless of writability.
 *   2. `SaveTracker` — initial per-layer status derivation: writable ⇒ pending,
 *      locked ⇒ skipped("read-only; not saved"); and the save flow only marks /
 *      reports writable layers (incl. the TM-352 unconfirmed-save path).
 *   3. `NgSaveTarget` — `computeOverall` aggregation scales with the number of
 *      (writable) layers in the payload: all-succeeded / partial / all-failed.
 *
 * Only writable layers ever reach a `SavePayload` (the library filters locked
 * layers out upstream), so seam 3 is parametrized over writable counts; seams
 * 1–2 mix both kinds to assert locked layers are handled but never saved.
 */

import type {
  ChunkContentRef,
  EditSession,
  LayerId,
  LayerMetadata,
  ReadonlyChunkVoxelBuffer,
  SaveLayerOutcome,
  SavePayload,
  SaveResult,
  SavedChunk,
} from "@zettaai/edit-session";
import {
  Resolution,
  layerId,
  sessionError,
  sessionId,
} from "@zettaai/edit-session";
import { describe, it, expect, afterEach } from "vitest";

import type { NgLayerMetadataSource } from "#src/editing/adapters/ng_layer_metadata_source.js";
import { NgSaveTarget } from "#src/editing/adapters/ng_save_target.js";
import { NgSessionLockAdapter } from "#src/editing/adapters/ng_session_lock.js";
import type {
  SaveBackend,
  SaveBackendResult,
} from "#src/editing/adapters/save_backend.js";
import {
  registerSaveBackend,
  unregisterSaveBackend,
} from "#src/editing/adapters/save_backend.js";
import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { SaveTracker } from "#src/editing/ui/session_controls/save_tracker.js";

import { FakeLayerManager } from "#tests/editing/fixtures/fake_layer_manager.js";
import { FakeLogger } from "#tests/editing/fixtures/fake_logger.js";

const RESOLUTION = Resolution.from([8, 8, 40]);

/** `[writableCount, lockedCount]` combinations to sweep (incl. 0-writable). */
const COMBOS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [1, 1],
  [2, 1],
  [3, 2],
  [0, 2],
];

interface SessionLayer {
  readonly id: string;
  readonly writable: boolean;
}

function makeLayers(writable: number, locked: number): SessionLayer[] {
  const out: SessionLayer[] = [];
  for (let i = 0; i < writable; i++)
    out.push({ id: `W${i + 1}`, writable: true });
  for (let i = 0; i < locked; i++)
    out.push({ id: `K${i + 1}`, writable: false });
  return out;
}

// ---------------------------------------------------------------------------
// Seam 1 — data-source locking covers every session layer
// ---------------------------------------------------------------------------

describe("locked/writable — NgSessionLockAdapter data-source locking", () => {
  for (const [writable, locked] of COMBOS) {
    it(`${writable} writable + ${locked} locked: all session layers lock, outsiders don't`, () => {
      const layers = makeLayers(writable, locked);
      const adapter = new NgSessionLockAdapter();
      adapter.setActiveSession({
        sessionId: sessionId("s"),
        sessionLayerIds: new Set(layers.map((l) => layerId(l.id))),
      });

      // Writable AND locked session layers are data-source-locked.
      for (const l of layers) {
        expect(adapter.isLayerDataSourceLocked(layerId(l.id))).toBe(true);
      }
      // A layer outside the session is never locked.
      expect(adapter.isLayerDataSourceLocked(layerId("OUTSIDER"))).toBe(false);

      // Clearing the session releases every layer.
      adapter.clearActiveSession();
      for (const l of layers) {
        expect(adapter.isLayerDataSourceLocked(layerId(l.id))).toBe(false);
      }
    });
  }

  it("acquire is a mutex: a second acquire throws until the first releases", async () => {
    const adapter = new NgSessionLockAdapter();
    const lock = await adapter.acquire(sessionId("s1"));
    await expect(adapter.acquire(sessionId("s2"))).rejects.toThrow(
      /another session/,
    );
    lock.release();
    const lock2 = await adapter.acquire(sessionId("s2")); // now free
    lock2.release();
  });
});

// ---------------------------------------------------------------------------
// Seam 2 — SaveTracker: per-layer status + save flow across counts
// ---------------------------------------------------------------------------

function fakeHost(
  layers: readonly SessionLayer[],
  saveResult: SaveResult = { overall: "all-succeeded", outcomes: [] },
  unconfirmed = false,
): EditSessionHost {
  return {
    state: {
      value: {
        value: {
          layers: layers.map((l) => ({
            layerId: layerId(l.id),
            writable: l.writable,
          })),
        },
      },
    },
    saveActive: async () => saveResult,
    hasUnconfirmedSaves: () => unconfirmed,
    cancelActiveSave: () => {},
  } as unknown as EditSessionHost;
}

function fakeSession(
  layers: readonly SessionLayer[],
  dirty = true,
): EditSession {
  return {
    config: { layers: layers.map((l) => ({ layerId: layerId(l.id) })) },
    dirty: { isDirty: () => dirty },
  } as unknown as EditSession;
}

function succeeded(id: string): SaveLayerOutcome {
  return { layerId: layerId(id), status: "succeeded" };
}

function failed(id: string, message = "boom"): SaveLayerOutcome {
  return {
    layerId: layerId(id),
    status: "failed",
    error: sessionError({
      kind: "recoverable",
      code: "save-failed",
      message,
      at: 0,
    }),
  };
}

describe("locked/writable — SaveTracker initial status derivation", () => {
  for (const [writable, locked] of COMBOS) {
    it(`${writable} writable + ${locked} locked → ${writable} pending, ${locked} skipped`, () => {
      const layers = makeLayers(writable, locked);
      const tracker = new SaveTracker(fakeHost(layers), fakeSession(layers));
      const statuses = [...tracker.layerStatuses.values()];

      expect(statuses).toHaveLength(writable + locked);
      expect(
        statuses.filter((s) => s.writable && s.status === "pending"),
      ).toHaveLength(writable);
      expect(
        statuses.filter((s) => !s.writable && s.status === "skipped"),
      ).toHaveLength(locked);
      tracker.dispose();
    });
  }
});

describe("locked/writable — SaveTracker save flow", () => {
  it("success: writable layers succeed, locked stay skipped, state done-success", async () => {
    const layers = makeLayers(2, 1);
    const result: SaveResult = {
      overall: "all-succeeded",
      outcomes: [succeeded("W1"), succeeded("W2")],
    };
    const host = fakeHost(layers, result);
    const session = fakeSession(layers);
    const tracker = new SaveTracker(host, session);

    await tracker.startSave(host, session);

    expect(tracker.state.kind).toBe("done-success");
    expect(tracker.layerStatuses.get("W1")?.status).toBe("succeeded");
    expect(tracker.layerStatuses.get("W2")?.status).toBe("succeeded");
    // The locked layer is never in the save payload, so it stays skipped.
    expect(tracker.layerStatuses.get("K1")?.status).toBe("skipped");
    tracker.dispose();
  });

  it("partial: failed writable layers are listed and named by count", async () => {
    const layers = makeLayers(3, 1);
    const result: SaveResult = {
      overall: "partial",
      outcomes: [succeeded("W1"), failed("W2"), failed("W3")],
    };
    const host = fakeHost(layers, result);
    const session = fakeSession(layers);
    const tracker = new SaveTracker(host, session);

    await tracker.startSave(host, session);

    expect(tracker.state.kind).toBe("done-partial");
    if (tracker.state.kind === "done-partial") {
      expect([...tracker.state.failedLayers].sort()).toEqual(["W2", "W3"]);
    }
    expect(tracker.layerStatuses.get("W1")?.status).toBe("succeeded");
    expect(tracker.layerStatuses.get("W2")?.status).toBe("failed");
    expect(tracker.lastFailureMessage()).toMatch(
      /Couldn't save 2 layers \(W2, W3\)/,
    );
    tracker.dispose();
  });

  it("no-op when the session is not dirty", async () => {
    const layers = makeLayers(1, 0);
    const host = fakeHost(layers);
    const session = fakeSession(layers, /* dirty */ false);
    const tracker = new SaveTracker(host, session);

    await tracker.startSave(host, session);

    expect(tracker.state.kind).toBe("idle");
    tracker.dispose();
  });

  it("unconfirmed saves surface a persistent failure even on all-succeeded (TM-352)", async () => {
    const layers = makeLayers(1, 0);
    const result: SaveResult = {
      overall: "all-succeeded",
      outcomes: [succeeded("W1")],
    };
    const host = fakeHost(layers, result, /* unconfirmed */ true);
    const session = fakeSession(layers);
    const tracker = new SaveTracker(host, session);

    await tracker.startSave(host, session);

    // Write acked but read-back NOT confirmed ⇒ not a green "saved".
    expect(tracker.state.kind).toBe("done-partial");
    tracker.dispose();
  });
});

// ---------------------------------------------------------------------------
// Seam 3 — NgSaveTarget aggregation scales with writable-layer count
// ---------------------------------------------------------------------------

function fakeContentRef(): ChunkContentRef {
  return {
    hash: "abc",
    byteLength: 4,
    async retain(): Promise<ReadonlyChunkVoxelBuffer> {
      const view = new Uint8Array(4);
      return { byteLength: 4, asView: () => view };
    },
  };
}

function chunk(name: string): SavedChunk {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  return {
    layerId: layerId(name),
    resolution: RESOLUTION,
    chunkId: "0,0,0",
    chunkCoord: { x: 0, y: 0, z: 0 },
    contentRef: fakeContentRef(),
    bytes: { byteLength: bytes.byteLength, asView: () => bytes },
  };
}

function payload(names: readonly string[]): SavePayload {
  return {
    sessionId: sessionId("test-session"),
    savedAt: 0,
    layerIds: names.map((n) => layerId(n)),
    chunks: names.map((n) => chunk(n)),
  };
}

function fakeMetadataSource(): NgLayerMetadataSource {
  return {
    async resolve(id: LayerId): Promise<LayerMetadata> {
      return {
        layerId: id,
        voxelDataType: "uint64",
        channels: 1,
        scales: [
          {
            resolution: RESOLUTION,
            voxelSizeNm: [8, 8, 40],
            voxelOffset: [0, 0, 0],
            sizeVoxels: [64, 64, 64],
            chunkDataSize: [64, 64, 64],
          },
        ],
      };
    },
  } as unknown as NgLayerMetadataSource;
}

const OK_SCHEME = "lwm-ok";
const BAD_SCHEME = "lwm-bad";

const okBackend: SaveBackend = {
  async saveLayer(id): Promise<SaveBackendResult> {
    return { status: "succeeded", layerId: id, chunkCount: 1 };
  },
};
const badBackend: SaveBackend = {
  async saveLayer(id): Promise<SaveBackendResult> {
    return { status: "failed", layerId: id, error: "boom" };
  },
};

describe("locked/writable — NgSaveTarget aggregation across counts", () => {
  afterEach(() => {
    unregisterSaveBackend(OK_SCHEME);
    unregisterSaveBackend(BAD_SCHEME);
  });

  function targetFor(
    layers: ReadonlyArray<{ name: string; canonicalUrl: string }>,
  ): NgSaveTarget {
    return new NgSaveTarget(
      new FakeLayerManager(layers).asLayerManager(),
      fakeMetadataSource(),
      new FakeLogger().asNgLogger(),
    );
  }

  for (const n of [1, 3, 5]) {
    it(`${n} writable layers all succeed → all-succeeded with ${n} outcomes`, async () => {
      registerSaveBackend(OK_SCHEME, okBackend);
      const names = Array.from({ length: n }, (_, i) => `L${i + 1}`);
      const result = await targetFor(
        names.map((name) => ({ name, canonicalUrl: `${OK_SCHEME}://x` })),
      ).save(payload(names));
      expect(result.overall).toBe("all-succeeded");
      expect(result.outcomes).toHaveLength(n);
    });
  }

  it("mixed success/fail across 4 layers → partial (2 failed)", async () => {
    registerSaveBackend(OK_SCHEME, okBackend);
    registerSaveBackend(BAD_SCHEME, badBackend);
    const names = ["L1", "L2", "L3", "L4"];
    const result = await targetFor([
      { name: "L1", canonicalUrl: `${OK_SCHEME}://x` },
      { name: "L2", canonicalUrl: `${BAD_SCHEME}://x` },
      { name: "L3", canonicalUrl: `${OK_SCHEME}://x` },
      { name: "L4", canonicalUrl: `${BAD_SCHEME}://x` },
    ]).save(payload(names));
    expect(result.overall).toBe("partial");
    expect(result.outcomes.filter((o) => o.status === "failed")).toHaveLength(
      2,
    );
  });

  it("all writable layers fail → all-failed", async () => {
    registerSaveBackend(BAD_SCHEME, badBackend);
    const names = ["L1", "L2", "L3"];
    const result = await targetFor(
      names.map((name) => ({ name, canonicalUrl: `${BAD_SCHEME}://x` })),
    ).save(payload(names));
    expect(result.overall).toBe("all-failed");
    expect(result.outcomes).toHaveLength(3);
  });
});
