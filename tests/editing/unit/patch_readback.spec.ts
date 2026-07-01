/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect } from "vitest";

import {
  summarizePatchedVoxels,
  type PatchChunkLike,
} from "#src/editing/benchmarks/patch_readback.js";

type Vec3 = [number, number, number];

/** Build a patch chunk and set `painted` voxels (local coords) to `value`. */
function chunk(
  size: Vec3,
  painted: ReadonlyArray<{ at: Vec3; v: bigint }>,
): PatchChunkLike {
  const [cx, cy, cz] = size;
  const volume = cx * cy * cz;
  const data = new BigUint64Array(volume);
  const patched = new Uint8Array(volume);
  for (const { at, v } of painted) {
    const idx = at[0] + cx * (at[1] + cy * at[2]);
    data[idx] = v;
    patched[idx] = 1;
  }
  return { chunkDataSize: size, data, patched };
}

/** Map entries iterable from `[gridKeyCSV, chunk]` pairs. */
function entries(
  rows: ReadonlyArray<[string, PatchChunkLike]>,
): Iterable<readonly [string, PatchChunkLike]> {
  return new Map(rows).entries();
}

describe("summarizePatchedVoxels", () => {
  it("counts patched voxels and computes global bbox (lo incl, hi excl)", () => {
    // Chunk grid (1,0,0) of size [8,8,8] → global base (8,0,0).
    const c = chunk(
      [8, 8, 8],
      [
        { at: [1, 2, 3], v: 5n }, // global (9, 2, 3)
        { at: [4, 4, 4], v: 5n }, // global (12, 4, 4)
      ],
    );
    const s = summarizePatchedVoxels(entries([["1,0,0", c]]));
    expect(s.paintedVoxels).toBe(2);
    expect(s.chunkCount).toBe(1);
    expect(s.bbox).toEqual({ lo: [9, 2, 3], hi: [13, 5, 5] });
    expect(s.distinctValues).toEqual(["5"]);
  });

  it("aggregates across chunks and counts only chunks with patches", () => {
    const a = chunk([8, 8, 8], [{ at: [0, 0, 0], v: 1n }]); // global (0,0,0)
    const b = chunk([8, 8, 8], [{ at: [7, 7, 7], v: 2n }]); // grid (1,1,0) → (15,15,7)
    const empty = chunk([8, 8, 8], []);
    const s = summarizePatchedVoxels(
      entries([
        ["0,0,0", a],
        ["1,1,0", b],
        ["2,2,2", empty],
      ]),
    );
    expect(s.paintedVoxels).toBe(2);
    expect(s.chunkCount).toBe(2); // the empty chunk is not counted
    expect(s.bbox).toEqual({ lo: [0, 0, 0], hi: [16, 16, 8] });
    expect(s.distinctValues).toEqual(["1", "2"]);
  });

  it("signature is stable and independent of chunk iteration order", () => {
    const a = chunk([8, 8, 8], [{ at: [1, 1, 1], v: 7n }]);
    const b = chunk([8, 8, 8], [{ at: [2, 2, 2], v: 9n }]);
    const s1 = summarizePatchedVoxels(
      entries([
        ["0,0,0", a],
        ["1,0,0", b],
      ]),
    );
    const s2 = summarizePatchedVoxels(
      entries([
        ["1,0,0", b],
        ["0,0,0", a],
      ]),
    );
    expect(s1.signature).toBe(s2.signature);
    expect(s1.signature).toMatch(/^[0-9a-f]{8}$/);
  });

  it("signature changes when a painted value changes", () => {
    const base = summarizePatchedVoxels(
      entries([["0,0,0", chunk([8, 8, 8], [{ at: [1, 1, 1], v: 7n }])]]),
    );
    const diff = summarizePatchedVoxels(
      entries([["0,0,0", chunk([8, 8, 8], [{ at: [1, 1, 1], v: 8n }])]]),
    );
    expect(diff.signature).not.toBe(base.signature);
  });

  it("an erase patch (value 0) is counted and reported", () => {
    const s = summarizePatchedVoxels(
      entries([["0,0,0", chunk([8, 8, 8], [{ at: [3, 3, 3], v: 0n }])]]),
    );
    expect(s.paintedVoxels).toBe(1);
    expect(s.distinctValues).toEqual(["0"]);
  });

  it("empty input yields a null bbox and the empty signature", () => {
    const s = summarizePatchedVoxels(entries([]));
    expect(s.paintedVoxels).toBe(0);
    expect(s.chunkCount).toBe(0);
    expect(s.bbox).toBeNull();
    expect(s.distinctValues).toEqual([]);
  });

  it("maxVoxels caps the collected set but keeps count + bbox exact", () => {
    const painted = [];
    for (let i = 0; i < 10; i++) painted.push({ at: [i, 0, 0] as Vec3, v: 1n });
    const s = summarizePatchedVoxels(
      entries([["0,0,0", chunk([16, 8, 8], painted)]]),
      { maxVoxels: 4, sampleSize: 3 },
    );
    expect(s.paintedVoxels).toBe(10); // exact, not capped
    expect(s.bbox).toEqual({ lo: [0, 0, 0], hi: [10, 1, 1] }); // exact
    expect(s.truncated).toBe(true);
    expect(s.sample).toHaveLength(3);
  });

  it("originOffset shifts coords to absolute global voxels", () => {
    // Patch grid is offset-relative; adding the layer voxelOffset [128,128,8]
    // yields absolute coords (the edit-region / saved-data frame).
    const c = chunk([8, 8, 8], [{ at: [1, 1, 1], v: 5n }]); // relative (1,1,1)
    const s = summarizePatchedVoxels(entries([["0,0,0", c]]), {
      originOffset: [128, 128, 8],
    });
    expect(s.sample[0].g).toEqual([129, 129, 9]);
    expect(s.bbox).toEqual({ lo: [129, 129, 9], hi: [130, 130, 10] });
  });

  it("indexes wide chunks (>4096) without losing coordinates", () => {
    // cx=8192 → a voxel at local x=5000 must map to global x=5000 (grid 0).
    const c = chunk([8192, 4, 1], [{ at: [5000, 2, 0], v: 3n }]);
    const s = summarizePatchedVoxels(entries([["0,0,0", c]]));
    expect(s.sample[0].g).toEqual([5000, 2, 0]);
    expect(s.bbox).toEqual({ lo: [5000, 2, 0], hi: [5001, 3, 1] });
  });
});
