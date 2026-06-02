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
  LayerId,
  LayerMetadata,
  SavedChunk,
} from "@zettaai/edit-session";

/**
 * Per-layer save outcome returned by a `SaveBackend`. This is the host's
 * internal richer result type — `NgSaveTarget` collapses these into the
 * library's `SaveLayerOutcome` (which only has `succeeded`/`failed`).
 *
 * The architecture doc (`docs/edit-session-integration/architecture/03-host-adapters.md`)
 * specifies `partial` and `skipped` as first-class states so the sidebar can
 * surface per-chunk progress and "no backend for this data source" cases.
 */
export type SaveBackendResult =
  | { readonly status: "succeeded"; readonly layerId: LayerId; readonly chunkCount: number }
  | {
      readonly status: "partial";
      readonly layerId: LayerId;
      readonly succeeded: number;
      readonly failed: number;
      readonly details: string;
    }
  | { readonly status: "failed"; readonly layerId: LayerId; readonly error: string }
  | { readonly status: "skipped"; readonly layerId: LayerId; readonly reason: string };

// Uses the library's `SavedChunk` (index.d.mts line 376) directly — its
// fields (chunkId, chunkCoord, contentRef, bytes, layerId, resolution) cover
// everything a save backend needs. No host-side `DirtyChunkPayload` wrapper.

/**
 * Persist the dirty chunks of a single layer to the host's storage backend
 * (network endpoint, local file, IndexedDB, etc.). One implementation per
 * data-source kind ("calcada", "precomputed", ...). Implementations are
 * registered into a process-wide registry keyed by data-source scheme.
 */
export interface SaveBackend {
  saveLayer(
    layerId: LayerId,
    chunks: readonly SavedChunk[],
    metadata: LayerMetadata,
    signal: AbortSignal,
  ): Promise<SaveBackendResult>;
}

const saveBackendRegistry = new Map<string, SaveBackend>();

export function registerSaveBackend(
  dataSourceKind: string,
  backend: SaveBackend,
): void {
  saveBackendRegistry.set(dataSourceKind, backend);
}

export function getSaveBackend(
  dataSourceKind: string,
): SaveBackend | undefined {
  return saveBackendRegistry.get(dataSourceKind);
}

export function unregisterSaveBackend(dataSourceKind: string): void {
  saveBackendRegistry.delete(dataSourceKind);
}
