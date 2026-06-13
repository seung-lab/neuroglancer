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
  DEFAULT_SPACING_FRACTION,
  resolveSpacingVoxels,
  StrokeGeometry,
  type Vec3,
} from "#src/editing/tool_runtimes/stroke_geometry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Brush diameter that yields a clean integer spacing at 10% (20 → spacing 2). */
const DIAMETER = 20;
const OPTS = { diameterVoxels: DIAMETER, spacingFraction: 0.1 } as const;

function dist(a: Vec3, b: Vec3): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Feed every sample at once, then finish; return the full canonical sequence. */
function runAtOnce(samples: readonly Vec3[]): Vec3[] {
  const g = new StrokeGeometry(OPTS);
  g.pushSamples(samples);
  g.drain();
  g.finish();
  return [...g.canonical()];
}

/** Feed samples split into arbitrary batches, draining each time, then finish. */
function runBatched(batches: readonly (readonly Vec3[])[]): {
  canonical: Vec3[];
  drained: Vec3[];
} {
  const g = new StrokeGeometry(OPTS);
  const drained: Vec3[] = [];
  for (const b of batches) {
    g.pushSamples(b);
    drained.push(...g.drain());
  }
  drained.push(...g.finish());
  return { canonical: [...g.canonical()], drained };
}

function expectVecClose(a: Vec3, b: Vec3): void {
  expect(a[0]).toBeCloseTo(b[0], 9);
  expect(a[1]).toBeCloseTo(b[1], 9);
  expect(a[2]).toBeCloseTo(b[2], 9);
}

/** A straight horizontal line of `n` control points, `step` apart along x. */
function straightLine(n: number, step: number): Vec3[] {
  return Array.from({ length: n }, (_, i): Vec3 => [i * step, 0, 0]);
}

// ---------------------------------------------------------------------------
// Spacing resolution
// ---------------------------------------------------------------------------

