/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { SessionVoxelBounds } from "@zettaai/edit-session";
import { describe, it, expect } from "vitest";

import type { Vec3 } from "#src/editing/tool_runtimes/paint_rasterize.js";
import {
  chunksForStroke,
  PaintStrokePipeline,
  type ChunkTile,
} from "#src/editing/tool_runtimes/paint_stroke_pipeline.js";

const CS: [number, number, number] = [64, 64, 64];

function keys(tiles: readonly ChunkTile[]): string[] {
  return tiles.map((t) => `${t.coord.x},${t.coord.y},${t.coord.z}`).sort();
}

describe("chunksForStroke", () => {
  it("returns the single chunk a small stroke lies within, with correct origin", () => {
    const pts: Vec3[] = [
      [10, 10, 5],
      [40, 20, 5],
    ];
    const tiles = chunksForStroke(pts, 4, CS);
    expect(keys(tiles)).toEqual(["0,0,0"]);
    expect(tiles[0].origin).toEqual([0, 0, 0]);
  });

  it("enumerates both chunks a stroke spanning an X boundary covers", () => {
    const pts: Vec3[] = [
      [50, 10, 5],
      [80, 10, 5],
    ];
    const tiles = chunksForStroke(pts, 5, CS);
    expect(keys(tiles)).toEqual(["0,0,0", "1,0,0"]);
    const t1 = tiles.find((t) => t.coord.x === 1)!;
    expect(t1.origin).toEqual([64, 0, 0]);
  });

  it("expands by the radius into a neighbouring chunk", () => {
    // A single stamp at x=60, r=8 reaches x=68 → crosses the x=64 boundary.
    const tiles = chunksForStroke([[60, 10, 5]], 8, CS);
    expect(keys(tiles)).toEqual(["0,0,0", "1,0,0"]);
  });

  it("dedupes chunks shared by adjacent segments (L-shape)", () => {
    const pts: Vec3[] = [
      [10, 10, 5],
      [60, 10, 5],
      [60, 60, 5],
    ];
    expect(keys(chunksForStroke(pts, 2, CS))).toEqual(["0,0,0"]);
  });

  it("clips the footprint to the session bounds in X", () => {
    const bounds: SessionVoxelBounds = {
      loX: 0,
      loY: 0,
      loZ: 0,
      hiX: 64, // valid x is [0, 63]
      hiY: 256,
      hiZ: 256,
    };
    const pts: Vec3[] = [
      [50, 10, 5],
      [80, 10, 5],
    ];
    // Without bounds this spans chunks 0 and 1; clipped to x<64 only chunk 0.
    expect(keys(chunksForStroke(pts, 5, CS, bounds))).toEqual(["0,0,0"]);
  });

  it("returns nothing when the z-slice is outside the session bounds", () => {
    const bounds: SessionVoxelBounds = {
      loX: 0,
      loY: 0,
      loZ: 0,
      hiX: 256,
      hiY: 256,
      hiZ: 64,
    };
    expect(chunksForStroke([[10, 10, 100]], 4, CS, bounds)).toEqual([]);
  });

  it("returns nothing for an empty point list", () => {
    expect(chunksForStroke([], 4, CS)).toEqual([]);
  });
});

describe("PaintStrokePipeline (non-isolated environment)", () => {
  it("reports unavailable and invalidate() is a safe no-op without SAB", () => {
    // The test environment is not cross-origin isolated, so SharedArrayBuffer
    // backing is unavailable and the pipeline degrades to the fallback path.
    const pipeline = new PaintStrokePipeline();
    expect(pipeline.available).toBe(false);
    expect(() => pipeline.invalidate()).not.toThrow();
  });
});
