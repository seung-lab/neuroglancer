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
  cropNcdhwOutput,
  getRetainedOutputShape,
  planInferenceTiles,
  stitchCroppedTile,
} from "#src/inference/geometry.js";

const fixed: InferenceGeometry = {
  inputShape: [20, 80, 80],
  inputSpacing: [40, 16, 16],
  rawOutputShape: [20, 80, 80],
  outputSpacing: [40, 16, 16],
  rawOutputOrigin: [0, 0, 0],
  cropBefore: [2, 10, 10],
  cropAfter: [2, 10, 10],
  outputChannels: 4,
};

// Center alignment: (19 * 40 - 99 * 8) / 2 = -16, not zero.
const upsampled: InferenceGeometry = {
  ...fixed,
  rawOutputShape: [100, 80, 80],
  outputSpacing: [8, 16, 16],
  rawOutputOrigin: [-16, 0, 0],
  cropBefore: [10, 10, 10],
  cropAfter: [10, 10, 10],
};

const inputBounds: VoxelBox = { origin: [0, 0, 0], shape: [200, 500, 500] };
const options = { inputBounds };
const roi: VoxelBox = { origin: [18, 70, 130], shape: [17, 61, 121] };
const count = (shape: Zyx) => shape[0] * shape[1] * shape[2];

function index(shape: Zyx, c: number, z: number, y: number, x: number) {
  return ((c * shape[0] + z) * shape[1] + y) * shape[2] + x;
}

function value(c: number, z: number, y: number, x: number) {
  return c * 4_000_000 + z * 10_000 + y * 100 + x;
}

describe("geometry validation", () => {
  it.each([
    "inputShape",
    "rawOutputShape",
    "inputSpacing",
    "outputSpacing",
    "rawOutputOrigin",
    "cropBefore",
    "cropAfter",
  ] as const)("rejects sparse %s triples", (field) => {
    const sparse = [...fixed[field]];
    delete sparse[0];
    expect(() => getRetainedOutputShape({ ...fixed, [field]: sparse })).toThrow(
      "ZYX triple",
    );
  });
});