describe("resolveSpacingVoxels", () => {
  it("is diameter * fraction", () => {
    expect(
      resolveSpacingVoxels({ diameterVoxels: 20, spacingFraction: 0.1 }),
    ).toBe(2);
    expect(
      resolveSpacingVoxels({ diameterVoxels: 40, spacingFraction: 0.25 }),
    ).toBe(10);
  });

  it("defaults to DEFAULT_SPACING_FRACTION", () => {
    expect(resolveSpacingVoxels({ diameterVoxels: 100 })).toBe(
      100 * DEFAULT_SPACING_FRACTION,
    );
  });

  it("clamps to a one-voxel floor", () => {
    expect(
      resolveSpacingVoxels({ diameterVoxels: 3, spacingFraction: 0.1 }),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Determinism / batch-invariance
// ---------------------------------------------------------------------------

describe("StrokeGeometry determinism", () => {
  const samples: Vec3[] = [
    [0, 0, 0],
    [10, 2, 0],
    [20, -3, 0],
    [33, 5, 0],
    [50, 0, 0],
    [61, 8, 0],
    [70, 1, 0],
  ];

  it("is invariant to how samples are batched", () => {
    const whole = runAtOnce(samples);

    // Split the same samples into a few different batch shapes.
    const shapes: Vec3[][][] = [
      samples.map((s) => [s]), // one-at-a-time
      [samples.slice(0, 3), samples.slice(3)], // two batches
      [samples.slice(0, 1), samples.slice(1, 5), samples.slice(5)], // uneven
    ];

    for (const shape of shapes) {
      const { canonical } = runBatched(shape);
      expect(canonical.length).toBe(whole.length);
      for (let i = 0; i < whole.length; i++) {
        expectVecClose(canonical[i], whole[i]);
      }
    }
  });

  it("drain/finish stream the canonical stamps after the start, in order", () => {
    // The first canonical stamp is the stroke start (the caller already holds
    // it as the down position); drain()/finish() stream everything after it.
    const { canonical, drained } = runBatched(samples.map((s) => [s]));
    const afterStart = canonical.slice(1);
    expect(drained.length).toBe(afterStart.length);
    for (let i = 0; i < afterStart.length; i++) {
      expectVecClose(drained[i], afterStart[i]);
    }
  });

  it("canonical()'s emitted prefix never moves as more samples arrive", () => {
    const g = new StrokeGeometry(OPTS);
    let prev: Vec3[] = [];
    for (const s of samples) {
      g.pushSamples([s]);
      g.drain();
      const now = [...g.canonical()];
      // Everything emitted before must be byte-identical now (stable prefix).
      for (let i = 0; i < prev.length; i++) {
        expect(now[i]).toEqual(prev[i]);
      }
      prev = now;
    }
  });
});

// ---------------------------------------------------------------------------
// Even arc-length spacing
// ---------------------------------------------------------------------------

describe("StrokeGeometry even spacing", () => {
  it("places interior stamps one spacing apart along a straight line", () => {
    // 11 points 10 apart → a 100-voxel line; spacing 2 → ~50 stamps.
    const stamps = runAtOnce(straightLine(11, 10));
    expect(stamps.length).toBeGreaterThan(10);
    expectVecClose(stamps[0], [0, 0, 0]); // first stamp is the start

    // Consecutive gaps (excluding the very last, which lands on the endpoint)
    // are exactly the spacing on a straight line.
    for (let i = 1; i < stamps.length - 1; i++) {
      expect(dist(stamps[i - 1], stamps[i])).toBeCloseTo(2, 6);
    }
  });

  it("keeps spacing continuous across batch boundaries (no seam)", () => {
    const line = straightLine(11, 10);
    const { canonical } = runBatched([
      line.slice(0, 4),
      line.slice(4, 7),
      line.slice(7),
    ]);
    for (let i = 1; i < canonical.length - 1; i++) {
      expect(dist(canonical[i - 1], canonical[i])).toBeCloseTo(2, 6);
    }
  });
});

// ---------------------------------------------------------------------------
// Catmull-Rom smoothing
// ---------------------------------------------------------------------------

describe("StrokeGeometry smoothing", () => {
  it("rounds a right-angle corner without overshooting the control points", () => {
    // An L: right along x to (40,0), then up to (40,40).
    const path: Vec3[] = [
      [0, 0, 0],
      [20, 0, 0],
      [40, 0, 0],
      [40, 20, 0],
      [40, 40, 0],
    ];
    const stamps = runAtOnce(path);

    // No gross overshoot or looping near the corner. Centripetal Catmull-Rom
    // can overshoot the control-point bounding box by a sub-voxel amount on a
    // sharp asymmetric corner (invisible after voxel quantization), but never
    // by the large amounts uniform Catmull-Rom would. Bound it to one spacing.
    const M = 2;
    for (const s of stamps) {
      expect(s[0]).toBeGreaterThanOrEqual(-M);
      expect(s[0]).toBeLessThanOrEqual(40 + M);
      expect(s[1]).toBeGreaterThanOrEqual(-M);
      expect(s[1]).toBeLessThanOrEqual(40 + M);
      expect(s[2]).toBe(0);
    }

    // The corner is rounded: at least one stamp leaves the raw L-polyline by
    // more than half a voxel — a straight-segment rasterizer would keep every
    // point exactly on the two legs.
    const distToL = (s: Vec3): number => {
      const onLeg1 = s[0] >= 0 && s[0] <= 40 ? Math.abs(s[1]) : Infinity; // y=0 leg
      const onLeg2 = s[1] >= 0 && s[1] <= 40 ? Math.abs(s[0] - 40) : Infinity; // x=40 leg
      return Math.min(onLeg1, onLeg2);
    };
    expect(stamps.some((s) => distToL(s) > 0.5)).toBe(true);
  });

  it("preserves a constant z for a same-slice stroke", () => {
    const z = 7;
    const stamps = runAtOnce([
      [0, 0, z],
      [10, 5, z],
      [20, -4, z],
      [30, 2, z],
    ]);
    for (const s of stamps) expect(s[2]).toBe(z);
  });
});

// ---------------------------------------------------------------------------
// Degenerate inputs
// ---------------------------------------------------------------------------

describe("StrokeGeometry degenerate inputs", () => {
  it("a single sample yields just that stamp", () => {
    const g = new StrokeGeometry(OPTS);
    g.pushSamples([[1, 2, 3]]);
    expect(g.drain()).toEqual([]);
    expect(g.finish()).toEqual([]);
    expect(g.canonical()).toEqual([[1, 2, 3]]);
    expect(g.head()).toEqual([1, 2, 3]);
  });

  it("drops consecutive duplicate samples", () => {
    const g = new StrokeGeometry(OPTS);
    g.pushSamples([
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
    ]);
    g.drain();
    g.finish();
    expect(g.canonical()).toEqual([[1, 1, 1]]);
  });

  it("emits nothing from drain() until a segment's stencil is complete", () => {
    const g = new StrokeGeometry(OPTS);
    g.pushSamples([
      [0, 0, 0],
      [10, 0, 0],
    ]);
    // Only two controls → no finalized segment yet; head carries feedback.
    expect(g.drain()).toEqual([]);
    expect(g.head()).toEqual([10, 0, 0]);
    // finish() finalizes the lone segment and reaches the endpoint.
    const tail = g.finish();
    expect(tail.length).toBeGreaterThan(0);
    expectVecClose(g.canonical()[0], [0, 0, 0]);
    expectVecClose(g.canonical()[g.canonical().length - 1], [10, 0, 0]);
  });
});
