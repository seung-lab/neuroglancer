/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { LayerId, LayerMetadata, SavedChunk } from "@zettaai/edit-session";

import { NullarySignal } from "#src/util/signal.js";

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
  | {
      readonly status: "succeeded";
      readonly layerId: LayerId;
      readonly chunkCount: number;
    }
  | {
      readonly status: "partial";
      readonly layerId: LayerId;
      readonly succeeded: number;
      readonly failed: number;
      readonly details: string;
    }
  | {
      readonly status: "failed";
      readonly layerId: LayerId;
      readonly error: string;
    }
  | {
      readonly status: "skipped";
      readonly layerId: LayerId;
      readonly reason: string;
    };

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

/**
 * Dispatched whenever the set of registered backends changes (per-scheme or
 * default, register or clear). The host mirrors this into a reactive
 * `saveBackendAvailable` watchable so the UI can gate the Save controls on
 * whether persistence is actually wired up.
 */
export const saveBackendRegistryChanged = new NullarySignal();

const saveBackendRegistry = new Map<string, SaveBackend>();

export function registerSaveBackend(
  dataSourceKind: string,
  backend: SaveBackend,
): void {
  saveBackendRegistry.set(dataSourceKind, backend);
  saveBackendRegistryChanged.dispatch();
}

export function getSaveBackend(
  dataSourceKind: string,
): SaveBackend | undefined {
  return saveBackendRegistry.get(dataSourceKind);
}

export function unregisterSaveBackend(dataSourceKind: string): void {
  if (saveBackendRegistry.delete(dataSourceKind)) {
    saveBackendRegistryChanged.dispatch();
  }
}

/**
 * Catch-all backend used when no scheme-specific backend is registered for a
 * layer's data-source kind. The default `HttpSaveBackend` registers here so a
 * single transport persists chunks for every protocol (`calcada`, `gs`,
 * `precomputed`, `https`, ...) via `POST /cutout` through the shared
 * `BackendClient`. Per-scheme backends (if any are ever registered) take
 * precedence over this default.
 */
let defaultSaveBackend: SaveBackend | undefined;

export function registerDefaultSaveBackend(backend: SaveBackend): void {
  defaultSaveBackend = backend;
  saveBackendRegistryChanged.dispatch();
}

export function getDefaultSaveBackend(): SaveBackend | undefined {
  return defaultSaveBackend;
}

export function clearDefaultSaveBackend(): void {
  if (defaultSaveBackend !== undefined) {
    defaultSaveBackend = undefined;
    saveBackendRegistryChanged.dispatch();
  }
}

/**
 * Whether any backend (a default catch-all or any per-scheme backend) is
 * currently registered — i.e. whether saving is wired up at all. The host
 * does not auto-register a backend; the embedding host (the portal) installs
 * one, so this is `false` until it does.
 */
export function hasAnySaveBackend(): boolean {
  return defaultSaveBackend !== undefined || saveBackendRegistry.size > 0;
}
