/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { LayerId, Resolution } from "@zettaai/edit-session";
import { describe, it, expect } from "vitest";

import { LocalPatchChunk } from "#src/editing/local_patch_chunk.js";
import {
  notePaintedSubBox,
  takePaintedSubBox,
} from "#src/editing/overlay/painted_subbox_registry.js";
import { fuseOverlayIntoChunk } from "#src/editing/overlay/patch_mirror.js";
import type { vec3 } from "#src/util/geom.js";

const SIZE = [4, 4, 4] as unknown as vec3;
const VOLUME = 64;

function idx(x: number, y: number, z: number): number {
  return x + 4 * (y + 4 * z);
}

describe("fuseOverlayIntoChunk", () => {
  it("uint16: widens values without BigInt loss, derives patched, returns change box", () => {
    const chunk = new LocalPatchChunk(SIZE);
    const overlay = new Uint16Array(VOLUME);
    const baseline = new Uint16Array(VOLUME);
    overlay[idx(1, 2, 3)] = 5;
    overlay[idx(2, 2, 3)] = 65535;
    // A voxel where overlay equals a non-zero baseline: NOT patched, but the
    // mirrored value still updates from the chunk's zero-init.
    overlay[idx(0, 0, 0)] = 9;
    baseline[idx(0, 0, 0)] = 9;

    const box = fuseOverlayIntoChunk(chunk, overlay, baseline);

    expect(chunk.data[idx(1, 2, 3)]).toBe(5n);
    expect(chunk.data[idx(2, 2, 3)]).toBe(65535n);
    expect(chunk.data[idx(0, 0, 0)]).toBe(9n);
    expect(chunk.patched[idx(1, 2, 3)]).toBe(1);
    expect(chunk.patched[idx(2, 2, 3)]).toBe(1);
    expect(chunk.patched[idx(0, 0, 0)]).toBe(0);
    expect(box).toEqual({ x0: 0, y0: 0, z0: 0, x1: 2, y1: 2, z1: 3 });
  });

  it("second fuse returns only the newly-changed voxel's box", () => {
    const chunk = new LocalPatchChunk(SIZE);
    const overlay = new Uint16Array(VOLUME);
    const baseline = new Uint16Array(VOLUME);
    overlay[idx(1, 1, 1)] = 7;
    fuseOverlayIntoChunk(chunk, overlay, baseline);

    overlay[idx(3, 2, 1)] = 8;
    const box = fuseOverlayIntoChunk(chunk, overlay, baseline);
    expect(box).toEqual({ x0: 3, y0: 2, z0: 1, x1: 3, y1: 2, z1: 1 });
  });

  it("returns null when the chunk is already up to date", () => {
    const chunk = new LocalPatchChunk(SIZE);
    const overlay = new Uint16Array(VOLUME);
    const baseline = new Uint16Array(VOLUME);
    overlay[idx(1, 1, 1)] = 7;
    fuseOverlayIntoChunk(chunk, overlay, baseline);
    expect(fuseOverlayIntoChunk(chunk, overlay, baseline)).toBeNull();
  });

  it("erase-to-baseline-zero is patched; revert-to-baseline clears the patch", () => {
    const chunk = new LocalPatchChunk(SIZE);
    const overlay = new Uint16Array(VOLUME);
    const baseline = new Uint16Array(VOLUME);
    baseline[idx(2, 2, 2)] = 9;
    // User erased the voxel (overlay 0, baseline 9): patched.
    fuseOverlayIntoChunk(chunk, overlay, baseline);
    expect(chunk.data[idx(2, 2, 2)]).toBe(0n);
    expect(chunk.patched[idx(2, 2, 2)]).toBe(1);
    // Undo restores baseline value: patch bit must clear again.
    overlay[idx(2, 2, 2)] = 9;
    const box = fuseOverlayIntoChunk(chunk, overlay, baseline);
    expect(chunk.patched[idx(2, 2, 2)]).toBe(0);
    expect(box).toEqual({ x0: 2, y0: 2, z0: 2, x1: 2, y1: 2, z1: 2 });
  });

  it("signed types widen via two's complement, matching the old BigInt path", () => {
    const chunk = new LocalPatchChunk(SIZE);
    const overlay = new Int16Array(VOLUME);
    const baseline = new Int16Array(VOLUME);
    overlay[idx(0, 1, 0)] = -1;
    fuseOverlayIntoChunk(chunk, overlay, baseline);
    expect(chunk.data[idx(0, 1, 0)]).toBe(BigInt(-1 >>> 0));
    expect(chunk.patched[idx(0, 1, 0)]).toBe(1);
  });

  it("uint64: preserves values above 2^32", () => {
    const chunk = new LocalPatchChunk(SIZE);
    const overlay = new BigUint64Array(VOLUME);
    const baseline = new BigUint64Array(VOLUME);
    const big = (1n << 40n) + 123n;
    overlay[idx(3, 3, 3)] = big;
    const box = fuseOverlayIntoChunk(chunk, overlay, baseline);
    expect(chunk.data[idx(3, 3, 3)]).toBe(big);
    expect(chunk.patched[idx(3, 3, 3)]).toBe(1);
    expect(box).toEqual({ x0: 3, y0: 3, z0: 3, x1: 3, y1: 3, z1: 3 });
  });

  it("throws on length mismatch and unsupported view types", () => {
    const chunk = new LocalPatchChunk(SIZE);
    expect(() =>
      fuseOverlayIntoChunk(chunk, new Uint16Array(8), new Uint16Array(8)),
    ).toThrow(/chunk volume/);
    expect(() =>
      fuseOverlayIntoChunk(
        chunk,
        new Float32Array(VOLUME),
        new Float32Array(VOLUME),
      ),
    ).toThrow(/unsupported voxel data type/);
  });
});

