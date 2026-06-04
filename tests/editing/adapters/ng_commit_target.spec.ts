/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect, beforeEach } from "vitest";
import type {
  ChunkContentRef,
  CommittedChunk,
  CommitPayload,
  ReadonlyChunkVoxelBuffer,
} from "@zettaai/edit-session";
import { Resolution, layerId, sessionId } from "@zettaai/edit-session";

import { NgCommitTarget } from "#src/editing/adapters/ng_commit_target.js";

function fakeContentRef(hash: string, byteLength: number): ChunkContentRef {
  return {
    hash,
    byteLength,
    async retain(): Promise<ReadonlyChunkVoxelBuffer> {
      const view = new Uint8Array(byteLength);
      return { byteLength, asView: () => view };
    },
  };
}

function makeChunk(
  layerName: string,
  resolution: string,
  chunkId: string,
  bytesView: Uint8Array,
): CommittedChunk {
  return {
    layerId: layerId(layerName),
    resolution: Resolution.from([
      Number(resolution.split("x")[0]),
      Number(resolution.split("x")[1]),
      Number(resolution.split("x")[2]),
    ]),
    chunkId,
    chunkCoord: { x: 0, y: 0, z: 0 },
    contentRef: fakeContentRef(`hash-${chunkId}`, bytesView.byteLength),
    bytes: {
      byteLength: bytesView.byteLength,
      asView: () => bytesView,
    },
  };
}

function payload(chunks: CommittedChunk[]): CommitPayload {
  return {
    sessionId: sessionId("test-session"),
    committedAt: 0,
    chunks,
  };
}

describe("NgCommitTarget", () => {
  let target: NgCommitTarget;

  beforeEach(() => {
    target = new NgCommitTarget();
  });

  it("accept stores chunks under (layerId, resolution, chunkId) keys", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const chunk = makeChunk("L1", "8x8x40", "0,0,0", bytes);
    const result = await target.accept(payload([chunk]));
    expect(result.status).toBe("accepted");

    const expectedKey = `L1|${Resolution.from([8, 8, 40])}|0,0,0`;
    expect(target.accepted.has(expectedKey)).toBe(true);
    expect(target.accepted.size).toBe(1);
    const stored = target.accepted.get(expectedKey)!;
    expect(stored.layerId).toBe("L1");
    expect(stored.chunkId).toBe("0,0,0");
  });

  it("repeated accepts coalesce keyed updates", async () => {
    const first = makeChunk("L1", "8x8x40", "0,0,0", new Uint8Array([1, 2]));
    await target.accept(payload([first]));
    expect(target.accepted.size).toBe(1);

    // Re-accept the same key with new bytes — should overwrite, not duplicate.
    const second = makeChunk("L1", "8x8x40", "0,0,0", new Uint8Array([9, 9]));
    await target.accept(payload([second]));
    expect(target.accepted.size).toBe(1);

    const expectedKey = `L1|${Resolution.from([8, 8, 40])}|0,0,0`;
    const stored = target.accepted.get(expectedKey)!;
    const view = stored.bytes.asView() as Uint8Array;
    expect(Array.from(view)).toEqual([9, 9]);

    // A different chunkId triggers a new entry.
    const other = makeChunk("L1", "8x8x40", "1,0,0", new Uint8Array([7]));
    await target.accept(payload([other]));
    expect(target.accepted.size).toBe(2);
  });

  it("bytes are copied — mutating the input after accept does not mutate stored state", async () => {
    const input = new Uint8Array([10, 20, 30, 40]);
    const chunk = makeChunk("L1", "8x8x40", "0,0,0", input);
    await target.accept(payload([chunk]));

    // Mutate the original buffer; stored bytes must be unaffected.
    input[0] = 255;
    input[3] = 255;

    const expectedKey = `L1|${Resolution.from([8, 8, 40])}|0,0,0`;
    const stored = target.accepted.get(expectedKey)!;
    const storedView = stored.bytes.asView() as Uint8Array;
    expect(Array.from(storedView)).toEqual([10, 20, 30, 40]);
  });

  it("clearLayer removes only the given layer's entries", async () => {
    await target.accept(
      payload([
        makeChunk("L1", "8x8x40", "0,0,0", new Uint8Array([1])),
        makeChunk("L1", "8x8x40", "1,0,0", new Uint8Array([2])),
        makeChunk("L2", "8x8x40", "0,0,0", new Uint8Array([3])),
      ]),
    );
    expect(target.accepted.size).toBe(3);
    target.clearLayer(layerId("L1"));
    expect(target.accepted.size).toBe(1);
    const remainingKey = `L2|${Resolution.from([8, 8, 40])}|0,0,0`;
    expect(target.accepted.has(remainingKey)).toBe(true);
  });

  it("clearAll wipes every entry", async () => {
    await target.accept(
      payload([
        makeChunk("L1", "8x8x40", "0,0,0", new Uint8Array([1])),
        makeChunk("L2", "8x8x40", "0,0,0", new Uint8Array([2])),
      ]),
    );
    expect(target.accepted.size).toBe(2);
    target.clearAll();
    expect(target.accepted.size).toBe(0);
  });
});
