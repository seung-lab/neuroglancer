/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { Resolution, layerId } from "@zettaai/edit-session";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { NgSessionLockAdapter } from "#src/editing/adapters/ng_session_lock.js";
import {
  EditSessionHost,
  TrackableEditSessionIntent,
  type EditSessionIntent,
} from "#src/editing/edit_session_host.js";

import { createFakeViewer } from "#tests/editing/fakes/fake_viewer.js";

// The host module transitively imports `src/webgl/shader_lib.ts`, which reads
// `WebGL2RenderingContext.UNSIGNED_BYTE` etc. at module-eval time. Stub the
// global before the host module loads. `vi.hoisted` ensures this runs before
// every other static import in this file, regardless of where it appears.
vi.hoisted(() => {
  if (typeof (globalThis as any).WebGL2RenderingContext === "undefined") {
    // Only the numeric constants accessed at module-eval time matter; we
    // populate just enough to satisfy the lookups.
    (globalThis as any).WebGL2RenderingContext = {
      UNSIGNED_BYTE: 0x1401,
      BYTE: 0x1400,
      UNSIGNED_SHORT: 0x1403,
      SHORT: 0x1402,
      FLOAT: 0x1406,
      INT: 0x1404,
      UNSIGNED_INT: 0x1405,
    };
  }
});

const RES = Resolution.from([8, 8, 40]);

function sampleIntent(): EditSessionIntent {
  return {
    layers: [
      { layerId: layerId("L1"), resolutions: [RES], writable: true },
      { layerId: layerId("L2"), resolutions: [RES], writable: false },
    ],
    region: {
      lo: [0, 0, 0],
      hi: [16, 16, 16],
      // Canonical `CoordinateSpace` JSON: scale in metres, unit "m" — exactly
      // what `coordinateSpaceToJson` emits (8/8/40 nm).
      dimensions: { x: [8e-9, "m"], y: [8e-9, "m"], z: [4e-8, "m"] },
    },
  };
}