describe("fuseOverlayIntoChunk · scanBox (P2)", () => {
  // Fuse `overlay` into two fresh chunks — one full-scan, one bounded by
  // `scanBox` — and assert the bounded result is byte-identical (data, patched,
  // returned change box). This is the core P2 correctness claim: bounding to a
  // superset of the touched voxels changes nothing observable.
  function expectBoundedMatchesFull(
    overlay: Uint16Array,
    baseline: Uint16Array,
    scanBox: {
      x0: number;
      y0: number;
      z0: number;
      x1: number;
      y1: number;
      z1: number;
    },
  ): void {
    const full = new LocalPatchChunk(SIZE);
    const bounded = new LocalPatchChunk(SIZE);
    const fullBox = fuseOverlayIntoChunk(full, overlay, baseline);
    const boundedBox = fuseOverlayIntoChunk(
      bounded,
      overlay,
      baseline,
      scanBox,
    );
    expect(Array.from(bounded.data)).toEqual(Array.from(full.data));
    expect(Array.from(bounded.patched)).toEqual(Array.from(full.patched));
    expect(boundedBox).toEqual(fullBox);
  }

  it("tight box covering exactly the written voxels matches a full scan", () => {
    const overlay = new Uint16Array(VOLUME);
    const baseline = new Uint16Array(VOLUME);
    overlay[idx(1, 2, 3)] = 5;
    overlay[idx(2, 2, 3)] = 65535;
    expectBoundedMatchesFull(overlay, baseline, {
      x0: 1,
      y0: 2,
      z0: 3,
      x1: 2,
      y1: 2,
      z1: 3,
    });
  });

  it("a box that is a strict superset of the change still matches a full scan", () => {
    const overlay = new Uint16Array(VOLUME);
    const baseline = new Uint16Array(VOLUME);
    overlay[idx(2, 2, 2)] = 11;
    // Superset: covers the whole chunk-local half — includes many unchanged
    // voxels, which must early-continue and not widen the returned box.
    expectBoundedMatchesFull(overlay, baseline, {
      x0: 0,
      y0: 0,
      z0: 0,
      x1: 3,
      y1: 3,
      z1: 3,
    });
  });

  it("an out-of-range box is clamped to the chunk (no out-of-bounds index)", () => {
    const overlay = new Uint16Array(VOLUME);
    const baseline = new Uint16Array(VOLUME);
    overlay[idx(3, 3, 3)] = 42;
    // x1/y1/z1 beyond the chunk and x0 negative: must clamp, not throw/corrupt.
    expectBoundedMatchesFull(overlay, baseline, {
      x0: -5,
      y0: -5,
      z0: -5,
      x1: 99,
      y1: 99,
      z1: 99,
    });
  });

  it("only the written sub-box is touched: a stale voxel outside it is left intact on first sync", () => {
    // A chunk freshly created (data/patched all zero). A bounded fuse over a box
    // that excludes voxel (3,3,3) must leave its mirror state at the zero-init,
    // proving the scan never reads/writes outside the box.
    const chunk = new LocalPatchChunk(SIZE);
    const overlay = new Uint16Array(VOLUME);
    const baseline = new Uint16Array(VOLUME);
    overlay[idx(0, 0, 0)] = 7; // inside the box
    overlay[idx(3, 3, 3)] = 9; // outside the box — must be ignored
    fuseOverlayIntoChunk(chunk, overlay, baseline, {
      x0: 0,
      y0: 0,
      z0: 0,
      x1: 1,
      y1: 1,
      z1: 1,
    });
    expect(chunk.data[idx(0, 0, 0)]).toBe(7n);
    expect(chunk.patched[idx(0, 0, 0)]).toBe(1);
    expect(chunk.data[idx(3, 3, 3)]).toBe(0n);
    expect(chunk.patched[idx(3, 3, 3)]).toBe(0);
  });
});

