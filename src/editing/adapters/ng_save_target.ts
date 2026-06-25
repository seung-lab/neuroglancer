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
  SaveLayerOutcome,
  SavePayload,
  SaveResult,
  SavedChunk,
  SaveTarget,
  SessionError,
} from "@zettaai/edit-session";
import { sessionError } from "@zettaai/edit-session";

import type { NgLayerMetadataSource } from "#src/editing/adapters/ng_layer_metadata_source.js";
import type { NgLogger } from "#src/editing/adapters/ng_logger.js";
import type {
  SaveBackend,
  SaveBackendResult,
} from "#src/editing/adapters/save_backend.js";
import {
  getDefaultSaveBackend,
  getSaveBackend,
} from "#src/editing/adapters/save_backend.js";
import type { LayerManager, UserLayer } from "#src/layer/index.js";

/**
 * Read-back verifier injected into {@link NgSaveTarget}. Confirms that the
 * chunks the backend acked are actually retrievable from storage with the bytes
 * we sent — `NgChunkSource` implements this (TM-352). When absent, the save is
 * trusted as soon as the backend returns `succeeded` (legacy behavior / tests).
 */
export interface ChunkPersistenceVerifier {
  verifyChunksPersisted(
    chunks: readonly SavedChunk[],
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; unverified: readonly SavedChunk[] }>;
}

/**
 * `SaveTarget` adapter that routes per-layer chunk persistence through the
 * `SaveBackend` registry. Picks a backend by the layer's primary data-source
 * scheme (e.g. `"calcada"`, `"precomputed"`); layers whose scheme has no
 * registered backend are reported as `failed` with a `no-save-backend-for-...`
 * error so the sidebar can surface the gap per-layer.
 */
export class NgSaveTarget implements SaveTarget {
  constructor(
    private readonly layerManager: LayerManager,
    private readonly metadataSource: NgLayerMetadataSource,
    private readonly logger: NgLogger,
    private readonly verifier?: ChunkPersistenceVerifier,
  ) {}

