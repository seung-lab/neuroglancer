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
    expect(third.indices.length).toBe(4 * 3);
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
    expect(large.indices.length / 3).toBe(4 * 37 ** 3);
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
      const { vertexPositions: v, indices } = await extractWatershedMesh(
        input,
        shape,
      );
      const expectedArea = shape.reduce(
        (area, size, a) => (a === axis ? area : area * (size - 1)),
        1,
      );
      expect(indices.length / 3).toBe(2 * expectedArea);
      let area = 0;
      for (let i = 0; i < v.length; i += 3) {
        expect(v[i + axis]).toBe(threshold);
        for (let a = 0; a < 3; ++a) {
          expect(v[i + a]).toBeGreaterThanOrEqual(0.5);
          expect(v[i + a]).toBeLessThanOrEqual(shape[a] - 0.5);
        }
      }
      for (let i = 0; i < v.length; i += 9) {
        const n = normal(v, i);
        expect(n[axis]).toBeLessThan(0);
        area += Math.hypot(...n) / 2;
      }
      expect(area).toBe(expectedArea);
      expect(input).toEqual(before);
    },
  );

  it("leaves ROI boundaries open and removes a merged label's internal interface", async () => {
    const shape = [3, 2, 2];
    const left = await extractWatershedMesh(
      maskFrom(shape, (x) => x === 0),
      shape,
    );
    const right = await extractWatershedMesh(
      maskFrom(shape, (x) => x >= 1),
      shape,
    );
    expect(left.indices.length).toBe(6);
    expect(right.indices.length).toBe(6);
    const merged = await extractWatershedMesh(
      new Uint8Array(12).fill(255),
      shape,
    );
    expect(merged.indices.length).toBe(0);
    expect(merged.vertexPositions.length).toBe(0);
    const background = await extractWatershedMesh(new Uint8Array(12), shape);
    expect(background.indices.length).toBe(0);
  });

  it.each([
    [1, 3, 4],
    [4, 1, 3],
    [3, 4, 1],
  ])("returns no triangles for a thin region %s", async (...shape) => {
    const result = await extractWatershedMesh(
      maskFrom(shape, (x, y, z) => (x + y + z) % 2 === 0),
      shape,
    );
    expect(result.indices.length).toBe(0);
    expect(result.vertexPositions.length).toBe(0);
  });

  it("rejects malformed shape, mask values/length, and excessive voxel counts", async () => {
    for (const shape of [
      [0, 2, 2],
      [2, 2],
      [2, 2, 2.5],
      [NaN, 2, 2],
      [2 ** 21 + 1, 1, 1],
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
  });

  it("rejects high-complexity surfaces before extraction and recovers without truncation", async () => {
    const mask = maskFrom([40, 40, 40], (x, y, z) => (x + y + z) % 2 === 0);
    expect(mask.length).toBeLessThan(2 ** 21);
    expect(5 * 39 ** 3).toBeGreaterThan(MAX_WATERSHED_MESH_TRIANGLES);
    await expect(extractWatershedMesh(mask, [40, 40, 40])).rejects.toThrow(
      "surface budget exceeded",
    );
    const recovered = await extractWatershedMesh(singleton(), [3, 3, 3]);
    expect(recovered.indices.length).toBe(24);
  });
});
