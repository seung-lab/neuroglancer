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
  applyMaskPipeline,
  applyMorphologyPipeline,
  binaryClose3D,
  computeThresholdMask,
  filterComponentsByMinSize,
  type MaskBuffer,
} from "#src/editing/tool_runtimes/mask_compute.js";
import type { VoxelTriple } from "#src/editing/tool_runtimes/mask_coord.js";

const SHAPE: VoxelTriple = [4, 4, 4];

function setAt(buf: MaskBuffer, x: number, y: number, z: number, v: number) {
  const [sx, sy] = buf.shape;
  buf.data[x + sx * (y + sy * z)] = v;
}

function getAt(buf: MaskBuffer, x: number, y: number, z: number): number {
  const [sx, sy] = buf.shape;
  return buf.data[x + sx * (y + sy * z)];
}

function emptyMask(shape: VoxelTriple = SHAPE): MaskBuffer {
  return { data: new Uint8Array(shape[0] * shape[1] * shape[2]), shape };
}

describe("computeThresholdMask", () => {
  it("sets 1 inside the inclusive band", () => {
    const img = new Uint8Array([0, 50, 100, 150, 200, 250]);
    const m = computeThresholdMask(img, [2, 3, 1], 100, 200);
    expect(Array.from(m.data)).toEqual([0, 0, 1, 1, 1, 0]);
  });

  it("low > high yields all zeros", () => {
    const img = new Uint8Array([50, 100, 150]);
    const m = computeThresholdMask(img, [3, 1, 1], 200, 100);
    expect(Array.from(m.data)).toEqual([0, 0, 0]);
  });

  it("low === high matches a single value", () => {
    const img = new Uint8Array([0, 5, 10, 5]);
    const m = computeThresholdMask(img, [4, 1, 1], 5, 5);
    expect(Array.from(m.data)).toEqual([0, 1, 0, 1]);
  });

  it("handles BigUint64Array inputs", () => {
    const img = new BigUint64Array([0n, 100n, 200n, 300n]);
    const m = computeThresholdMask(img, [4, 1, 1], 100, 200);
    expect(Array.from(m.data)).toEqual([0, 1, 1, 0]);
  });

  it("throws on shape mismatch", () => {
    expect(() =>
      computeThresholdMask(new Uint8Array(5), [4, 1, 1], 0, 255),
    ).toThrow(/length 5 != shape volume 4/);
  });
});

describe("binaryClose3D", () => {
  it("iterations=0 is identity", () => {
    const m = emptyMask();
    setAt(m, 1, 1, 1, 1);
    const out = binaryClose3D(m, 0);
    expect(out.data).toBe(m.data);
  });

  it("fills a single-voxel hole (closing=1)", () => {
    // 3x3x3 cube of 1s with a hole at center → closing should fill the hole.
    const m = emptyMask([3, 3, 3]);
    for (let z = 0; z < 3; z++) {
      for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 3; x++) {
          if (x === 1 && y === 1 && z === 1) continue;
          setAt(m, x, y, z, 1);
        }
      }
    }
    expect(getAt(m, 1, 1, 1)).toBe(0);
    const closed = binaryClose3D(m, 1);
    expect(getAt(closed, 1, 1, 1)).toBe(1);
  });

  it("does not change a solid blob interior to a padded buffer", () => {
    // 5x5x5 buffer, central 3x3x3 cube filled. With closing=1 the interior
    // stays solid (dilate grows by 1 then erode shrinks by 1 — surfaces
    // line up because the halo isolates the blob from the boundary).
    const m = emptyMask([5, 5, 5]);
    for (let z = 1; z <= 3; z++) {
      for (let y = 1; y <= 3; y++) {
        for (let x = 1; x <= 3; x++) {
          setAt(m, x, y, z, 1);
        }
      }
    }
    const before = Array.from(m.data);
    const closed = binaryClose3D(m, 1);
    expect(Array.from(closed.data)).toEqual(before);
  });

  it("respects buffer boundary (no wraparound)", () => {
    // Single isolated voxel at corner — should stay (closing of an
    // isolated voxel is identity since dilation grows then erosion
    // shrinks back to original within an infinite domain; near the
    // corner, the borders trim it).
    const m = emptyMask([3, 3, 3]);
    setAt(m, 0, 0, 0, 1);
    const closed = binaryClose3D(m, 1);
    // A single voxel dilates to a 6-connected cross then erodes. With
    // our 6-connected dilate/erode the isolated voxel disappears at the
    // erode step because the corner has out-of-bounds neighbors treated
    // as 0. Documented: closing near borders is approximate.
    expect(getAt(closed, 0, 0, 0)).toBe(0);
  });
});

describe("filterComponentsByMinSize", () => {
  it("minSize <= 1 is a no-op", () => {
    const m = emptyMask();
    setAt(m, 0, 0, 0, 1);
    filterComponentsByMinSize(m, 1);
    expect(getAt(m, 0, 0, 0)).toBe(1);
  });

  it("drops sub-min components, keeps at-or-above", () => {
    const m = emptyMask();
    // Small component: 1 voxel.
    setAt(m, 0, 0, 0, 1);
    // Larger component: 4 voxels in a line.
    setAt(m, 1, 1, 0, 1);
    setAt(m, 2, 1, 0, 1);
    setAt(m, 3, 1, 0, 1);
    setAt(m, 3, 2, 0, 1);
    filterComponentsByMinSize(m, 3);
    expect(getAt(m, 0, 0, 0)).toBe(0);
    expect(getAt(m, 1, 1, 0)).toBe(1);
    expect(getAt(m, 2, 1, 0)).toBe(1);
    expect(getAt(m, 3, 1, 0)).toBe(1);
    expect(getAt(m, 3, 2, 0)).toBe(1);
  });

  it("treats 6-connected components correctly (diagonal is separate)", () => {
    const m = emptyMask();
    // Two diagonal voxels — not 6-connected.
    setAt(m, 0, 0, 0, 1);
    setAt(m, 1, 1, 0, 1);
    filterComponentsByMinSize(m, 2);
    expect(getAt(m, 0, 0, 0)).toBe(0);
    expect(getAt(m, 1, 1, 0)).toBe(0);
  });
});

