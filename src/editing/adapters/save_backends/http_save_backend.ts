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
 * @file `HttpSaveBackend` (TM-348): a `SaveBackend` that writes dirty chunks
 * directly to the Zetta backend's `POST /painting/cutout` endpoint through the
 * shared {@link BackendClient}, instead of delegating them to the portal over
 * `postMessage` (`PostMessageSaveBackend`).
 *
 * This is what lets a standalone neuroglancer (no portal) actually persist
 * edits: the same build-time / injected {@link BackendEndpoint} that powers the
 * tool compute backends also carries the URL + auth for the save write, so save
 * needs no separate wiring.
 *
 * The request is reconstructed entirely from NG-local data — `scaleFor` yields
 * the scale's `voxelOffset` + `chunkDataSize`, so unlike the portal handler this
 * does not fetch the layer's `info` file. Bytes are posted exactly as the portal
 * path posts them (native dtype, X-fastest, gzipped, no axis reorder — the
 * `/cutout` default `is_fortran=true` consumes that layout), so this is
 * byte-for-byte equivalent to the proven `PostMessageSaveBackend` + portal
 * handler path.
 */

import type { LayerId, LayerMetadata, SavedChunk } from "@zettaai/edit-session";
import { scaleFor } from "@zettaai/edit-session";

import type {
  SaveBackend,
  SaveBackendResult,
} from "#src/editing/adapters/save_backend.js";
import type { BackendClient } from "#src/editing/backend/backend_client.js";

/** Default backend path for the chunk write (relative to the endpoint root). */
const DEFAULT_CUTOUT_PATH = "/painting/cutout";

export type Vec3 = [number, number, number];

/**
 * Derive the `/cutout` `path` from neuroglancer's canonical data-source URL,
 * mirroring the portal's mapping (TM-289):
 *   - precomputed: `gs://bucket/path|precomputed:` → `gs://bucket/path`
 *   - calcada:     `calcada://gs://bucket/path`    → `gs://bucket/path`
 *   - plain:       `gs://bucket/path`              → unchanged
 * Returns `undefined` when no usable path can be recovered.
 */
export function dataSourceUrlToCutoutPath(
  url: string | undefined,
): string | undefined {
  if (!url) return undefined;
  let path = url.trim();
  if (path.length === 0) return undefined;

  // Drop the `|<scheme>:` suffix NG appends (e.g. `|precomputed:`, `|n5:`).
  const pipeIndex = path.indexOf("|");
  if (pipeIndex !== -1) {
    path = path.slice(0, pipeIndex);
  }

  // Unwrap a leading `calcada://` wrapper, leaving the inner storage URL.
  if (path.startsWith("calcada://")) {
    path = path.slice("calcada://".length);
  }

  path = path.replace(/\/+$/, "");
  return path.length > 0 ? path : undefined;
}

/** Parse a `"8x8x40"` resolution key into a numeric `[x, y, z]` triple. */
export function parseResolution(resolution: string): Vec3 {
  const parts = resolution.split("x").map((p) => Number(p));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`Invalid resolution key: "${resolution}"`);
  }
  return [parts[0], parts[1], parts[2]];
}

/**
 * Absolute voxel bounding box of a chunk:
 *   start = voxelOffset + chunkCoord * chunkDataSize
 *   end   = start + chunkDataSize
 */
export function cutoutBbox(
  chunkCoord: { x: number; y: number; z: number },
  chunkDataSize: readonly [number, number, number],
  voxelOffset: readonly [number, number, number],
): { start: Vec3; end: Vec3 } {
  const coord: Vec3 = [chunkCoord.x, chunkCoord.y, chunkCoord.z];
  const start = coord.map(
    (c, i) => voxelOffset[i] + c * chunkDataSize[i],
  ) as Vec3;
  const end = start.map((s, i) => s + chunkDataSize[i]) as Vec3;
  return { start, end };
}