describe("planInferenceTiles", () => {
  it("tiles the output ROI, preserving full inputs and trimming only final outputs", () => {
    expect(getRetainedOutputShape(fixed)).toEqual([16, 60, 60]);
    const tiles = [...planInferenceTiles(fixed, roi, options)];
    expect(tiles).toHaveLength(12);
    expect(tiles[0]).toEqual({
      input: { origin: [16, 60, 120], shape: [20, 80, 80] },
      output: { origin: [18, 70, 130], shape: [16, 60, 60] },
    });
    expect(tiles[1].output.origin).toEqual([18, 70, 190]);
    expect(tiles[3].output.origin).toEqual([18, 130, 130]);
    expect(tiles.at(-1)).toEqual({
      input: { origin: [32, 120, 240], shape: [20, 80, 80] },
      output: { origin: [34, 130, 250], shape: [1, 1, 1] },
    });
    expect(
      tiles.every((tile) => count(tile.input.shape) === 20 * 80 * 80),
    ).toBe(true);
  });

  it("does not add extra tiles for exact multiples", () => {
    const tiles = [
      ...planInferenceTiles(
        fixed,
        { origin: [2, 10, 10], shape: [32, 120, 120] },
        options,
      ),
    ];
    expect(tiles).toHaveLength(8);
    expect(tiles.every((tile) => tile.output.shape.join() === "16,60,60")).toBe(
      true,
    );
  });

  it("keeps a full input even for a one-voxel ROI", () => {
    expect([
      ...planInferenceTiles(
        fixed,
        { origin: [2, 10, 10], shape: [1, 1, 1] },
        options,
      ),
    ]).toEqual([
      {
        input: { origin: [0, 0, 0], shape: fixed.inputShape },
        output: { origin: [2, 10, 10], shape: [1, 1, 1] },
      },
    ]);
  });

  it("aligns physical centers for unequal resolutions and anisotropic spacing", () => {
    const outputRoi: VoxelBox = { origin: [8, 10, 10], shape: [81, 61, 61] };
    expect(getRetainedOutputShape(upsampled)).toEqual([80, 60, 60]);
    const tiles = [...planInferenceTiles(upsampled, outputRoi, options)];
    expect(tiles).toHaveLength(8);
    expect(tiles[0].input.origin).toEqual([0, 0, 0]);
    expect(tiles.at(-1)?.input).toEqual({
      origin: [16, 60, 60],
      shape: [20, 80, 80],
    });
    expect(tiles.at(-1)?.output).toEqual({
      origin: [88, 70, 70],
      shape: [1, 1, 1],
    });
    for (const tile of tiles) {
      for (let axis = 0; axis < 3; ++axis) {
        const inputCenter =
          (tile.input.origin[axis] + (upsampled.inputShape[axis] - 1) / 2) *
          upsampled.inputSpacing[axis];
        const rawFirstCenter =
          tile.input.origin[axis] * upsampled.inputSpacing[axis] +
          upsampled.rawOutputOrigin[axis];
        const outputCenter =
          rawFirstCenter +
          ((upsampled.rawOutputShape[axis] - 1) / 2) *
            upsampled.outputSpacing[axis];
        expect(outputCenter).toBe(inputCenter);
        expect(
          rawFirstCenter +
            upsampled.cropBefore[axis] * upsampled.outputSpacing[axis],
        ).toBe(tile.output.origin[axis] * upsampled.outputSpacing[axis]);
      }
    }
  });

  it("supports asymmetric output crops and a nonzero physical raw origin", () => {
    const geometry: InferenceGeometry = {
      ...fixed,
      rawOutputOrigin: [80, -16, 32],
      cropBefore: [1, 3, 5],
      cropAfter: [4, 7, 9],
    };
    expect(getRetainedOutputShape(geometry)).toEqual([15, 70, 66]);
    const [tile] = planInferenceTiles(
      geometry,
      { origin: [13, 22, 37], shape: [1, 1, 1] },
      options,
    );
    expect(tile.input.origin).toEqual([10, 20, 30]);
  });

  it("supports negative global indices when the input bounds allow them", () => {
    const [tile] = planInferenceTiles(
      fixed,
      { origin: [-8, -10, -20], shape: [1, 1, 1] },
      {
        inputBounds: { origin: [-100, -100, -100], shape: [200, 200, 200] },
      },
    );
    expect(tile.input.origin).toEqual([-10, -20, -30]);
  });

  it("allows normal floating-point roundoff, not fractional alignment", () => {
    const geometry = {
      ...fixed,
      inputSpacing: [0.1, 0.2, 0.3] as Zyx,
      outputSpacing: [0.1, 0.2, 0.3] as Zyx,
    };
    expect(
      [...planInferenceTiles(geometry, roi, options)][0].input.origin,
    ).toEqual([16, 60, 120]);
    expect(() =>
      planInferenceTiles(
        upsampled,
        { origin: [9, 10, 10], shape: [1, 1, 1] },
        options,
      ),
    ).toThrow("Fractional input alignment");
    expect(() =>
      planInferenceTiles(
        { ...fixed, rawOutputOrigin: [20, 0, 0] },
        roi,
        options,
      ),
    ).toThrow("Fractional input alignment");
  });

  it("rejects a fractional stride before yielding, but permits a single aligned tile", () => {
    const geometry: InferenceGeometry = {
      ...upsampled,
      cropAfter: [11, 10, 10],
    };
    expect([
      ...planInferenceTiles(
        geometry,
        { origin: [8, 10, 10], shape: [79, 1, 1] },
        options,
      ),
    ]).toHaveLength(1);
    expect(() =>
      planInferenceTiles(
        geometry,
        { origin: [8, 10, 10], shape: [80, 1, 1] },
        options,
      ),
    ).toThrow("Fractional input alignment");
  });

  it("accepts exact input/output bounds and rejects one-voxel violations eagerly", () => {
    const request: VoxelBox = { origin: [2, 10, 10], shape: [17, 1, 1] };
    const exact = {
      inputBounds: { origin: [0, 0, 0] as Zyx, shape: [36, 80, 80] as Zyx },
      outputBounds: request,
    };
    expect([...planInferenceTiles(fixed, request, exact)]).toHaveLength(2);
    expect(() =>
      planInferenceTiles(fixed, request, {
        ...exact,
        inputBounds: { origin: [0, 0, 0], shape: [35, 80, 80] },
      }),
    ).toThrow("Full input tile exceeds input bounds");
    expect(() =>
      planInferenceTiles(fixed, request, {
        ...exact,
        inputBounds: { origin: [1, 0, 0], shape: [36, 80, 80] },
      }),
    ).toThrow("Full input tile exceeds input bounds");
    expect(() =>
      planInferenceTiles(fixed, request, {
        ...exact,
        outputBounds: { origin: [2, 10, 10], shape: [16, 1, 1] },
      }),
    ).toThrow("Output ROI exceeds output bounds");
    expect(() =>
      planInferenceTiles(fixed, request, {
        ...exact,
        outputBounds: { origin: [3, 10, 10], shape: [17, 1, 1] },
      }),
    ).toThrow("Output ROI exceeds output bounds");
  });

  it("bounds the tile count without materializing a list", () => {
    expect(() =>
      planInferenceTiles(fixed, roi, { ...options, maxTiles: 11 }),
    ).toThrow("Tile count 12 exceeds maxTiles 11");
    expect([
      ...planInferenceTiles(fixed, roi, { ...options, maxTiles: 12 }),
    ]).toHaveLength(12);
    expect(() =>
      planInferenceTiles(
        fixed,
        { origin: [2, 10, 10], shape: [1_600_001, 1, 1] },
        options,
      ),
    ).toThrow("exceeds maxTiles 100000");
    const plan = planInferenceTiles(fixed, roi, options);
    expect(plan.next).toBeTypeOf("function");
    expect(plan.next().done).toBe(false);
  });

  it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid maxTiles %s",
    (maxTiles) => {
      expect(() =>
        planInferenceTiles(fixed, roi, { ...options, maxTiles }),
      ).toThrow("maxTiles");
    },
  );

  it("snapshots the plan and gives each tile independent arrays", () => {
    const request = {
      origin: [18, 70, 130] as [number, number, number],
      shape: [17, 61, 121] as [number, number, number],
    };
    const inputShape: [number, number, number] = [20, 80, 80];
    const plan = planInferenceTiles({ ...fixed, inputShape }, request, options);
    request.origin[0] = 100;
    request.shape[0] = 1;
    inputShape[0] = 1;
    const first = plan.next().value!;
    (first.input.shape as [number, number, number])[0] = 999;
    const second = plan.next().value!;
    expect(second.input.shape).toEqual([20, 80, 80]);
    expect(second.output.origin).toEqual([18, 70, 190]);
    expect([...plan]).toHaveLength(10);
  });
});