describe("applyMaskPipeline (filterComponentsFirst=false)", () => {
  it("threshold-only when closing=0 and minSize=0", () => {
    const img = new Uint8Array([0, 100, 200, 50, 150, 250, 25, 175]);
    const out = applyMaskPipeline({
      imageValues: img,
      shape: [2, 2, 2],
      thresholdLow: 100,
      thresholdHigh: 200,
      binaryClosing: 0,
      minComponentSize: 0,
      filterComponentsFirst: false,
    });
    expect(Array.from(out.data)).toEqual([0, 1, 1, 0, 1, 0, 0, 1]);
  });

  it("removes too-small components after threshold", () => {
    // 4x4 image with two bright regions: 1 voxel (size=1) and 4 voxels.
    const img = new Uint8Array(16);
    img[0] = 200; // isolated bright voxel
    img[5] = 200;
    img[6] = 200;
    img[9] = 200;
    img[10] = 200; // 4 connected voxels (size 4)
    const out = applyMaskPipeline({
      imageValues: img,
      shape: [4, 4, 1],
      thresholdLow: 150,
      thresholdHigh: 255,
      binaryClosing: 0,
      minComponentSize: 3,
      filterComponentsFirst: false,
    });
    expect(out.data[0]).toBe(0); // size-1 dropped
    expect(out.data[5]).toBe(1); // 4-component kept
    expect(out.data[6]).toBe(1);
    expect(out.data[9]).toBe(1);
    expect(out.data[10]).toBe(1);
  });
});

describe("applyMaskPipeline (filterComponentsFirst=true)", () => {
  it("threshold first, then filter components, then close (reference parity)", () => {
    // Image [0, 50, 100, 150, 200] thresholded against [100, 200] →
    // [0, 0, 1, 1, 1]. minSize=3 keeps the 3-voxel component. closing=0
    // no-op. Final: [0, 0, 1, 1, 1].
    const img = new Uint8Array([0, 50, 100, 150, 200]);
    const out = applyMaskPipeline({
      imageValues: img,
      shape: [5, 1, 1],
      thresholdLow: 100,
      thresholdHigh: 200,
      binaryClosing: 0,
      minComponentSize: 3,
      filterComponentsFirst: true,
    });
    expect(Array.from(out.data)).toEqual([0, 0, 1, 1, 1]);
  });

  it("closing runs after the component filter when filterFirst=true", () => {
    // Threshold [100, 255] → [1, 0, 1, 0, 1].
    // filterFirst (minSize=1, no-op) → [1, 0, 1, 0, 1].
    // close r=1 → dilate [1,1,1,1,1] → erode [0,1,1,1,0] (boundary erodes,
    // matching scipy default `border_value=0`).
    const img = new Uint8Array([200, 50, 200, 50, 200]);
    const out = applyMaskPipeline({
      imageValues: img,
      shape: [5, 1, 1],
      thresholdLow: 100,
      thresholdHigh: 255,
      binaryClosing: 1,
      minComponentSize: 1,
      filterComponentsFirst: true,
    });
    expect(Array.from(out.data)).toEqual([0, 1, 1, 1, 0]);
  });
});

describe("applyMorphologyPipeline", () => {
  it("applies closing then filter when filterComponentsFirst=false", () => {
    //   start    = [1, 1, 1, 0, 1, 0, 1]
    //   close r=1: dilate → [1,1,1,1,1,1,1]; erode → [0,1,1,1,1,1,0]
    //              (boundary erodes per scipy default `border_value=0`)
    //   minSize=4: kept component size 5 → unchanged
    const mask: MaskBuffer = {
      data: new Uint8Array([1, 1, 1, 0, 1, 0, 1]),
      shape: [7, 1, 1],
    };
    const out = applyMorphologyPipeline({
      mask,
      binaryClosing: 1,
      minComponentSize: 4,
      filterComponentsFirst: false,
    });
    expect(Array.from(out.data)).toEqual([0, 1, 1, 1, 1, 1, 0]);
  });

  it("applies filter then closing when filterComponentsFirst=true", () => {
    // Same input. With filterFirst:
    //   minSize=4 first → drop every component below 4. Two components:
    //     [1,1,1] size 3 → dropped; [1] size 1 → dropped; [1] size 1 → dropped
    //   result before close: all zeros
    //   close r=1 → still zeros
    const mask: MaskBuffer = {
      data: new Uint8Array([1, 1, 1, 0, 1, 0, 1]),
      shape: [7, 1, 1],
    };
    const out = applyMorphologyPipeline({
      mask,
      binaryClosing: 1,
      minComponentSize: 4,
      filterComponentsFirst: true,
    });
    expect(Array.from(out.data)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("returns input mask when both binaryClosing=0 and minSize<=1", () => {
    const mask: MaskBuffer = {
      data: new Uint8Array([1, 0, 1]),
      shape: [3, 1, 1],
    };
    const out = applyMorphologyPipeline({
      mask,
      binaryClosing: 0,
      minComponentSize: 1,
      filterComponentsFirst: false,
    });
    expect(out.data).toBe(mask.data);
  });
});
