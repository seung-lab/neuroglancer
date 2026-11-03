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
  copyWatershedResultChunk,
  getWatershedResultInfo,
  parseWatershedUrl,
} from "#src/datasource/watershed/base.js";
import type { WatershedResult } from "#src/watershed/base.js";
import { MAX_WATERSHED_VOXELS } from "#src/watershed/base.js";

function makeResult(): WatershedResult {
  return {
    data: Uint32Array.from({ length: 60 }, (_, i) => i),
    shapeXYZ: [5, 4, 3],
    offsetXYZ: [23.5, -11.25, 7],
    spacingXYZ: [10, 20, 30],
    unitsXYZ: ["nm", "nm", "nm"],
  };
}

describe("watershed snapshot metadata", () => {
  it("validates and freezes independent metadata without retaining data", () => {
    const result = makeResult();
    const info = getWatershedResultInfo(result);
    expect(Object.isFrozen(info)).toBe(true);
    for (const key of [
      "shapeXYZ",
      "offsetXYZ",
      "spacingXYZ",
      "unitsXYZ",
    ] as const) {
      expect(Object.isFrozen(info[key])).toBe(true);
      expect(info[key]).not.toBe(result[key]);
    }
    (result.shapeXYZ as number[])[0] = 100;
    (result.offsetXYZ as number[])[0] = 100;
    (result.spacingXYZ as number[])[0] = 100;
    (result.unitsXYZ as string[])[0] = "m";
    expect(info).toEqual({
      shapeXYZ: [5, 4, 3],
      offsetXYZ: [23.5, -11.25, 7],
      spacingXYZ: [10, 20, 30],
      unitsXYZ: ["nm", "nm", "nm"],
    });
    expect(info).not.toHaveProperty("data");
  });

  it("accepts arbitrary finite offsets and canonical/unitless spatial units", () => {
    expect(
      getWatershedResultInfo({
        ...makeResult(),
        offsetXYZ: [Number.MAX_VALUE, Number.MIN_VALUE, -0.125],
        unitsXYZ: ["m", "µm", ""],
      }).offsetXYZ,
    ).toEqual([Number.MAX_VALUE, Number.MIN_VALUE, -0.125]);
  });

  it.each([
    { data: new Float32Array(60) },
    { data: new Int32Array(60) },
    { data: Array(60).fill(0) },
    { data: new Uint32Array(59) },
    { shapeXYZ: [5, 4] },
    { shapeXYZ: [5, 4, 0] },
    { shapeXYZ: [5, -4, 3] },
    { shapeXYZ: [5, 4.5, 3] },
    { shapeXYZ: [5, NaN, 3] },
    { shapeXYZ: [5, Infinity, 3] },
    { shapeXYZ: [Number.MAX_SAFE_INTEGER + 1, 1, 1] },
    { shapeXYZ: [MAX_WATERSHED_VOXELS + 1, 1, 1] },
    { shapeXYZ: new Array(3) },
    { offsetXYZ: [0, 1] },
    { offsetXYZ: [0, 1, NaN] },
    { offsetXYZ: [0, 1, Infinity] },
    { offsetXYZ: new Array(3) },
    { spacingXYZ: [1, 0, 1] },
    { spacingXYZ: [1, -1, 1] },
    { spacingXYZ: [1, NaN, 1] },
    { spacingXYZ: [1, Infinity, 1] },
    { spacingXYZ: [Number.MAX_VALUE, 1, 1], unitsXYZ: ["km", "m", "m"] },
    { spacingXYZ: [Number.MIN_VALUE, 1, 1], unitsXYZ: ["nm", "m", "m"] },
    { unitsXYZ: ["unknown", "m", "m"] },
    { unitsXYZ: ["m", "m"] },
    { unitsXYZ: new Array(3) },
  ])("rejects invalid snapshots %j", (override) => {
    expect(() =>
      getWatershedResultInfo({
        ...makeResult(),
        ...override,
      } as WatershedResult),
    ).toThrow();
  });

  it("accepts the maximum ROI but rejects a detached input", () => {
    const data = new Uint32Array(MAX_WATERSHED_VOXELS);
    const result = { ...makeResult(), data, shapeXYZ: [128, 128, 128] };
    expect(getWatershedResultInfo(result).shapeXYZ).toEqual([128, 128, 128]);
    structuredClone(data, { transfer: [data.buffer] });
    expect(() => getWatershedResultInfo(result)).toThrow("data length");
  });

  it("accepts only opaque hex URLs without paths, queries, or payloads", () => {
    expect(parseWatershedUrl("watershed://012345abcdef")).toBe("012345abcdef");
    for (const url of [
      "watershed://",
      "watershed://invalid",
      "watershed://abc/path",
      "watershed://abc?data=1",
      "watershed://abc#fragment",
      "inference://abc",
    ]) {
      expect(() => parseWatershedUrl(url)).toThrow(
        "Invalid watershed result URL",
      );
    }
  });
});

