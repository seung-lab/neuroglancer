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

import type {
  SaveBackend,
  SaveBackendResult,
} from "#src/editing/adapters/save_backend.js";
import { registerSaveBackend } from "#src/editing/adapters/save_backend.js";
import type { HttpSource } from "#src/datasource/calcada/base.js";

/**
 * Construction-time dependencies for `CalcadaSaveBackend`. The host
 * (`EditSessionHost`) builds one of these per active session by reading the
 * session's calcada-backed layers and handing in their `HttpSource`. We
 * intentionally do NOT auto-register at module load: the registry can't
 * synthesize an `HttpSource` on its own — see `registerCalcadaSaveBackend`.
 */
export interface CalcadaSaveBackendDeps {
  /**
   * Resolve the `HttpSource` for the calcada data source of `layerId`. The
   * `baseUrl` of the returned source is used to build the per-chunk POST URL.
   * Returning `undefined` causes `saveLayer` to fail-fast for that layer.
   */
  resolveHttpSource(layerId: LayerId): HttpSource | undefined;
}

/**
 * Persists dirty chunks for a calcada-backed segmentation layer by POSTing
 * each chunk's bytes to the calcada edit-write endpoint
 * (`${baseUrl}/edit_write/<resolution>/<x>_<y>_<z>`). Per-chunk success is
 * aggregated into a `partial`/`succeeded`/`failed` `SaveBackendResult`.
 *
 * NOTE: The calcada save protocol is not yet codified in the data source
 * (the existing `src/datasource/calcada/frontend.ts` only POSTs to graphene
 * graph endpoints — merge/split/etc). The URL shape and body framing below
 * mirror the closest existing POST pattern (`GrapheneGraphServerInterface.
 * mergeSegments` at `src/datasource/calcada/frontend.ts:2186-2208`) and the
 * architecture spec at `docs/edit-session-integration/architecture/03-host-adapters.md`.
 * The exact route/body should be confirmed with the calcada backend team
 * before the v1 demo; this implementation is structured so the URL builder
 * and body serializer are swap-in points.
 */
export class CalcadaSaveBackend implements SaveBackend {
  constructor(private readonly deps: CalcadaSaveBackendDeps) {}

  async saveLayer(
    layerId: LayerId,
    chunks: readonly SavedChunk[],
    metadata: LayerMetadata,
    signal: AbortSignal,
  ): Promise<SaveBackendResult> {
    const httpSource = this.deps.resolveHttpSource(layerId);
    if (httpSource === undefined) {
      return {
        status: "failed",
        layerId,
        error: `calcada: no HTTP source available for layer ${layerId}`,
      };
    }

    if (chunks.length === 0) {
      return { status: "succeeded", layerId, chunkCount: 0 };
    }

    let succeeded = 0;
    let failed = 0;
    let firstError: string | undefined;
    let cancelled = false;

    for (let i = 0; i < chunks.length; ++i) {
      if (signal.aborted) {
        cancelled = true;
        break;
      }
      const chunk = chunks[i];
      try {
        await postChunk(httpSource, chunk, metadata, signal);
        succeeded += 1;
      } catch (err) {
        failed += 1;
        if (firstError === undefined) {
          firstError = err instanceof Error ? err.message : String(err);
        }
        if (signal.aborted) {
          cancelled = true;
          break;
        }
      }
    }

    if (cancelled) {
      const processed = succeeded + failed;
      return {
        status: "partial",
        layerId,
        succeeded,
        failed,
        details: `cancelled-after-${processed}-of-${chunks.length}`,
      };
    }
    if (failed === 0) {
      return { status: "succeeded", layerId, chunkCount: succeeded };
    }
    if (succeeded === 0) {
      return {
        status: "failed",
        layerId,
        error: firstError ?? "all chunks failed",
      };
    }
    return {
      status: "partial",
      layerId,
      succeeded,
      failed,
      details: firstError ?? "mixed-outcomes",
    };
  }
}

/**
 * Register a `CalcadaSaveBackend` for the lifetime of an edit session. Pair
 * each call with the disposer returned (or call `unregisterSaveBackend("calcada")`
 * from the call site) when the session closes.
 */
export function registerCalcadaSaveBackend(
  deps: CalcadaSaveBackendDeps,
): CalcadaSaveBackend {
  const backend = new CalcadaSaveBackend(deps);
  registerSaveBackend("calcada", backend);
  return backend;
}

/**
 * Build the per-chunk URL using `(resolution, chunkCoord)` so the server can
 * route writes to the right scale and grid cell. Mirrors the existing
 * graphene POST URL convention of `${baseUrl}/<verb>?...`.
 */
function buildChunkUrl(baseUrl: string, chunk: SavedChunk): string {
  const { resolution, chunkCoord } = chunk;
  const cleanBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${cleanBase}/edit_write/${encodeURIComponent(resolution)}/${chunkCoord.x}_${chunkCoord.y}_${chunkCoord.z}`;
}

async function postChunk(
  httpSource: HttpSource,
  chunk: SavedChunk,
  metadata: LayerMetadata,
  signal: AbortSignal,
): Promise<void> {
  const url = buildChunkUrl(httpSource.baseUrl, chunk);
  const body = serializeChunkBody(chunk);
  await httpSource.fetchOkImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Edit-Layer": String(metadata.layerId),
      "X-Edit-Resolution": chunk.resolution,
      "X-Edit-Chunk": `${chunk.chunkCoord.x},${chunk.chunkCoord.y},${chunk.chunkCoord.z}`,
    },
    body,
    signal,
  });
}

function serializeChunkBody(chunk: SavedChunk): ArrayBuffer {
  const view = chunk.bytes.asView();
  // Re-slice into a fresh ArrayBuffer to detach from any pooled storage.
  const u8 = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  return u8.slice().buffer;
}
