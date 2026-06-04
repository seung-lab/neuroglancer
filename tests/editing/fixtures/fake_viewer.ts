/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import type { LayerManager } from "#src/layer/index.js";
import type { Viewer } from "#src/viewer.js";

import { FakeLayerManager } from "#tests/editing/fixtures/fake_layer_manager.js";

/**
 * Minimal stand-in for `Viewer` exposing only the fields read by
 * `EditSessionHost` during construction and the lifecycle helpers we test
 * in isolation (no `openSession` calls — those require a richer fake).
 */
export interface FakeViewer {
  readonly layerManager: LayerManager;
  readonly chunkManager: ChunkManager;
  readonly display: unknown;
}

export function createFakeViewer(
  layerManager: FakeLayerManager = new FakeLayerManager([]),
): Viewer {
  const fake: FakeViewer = {
    layerManager: layerManager.asLayerManager(),
    chunkManager: {} as unknown as ChunkManager,
    display: {},
  };
  return fake as unknown as Viewer;
}
