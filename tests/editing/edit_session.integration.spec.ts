/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { Resolution, layerId, sessionId } from "@zettaai/edit-session";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  EditSessionHost,
  type EditSessionIntent,
} from "#src/editing/edit_session_host.js";

import { FakeLayerManager } from "#tests/editing/fixtures/fake_layer_manager.js";
import { createFakeViewer } from "#tests/editing/fixtures/fake_viewer.js";

// `EditSessionHost`'s module graph transitively imports
// `src/webgl/shader_lib.ts`, which reads `WebGL2RenderingContext.*` at
// module-eval time. Polyfill the global before the host module loads.
// `vi.hoisted` runs before every static import regardless of placement.
vi.hoisted(() => {
  if (typeof (globalThis as any).WebGL2RenderingContext === "undefined") {
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

describe("EditSessionHost — integration (state surface)", () => {
  let host: EditSessionHost;

  beforeEach(() => {
    host = new EditSessionHost(createFakeViewer(new FakeLayerManager([])));
  });

  afterEach(() => {
    host.dispose();
  });

  it("state and sessionLock start cleared and disposal is safe", () => {
    expect(host.activeSession.value).toBeUndefined();
    expect(host.sessionLock.activeSession.value).toBeUndefined();
    expect(host.state.value.value).toBeNull();
  });

  it("setActiveSession + clearActiveSession on the lock toggle isLayerDataSourceLocked", () => {
    const layers = new Set([layerId("L1"), layerId("L2")]);
    host.sessionLock.setActiveSession({
      sessionId: sessionId("dummy"),
      sessionLayerIds: layers,
    });
    expect(host.sessionLock.isLayerDataSourceLocked(layerId("L1"))).toBe(true);
    expect(host.sessionLock.isLayerDataSourceLocked(layerId("L3"))).toBe(false);
    host.sessionLock.clearActiveSession();
    expect(host.sessionLock.isLayerDataSourceLocked(layerId("L1"))).toBe(false);
  });

  it("state.restoreState with an unresolvable intent auto-clears via failRestore", async () => {
    const intent: EditSessionIntent = {
      layers: [{ layerId: layerId("L1"), resolutions: [RES], writable: true }],
      region: {
        lo: [0, 0, 0],
        hi: [16, 16, 16],
        dimensions: { x: [8e-9, "m"], y: [8e-9, "m"], z: [4e-8, "m"] },
      },
    };
    // The host subscribes to `state.changed` and auto-triggers
    // `tryRestoreFromState()`. With no matching layer in the fake LayerManager,
    // the async restore attempt fails and `failRestore` clears the intent.
    // Flush microtasks so the attempt completes.
    host.state.restoreState(intent);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.state.value.value).toBeNull();
    // reset() on an already-null trackable is a no-op.
    host.state.reset();
    expect(host.state.value.value).toBeNull();
  });

  it("getActiveRegionWatchableForLayer keeps the same instance across calls", () => {
    const a1 = host.getActiveRegionWatchableForLayer("L1");
    const a2 = host.getActiveRegionWatchableForLayer("L1");
    expect(a1).toBe(a2);
    expect(a1.value).toBeUndefined();
  });

  it("tryRestoreFromState fails gracefully when intent references a missing layer", async () => {
    // No layers are registered with the FakeLayerManager — the restore path
    // must short-circuit (no active session, intent cleared).
    const intent: EditSessionIntent = {
      layers: [
        { layerId: layerId("missing-L1"), resolutions: [RES], writable: true },
      ],
      region: {
        lo: [0, 0, 0],
        hi: [16, 16, 16],
        dimensions: { x: [8e-9, "m"], y: [8e-9, "m"], z: [4e-8, "m"] },
      },
    };
    host.state.restoreState(intent);
    // The subscription auto-triggers `tryRestoreFromState`. Flush microtasks
    // so the async restore attempt completes.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.activeSession.value).toBeUndefined();
    // failRestore clears the state on missing references.
    expect(host.state.value.value).toBeNull();
  });
});

/**
 * End-to-end open/discard testing is deferred to manual QA.
 *
 * Why: `EditSessionHost.openSession()` constructs a real `EditSession` via
 * the library's `EditSession.open`, which in turn requires:
 *   - `NgChunkSource.pinChunks` to resolve a real `VolumeChunkSource` on
 *     each selected layer (depends on neuroglancer's chunk pipeline);
 *   - `NgLayerMetadataSource.resolve` to walk a real `UserLayer.dataSources`
 *     with a `loadState.dataSource.volume`;
 *   - `viewer.inputEventMap`, `viewer.element`, `viewer.display.gl` for the
 *     hotkey binder, pointer-event bridge, and cursor overlays.
 *
 * Fabricating these is on the order of constructing a real `Viewer` —
 * which the slice-view tests already exercise but at a different layer of
 * the system. See `docs/edit-session-integration/10-implementation-roadmap.md`
 * Step 27 (manual QA) for the smoke-test coverage that compensates.
 */
describe.todo(
  "EditSessionHost — full open/discard cycle (deferred to manual QA)",
);
