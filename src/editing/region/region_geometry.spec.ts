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
  BOX_EDGE_VERTEX_COUNT,
  buildUnitBoxEdgeVertices,
  planeIntersectsBox,
} from "#src/editing/region/region_geometry.js";
import { vec3 } from "#src/util/geom.js";

describe("buildUnitBoxEdgeVertices", () => {
  const verts = buildUnitBoxEdgeVertices();

  it("emits 24 vertices (12 edges × 2 endpoints) with coords in {0,1}", () => {
    expect(verts.length).toBe(BOX_EDGE_VERTEX_COUNT * 3);
    for (const c of verts) {
      expect(c === 0 || c === 1).toBe(true);
    }
  });

  it("each edge's endpoints differ in exactly one axis", () => {
    for (let e = 0; e < 12; ++e) {
      const a = verts.subarray(e * 6, e * 6 + 3);
      const b = verts.subarray(e * 6 + 3, e * 6 + 6);
      const differing = [0, 1, 2].filter((axis) => a[axis] !== b[axis]);
      expect(differing.length).toBe(1);
    }
  });

  it("covers all 12 unique edges of the unit cube", () => {
    const keys = new Set<string>();
    for (let e = 0; e < 12; ++e) {
      const a = Array.from(verts.subarray(e * 6, e * 6 + 3));
      const b = Array.from(verts.subarray(e * 6 + 3, e * 6 + 6));
      // Canonical edge key: endpoints sorted so direction doesn't matter.
      const [k0, k1] = [a.join(","), b.join(",")].sort();
      keys.add(`${k0}|${k1}`);
    }
    expect(keys.size).toBe(12);
  });
});

describe("planeIntersectsBox", () => {
  const lo = vec3.fromValues(10, 20, 30);
  const hi = vec3.fromValues(40, 60, 80);

  it("returns true for an axis-aligned plane through the box", () => {
    const normal = vec3.fromValues(0, 0, 1);
    expect(planeIntersectsBox(lo, hi, normal, 50)).toBe(true);
  });

  it("returns false for planes beyond either face", () => {
    const normal = vec3.fromValues(0, 0, 1);
    expect(planeIntersectsBox(lo, hi, normal, 29)).toBe(false);
    expect(planeIntersectsBox(lo, hi, normal, 81)).toBe(false);
  });

  it("returns true for planes exactly on a face (epsilon)", () => {
    const normal = vec3.fromValues(0, 0, 1);
    expect(planeIntersectsBox(lo, hi, normal, 30)).toBe(true);
    expect(planeIntersectsBox(lo, hi, normal, 80)).toBe(true);
  });

  it("handles negative normal components", () => {
    const normal = vec3.fromValues(0, 0, -1);
    expect(planeIntersectsBox(lo, hi, normal, -50)).toBe(true);
    expect(planeIntersectsBox(lo, hi, normal, -81)).toBe(false);
  });

  it("handles oblique normals", () => {
    const normal = vec3.normalize(vec3.create(), vec3.fromValues(1, 1, 1));
    // Corner projections range over [dot(n, lo), dot(n, hi)] for positive n.
    const dLo = vec3.dot(normal, lo);
    const dHi = vec3.dot(normal, hi);
    expect(planeIntersectsBox(lo, hi, normal, (dLo + dHi) / 2)).toBe(true);
    expect(planeIntersectsBox(lo, hi, normal, dLo - 1)).toBe(false);
    expect(planeIntersectsBox(lo, hi, normal, dHi + 1)).toBe(false);
  });

  it("handles a degenerate (zero-extent) box", () => {
    const flatHi = vec3.fromValues(40, 60, 30);
    const normal = vec3.fromValues(0, 0, 1);
    expect(planeIntersectsBox(lo, flatHi, normal, 30)).toBe(true);
    expect(planeIntersectsBox(lo, flatHi, normal, 31)).toBe(false);
  });
});
