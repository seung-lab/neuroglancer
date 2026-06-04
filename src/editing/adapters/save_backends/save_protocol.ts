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
 * @file The neuroglancer-owned **save protocol**: the `postMessage`
 * request/response contract NG uses to delegate persistence to its host
 * (the portal). NG runs as a same-origin iframe; it cannot import the
 * portal's authenticated write toolchain, so for each dirty chunk it posts
 * an {@link NgSaveChunkMessage} to the parent window and awaits a correlated
 * {@link NgSaveResultMessage}. See `TM-289` (Option A).
 *
 * This module is the single source of truth for the wire shapes. The portal's
 * handler (`useNgSaveHandler`) must mirror these — keep the two in sync.
 *
 * ## Byte layout (open items, resolved portal-side — see TM-289)
 *
 * - `bytes` is a standalone, transferable `ArrayBuffer` carrying the chunk's
 *   raw voxel buffer. The host stores **BigUint64 per voxel** internally
 *   (8 bytes/voxel); the portal is responsible for any dtype narrowing the
 *   `/cutout` endpoint expects.
 * - Voxel ordering is whatever NG's overlay produces (X fastest within the
 *   chunk). The GET read path uses `permute_pattern=C X Y Z -> C Z Y X`; the
 *   portal must confirm whether the write POST needs an analogous axis
 *   permutation so saved bytes match server layout. NG sends bytes verbatim.
 */

/** Message type sent NG → portal, one per dirty chunk. */
export const NG_SAVE_CHUNK = "ng-save-chunk";

/** Message type sent portal → NG, one per chunk, correlated by `requestId`. */
export const NG_SAVE_RESULT = "ng-save-result";

/**
 * Request: persist a single dirty chunk. `bytes` is transferred (zero-copy),
 * so it is detached from NG's heap once posted.
 */
export interface NgSaveChunkMessage {
  readonly type: typeof NG_SAVE_CHUNK;
  /** Unique within this NG session; echoed back in the matching result. */
  readonly requestId: string;
  /** The edit-session layer id. */
  readonly layerId: string;
  /** Physical voxel size key, e.g. `"8x8x40"`. */
  readonly resolution: string;
  /** Chunk grid coordinate (absolute chunk index at this resolution). */
  readonly chunkCoord: { readonly x: number; readonly y: number; readonly z: number };
  /** Chunk shape in voxels at this resolution — bbox extent for the cutout. */
  readonly chunkDataSize: readonly [number, number, number];
  /**
   * Canonical data-source URL of the layer (e.g. `gs://bucket/path|precomputed:`,
   * `calcada://...`). Lets the portal map the layer to its `/cutout` `path`
   * regardless of protocol. May be absent if no data source is loaded.
   */
  readonly dataSourceUrl?: string;
  /** Raw voxel bytes (transferable). See file header for layout. */
  readonly bytes: ArrayBuffer;
}

/** Response: outcome of persisting the chunk named by `requestId`. */
export type NgSaveResultMessage =
  | { readonly type: typeof NG_SAVE_RESULT; readonly requestId: string; readonly ok: true }
  | {
      readonly type: typeof NG_SAVE_RESULT;
      readonly requestId: string;
      readonly ok: false;
      readonly error: string;
    };

/** Narrowing guard for inbound results on the NG side. */
export function isNgSaveResultMessage(data: unknown): data is NgSaveResultMessage {
  if (typeof data !== "object" || data === null) return false;
  const m = data as Record<string, unknown>;
  return (
    m.type === NG_SAVE_RESULT &&
    typeof m.requestId === "string" &&
    typeof m.ok === "boolean"
  );
}