describe("EditSessionHost (no active session)", () => {
  let host: EditSessionHost;

  beforeEach(() => {
    host = new EditSessionHost(createFakeViewer());
  });

  afterEach(() => {
    host.dispose();
  });

  it("constructor wires all adapters and exposes the trackable state", () => {
    expect(host.logger).toBeDefined();
    expect(host.sessionLock).toBeInstanceOf(NgSessionLockAdapter);
    expect(host.layerMetadataSource).toBeDefined();
    expect(host.state).toBeInstanceOf(TrackableEditSessionIntent);
    expect(host.activeSession.value).toBeUndefined();
    expect(host.state.value.value).toBeNull();
  });

  it("tryRestoreFromState is a no-op when the persisted intent is null", async () => {
    expect(host.state.value.value).toBeNull();
    await host.tryRestoreFromState();
    expect(host.activeSession.value).toBeUndefined();
    expect(host.state.value.value).toBeNull();
  });

  it("discardActive is a no-op when no session is active", async () => {
    await expect(host.discardActive()).resolves.toBeUndefined();
    expect(host.activeSession.value).toBeUndefined();
  });

  it("commitActive rejects when no session is active", async () => {
    await expect(host.commitActive()).rejects.toThrow(/No active session/);
  });

  it("saveActive rejects when no session is active", async () => {
    await expect(host.saveActive()).rejects.toThrow(/No active session/);
  });

  it("cancelActiveSave is a no-op when no save is in flight", () => {
    expect(() => host.cancelActiveSave()).not.toThrow();
  });

  it("getActiveRegionWatchableForLayer returns a stable per-layer watchable", () => {
    const w1 = host.getActiveRegionWatchableForLayer("L1");
    const w1Again = host.getActiveRegionWatchableForLayer("L1");
    expect(w1Again).toBe(w1);
    expect(w1.value).toBeUndefined();

    const w2 = host.getActiveRegionWatchableForLayer("L2");
    expect(w2).not.toBe(w1);
  });

  it("getPatchStoreForLayer returns undefined when no session attached the layer", () => {
    expect(host.getPatchStoreForLayer(layerId("L1"))).toBeUndefined();
  });

  it("attachedPatchTextureCaches is empty when no session is active", () => {
    expect(host.attachedPatchTextureCaches.size).toBe(0);
  });

  it("ensureMaskReference is a no-op (no metadata fetch) with no active session", async () => {
    const resolve = vi.spyOn(host.layerMetadataSource, "resolve");
    await expect(
      host.ensureMaskReference(layerId("L1"), RES),
    ).resolves.toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("TrackableEditSessionIntent", () => {
  let trackable: TrackableEditSessionIntent;

  beforeEach(() => {
    trackable = new TrackableEditSessionIntent();
  });

  it("starts null and toJSON reflects that", () => {
    expect(trackable.value.value).toBeNull();
    expect(trackable.toJSON()).toBeNull();
  });

  it("toJSON / restoreState roundtrip a valid intent", () => {
    const intent = sampleIntent();
    trackable.value.value = intent;
    const json = trackable.toJSON();
    expect(json).toEqual(intent);

    const other = new TrackableEditSessionIntent();
    other.restoreState(json);
    expect(other.value.value).toEqual(intent);
  });

  it("restoreState(null) resets to null", () => {
    trackable.value.value = sampleIntent();
    trackable.restoreState(null);
    expect(trackable.value.value).toBeNull();
  });

  it("restoreState(invalid object) resets to null", () => {
    trackable.value.value = sampleIntent();
    // Missing required `layers`.
    trackable.restoreState({ foo: 1 });
    expect(trackable.value.value).toBeNull();
  });

  it("restoreState(invalid scalar) resets to null", () => {
    trackable.value.value = sampleIntent();
    trackable.restoreState(123);
    expect(trackable.value.value).toBeNull();
  });

  it("restoreState rejects invalid layer entries", () => {
    trackable.value.value = sampleIntent();
    const bad = {
      // writable must be a boolean
      layers: [{ layerId: "L1", resolution: RES, writable: "bogus" }],
      region: {
        lo: [0, 0, 0],
        hi: [1, 1, 1],
        dimensions: { x: [8, "nm"], y: [8, "nm"], z: [40, "nm"] },
      },
    };
    trackable.restoreState(bad);
    expect(trackable.value.value).toBeNull();
  });

  it("restoreState rejects invalid region shape", () => {
    trackable.value.value = sampleIntent();
    const bad = {
      layers: [],
      // `lo` must have three components.
      region: {
        lo: [0, 0],
        hi: [1, 1, 1],
        dimensions: { x: [8, "nm"], y: [8, "nm"], z: [40, "nm"] },
      },
    };
    trackable.restoreState(bad);
    expect(trackable.value.value).toBeNull();
  });

  it("restoreState rejects a region with unparseable dimensions", () => {
    trackable.value.value = sampleIntent();
    const bad = {
      layers: [],
      region: {
        lo: [0, 0, 0],
        hi: [1, 1, 1],
        // Fewer than three spatial dims.
        dimensions: { x: [8, "nm"], y: [8, "nm"] },
      },
    };
    trackable.restoreState(bad);
    expect(trackable.value.value).toBeNull();
  });

  it("restoreState canonicalizes region dimensions to the ngState form", () => {
    // A non-canonical (nm-unit) dimensions block is normalized to the canonical
    // metre form on parse, matching how ngState serializes coordinate spaces.
    trackable.restoreState({
      layers: [{ layerId: "L1", resolutions: [RES], writable: true }],
      region: {
        lo: [0, 0, 0],
        hi: [16, 16, 16],
        dimensions: { x: [8, "nm"], y: [8, "nm"], z: [40, "nm"] },
      },
    });
    expect(trackable.value.value?.region.dimensions).toEqual({
      x: [8e-9, "m"],
      y: [8e-9, "m"],
      z: [4e-8, "m"],
    });
  });

  it("reset() clears the value", () => {
    trackable.value.value = sampleIntent();
    trackable.reset();
    expect(trackable.value.value).toBeNull();
  });

  it("forwards value changes to its `changed` signal", () => {
    let fires = 0;
    trackable.changed.add(() => fires++);
    trackable.value.value = sampleIntent();
    expect(fires).toBe(1);
    trackable.reset();
    expect(fires).toBe(2);
  });
});
