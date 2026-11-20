/**
 * @license
 * Copyright 2026 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, expect, it } from "vitest";
import {
  extractWatershedMesh,
  MAX_WATERSHED_MESH_BYTES,
  MAX_WATERSHED_MESH_TRIANGLES,
  MAX_WATERSHED_MESH_VOXELS,
} from "#src/watershed/meshing/wasm.js";

function maskFrom(
  shape: readonly number[],
  inside: (x: number, y: number, z: number) => boolean,
): Uint8Array {
  const [x, y, z] = shape;
  const mask = new Uint8Array(x * y * z);
  for (let k = 0; k < z; ++k)
    for (let j = 0; j < y; ++j)
      for (let i = 0; i < x; ++i)
        mask[(k * y + j) * x + i] = inside(i, j, k) ? 255 : 0;
  return mask;
}

function normal(v: Float32Array, i: number): number[] {
  const ab = [v[i + 3] - v[i], v[i + 4] - v[i + 1], v[i + 5] - v[i + 2]];
  const ac = [v[i + 6] - v[i], v[i + 7] - v[i + 1], v[i + 8] - v[i + 2]];
  return [
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  ];
}

function expectClosed(v: Float32Array) {
  expect(v.length).toBeGreaterThan(0);
  // WASM returns triangle soup; match shared edges by coordinates, not index.
  const edges = new Map<string, number>();
  for (let i = 0; i < v.length; i += 9) {
    const vertices = [0, 3, 6].map((j) =>
      v.subarray(i + j, i + j + 3).join(","),
    );
    for (let j = 0; j < 3; ++j) {
      const [a, b] = [vertices[j], vertices[(j + 1) % 3]].sort();
      const key = `${a};${b}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  expect(new Set(edges.values())).toEqual(new Set([2]));
}

const singleton = () =>
  maskFrom([3, 3, 3], (x, y, z) => x === 1 && y === 1 && z === 1);

describe("browser WASM watershed marching cubes", () => {
  it("shares module initialization safely and owns inputs and outputs across concurrent calls", async () => {
    const input = singleton();
    const before = input.slice();
    const firstPromise = extractWatershedMesh(input, [3, 3, 3]);
    // The first call must already own its validated input even during WASM loading.
    input.fill(0);
    const [first, second, third] = await Promise.all([
      firstPromise,
      extractWatershedMesh(before, [3, 3, 3]),
      extractWatershedMesh(
        maskFrom([4, 3, 2], (x) => x >= 2),
        [4, 3, 2],
      ),
    ]);
    expect(first.vertexPositions).toEqual(second.vertexPositions);
    expect(first.vertexPositions.length).toBe(8 * 9);
    expectClosed(third.vertexPositions);
    expect(first.vertexPositions.buffer).not.toBe(
      second.vertexPositions.buffer,
    );
    expect(before).toEqual(singleton());
    const saved = first.vertexPositions.slice();
    // Force substantially larger native allocations / potential memory growth.
    const large = await extractWatershedMesh(
      maskFrom([38, 38, 38], (x, y, z) => (x + y + z) % 2 === 0),
      [38, 38, 38],
    );
    expect(large.indices.length / 3).toBeGreaterThan(4 * 37 ** 3);
    expect(
      large.vertexPositions.byteLength + large.indices.byteLength,
    ).toBeLessThanOrEqual(MAX_WATERSHED_MESH_BYTES);
    expect(first.vertexPositions).toEqual(saved);
    second.vertexPositions.fill(-1);
    expect(first.vertexPositions).toEqual(saved);
    expect(input.every((v) => v === 0)).toBe(true);
  });

  it("extracts an interior singleton as an outward-wound octahedron at voxel-center coordinates", async () => {
    const { vertexPositions: v, indices } = await extractWatershedMesh(
      singleton(),
      [3, 3, 3],
    );
    expect(indices).toEqual(Uint32Array.from({ length: 24 }, (_, i) => i));
    const vertices = new Set<string>();
    let volume = 0;
    let area = 0;
    for (let i = 0; i < v.length; i += 3)
      vertices.add(Array.from(v.subarray(i, i + 3)).join(","));
    expect(vertices).toEqual(
      new Set([
        "1,1.5,1.5",
        "2,1.5,1.5",
        "1.5,1,1.5",
        "1.5,2,1.5",
        "1.5,1.5,1",
        "1.5,1.5,2",
      ]),
    );
    for (let i = 0; i < v.length; i += 9) {
      const n = normal(v, i);
      const towardSurface = [0, 1, 2].map(
        (axis) => (v[i + axis] + v[i + 3 + axis] + v[i + 6 + axis]) / 3 - 1.5,
      );
      expect(
        n.reduce((sum, value, axis) => sum + value * towardSurface[axis], 0),
      ).toBeGreaterThan(0);
      area += Math.hypot(...n) / 2;
      volume += (v[i] * n[0] + v[i + 1] * n[1] + v[i + 2] * n[2]) / 6;
    }
    expect(volume).toBeCloseTo(1 / 6, 7);
    expect(area).toBeCloseTo(Math.sqrt(3), 7);
  });

  it.each([0, 1, 2])(
    "respects X-fastest XYZ layout for a plane normal to axis %s",
    async (axis) => {
      const shape = [4, 3, 2];
      const threshold = axis === 0 ? 2 : 1;
      const input = maskFrom(shape, (x, y, z) => [x, y, z][axis] >= threshold);
      const before = input.slice();
      const { vertexPositions: v } = await extractWatershedMesh(input, shape);
      const expectedArea = shape.reduce(
        (area, size, a) => (a === axis ? area : area * (size - 1)),
        1,
      );
      expectClosed(v);
      let area = 0;
      for (let i = 0; i < v.length; i += 9) {
        if ([0, 3, 6].some((j) => v[i + j + axis] !== threshold)) continue;
        const n = normal(v, i);
        expect(n[axis]).toBeLessThan(0);
        area += Math.hypot(...n) / 2;
      }
      expect(area).toBe(expectedArea);
      expect(input).toEqual(before);
    },
  );

  // Classic cube edges: four around the lower Z face, four around the
  // upper Z face, then four joining the faces. At isovalue 0.5 all emitted
  // vertices must be these edge midpoints in voxel-center coordinates.
  const edgeMidpoints = [
    [1, 0.5, 0.5],
    [1.5, 1, 0.5],
    [1, 1.5, 0.5],
    [0.5, 1, 0.5],
    [1, 0.5, 1.5],
    [1.5, 1, 1.5],
    [1, 1.5, 1.5],
    [0.5, 1, 1.5],
    [0.5, 0.5, 1],
    [1.5, 0.5, 1],
    [1.5, 1.5, 1],
    [0.5, 1.5, 1],
  ];
  it.each([
    { background: [0], edges: [0, 8, 3] },
    // Ambiguous complementary cases 5 and 250 emit *different* counts.
    { background: [0, 3], edges: [0, 8, 3, 1, 2, 10] },
    {
      background: [1, 2, 4, 5, 6, 7],
      edges: [3, 8, 2, 8, 10, 2, 8, 1, 10, 8, 0, 1],
    },
    { background: [0, 1, 3], edges: [3, 2, 10, 3, 10, 8, 8, 10, 9] },
    {
      background: [0, 2, 3, 4, 5],
      edges: [11, 10, 1, 11, 1, 7, 7, 1, 0, 7, 0, 9, 7, 9, 5],
    },
  ])(
    "preserves the interior cell mesh for background offsets $background",
    async ({ background, edges }) => {
      const mask = new Uint8Array(8).fill(255);
      for (const offset of background) mask[offset] = 0;
      const { vertexPositions, indices } = await extractWatershedMesh(
        mask,
        [2, 2, 2],
      );
      expect(vertexPositions.subarray(0, 3 * edges.length)).toEqual(
        Float32Array.from(edges.flatMap((edge) => edgeMidpoints[edge])),
      );
      expect(indices.subarray(0, edges.length)).toEqual(
        Uint32Array.from(edges, (_, i) => i),
      );
    },
  );

  it("closes a cut segment at the ROI boundary without changing the mask", async () => {
    const shape = [5, 6, 7];
    const mask = maskFrom(
      shape,
      (x, y, z) => x < 3 && y > 0 && y < 5 && z > 0 && z < 6,
    );
    const before = mask.slice();
    const { vertexPositions: v } = await extractWatershedMesh(mask, shape);
    expectClosed(v);
    const cap = [];
    for (let i = 0; i < v.length; i += 9) {
      if (v[i] === 0 && v[i + 3] === 0 && v[i + 6] === 0)
        cap.push(normal(v, i)[0]);
    }
    expect(cap).toHaveLength(2 * 3 * 4);
    expect(cap.every((x) => x < 0)).toBe(true);
    expect(mask).toEqual(before);
  });

  it("preserves an interior cavity when capping an ROI", async () => {
    const shape = [5, 5, 5];
    const { vertexPositions: solid } = await extractWatershedMesh(
      new Uint8Array(125).fill(255),
      shape,
    );
    const { vertexPositions: hollow } = await extractWatershedMesh(
      maskFrom(shape, (x, y, z) => x !== 2 || y !== 2 || z !== 2),
      shape,
    );
    expectClosed(solid);
    expectClosed(hollow);
    expect(hollow.length - solid.length).toBe(8 * 9);
    const cavity = [];
    for (let i = 0; i < hollow.length; i += 9) {
      if (
        hollow.subarray(i, i + 9).every((value) => value >= 2 && value <= 3)
      ) {
        cavity.push(hollow.subarray(i, i + 9));
      }
    }
    expect(cavity).toHaveLength(8);
  });

  it("returns no triangles for an all-background region", async () => {
    const result = await extractWatershedMesh(new Uint8Array(12), [3, 2, 2]);
    expect(result.indices.length).toBe(0);
    expect(result.vertexPositions.length).toBe(0);
  });

  it.each([
    [1, 3, 4],
    [4, 1, 3],
    [3, 4, 1],
  ])("caps a region one voxel thick (%s × %s × %s)", async (...shape) => {
    const axis = shape.indexOf(1);
    const { vertexPositions: v, indices } = await extractWatershedMesh(
      maskFrom(shape, (...xyz) =>
        xyz.every((value, a) => value === (a === axis ? 0 : 1)),
      ),
      shape,
    );
    expectClosed(v);
    expect(indices.length).toBe(24);
    expect(new Set(v.filter((_, i) => i % 3 === axis))).toEqual(
      new Set([0, 0.5, 1]),
    );
  });

  it("rejects malformed shape, mask values/length, and excessive voxel counts", async () => {
    for (const shape of [
      [0, 2, 2],
      [2, 2],
      [2, 2, 2.5],
      [NaN, 2, 2],
      [512, 512, 257],
    ]) {
      await expect(
        extractWatershedMesh(new Uint8Array(8), shape),
      ).rejects.toThrow(/shape|voxel limit/);
    }
    await expect(
      extractWatershedMesh(new Uint8Array(7), [2, 2, 2]),
    ).rejects.toThrow("matching XYZ shape");
    for (const invalid of [1, 127, 254]) {
      const mask = new Uint8Array(8);
      mask[0] = invalid;
      await expect(extractWatershedMesh(mask, [2, 2, 2])).rejects.toThrow(
        "0 or 255",
      );
    }
    // Thin regions still have to contain valid mask bytes.
    await expect(
      extractWatershedMesh(new Uint8Array([0, 1]), [2, 1, 1]),
    ).rejects.toThrow("0 or 255");
  });

  it("meshes a full 64 Mi-voxel mask with exact sparse-object geometry", async () => {
    const shape = [512, 512, 256];
    const mask = new Uint8Array(67_108_864);
    mask[(128 * 512 + 256) * 512 + 256] = 255;
    const expected = await extractWatershedMesh(singleton(), [3, 3, 3]);
    const saved = expected.vertexPositions.slice();
    const result = await extractWatershedMesh(mask, shape);
    expect(MAX_WATERSHED_MESH_VOXELS).toBe(67_108_864);
    const offset = [255, 255, 127];
    expect(result.vertexPositions).toEqual(
      saved.map((value, i) => value + offset[i % 3]),
    );
    expect(result.indices).toEqual(expected.indices);
    expect(result.indices.length).toBe(24);
    expect(expected.vertexPositions).toEqual(saved);
    expect(mask[(128 * 512 + 256) * 512 + 256]).toBe(255);
    expect(mask[0]).toBe(0);
    await expect(
      extractWatershedMesh(new Uint8Array(), [512, 512, 257]),
    ).rejects.toThrow("2**26 voxel limit");
    const recovered = await extractWatershedMesh(singleton(), [3, 3, 3]);
    expect(recovered.vertexPositions).toEqual(saved);
  }, 60_000);

  it("fits large parallel planes even when five triangles per mixed cell would exceed the cap", async () => {
    const shape = [401, 401, 2];
    const { vertexPositions, indices } = await extractWatershedMesh(
      maskFrom(shape, (_x, _y, z) => z === 1),
      shape,
    );
    const cellsPerPlane = 400 ** 2;
    expect(5 * 2 * cellsPerPlane).toBeGreaterThan(MAX_WATERSHED_MESH_TRIANGLES);
    let interior = 0;
    let cap = 0;
    for (let i = 2; i < vertexPositions.length; i += 9) {
      const z = vertexPositions[i];
      if (z !== vertexPositions[i + 3] || z !== vertexPositions[i + 6])
        continue;
      if (z === 1) ++interior;
      if (z === 2) ++cap;
    }
    expect(interior).toBe(2 * cellsPerPlane);
    expect(cap).toBe(2 * cellsPerPlane);
    expect(indices.length).toBe(vertexPositions.length / 3);
    expect(indices.every((value, i) => value === i)).toBe(true);
  });

  // 64 × 64 × 32 isolated boundary samples and interior samples, each
  // emitting eight triangles. Leave room for one more isolated sample.
  const shapeAtLimit = [128, 128, 66];
  const maskAtLimit = () =>
    maskFrom(
      shapeAtLimit,
      (x, y, z) => x % 2 === 0 && y % 2 === 0 && z % 2 === 0 && z < 64,
    );

  it("returns the entire mesh at the inclusive surface cap", async () => {
    const { vertexPositions, indices } = await extractWatershedMesh(
      maskAtLimit(),
      shapeAtLimit,
    );
    expect(8 * 64 * 64 * 32).toBe(MAX_WATERSHED_MESH_TRIANGLES);
    expect(vertexPositions.length).toBe(9 * MAX_WATERSHED_MESH_TRIANGLES);
    expect(indices.length).toBe(3 * MAX_WATERSHED_MESH_TRIANGLES);
    expect(indices[indices.length - 1]).toBe(indices.length - 1);
    expect(vertexPositions.byteLength + indices.byteLength).toBe(
      MAX_WATERSHED_MESH_BYTES,
    );
  });

  it("counts boundary triangles against the cap, rejects overflow, then recovers", async () => {
    const mask = maskAtLimit();
    mask[64 * 128 * 128] = 255;
    await expect(extractWatershedMesh(mask, shapeAtLimit)).rejects.toThrow(
      /surface budget exceeded.*1048576 triangles.*smaller region/i,
    );
    const recovered = await extractWatershedMesh(singleton(), [3, 3, 3]);
    expect(recovered.indices.length).toBe(24);
  });
});