describe("paintedSubBoxRegistry (P2)", () => {
  const L = "seg" as LayerId;
  const R = "8,8,8" as Resolution;
  const C = "0,0,0";

  it("take returns the recorded box once, then undefined (consumed)", () => {
    const box = { x0: 1, y0: 1, z0: 1, x1: 2, y1: 2, z1: 2 };
    notePaintedSubBox(L, R, C, box);
    expect(takePaintedSubBox(L, R, C)).toEqual(box);
    // Consumed: a second take (e.g. a later non-paint commit) sees nothing →
    // full-chunk scan, which is what history replay requires.
    expect(takePaintedSubBox(L, R, C)).toBeUndefined();
  });

  it("keys are distinct per (layer, resolution, chunk)", () => {
    notePaintedSubBox(L, R, "1,0,0", {
      x0: 0,
      y0: 0,
      z0: 0,
      x1: 0,
      y1: 0,
      z1: 0,
    });
    expect(takePaintedSubBox(L, R, "2,0,0")).toBeUndefined();
    expect(takePaintedSubBox(L, R, "1,0,0")).toBeDefined();
  });
});

describe("LocalPatchChunk pendingUpload lifecycle", () => {
  it("starts as a full obligation, merges boxes, and full absorbs boxes", () => {
    const chunk = new LocalPatchChunk(SIZE);
    expect(chunk.pendingUpload).toEqual({
      box: null,
      valueDone: false,
      maskDone: false,
    });
    // Merging into "full" keeps it full.
    chunk.mergePendingUpload({ x0: 1, y0: 1, z0: 1, x1: 1, y1: 1, z1: 1 });
    expect(chunk.pendingUpload!.box).toBeNull();
    // Once released, a merge re-opens a box-scoped obligation and unions.
    chunk.pendingUpload = null;
    chunk.mergePendingUpload({ x0: 1, y0: 1, z0: 1, x1: 2, y1: 1, z1: 1 });
    chunk.mergePendingUpload({ x0: 0, y0: 3, z0: 1, x1: 0, y1: 3, z1: 2 });
    expect(chunk.pendingUpload).toEqual({
      box: { x0: 0, y0: 1, z0: 1, x1: 2, y1: 3, z1: 2 },
      valueDone: false,
      maskDone: false,
    });
  });

  it("a new write resets partial consumption", () => {
    const chunk = new LocalPatchChunk(SIZE);
    chunk.pendingUpload = null;
    chunk.mergePendingUpload({ x0: 1, y0: 1, z0: 1, x1: 1, y1: 1, z1: 1 });
    chunk.pendingUpload!.valueDone = true; // value texture consumed it
    chunk.writeVoxel(2, 2, 2, 5n);
    expect(chunk.pendingUpload!.valueDone).toBe(false);
    expect(chunk.pendingUpload!.box).toEqual({
      x0: 1,
      y0: 1,
      z0: 1,
      x1: 2,
      y1: 2,
      z1: 2,
    });
  });
});
