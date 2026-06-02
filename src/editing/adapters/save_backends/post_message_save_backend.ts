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
import { scaleFor } from "@zettaai/edit-session";

import type {
  SaveBackend,
  SaveBackendResult,
} from "#src/editing/adapters/save_backend.js";
import type {
  NgSaveChunkMessage,
} from "#src/editing/adapters/save_backends/save_protocol.js";
import {
  NG_SAVE_CHUNK,
  isNgSaveResultMessage,
} from "#src/editing/adapters/save_backends/save_protocol.js";

/** Window-like target NG posts chunk messages to (default `window.parent`). */
export interface SavePostMessageTarget {
  postMessage(
    message: NgSaveChunkMessage,
    targetOrigin: string,
    transfer: Transferable[],
  ): void;
}

/** Event source NG listens on for results (default `window`). */
export interface SaveMessageSource {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
}

export interface PostMessageSaveBackendDeps {
  /** Where chunk messages are posted. Defaults to `window.parent`. */
  readonly postTarget?: SavePostMessageTarget;
  /** Where result messages are received. Defaults to `window`. */
  readonly messageSource?: SaveMessageSource;
  /**
   * `targetOrigin` for outbound posts and the expected origin of inbound
   * results. Defaults to the current origin (NG is a same-origin iframe).
   * Use `"*"` to disable the origin check.
   */
  readonly targetOrigin?: string;
  /**
   * Resolve the canonical data-source URL for a layer so the portal can map
   * it to a storage `path`. Typically bound to
   * `resolveDataSourceUrl(layerManager, layerId)`.
   */
  readonly resolveDataSourceUrl?: (layerId: LayerId) => string | undefined;
}

let requestCounter = 0;

/**
 * Protocol-agnostic `SaveBackend` that delegates persistence to the host
 * window (the portal) over `postMessage`. For each dirty chunk it posts an
 * `ng-save-chunk` message — the chunk's bytes ride along as a **transferable**
 * `ArrayBuffer` (zero-copy) — and awaits a correlated `ng-save-result`.
 *
 * The host (portal) performs the authenticated write (`/cutout`), so this
 * backend carries no auth or per-protocol knowledge and works for every
 * data-source kind. It is registered as the registry's default backend
 * (see `EditSessionHost`).
 *
 * Honors the `AbortSignal`: stops posting further chunks after the current one
 * and returns `partial`. Per-chunk outcomes aggregate into
 * `succeeded`/`partial`/`failed`, which `NgSaveTarget` collapses to the
 * library's `SaveLayerOutcome`.
 */
export class PostMessageSaveBackend implements SaveBackend {
  private readonly postTarget: SavePostMessageTarget;
  private readonly messageSource: SaveMessageSource;
  private readonly targetOrigin: string;
  private readonly resolveDataSourceUrl?: (
    layerId: LayerId,
  ) => string | undefined;

  constructor(deps: PostMessageSaveBackendDeps = {}) {
    this.postTarget = deps.postTarget ?? (window.parent as SavePostMessageTarget);
    this.messageSource = deps.messageSource ?? (window as SaveMessageSource);
    this.targetOrigin = deps.targetOrigin ?? window.location.origin;
    this.resolveDataSourceUrl = deps.resolveDataSourceUrl;
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

    const dataSourceUrl = this.resolveDataSourceUrl?.(layerId);

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
        await this.sendChunk(chunk, metadata, dataSourceUrl, signal);
        succeeded += 1;
      } catch (err) {
        if (signal.aborted) {
          cancelled = true;
          break;
        }
        failed += 1;
        if (firstError === undefined) {
          firstError = err instanceof Error ? err.message : String(err);
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

  private sendChunk(
    chunk: SavedChunk,
    metadata: LayerMetadata,
    dataSourceUrl: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const requestId = `ng-save-${++requestCounter}`;
    const scale = scaleFor(metadata, chunk.resolution);
    const message: NgSaveChunkMessage = {
      type: NG_SAVE_CHUNK,
      requestId,
      layerId: chunk.layerId,
      resolution: chunk.resolution,
      chunkCoord: {
        x: chunk.chunkCoord.x,
        y: chunk.chunkCoord.y,
        z: chunk.chunkCoord.z,
      },
      chunkDataSize: scale.chunkDataSize,
      dataSourceUrl,
      bytes: toTransferableBytes(chunk),
    };

    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("Save aborted", "AbortError"));
        return;
      }

      const onMessage = (event: MessageEvent): void => {
        if (
          this.targetOrigin !== "*" &&
          event.origin !== "" &&
          event.origin !== this.targetOrigin
        ) {
          return;
        }
        const data: unknown = event.data;
        if (!isNgSaveResultMessage(data)) return;
        if (data.requestId !== requestId) return;
        cleanup();
        if (data.ok) {
          resolve();
        } else {
          reject(new Error(data.error || `save failed for ${requestId}`));
        }
      };

      const onAbort = (): void => {
        cleanup();
        reject(new DOMException("Save aborted", "AbortError"));
      };

      const cleanup = (): void => {
        this.messageSource.removeEventListener("message", onMessage);
        signal.removeEventListener("abort", onAbort);
      };

      this.messageSource.addEventListener("message", onMessage);
      signal.addEventListener("abort", onAbort, { once: true });
      this.postTarget.postMessage(message, this.targetOrigin, [message.bytes]);
    });
  }
}

/**
 * Copy the chunk's voxel buffer into a fresh, standalone `ArrayBuffer` so it
 * can be transferred without detaching NG's pooled/overlay storage.
 */
function toTransferableBytes(chunk: SavedChunk): ArrayBuffer {
  const view = chunk.bytes.asView();
  const u8 = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  return u8.slice().buffer;
}