  async save(payload: SavePayload, signal?: AbortSignal): Promise<SaveResult> {
    const chunksByLayer = groupChunksByLayer(payload.chunks);
    const outcomes: SaveLayerOutcome[] = [];
    const effectiveSignal = signal ?? new AbortController().signal;

    for (const layerId of payload.layerIds) {
      const layerChunks = chunksByLayer.get(layerId) ?? [];
      this.logger.info(
        "save",
        `Saving layer ${layerId} (${layerChunks.length} chunks)`,
        { layerId, chunkCount: layerChunks.length },
      );

      let outcome: SaveLayerOutcome;
      try {
        outcome = await this.saveOneLayer(
          layerId,
          layerChunks,
          effectiveSignal,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Console-only diagnostics — NOT a user toast. The user-facing signal
        // is surfaced once by the topbar from the returned outcome; a thrown
        // error and an unconfirmed read-back are indistinguishable to the user
        // ("we couldn't confirm"), so we don't assert "failed" in the UI here.
        console.error(`[edit-session:save] Save errored for layer ${layerId}`, {
          layerId,
          error: message,
        });
        outcome = {
          layerId,
          status: "failed",
          error: sessionError({
            kind: "recoverable",
            code: "save-failed",
            message,
            cause: err,
            at: Date.now(),
          }),
        };
      }

      if (outcome.status === "succeeded") {
        this.logger.info("save", `Saved layer ${layerId}`, { layerId });
      } else {
        // Console-only — the topbar surfaces the single user-facing message.
        console.error(
          `[edit-session:save] Save not confirmed for layer ${layerId}`,
          { layerId, error: outcome.error.message },
        );
      }
      outcomes.push(outcome);
    }

    return { overall: computeOverall(outcomes), outcomes };
  }

  private async saveOneLayer(
    layerId: LayerId,
    chunks: readonly SavedChunk[],
    signal: AbortSignal,
  ): Promise<SaveLayerOutcome> {
    const kind = resolveDataSourceKind(this.layerManager, layerId);
    if (kind === undefined) {
      return toOutcome(layerId, {
        status: "skipped",
        layerId,
        reason: "no-data-source-loaded",
      });
    }
    // Prefer a scheme-specific backend; otherwise fall back to the registered
    // default (the protocol-agnostic `PostMessageSaveBackend`). Only skip when
    // neither exists, so saving works for every data-source kind out of the box.
    const backend: SaveBackend | undefined =
      getSaveBackend(kind) ?? getDefaultSaveBackend();
    if (backend === undefined) {
      return toOutcome(layerId, {
        status: "skipped",
        layerId,
        reason: `no-save-backend-for-datasource-${kind}`,
      });
    }
    const metadata = await this.metadataSource.resolve(layerId);
    const result = await backend.saveLayer(layerId, chunks, metadata, signal);
    const outcome = toOutcome(layerId, result);
    // A backend `ok` is only a write acknowledgement. Before declaring the
    // layer saved (which lets the library rebaseline / mark it clean), read the
    // chunks back from storage and confirm they match. A miss returns `failed`
    // so the layer stays dirty and the user can retry — their edits are never
    // dropped on an unconfirmed save (TM-352).
    if (
      outcome.status === "succeeded" &&
      this.verifier !== undefined &&
      chunks.length > 0
    ) {
      const verification = await this.verifier.verifyChunksPersisted(
        chunks,
        signal,
      );
      if (!verification.ok) {
        // Return a failed outcome with a single, user-facing message. The
        // outer `save()` loop logs the failure once, so don't double-log here;
        // the per-chunk counts ride in `cause` for diagnostics.
        return {
          layerId,
          status: "failed",
          error: sessionError({
            kind: "recoverable",
            code: "save-verification-failed",
            message:
              "Your changes couldn't be confirmed as saved. They're kept " +
              "here — please try saving again.",
            cause: {
              layerId,
              unverifiedChunks: verification.unverified.length,
              totalChunks: chunks.length,
            },
            at: Date.now(),
          }),
        };
      }
    }
    return outcome;
  }
}

/**
 * Resolve the data-source kind for `layerId` by inspecting the layer's first
 * loaded data source and matching its `canonicalUrl` (or `spec.url`) scheme.
 *
 * Determined via:
 *   - `LayerManager.getLayerByName` returns `ManagedUserLayer`
 *     (see `src/layer/index.ts:1035-1037`).
 *   - `ManagedUserLayer.layer.dataSources` is `LayerDataSource[]`
 *     (`src/layer/index.ts:380`).
 *   - Each `LayerDataSource.loadState.dataSource.canonicalUrl` carries the
 *     scheme prefix set by the provider (e.g. calcada's
 *     `${options.url.scheme}://${url}` at
 *     `src/datasource/calcada/frontend.ts:816`). Falls back to `spec.url`
 *     for sources whose `canonicalUrl` is missing.
 */
function resolveDataSourceKind(
  layerManager: LayerManager,
  layerId: LayerId,
): string | undefined {
  const managed = layerManager.getLayerByName(layerId);
  if (managed === undefined) return undefined;
  const userLayer: UserLayer | null = managed.layer;
  if (userLayer === null) return undefined;
  for (const layerDataSource of userLayer.dataSources) {
    const url = pickUrl(layerDataSource);
    const scheme = parseScheme(url);
    if (scheme !== undefined) return scheme;
  }
  return undefined;
}

/**
 * Resolve the canonical data-source URL for `layerId` (the same URL
 * `resolveDataSourceKind` derives its scheme from). Save backends that hand
 * chunks off to an external writer (e.g. `PostMessageSaveBackend` → portal)
 * pass this along so the writer can map the layer to its storage `path`
 * regardless of protocol. Returns `undefined` when no data source is loaded.
 */
export function resolveDataSourceUrl(
  layerManager: LayerManager,
  layerId: LayerId,
): string | undefined {
  const managed = layerManager.getLayerByName(layerId);
  if (managed === undefined) return undefined;
  const userLayer: UserLayer | null = managed.layer;
  if (userLayer === null) return undefined;
  for (const layerDataSource of userLayer.dataSources) {
    const url = pickUrl(layerDataSource);
    if (url !== undefined) return url;
  }
  return undefined;
}

function pickUrl(
  layerDataSource: UserLayer["dataSources"][number],
): string | undefined {
  const loadState = layerDataSource.loadState;
  if (
    loadState !== undefined &&
    !("error" in loadState && loadState.error !== undefined)
  ) {
    const canonical = (loadState as { dataSource?: { canonicalUrl?: string } })
      .dataSource?.canonicalUrl;
    if (canonical !== undefined && canonical.length > 0) return canonical;
  }
  const specUrl = layerDataSource.spec?.url;
  return specUrl && specUrl.length > 0 ? specUrl : undefined;
}

function parseScheme(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const match = url.match(/^([a-zA-Z][a-zA-Z0-9+\-_]*):\/\//);
  return match === null ? undefined : match[1];
}

function groupChunksByLayer(
  chunks: readonly SavedChunk[],
): Map<LayerId, SavedChunk[]> {
  const grouped = new Map<LayerId, SavedChunk[]>();
  for (const chunk of chunks) {
    let bucket = grouped.get(chunk.layerId);
    if (bucket === undefined) {
      bucket = [];
      grouped.set(chunk.layerId, bucket);
    }
    bucket.push(chunk);
  }
  return grouped;
}

function toOutcome(
  layerId: LayerId,
  result: SaveBackendResult,
): SaveLayerOutcome {
  if (result.status === "succeeded") {
    return { layerId, status: "succeeded" };
  }
  const error: SessionError = sessionError({
    kind: "recoverable",
    code:
      result.status === "partial"
        ? "save-partial"
        : result.status === "skipped"
          ? "save-skipped"
          : "save-failed",
    message: describeFailure(result),
    at: Date.now(),
  });
  return { layerId, status: "failed", error };
}

function describeFailure(
  result: Exclude<SaveBackendResult, { status: "succeeded" }>,
): string {
  switch (result.status) {
    case "partial":
      return `partial: ${result.succeeded} succeeded, ${result.failed} failed — ${result.details}`;
    case "failed":
      return result.error;
    case "skipped":
      return `skipped: ${result.reason}`;
  }
}

function computeOverall(
  outcomes: readonly SaveLayerOutcome[],
): SaveResult["overall"] {
  if (outcomes.length === 0) return "all-succeeded";
  let succeeded = 0;
  let failed = 0;
  for (const outcome of outcomes) {
    if (outcome.status === "succeeded") succeeded += 1;
    else failed += 1;
  }
  if (failed === 0) return "all-succeeded";
  if (succeeded === 0) return "all-failed";
  return "partial";
}
