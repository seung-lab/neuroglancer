/**
 * @license
 * Copyright 2026 Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect } from "vitest";

import type {
  AlignmentModel,
  AlignmentPair,
} from "#src/alignment_link/alignment_link_math.js";
import {
  alignmentIsMirrored,
  alignmentRotationAngle,
  applyAlignmentTransform,
  fitAlignmentTransform,
} from "#src/alignment_link/alignment_link_math.js";

const mapped = (
  pairs: AlignmentPair[],
  pos: [number, number, number],
  model: AlignmentModel = "local",
) => {
  const fit = fitAlignmentTransform(pairs, pos, model);
  expect(fit).not.toBeNull();
  return { fit: fit!, out: applyAlignmentTransform(fit!, pos) };
};

describe("fitAlignmentTransform", () => {
  it("returns null with no pairs", () => {
    expect(fitAlignmentTransform([], [0, 0, 0], "local")).toBeNull();
  });

  it("ignores malformed and non-finite pairs", () => {
    const pairs = [
      { p: [0, 0], q: [1, 1, 1] },
      { p: [0, 0, NaN], q: [1, 1, 1] },
    ] as AlignmentPair[];
    expect(fitAlignmentTransform(pairs, [0, 0, 0], "local")).toBeNull();
  });

  it("fits a pure translation from a single line", () => {
    const pairs = [{ p: [100, 200, 10], q: [150, 180, 11] }];
    const { fit, out } = mapped(pairs, [120, 210, 10]);
    expect(fit.mode).toBe("translation");
    expect(out[0]).toBeCloseTo(170);
    expect(out[1]).toBeCloseTo(190);
    expect(out[2]).toBeCloseTo(11);
  });

  it("behaves like a constant offset when all lines share one translation", () => {
    const pairs = [
      { p: [0, 0, 0], q: [50, -20, 1] },
      { p: [100, 0, 0], q: [150, -20, 1] },
      { p: [0, 100, 0], q: [50, 80, 1] },
    ];
    const { out } = mapped(pairs, [500, 700, 0]);
    expect(out[0]).toBeCloseTo(550);
    expect(out[1]).toBeCloseTo(680);
    expect(out[2]).toBeCloseTo(1);
  });

  it("recovers a similarity from two lines", () => {
    // Rotation by 90 degrees, scale 2, then translate by (10, 5).
    const T = (p: number[]) => [10 - 2 * p[1], 5 + 2 * p[0], p[2] + 3];
    const pts = [
      [0, 0, 0],
      [100, 40, 0],
    ];
    const pairs = pts.map((p) => ({ p, q: T(p) }));
    const { fit, out } = mapped(pairs, [50, 20, 0]);
    expect(fit.mode).toBe("similarity");
    const expected = T([50, 20, 0]);
    expect(out[0]).toBeCloseTo(expected[0]);
    expect(out[1]).toBeCloseTo(expected[1]);
    expect(out[2]).toBeCloseTo(expected[2]);
  });

  it("recovers a full affine from three non-collinear lines", () => {
    // Anisotropic scale + shear + translation: not a similarity.
    const T = (p: number[]) => [
      1.5 * p[0] + 0.3 * p[1] + 7,
      -0.2 * p[0] + 0.8 * p[1] - 4,
      p[2] + 1,
    ];
    const pts = [
      [0, 0, 5],
      [200, 0, 5],
      [0, 150, 5],
    ];
    const pairs = pts.map((p) => ({ p, q: T(p) }));
    const { fit, out } = mapped(pairs, [80, 60, 5], "affine");
    expect(fit.mode).toBe("affine");
    const expected = T([80, 60, 5]);
    expect(out[0]).toBeCloseTo(expected[0]);
    expect(out[1]).toBeCloseTo(expected[1]);
    expect(out[2]).toBeCloseTo(expected[2]);
  });

  it("falls back to similarity for collinear points instead of exploding", () => {
    const T = (p: number[]) => [p[0] + 10, p[1] - 5, p[2]];
    const pts = [
      [0, 0, 0],
      [100, 100, 0],
      [200, 200, 0],
    ];
    const pairs = pts.map((p) => ({ p, q: T(p) }));
    const { fit, out } = mapped(pairs, [50, 50, 0]);
    expect(fit.mode).toBe("similarity");
    expect(out[0]).toBeCloseTo(60);
    expect(out[1]).toBeCloseTo(45);
  });

  it("respects a forced translation model", () => {
    const T = (p: number[]) => [2 * p[0], 2 * p[1], p[2]];
    const pts = [
      [0, 0, 0],
      [100, 0, 0],
      [0, 100, 0],
    ];
    const pairs = pts.map((p) => ({ p, q: T(p) }));
    const { fit } = mapped(pairs, [0, 0, 0], "translation");
    expect(fit.mode).toBe("translation");
    expect(fit.m00).toBe(1);
    expect(fit.m11).toBe(1);
  });

  it("localizes: nearby correspondences dominate distant ones", () => {
    // Two clusters with different translations; the target sits in cluster A.
    const clusterA = [
      { p: [0, 0, 0], q: [10, 0, 0] },
      { p: [50, 0, 0], q: [60, 0, 0] },
      { p: [0, 50, 0], q: [10, 50, 0] },
    ];
    const clusterB = [
      { p: [10000, 10000, 0], q: [10900, 10000, 0] },
      { p: [10050, 10000, 0], q: [10950, 10000, 0] },
      { p: [10000, 10050, 0], q: [10900, 10050, 0] },
    ];
    const { out } = mapped([...clusterA, ...clusterB], [25, 25, 0]);
    // Cluster A offset is +10 in x; cluster B (+900) must barely matter.
    expect(out[0]).toBeGreaterThan(30);
    expect(out[0]).toBeLessThan(45);
    expect(out[1]).toBeCloseTo(25, 0);
  });

  it("localizes in z: lines from another section pair are ignored", () => {
    const samePair = [{ p: [100, 100, 10], q: [120, 100, 11] }];
    const otherPair = [
      { p: [100, 100, 900], q: [600, 100, 901] },
      { p: [200, 100, 900], q: [700, 100, 901] },
    ];
    const { out } = mapped([...samePair, ...otherPair], [100, 100, 10]);
    expect(out[0]).toBeCloseTo(120, 0);
    expect(out[2]).toBeCloseTo(11, 0);
  });

  it("interpolates almost exactly at an annotation endpoint", () => {
    const pairs = [
      { p: [100, 100, 0], q: [250, 130, 1] },
      { p: [900, 500, 0], q: [1100, 480, 1] },
      { p: [400, 800, 0], q: [560, 790, 1] },
    ];
    const { out } = mapped(pairs, [100, 100, 0]);
    expect(out[0]).toBeCloseTo(250, 0);
    expect(out[1]).toBeCloseTo(130, 0);
  });

  it("degrades to translation instead of exploding the scale on near-coincident leader endpoints", () => {
    // Two lines drawn from almost the same leader landmark (0.36 px apart)
    // to follower points 144 px apart: the implied similarity scale is ~400x.
    const pairs = [
      { p: [20000, 10000, 0], q: [25000, 12000, 1] },
      { p: [20000.36, 10000, 0], q: [25144, 12000, 1] },
    ];
    const { fit, out } = mapped(pairs, [20050, 10000, 0], "similarity");
    expect(fit.mode).toBe("translation");
    // Sane output: near the mean offset, not slung 20,000 px away.
    expect(Math.abs(out[0] - 25122)).toBeLessThan(200);
  });

  it("caps the affine branch too when local weights concentrate on contradictory near-duplicates", () => {
    const pairs = [
      { p: [0, 0, 0], q: [0, 0, 0] },
      { p: [0.1, 0, 0], q: [500, 0, 0] }, // contradictory near-duplicate
      { p: [1000, 1000, 0], q: [1000, 1000, 0] },
    ];
    const fit = fitAlignmentTransform(pairs, [0, 0, 0], "local");
    expect(fit).not.toBeNull();
    const frob =
      fit!.m00 * fit!.m00 +
      fit!.m01 * fit!.m01 +
      fit!.m10 * fit!.m10 +
      fit!.m11 * fit!.m11;
    expect(frob).toBeLessThanOrEqual(1e4);
    const out = applyAlignmentTransform(fit!, [0, 0, 0]);
    expect(Math.abs(out[0])).toBeLessThan(1000);
    expect(Math.abs(out[1])).toBeLessThan(1000);
  });

  it("extracts the in-plane rotation angle of a fit", () => {
    // Pure translation: no rotation.
    const translation = mapped(
      [{ p: [0, 0, 0], q: [500, 100, 1] }],
      [0, 0, 0],
    ).fit;
    expect(alignmentRotationAngle(translation)).toBeCloseTo(0);

    // Similarity with rotation 90 degrees and scale 2.
    const T = (p: number[]) => [10 - 2 * p[1], 5 + 2 * p[0], p[2]];
    const pts = [
      [0, 0, 0],
      [100, 40, 0],
    ];
    const rotated = mapped(
      pts.map((p) => ({ p, q: T(p) })),
      [50, 20, 0],
    ).fit;
    expect(alignmentRotationAngle(rotated)).toBeCloseTo(Math.PI / 2);
  });

  it("detects mirrored (flipped-section) fits", () => {
    // Flip across x = 500: T(p) = (1000 - px, py).
    const T = (p: number[]) => [1000 - p[0], p[1], p[2] + 1];
    const pts = [
      [0, 0, 0],
      [100, 0, 0],
      [0, 100, 0],
    ];
    const pairs = pts.map((p) => ({ p, q: T(p) }));
    const { fit, out } = mapped(pairs, [50, 20, 0], "affine");
    expect(fit.mode).toBe("affine");
    expect(alignmentIsMirrored(fit)).toBe(true);
    // Positions still map correctly (mirrored motion).
    const expected = T([50, 20, 0]);
    expect(out[0]).toBeCloseTo(expected[0]);
    expect(out[1]).toBeCloseTo(expected[1]);

    const translation = mapped([{ p: [0, 0, 0], q: [10, 0, 0] }], [0, 0, 0]);
    expect(alignmentIsMirrored(translation.fit)).toBe(false);
  });

  it("round-trips: reverse fit approximately inverts the forward map", () => {
    const T = (p: number[]) => [
      1.2 * p[0] + 0.1 * p[1] + 30,
      -0.05 * p[0] + 0.9 * p[1] + 12,
      p[2] + 1,
    ];
    const pts = [
      [0, 0, 0],
      [300, 20, 0],
      [40, 250, 0],
      [280, 260, 0],
    ];
    const pairs = pts.map((p) => ({ p, q: T(p) }));
    const forward = mapped(pairs, [150, 130, 0]).out;
    const reversed = pairs.map(({ p, q }) => ({ p: q, q: p }));
    const back = mapped(reversed, forward).out;
    expect(back[0]).toBeCloseTo(150, 3);
    expect(back[1]).toBeCloseTo(130, 3);
    expect(back[2]).toBeCloseTo(0, 3);
  });
});