/** Build the `/cutout` query string (path + resolution + bbox), repeated-key form. */
export function buildCutoutParams(input: {
  path: string;
  resolution: Vec3;
  start: Vec3;
  end: Vec3;
}): URLSearchParams {
  const params = new URLSearchParams();
  params.set("path", input.path);
  for (const r of input.resolution) params.append("resolution", String(r));
  for (const s of input.start) params.append("bbox_start", String(s));
  for (const e of input.end) params.append("bbox_end", String(e));
  return params;
}

/** Copy a chunk's voxel buffer into a standalone `Uint8Array` (native dtype, X-fastest). */
function chunkToBytes(chunk: SavedChunk): Uint8Array {
  const view = chunk.bytes.asView();
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
}

/** Gzip-compress a byte buffer, as `/cutout` requires (it always `gzip.decompress`es the body). */
async function gzip(bytes: Uint8Array): Promise<ArrayBuffer> {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  void writer.write(bytes);
  void writer.close();
  return new Response(cs.readable).arrayBuffer();
}

export interface HttpSaveBackendDeps {
  /** Shared client carrying the backend endpoint (URL + auth). */
  readonly client: BackendClient;
  /** Resolve a layer's canonical data-source URL (→ the `/cutout` `path`). */
  readonly resolveDataSourceUrl?: (layerId: LayerId) => string | undefined;
  /** Override the write path (default `/painting/cutout`). */
  readonly cutoutPath?: string;
}

/**
 * `SaveBackend` that persists each dirty chunk via `POST /cutout` through the
 * shared {@link BackendClient}. Per-chunk outcomes aggregate into
 * succeeded / partial / failed, matching `PostMessageSaveBackend`.
 */
export class HttpSaveBackend implements SaveBackend {
  private readonly client: BackendClient;
  private readonly resolveDataSourceUrl?: (
    layerId: LayerId,
  ) => string | undefined;
  private readonly cutoutPath: string;

  constructor(deps: HttpSaveBackendDeps) {
    this.client = deps.client;
    this.resolveDataSourceUrl = deps.resolveDataSourceUrl;
    this.cutoutPath = deps.cutoutPath ?? DEFAULT_CUTOUT_PATH;
  }

  async saveLayer(
    layerId: LayerId,
    chunks: readonly SavedChunk[],
    metadata: LayerMetadata,
    signal: AbortSignal,
  ): Promise<SaveBackendResult> {
    if (chunks.length === 0) {
      return { status: "succeeded", layerId, chunkCount: 0 };
    }

    const path = dataSourceUrlToCutoutPath(
      this.resolveDataSourceUrl?.(layerId),
    );
    if (path === undefined) {
      return {
        status: "skipped",
        layerId,
        reason: "no data-source URL resolved for layer",
      };
    }

    let succeeded = 0;
    let failed = 0;
    let firstError: string | undefined;
    let cancelled = false;

    for (const chunk of chunks) {
      if (signal.aborted) {
        cancelled = true;
        break;
      }
      try {
        await this.sendChunk(chunk, metadata, path, signal);
        succeeded += 1;
      } catch (err) {
        if (signal.aborted) {
          cancelled = true;
          break;
        }
        failed += 1;
        firstError ??= err instanceof Error ? err.message : String(err);
      }
    }

    if (cancelled) {
      return {
        status: "partial",
        layerId,
        succeeded,
        failed,
        details: `cancelled-after-${succeeded + failed}-of-${chunks.length}`,
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

  private async sendChunk(
    chunk: SavedChunk,
    metadata: LayerMetadata,
    path: string,
    signal: AbortSignal,
  ): Promise<void> {
    const scale = scaleFor(metadata, chunk.resolution);
    const { start, end } = cutoutBbox(
      chunk.chunkCoord,
      scale.chunkDataSize,
      scale.voxelOffset,
    );
    const params = buildCutoutParams({
      path,
      resolution: parseResolution(chunk.resolution),
      start,
      end,
    });

    const body = await gzip(chunkToBytes(chunk));
    // `is_fortran` is left at its `/cutout` default (true), which consumes the
    // native-dtype, X-fastest bytes NG produces — no axis reorder needed.
    await this.client.request(`${this.cutoutPath}?${params.toString()}`, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/octet-stream" },
      signal,
    });
  }
}
