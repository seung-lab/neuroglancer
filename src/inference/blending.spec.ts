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
import type {
  InferenceGeometry,
  VoxelBox,
  Zyx,
} from "#src/inference/geometry.js";
import {
  blendCroppedTile,
  cropNcdhwOutput,
  getBlendedOutputBounds,
  getInferenceStrides,
  makeWuPatchMask,
  planBlendedInferenceTiles,
  stitchCroppedTile,
} from "#src/inference/geometry.js";
import { makeNooversegGeometry } from "#src/inference/model.js";
import golden from "#testdata/inference/wu_bump.json";

function zyx(values: readonly number[]): Zyx {
  expect(values).toHaveLength(3);
  return [values[0], values[1], values[2]];
}

const geometry = makeNooversegGeometry([40e-9, 16e-9, 16e-9]);
const inputBounds: VoxelBox = { origin: [0, 0, 0], shape: [40, 160, 160] };
const options = { inputBounds };
const spatialSize = 16 * 60 * 60;
const patchMask = makeWuPatchMask([16, 60, 60], [10, 40, 40]);

// Pointwise analytic oracle: no production mask generation or array translation.
function referenceBump(z: number, y: number, x: number) {
  const bump = (p: number[]) =>
    Math.exp(
      p.reduce((sum, v, axis) => {
        const u = (2 * (v + 1)) / ([16, 60, 60][axis] + 1) - 1;
        return sum - 1 / (1 - u * u);
      }, 0),
    );
  const minimum = bump([0, 0, 0]);
  return (
    1 + ((bump([z, y, x]) - minimum) * 999999) / (bump([7, 29, 29]) - minimum)
  );
}

function referenceWeight(z: number, y: number, x: number) {
  let sum = 0;
  for (const dz of [-10, 0, 10])
    for (const dy of [-40, 0, 40])
      for (const dx of [-40, 0, 40]) {
        const p = [z + dz, y + dy, x + dx];
        if (p.every((v, axis) => v >= 0 && v < [16, 60, 60][axis]))
          sum += referenceBump(p[0], p[1], p[2]);
      }
  return Math.fround(referenceBump(z, y, x) / sum);
}

function prediction(c: number, input: Zyx, z: number, y: number, x: number) {
  return (
    c * 1000 +
    input[0] * 2 +
    input[1] * 3 +
    input[2] * 5 +
    z * 7 +
    y * 11 +
    x * 13
  );
}

function blend(roi: VoxelBox, overlap = true) {
  const { tiles } = planBlendedInferenceTiles(geometry, roi, options, overlap);
  const size = roi.shape.reduce((a, b) => a * b, 1);
  const data = new Float32Array(4 * size);
  const weights = new Float64Array(size);
  const origins: Zyx[] = [];
  for (const tile of tiles) {
    origins.push(tile.input.origin);
    // The discarded halo must not enter the mean.
    const raw = new Float32Array(4 * 20 * 80 * 80).fill(1e20);
    for (let c = 0; c < 4; ++c)
      for (let z = 0; z < 16; ++z)
        for (let y = 0; y < 60; ++y)
          for (let x = 0; x < 60; ++x)
            raw[((c * 20 + z + 2) * 80 + y + 10) * 80 + x + 10] = prediction(
              c,
              tile.input.origin,
              z,
              y,
              x,
            );
    const cropped = cropNcdhwOutput(raw, geometry);
    if (overlap) {
      blendCroppedTile(
        cropped,
        data,
        weights,
        geometry,
        roi,
        tile.output,
        patchMask,
      );
    } else {
      stitchCroppedTile(cropped, data, geometry, roi, tile.output);
    }
  }
  return { data, weights, origins };
}

