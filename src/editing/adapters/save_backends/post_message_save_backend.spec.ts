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
import { Resolution, layerId as toLayerId } from "@zettaai/edit-session";
import { describe, it, expect } from "vitest";

import { PostMessageSaveBackend } from "#src/editing/adapters/save_backends/post_message_save_backend.js";
import type {
  NgSaveChunkMessage,
  NgSaveResultMessage,
} from "#src/editing/adapters/save_backends/save_protocol.js";
import { NG_SAVE_RESULT } from "#src/editing/adapters/save_backends/save_protocol.js";

const RES = Resolution.from([8, 8, 40]);
const LID: LayerId = toLayerId("seg");
const CHUNK_DATA_SIZE: [number, number, number] = [64, 64, 64];

const METADATA = {
  layerId: LID,
  voxelDataType: "uint64",
  channels: 1,
  scales: [
    {
      resolution: RES,
      voxelSizeNm: [8, 8, 40],
      voxelOffset: [0, 0, 0],
      sizeVoxels: [1024, 1024, 1024],
      chunkDataSize: CHUNK_DATA_SIZE,
    },
  ],
} as unknown as LayerMetadata;

function makeChunk(x: number, y: number, z: number): SavedChunk {
  const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  return {
    layerId: LID,
    resolution: RES,
    chunkId: `${x},${y},${z}`,
    chunkCoord: { x, y, z },
    contentRef: {},
    bytes: { byteLength: data.byteLength, asView: () => data },
  } as unknown as SavedChunk;
}

/**
 * Stands in for both the parent window (post target) and `window` (event
 * source). Records every posted message and auto-replies through its
 * registered listeners according to `responder`.
 */
class FakePortal {
  readonly posted: NgSaveChunkMessage[] = [];
  readonly transfers: Transferable[][] = [];
  readonly origin = "https://portal.test";
  private readonly listeners = new Set<(event: MessageEvent) => void>();

  constructor(
    private readonly responder: (
      message: NgSaveChunkMessage,
      index: number,
    ) => void,
  ) {}

  postMessage(
    message: NgSaveChunkMessage,
    _targetOrigin: string,
    transfer: Transferable[],
  ): void {
    const index = this.posted.length;
    this.posted.push(message);
    this.transfers.push(transfer);
    this.responder(message, index);
  }

  addEventListener(
    _type: "message",
    listener: (e: MessageEvent) => void,
  ): void {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: "message",
    listener: (e: MessageEvent) => void,
  ): void {
    this.listeners.delete(listener);
  }

  emit(result: NgSaveResultMessage): void {
    const event = { data: result, origin: this.origin } as MessageEvent;
    for (const listener of [...this.listeners]) listener(event);
  }
}

function ok(requestId: string): NgSaveResultMessage {
  return { type: NG_SAVE_RESULT, requestId, ok: true };
}
function fail(requestId: string, error: string): NgSaveResultMessage {
  return { type: NG_SAVE_RESULT, requestId, ok: false, error };
}

function backendFor(portal: FakePortal): PostMessageSaveBackend {
  return new PostMessageSaveBackend({
    postTarget: portal,
    messageSource: portal,
    targetOrigin: "*",
    resolveDataSourceUrl: () => "gs://bucket/seg|precomputed:",
  });
}

describe("PostMessageSaveBackend", () => {
  it("posts one transferable ng-save-chunk per chunk with correct fields", async () => {
    const portal = new FakePortal((message) => {
      queueMicrotask(() => portal.emit(ok(message.requestId)));
    });
    const backend = backendFor(portal);

    const result = await backend.saveLayer(
      LID,
      [makeChunk(0, 0, 0), makeChunk(1, 2, 3)],
      METADATA,
      new AbortController().signal,
    );

    expect(result).toEqual({
      status: "succeeded",
      layerId: LID,
      chunkCount: 2,
    });
    expect(portal.posted).toHaveLength(2);

    const [first, second] = portal.posted;
    expect(first.type).toBe("ng-save-chunk");
    expect(first.layerId).toBe(LID);
    expect(first.resolution).toBe(RES);
    expect(first.chunkCoord).toEqual({ x: 0, y: 0, z: 0 });
    expect(first.chunkDataSize).toEqual(CHUNK_DATA_SIZE);
    expect(first.dataSourceUrl).toBe("gs://bucket/seg|precomputed:");
    expect(second.chunkCoord).toEqual({ x: 1, y: 2, z: 3 });

    // bytes are a fresh, standalone ArrayBuffer handed to postMessage as a
    // transferable.
    expect(first.bytes).toBeInstanceOf(ArrayBuffer);
    expect(first.bytes.byteLength).toBe(8);
    expect(portal.transfers[0]).toEqual([first.bytes]);
    // requestIds are unique per chunk.
    expect(first.requestId).not.toBe(second.requestId);
  });

  it("returns succeeded with chunkCount 0 for an empty layer", async () => {
    const portal = new FakePortal(() => {});
    const result = await backendFor(portal).saveLayer(
      LID,
      [],
      METADATA,
      new AbortController().signal,
    );
    expect(result).toEqual({
      status: "succeeded",
      layerId: LID,
      chunkCount: 0,
    });
    expect(portal.posted).toHaveLength(0);
  });

  it("reports partial when some chunks fail", async () => {
    const portal = new FakePortal((message, index) => {
      queueMicrotask(() =>
        portal.emit(
          index === 1 ? fail(message.requestId, "boom") : ok(message.requestId),
        ),
      );
    });
    const result = await backendFor(portal).saveLayer(
      LID,
      [makeChunk(0, 0, 0), makeChunk(1, 0, 0), makeChunk(2, 0, 0)],
      METADATA,
      new AbortController().signal,
    );
    expect(result.status).toBe("partial");
    if (result.status === "partial") {
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.details).toContain("boom");
    }
  });

  it("reports failed when every chunk fails", async () => {
    const portal = new FakePortal((message) => {
      queueMicrotask(() => portal.emit(fail(message.requestId, "nope")));
    });
    const result = await backendFor(portal).saveLayer(
      LID,
      [makeChunk(0, 0, 0), makeChunk(1, 0, 0)],
      METADATA,
      new AbortController().signal,
    );
    expect(result).toEqual({
      status: "failed",
      layerId: LID,
      error: "nope",
    });
  });

  it("stops posting and returns partial when aborted mid-stream", async () => {
    const controller = new AbortController();
    const portal = new FakePortal((message, index) => {
      if (index === 0) {
        // Let the first chunk fully succeed, then abort before the next.
        queueMicrotask(() => portal.emit(ok(message.requestId)));
        queueMicrotask(() => controller.abort());
      }
      // Subsequent chunks get no reply; the abort interrupts the await.
    });
    const result = await backendFor(portal).saveLayer(
      LID,
      [makeChunk(0, 0, 0), makeChunk(1, 0, 0), makeChunk(2, 0, 0)],
      METADATA,
      controller.signal,
    );

    expect(result.status).toBe("partial");
    if (result.status === "partial") {
      expect(result.succeeded).toBe(1);
      expect(result.details).toContain("of-3");
    }
    // Chunk 2 must never be posted after the abort.
    expect(portal.posted.length).toBeLessThan(3);
  });
});