describe("geometry validation", () => {
  it.each<Partial<InferenceGeometry>>([
    { inputShape: [0, 80, 80] },
    { rawOutputShape: [20, 80.5, 80] },
    { inputSpacing: [0, 16, 16] },
    { inputSpacing: [-40, 16, 16] },
    { outputSpacing: [NaN, 16, 16] },
    { outputSpacing: [40, Infinity, 16] },
    { rawOutputOrigin: [Infinity, 0, 0] },
    { cropBefore: [-1, 10, 10] },
    { cropAfter: [2, 0.5, 10] },
    { cropAfter: [18, 10, 10] },
    { outputChannels: 0 },
    { outputChannels: 1.5 },
    { rawOutputShape: [Number.MAX_SAFE_INTEGER, 80, 80] },
    { outputChannels: Number.MAX_SAFE_INTEGER },
  ])("rejects invalid geometry %j", (change) => {
    expect(() => getRetainedOutputShape({ ...fixed, ...change })).toThrow();
  });

  it.each<VoxelBox>([
    { origin: [0.5, 0, 0], shape: [1, 1, 1] },
    { origin: [NaN, 0, 0], shape: [1, 1, 1] },
    { origin: [0, 0, 0], shape: [0, 1, 1] },
    { origin: [0, 0, 0], shape: [-1, 1, 1] },
    { origin: [0, 0, 0], shape: [1, 1.5, 1] },
    { origin: [Number.MAX_SAFE_INTEGER, 0, 0], shape: [1, 1, 1] },
    { origin: [0, 0, 0], shape: [Number.MAX_SAFE_INTEGER, 2, 1] },
  ])("rejects invalid ROI and bounds %j", (box) => {
    expect(() => planInferenceTiles(fixed, box, options)).toThrow();
    expect(() =>
      planInferenceTiles(fixed, roi, { inputBounds: box }),
    ).toThrow();
    expect(() =>
      planInferenceTiles(fixed, roi, { ...options, outputBounds: box }),
    ).toThrow();
  });
});