describe("nonoverlapping source-anchored stitching", () => {
  it("uses the full retained stride and trims a high final tile without averaging contexts", () => {
    expect(getInferenceStrides(geometry, false)).toEqual({
      inputStride: [16, 60, 60],
      outputStride: [16, 60, 60],
    });
    const roi: VoxelBox = { origin: [3, 11, 11], shape: [30, 119, 119] };
    const { data, origins } = blend(roi, false);
    expect(origins).toHaveLength(8);
    expect(origins[0]).toEqual([0, 0, 0]);
    expect(origins[7]).toEqual([16, 60, 60]);
    let i = 0;
    for (let c = 0; c < 4; ++c)
      for (let z = 3; z < 33; ++z)
        for (let y = 11; y < 130; ++y)
          for (let x = 11; x < 130; ++x) {
            const input = [
              Math.floor((z - 2) / 16) * 16,
              Math.floor((y - 10) / 60) * 60,
              Math.floor((x - 10) / 60) * 60,
            ] as Zyx;
            if (
              data[i++] !==
              prediction(
                c,
                input,
                z - input[0] - 2,
                y - input[1] - 10,
                x - input[2] - 10,
              )
            )
              throw new Error(`Direct-stitch mismatch at ${[c, z, y, x]}`);
          }
    const voxel: VoxelBox = { origin: [15, 55, 55], shape: [1, 1, 1] };
    expect(blend(voxel, false).data[0]).toBe(
      prediction(0, [0, 0, 0], 13, 45, 45),
    );
    expect(blend(voxel).data[0]).not.toBe(blend(voxel, false).data[0]);
  });

  it("partitions native bounds exactly once with odd inputs, shifted source and anisotropic output spacing", () => {
    const odd: InferenceGeometry = {
      inputShape: [5, 7, 9],
      rawOutputShape: [10, 7, 9],
      inputSpacing: [2, 3, 5],
      outputSpacing: [1, 3, 5],
      rawOutputOrigin: [0, 0, 0],
      cropBefore: [1, 1, 1],
      cropAfter: [1, 1, 1],
      outputChannels: 2,
    };
    const inputBounds: VoxelBox = { origin: [-5, 11, 23], shape: [14, 19, 25] };
    expect(() => getInferenceStrides(odd)).toThrow("Half-input stride");
    expect(getInferenceStrides(odd, false)).toEqual({
      inputStride: [4, 5, 7],
      outputStride: [8, 5, 7],
    });
    const bounds = getBlendedOutputBounds(odd, inputBounds, false);
    expect(bounds).toEqual({ origin: [-9, 12, 24], shape: [24, 15, 21] });
    const roi = { origin: [-8, 13, 25] as Zyx, shape: [22, 13, 19] as Zyx };
    const { tiles, total } = planBlendedInferenceTiles(
      odd,
      roi,
      { inputBounds },
      false,
    );
    const coverage = new Uint8Array(22 * 13 * 19);
    let count = 0;
    for (const tile of tiles) {
      ++count;
      for (let axis = 0; axis < 3; ++axis) {
        expect(
          (tile.input.origin[axis] - inputBounds.origin[axis]) %
            [4, 5, 7][axis],
        ).toBe(0);
        expect(
          tile.input.origin[axis] + odd.inputShape[axis],
        ).toBeLessThanOrEqual(
          inputBounds.origin[axis] + inputBounds.shape[axis],
        );
      }
      for (let z = 0; z < 22; ++z)
        for (let y = 0; y < 13; ++y)
          for (let x = 0; x < 19; ++x) {
            const point = [
              z + roi.origin[0],
              y + roi.origin[1],
              x + roi.origin[2],
            ];
            if (
              point.every(
                (p, axis) =>
                  p >= tile.output.origin[axis] &&
                  p < tile.output.origin[axis] + tile.output.shape[axis],
              )
            )
              ++coverage[(z * 13 + y) * 19 + x];
          }
    }
    expect(count).toBe(total);
    expect(total).toBe(27);
    expect(coverage.every((v) => v === 1)).toBe(true);
    expect(() =>
      planBlendedInferenceTiles(
        odd,
        { ...bounds, shape: [25, 15, 21] },
        { inputBounds },
        false,
      ),
    ).toThrow("exceeds");
  });

  it("rejects fractional native strides, but tolerates geometric floating rounding", () => {
    expect(() =>
      getInferenceStrides(
        { ...geometry, outputSpacing: [40e-9 * 1.01, 16e-9, 16e-9] },
        false,
      ),
    ).toThrow("Fractional");
    expect(
      getInferenceStrides(
        { ...geometry, outputSpacing: [40e-9 * (1 + 1e-10), 16e-9, 16e-9] },
        false,
      ).inputStride,
    ).toEqual([16, 60, 60]);
    expect(() =>
      getInferenceStrides(
        { ...geometry, outputSpacing: [40e-9 / 100, 16e-9, 16e-9] },
        false,
      ),
    ).toThrow();
  });
});