describe("watershed XYZ chunk copies", () => {
  it("always owns an exact-sized UINT32 tile, even for a full subarray input", () => {
    const buffer = new Uint32Array(62);
    const data = buffer.subarray(1, 61);
    data.set(makeResult().data);
    data[0] = 0xffffffff;
    const shape = [5, 4, 3];
    const copy = copyWatershedResultChunk(data, shape, [0, 0, 0], shape);
    expect(copy).toEqual(data);
    expect(copy.buffer).not.toBe(data.buffer);
    expect(copy.byteLength).toBe(copy.buffer.byteLength);
    const delivered = structuredClone(copy, { transfer: [copy.buffer] });
    expect(copy.byteLength).toBe(0);
    expect(delivered[0]).toBe(0xffffffff);
    delivered.fill(0);
    expect(data[0]).toBe(0xffffffff);
    expect(data.byteLength).toBe(240);
    expect(copyWatershedResultChunk(data, shape, [0, 0, 0], shape)).toEqual(
      data,
    );
  });

  it("packs partial XYZ edge boxes with X fastest", () => {
    const { data, shapeXYZ } = makeResult();
    expect(
      copyWatershedResultChunk(data, shapeXYZ, [3, 2, 1], [2, 2, 2]),
    ).toEqual(Uint32Array.of(33, 34, 38, 39, 53, 54, 58, 59));
    expect(
      copyWatershedResultChunk(data, shapeXYZ, [4, 3, 2], [1, 1, 1]),
    ).toEqual(Uint32Array.of(59));
  });

  it.each([
    [
      [0, 0],
      [1, 1, 1],
    ],
    [
      [0, 0, 0],
      [1, 1],
    ],
    [
      [-1, 0, 0],
      [1, 1, 1],
    ],
    [
      [5, 0, 0],
      [1, 1, 1],
    ],
    [
      [4, 0, 0],
      [2, 1, 1],
    ],
    [
      [0, 0, 3],
      [1, 1, 1],
    ],
    [
      [0.5, 0, 0],
      [1, 1, 1],
    ],
    [
      [NaN, 0, 0],
      [1, 1, 1],
    ],
    [
      [Infinity, 0, 0],
      [1, 1, 1],
    ],
    [
      [0, 0, 0],
      [0, 1, 1],
    ],
    [
      [0, 0, 0],
      [-1, 1, 1],
    ],
    [
      [0, 0, 0],
      [1.5, 1, 1],
    ],
    [
      [0, 0, 0],
      [Infinity, 1, 1],
    ],
    [
      [0, 0, 0],
      [Number.MAX_SAFE_INTEGER + 1, 1, 1],
    ],
  ])("rejects invalid chunk bounds %j %j", (lower, size) => {
    const { data, shapeXYZ } = makeResult();
    expect(() =>
      copyWatershedResultChunk(data, shapeXYZ, lower, size),
    ).toThrow();
  });

  it("rejects incorrect source dtype, shape, and length before copying", () => {
    expect(() =>
      copyWatershedResultChunk(
        new Float32Array(60) as unknown as Uint32Array,
        [5, 4, 3],
        [0, 0, 0],
        [1, 1, 1],
      ),
    ).toThrow("Uint32Array");
    expect(() =>
      copyWatershedResultChunk(
        new Uint32Array(59),
        [5, 4, 3],
        [0, 0, 0],
        [1, 1, 1],
      ),
    ).toThrow("data length");
    expect(() =>
      copyWatershedResultChunk(
        new Uint32Array(60),
        [5, 4],
        [0, 0, 0],
        [1, 1, 1],
      ),
    ).toThrow("shape");
  });
});