describe("cropNcdhwOutput", () => {
  it("crops asymmetric halos in every channel without changing or aliasing the raw data", () => {
    const geometry: InferenceGeometry = {
      ...fixed,
      inputShape: [4, 5, 7],
      rawOutputShape: [4, 5, 7],
      cropBefore: [1, 2, 1],
      cropAfter: [1, 1, 2],
    };
    const raw = Float32Array.from(
      { length: 4 * 4 * 5 * 7 },
      (_, i) => i + 0.25,
    );
    const before = raw.slice();
    const cropped = cropNcdhwOutput(raw, geometry);
    expect(getRetainedOutputShape(geometry)).toEqual([2, 2, 4]);
    expect(cropped).toHaveLength(4 * 2 * 2 * 4);
    for (let c = 0; c < 4; ++c) {
      for (let z = 0; z < 2; ++z) {
        for (let y = 0; y < 2; ++y) {
          for (let x = 0; x < 4; ++x) {
            expect(cropped[index([2, 2, 4], c, z, y, x)]).toBe(
              raw[index([4, 5, 7], c, z + 1, y + 2, x + 1)],
            );
          }
        }
      }
    }
    expect(raw).toEqual(before);
    expect(cropped.buffer).not.toBe(raw.buffer);
  });

  it("copies all channels even with no crop", () => {
    const geometry = {
      ...fixed,
      rawOutputShape: [1, 1, 2] as Zyx,
      cropBefore: [0, 0, 0] as Zyx,
      cropAfter: [0, 0, 0] as Zyx,
    };
    const raw = Float32Array.of(1, 2, 3, 4, 5, 6, 7, 8);
    expect(cropNcdhwOutput(raw, geometry)).toEqual(raw);
    expect(cropNcdhwOutput(raw, geometry)).not.toBe(raw);
  });

  it.each([-1, 1])("rejects raw buffers with length mismatch %s", (delta) => {
    expect(() =>
      cropNcdhwOutput(
        new Float32Array(4 * count(fixed.rawOutputShape) + delta),
        fixed,
      ),
    ).toThrow("Raw NCDHW output length");
  });
});

describe("crop and stitch integration", () => {
  it.each([
    { name: "fixed equal resolution", geometry: fixed, outputRoi: roi },
    {
      name: "center-aligned upsampled Z",
      geometry: upsampled,
      outputRoi: { origin: [8, 10, 10], shape: [81, 61, 61] } as VoxelBox,
    },
  ])(
    "writes each ROI voxel exactly once in every channel: $name",
    ({ geometry, outputRoi }) => {
      const destination = new Float32Array(
        geometry.outputChannels * count(outputRoi.shape),
      ).fill(NaN);
      const expected = destination.slice();
      const coverage = new Uint8Array(count(outputRoi.shape));
      for (const tile of planInferenceTiles(geometry, outputRoi, options)) {
        const raw = new Float32Array(
          geometry.outputChannels * count(geometry.rawOutputShape),
        );
        const rawOrigin = tile.input.origin.map(
          (i, axis) =>
            (i * geometry.inputSpacing[axis] + geometry.rawOutputOrigin[axis]) /
            geometry.outputSpacing[axis],
        );
        for (let c = 0; c < geometry.outputChannels; ++c) {
          for (let z = 0; z < geometry.rawOutputShape[0]; ++z) {
            for (let y = 0; y < geometry.rawOutputShape[1]; ++y) {
              for (let x = 0; x < geometry.rawOutputShape[2]; ++x) {
                raw[index(geometry.rawOutputShape, c, z, y, x)] = value(
                  c,
                  rawOrigin[0] + z,
                  rawOrigin[1] + y,
                  rawOrigin[2] + x,
                );
              }
            }
          }
        }
        const cropped = cropNcdhwOutput(raw, geometry);
        stitchCroppedTile(
          cropped,
          destination,
          geometry,
          outputRoi,
          tile.output,
        );
        for (let z = 0; z < tile.output.shape[0]; ++z) {
          for (let y = 0; y < tile.output.shape[1]; ++y) {
            for (let x = 0; x < tile.output.shape[2]; ++x) {
              const local = [z, y, x].map(
                (r, axis) =>
                  tile.output.origin[axis] - outputRoi.origin[axis] + r,
              );
              ++coverage[
                index(outputRoi.shape, 0, local[0], local[1], local[2])
              ];
            }
          }
        }
      }
      for (let c = 0; c < geometry.outputChannels; ++c) {
        for (let z = 0; z < outputRoi.shape[0]; ++z) {
          for (let y = 0; y < outputRoi.shape[1]; ++y) {
            for (let x = 0; x < outputRoi.shape[2]; ++x) {
              expected[index(outputRoi.shape, c, z, y, x)] = value(
                c,
                outputRoi.origin[0] + z,
                outputRoi.origin[1] + y,
                outputRoi.origin[2] + x,
              );
            }
          }
        }
      }
      expect(coverage.every((n) => n === 1)).toBe(true);
      // Compare every element without building a multi-million-element diff.
      expect(destination.findIndex((n, i) => n !== expected[i])).toBe(-1);
    },
  );
});