describe("half-input-stride post-crop blending", () => {
  it("matches independent Python Chunkflow golden masks, including float32 rounding", () => {
    for (const sampleCase of golden.cases) {
      const mask = makeWuPatchMask(
        zyx(sampleCase.shapeZYX),
        zyx(sampleCase.strideZYX),
      );
      const [, ny, nx] = sampleCase.shapeZYX;
      for (const {
        indexZYX: [z, y, x],
        weight,
      } of sampleCase.samples)
        expect(mask[(z * ny + y) * nx + x]).toBe(weight);
      expect(
        mask.every((weight) => Number.isFinite(weight) && weight > 0),
      ).toBe(true);
    }
  });
  it("matches independent golden blends and constants in all channels, including shifted tails", () => {
    for (const fixture of golden.blends) {
      expect(fixture.caseId).toBe("postcrop-16-60-60");
      const roi: VoxelBox = { origin: zyx(fixture.voxelZYX), shape: [1, 1, 1] };
      for (const constant of [false, true]) {
        const data = new Float32Array(4);
        const weights = new Float64Array(1);
        for (const contributor of fixture.contributors) {
          const source = new Float32Array(4 * spatialSize);
          for (let c = 0; c < 4; ++c)
            source.fill(
              (constant ? fixture.constantValue : contributor.prediction) *
                (c + 1) +
                c * 100,
              c * spatialSize,
              (c + 1) * spatialSize,
            );
          blendCroppedTile(
            source,
            data,
            weights,
            geometry,
            roi,
            {
              origin: zyx(contributor.originZYX),
              shape: [16, 60, 60],
            },
            patchMask,
          );
        }
        expect(weights[0]).toBe(fixture.weightSum);
        for (let c = 0; c < 4; ++c)
          expect(data[c]).toBeCloseTo(
            (constant ? fixture.constantOutput : fixture.output) * (c + 1) +
              c * 100,
            4,
          );
      }
    }
  });

  it("anchors full contexts to the source, with stride 10,40,40 and output overlap 6,20,20", () => {
    expect(getBlendedOutputBounds(geometry, inputBounds)).toEqual({
      origin: [2, 10, 10],
      shape: [36, 140, 140],
    });
    const roi: VoxelBox = { origin: [12, 50, 50], shape: [6, 20, 20] };
    const plan = planBlendedInferenceTiles(geometry, roi, options);
    const tiles = [...plan.tiles];
    expect(plan.total).toBe(8);
    expect(tiles.map((tile) => tile.input.origin)).toEqual([
      [0, 0, 0],
      [0, 0, 40],
      [0, 40, 0],
      [0, 40, 40],
      [10, 0, 0],
      [10, 0, 40],
      [10, 40, 0],
      [10, 40, 40],
    ]);
    expect(
      tiles.every(
        (tile) =>
          tile.input.shape.join() === "20,80,80" &&
          tile.output.shape.join() === "16,60,60",
      ),
    ).toBe(true);
    expect(tiles[0].output.origin).toEqual([2, 10, 10]);
    expect(tiles[7].output.origin).toEqual([12, 50, 50]);
  });

  it("Wu-weights distinct contextual predictions after cropping, clips both sides, and preserves every channel", () => {
    const roi: VoxelBox = { origin: [9, 45, 45], shape: [12, 30, 30] };
    const { data, weights } = blend(roi);
    const size = weights.length;
    const overlapCounts = new Set<number>();
    let i = 0;
    for (let z = 9; z < 21; ++z)
      for (let y = 45; y < 75; ++y)
        for (let x = 45; x < 75; ++x) {
          const contributors: Zyx[] = [];
          // Independent brute-force oracle scans the whole valid patch lattice.
          for (let iz = 0; iz <= 20; iz += 10)
            for (let iy = 0; iy <= 80; iy += 40)
              for (let ix = 0; ix <= 80; ix += 40)
                if (
                  z >= iz + 2 &&
                  z < iz + 18 &&
                  y >= iy + 10 &&
                  y < iy + 70 &&
                  x >= ix + 10 &&
                  x < ix + 70
                )
                  contributors.push([iz, iy, ix]);
          overlapCounts.add(contributors.length);
          const contributionWeights = contributors.map((p) =>
            referenceWeight(z - p[0] - 2, y - p[1] - 10, x - p[2] - 10),
          );
          const totalWeight = contributionWeights.reduce((a, b) => a + b, 0);
          expect(weights[i]).toBeCloseTo(totalWeight, 7);
          expect(weights[i]).toBeGreaterThan(0);
          for (let c = 0; c < 4; ++c) {
            const expected =
              contributors.reduce(
                (sum, p, index) =>
                  sum +
                  contributionWeights[index] *
                    prediction(
                      c,
                      p,
                      z - p[0] - 2,
                      y - p[1] - 10,
                      x - p[2] - 10,
                    ),
                0,
              ) / totalWeight;
            expect(data[c * size + i]).toBeCloseTo(expected, 2);
          }
          ++i;
        }
    expect(overlapCounts).toEqual(new Set([1, 2, 4, 8]));
  });

  it("is identical across ROI splits rather than re-anchoring at each requested origin", () => {
    const whole = blend({ origin: [9, 45, 45], shape: [1, 1, 60] });
    const left = blend({ origin: [9, 45, 45], shape: [1, 1, 23] });
    const right = blend({ origin: [9, 45, 68], shape: [1, 1, 37] });
    for (let c = 0; c < 4; ++c) {
      expect([
        ...left.data.slice(c * 23, (c + 1) * 23),
        ...right.data.slice(c * 37, (c + 1) * 37),
      ]).toEqual(Array.from(whole.data.subarray(c * 60, (c + 1) * 60)));
    }
  });

  it("includes contexts extending past a truncated live domain and excludes merely touching contexts", () => {
    const bounded = {
      inputBounds: { origin: [0, 0, 0] as Zyx, shape: [30, 80, 80] as Zyx },
    };
    const plan = planBlendedInferenceTiles(
      geometry,
      { origin: [2, 10, 10], shape: [16, 60, 60] },
      bounded,
    );
    expect(plan.total).toBe(2);
    expect([...plan.tiles].map((tile) => tile.output.origin)).toEqual([
      [2, 10, 10],
      [12, 10, 10],
    ]);
    expect(
      [
        ...planBlendedInferenceTiles(
          geometry,
          { origin: [18, 10, 10], shape: [1, 1, 1] },
          bounded,
        ).tiles,
      ].map((tile) => tile.input.origin),
    ).toEqual([[10, 0, 0]]);
  });

  it("keeps nonzero and negative native origins and physical voxel-center placement", () => {
    expect(
      getBlendedOutputBounds(geometry, {
        origin: [-7, 101, 203],
        shape: [53, 201, 261],
      }),
    ).toEqual({ origin: [-5, 111, 213], shape: [46, 180, 220] });
  });

  it("rejects holes, padding, invalid half strides and excessive work before yielding", () => {
    const roi: VoxelBox = { origin: [12, 50, 50], shape: [1, 1, 1] };
    expect(() =>
      planBlendedInferenceTiles(geometry, roi, { ...options, maxTiles: 7 }),
    ).toThrow("Tile count 8 exceeds maxTiles 7");
    expect(() =>
      planBlendedInferenceTiles(
        geometry,
        { origin: [1, 10, 10], shape: [1, 1, 1] },
        options,
      ),
    ).toThrow("input bounds");
    expect(() =>
      planBlendedInferenceTiles(
        geometry,
        { origin: [38, 10, 10], shape: [1, 1, 1] },
        options,
      ),
    ).toThrow("input bounds");
    expect(() =>
      planBlendedInferenceTiles(geometry, roi, {
        ...options,
        outputBounds: { origin: [12, 50, 51], shape: [1, 1, 1] },
      }),
    ).toThrow("output bounds");
    expect(() =>
      getBlendedOutputBounds(geometry, { ...inputBounds, shape: [19, 80, 80] }),
    ).toThrow("smaller");
    expect(() =>
      getBlendedOutputBounds(
        { ...geometry, inputShape: [21, 80, 80] },
        inputBounds,
      ),
    ).toThrow("Half-input stride");
    expect(() =>
      getBlendedOutputBounds(
        { ...geometry, cropAfter: [9, 10, 10] },
        inputBounds,
      ),
    ).toThrow("gaps");
  });

  it("uses an online normalized mean without overflowing finite float32 sums", () => {
    const roi: VoxelBox = { origin: [12, 50, 50], shape: [1, 1, 1] };
    const data = new Float32Array(4);
    const weights = new Float64Array(1);
    const large = new Float32Array(4 * spatialSize).fill(3e38);
    for (const tile of planBlendedInferenceTiles(geometry, roi, options).tiles)
      blendCroppedTile(
        large,
        data,
        weights,
        geometry,
        roi,
        tile.output,
        patchMask,
      );
    expect(weights[0]).toBeCloseTo(1, 7);
    expect([...data]).toEqual(Array(4).fill(large[0]));
  });

  it("normalizes a lone tiny corner weight without darkening dataset boundaries", () => {
    const roi: VoxelBox = { origin: [2, 10, 10], shape: [1, 1, 1] };
    const tile: VoxelBox = { origin: [2, 10, 10], shape: [16, 60, 60] };
    const data = new Float32Array(4);
    const weights = new Float64Array(1);
    const source = new Float32Array(4 * spatialSize);
    for (let c = 0; c < 4; ++c)
      source.fill((c + 1) * 7, c * spatialSize, (c + 1) * spatialSize);
    blendCroppedTile(source, data, weights, geometry, roi, tile, patchMask);
    expect(weights[0]).toBeGreaterThan(0);
    expect(weights[0]).toBeLessThan(0.001);
    expect([...data]).toEqual([7, 14, 21, 28]);
  });

  it("validates blend buffers and full crop geometry before writing", () => {
    const roi: VoxelBox = { origin: [2, 10, 10], shape: [1, 1, 1] };
    const tile: VoxelBox = { origin: [2, 10, 10], shape: [16, 60, 60] };
    const data = new Float32Array(4);
    const weights = new Float64Array(1);
    const source = new Float32Array(4 * spatialSize);
    expect(() =>
      blendCroppedTile(
        source,
        data,
        new Float64Array(2),
        geometry,
        roi,
        tile,
        patchMask,
      ),
    ).toThrow("lengths");
    expect(() =>
      blendCroppedTile(
        source,
        data,
        weights,
        geometry,
        roi,
        {
          ...tile,
          shape: [1, 1, 1],
        },
        patchMask,
      ),
    ).toThrow("full retained");
    expect(() =>
      blendCroppedTile(
        source,
        data,
        weights,
        geometry,
        roi,
        {
          ...tile,
          origin: [18, 10, 10],
        },
        patchMask,
      ),
    ).toThrow("intersect");
    expect(() =>
      blendCroppedTile(
        source,
        data,
        new Float64Array(data.buffer, 0, 1),
        geometry,
        roi,
        tile,
        patchMask,
      ),
    ).toThrow("alias");
    expect(() =>
      blendCroppedTile(
        source,
        data,
        weights,
        geometry,
        roi,
        tile,
        patchMask.subarray(1),
      ),
    ).toThrow("lengths");
    for (const bad of [0, -1, NaN, Infinity]) {
      const invalid = patchMask.slice();
      invalid[0] = bad;
      expect(() =>
        blendCroppedTile(source, data, weights, geometry, roi, tile, invalid),
      ).toThrow("finite and positive");
    }
    source[0] = Infinity;
    expect(() =>
      blendCroppedTile(source, data, weights, geometry, roi, tile, patchMask),
    ).toThrow("predictions must be finite");
    source[0] = 0;
    for (const bad of [-1, NaN, Infinity]) {
      weights[0] = bad;
      expect(() =>
        blendCroppedTile(source, data, weights, geometry, roi, tile, patchMask),
      ).toThrow("weights must be finite");
    }
    weights[0] = 0;
    expect([...data]).toEqual([0, 0, 0, 0]);
    expect(weights[0]).toBe(0);
  });

  it("validates mask geometry and supports degenerate bump ranges", () => {
    expect(() => makeWuPatchMask([0, 60, 60], [10, 40, 40])).toThrow("shape");
    expect(() => makeWuPatchMask([16, 60, 60], [10, 40.5, 40])).toThrow(
      "stride",
    );
    expect(() => makeWuPatchMask([16, 60, 60], [17, 40, 40])).toThrow("gaps");
    expect([...makeWuPatchMask([1, 1, 1], [1, 1, 1])]).toEqual([1]);
  });
});