describe("stitchCroppedTile validation", () => {
  const outputRoi: VoxelBox = { origin: [18, 70, 130], shape: [2, 3, 4] };
  const cropped = new Float32Array(4 * 16 * 60 * 60);

  it("writes only the requested prefix and preserves other destination voxels", () => {
    const source = Float32Array.from(cropped, (_, i) => i);
    const destination = new Float32Array(4 * 2 * 3 * 4).fill(-1);
    stitchCroppedTile(source, destination, fixed, outputRoi, {
      origin: [19, 72, 133],
      shape: [1, 1, 1],
    });
    for (let c = 0; c < 4; ++c) {
      const channel = destination.subarray(c * 24, (c + 1) * 24);
      expect(channel.subarray(0, 23).every((x) => x === -1)).toBe(true);
      expect(channel[23]).toBe(source[c * 16 * 60 * 60]);
    }
  });

  it.each<VoxelBox>([
    { origin: [17, 70, 130], shape: [1, 1, 1] },
    { origin: [20, 70, 130], shape: [2, 1, 1] },
    { origin: [18, 73, 130], shape: [1, 4, 1] },
    { origin: [18, 70, 134], shape: [1, 1, 5] },
    { origin: [18, 70.5, 130], shape: [1, 1, 1] },
  ])("rejects invalid tile %j before writing", (tile) => {
    const destination = new Float32Array(4 * 2 * 3 * 4).fill(-1);
    expect(() =>
      stitchCroppedTile(cropped, destination, fixed, outputRoi, tile),
    ).toThrow();
    expect(destination.every((x) => x === -1)).toBe(true);
  });

  it("clips full patches on all six faces and preserves exact channel-first values", () => {
    const source = Float32Array.from(cropped, (_, i) =>
      i % 2 ? -i / 8 : i / 4,
    );
    for (const origin of [
      [17, 69, 129],
      [19, 71, 131],
    ] as const) {
      const destination = new Float32Array(4 * 2 * 3 * 4).fill(NaN);
      const tile = { origin, shape: [2, 3, 4] as Zyx };
      stitchCroppedTile(source, destination, fixed, outputRoi, tile);
      for (let c = 0; c < 4; ++c)
        for (let z = 0; z < 2; ++z)
          for (let y = 0; y < 3; ++y)
            for (let x = 0; x < 4; ++x) {
              const local = [
                z + 18 - origin[0],
                y + 70 - origin[1],
                x + 130 - origin[2],
              ];
              const target = index(outputRoi.shape, c, z, y, x);
              if (local.every((v, axis) => v >= 0 && v < tile.shape[axis])) {
                expect(destination[target]).toBe(
                  source[index([16, 60, 60], c, local[0], local[1], local[2])],
                );
              } else {
                expect(destination[target]).toBeNaN();
              }
            }
    }
  });

  it.each([NaN, Infinity, -Infinity])(
    "rejects nonfinite full predictions (%s) before any write",
    (bad) => {
      const source = cropped.slice();
      source[source.length - 1] = bad;
      const destination = new Float32Array(4 * 2 * 3 * 4).fill(-1);
      expect(() =>
        stitchCroppedTile(source, destination, fixed, outputRoi, outputRoi),
      ).toThrow("finite");
      expect(destination.every((x) => x === -1)).toBe(true);
    },
  );

  it("rejects a tile larger than the retained crop even if it fits the ROI", () => {
    expect(() =>
      stitchCroppedTile(
        cropped,
        new Float32Array(4 * 17 * 60 * 60),
        fixed,
        { origin: [0, 0, 0], shape: [17, 60, 60] },
        { origin: [0, 0, 0], shape: [17, 60, 60] },
      ),
    ).toThrow("retained output bounds");
  });

  it("rejects bad source/destination lengths and overlapping buffers", () => {
    const destination = new Float32Array(4 * 2 * 3 * 4).fill(-1);
    expect(() =>
      stitchCroppedTile(
        cropped.subarray(1),
        destination,
        fixed,
        outputRoi,
        outputRoi,
      ),
    ).toThrow("length");
    expect(destination.every((x) => x === -1)).toBe(true);
    expect(() =>
      stitchCroppedTile(
        cropped,
        destination.subarray(1),
        fixed,
        outputRoi,
        outputRoi,
      ),
    ).toThrow("length");
    expect(() =>
      stitchCroppedTile(
        cropped,
        cropped.subarray(0, destination.length),
        fixed,
        outputRoi,
        outputRoi,
      ),
    ).toThrow("must not alias");
  });
});
