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
import type { InferenceResult } from "#src/datasource/inference/base.js";
import {
  copyInferenceResultChunk,
  getInferenceResultInfo,
  getInferenceMetadataInfo,
  parseInferenceUrl,
} from "#src/datasource/inference/base.js";

function makeResult(): InferenceResult {
  return {
    data: Float32Array.from({ length: 4 * 3 * 4 * 5 }, (_, i) => i),
    shapeZYX: [3, 4, 5],
    originZYX: [-7, 11, 23],
    spacingZYX: [30, 20, 10],
    axisNamesZYX: ["z", "y", "x"],
    unitsZYX: ["nm", "nm", "nm"],
    provenance: { model: "test", version: 1 },
  };
}

describe("inference result metadata", () => {
  it("snapshots and freezes metadata and serializes provenance", () => {
    const result = makeResult();
    const info = getInferenceResultInfo(result);
    expect(info.channels).toBe(4);
    expect(info.provenanceJson).toBe('{"model":"test","version":1}');
    expect(Object.isFrozen(info)).toBe(true);
    expect(Object.isFrozen(info.originZYX)).toBe(true);
    (result.originZYX as number[])[0] = 100;
    expect(info.originZYX).toEqual([-7, 11, 23]);
    expect(info.byteLength).toBeGreaterThan(result.data.byteLength);
  });

  it.each([
    { shapeZYX: [0, 4, 5] },
    { shapeZYX: [3, 4, 6] },
    { originZYX: [0.5, 1, 2] },
    { spacingZYX: [0, 1, 2] },
    { spacingZYX: [Number.MAX_VALUE, 1, 2], unitsZYX: ["km", "m", "m"] },
    { unitsZYX: ["unknown", "m", "m"] },
    { axisNamesZYX: ["z", "z", "x"] },
    { axisNamesZYX: ["c^", "y", "x"] },
    { provenance: { nan: NaN } },
  ])("rejects invalid metadata %j", (override) => {
    expect(() =>
      getInferenceResultInfo({ ...makeResult(), ...override }),
    ).toThrow();
  });

  it.each([1, 2, 7])(
    "normalizes explicit C=%i and checks tensor lengths",
    (channels) => {
      const result = {
        ...makeResult(),
        channels,
        data: new Float32Array(channels * 3 * 4 * 5),
      };
      expect(getInferenceResultInfo(result).channels).toBe(channels);
      expect(getInferenceMetadataInfo(result).channels).toBe(channels);
      expect(() =>
        getInferenceResultInfo({ ...result, data: result.data.slice(1) }),
      ).toThrow("data length");
    },
  );

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null])(
    "rejects invalid channel count %s",
    (channels) => {
      expect(() =>
        getInferenceMetadataInfo({
          ...makeResult(),
          channels: channels as number,
        }),
      ).toThrow("channels");
    },
  );

  it("validates metadata without sizing an unallocated whole-volume tensor", () => {
    const result = {
      ...makeResult(),
      shapeZYX: [29808, 327600, 327600],
      channels: 1,
    };
    expect(result.shapeZYX.reduce((a, b) => a * b, 4)).toBeGreaterThan(
      Number.MAX_SAFE_INTEGER,
    );
    const info = getInferenceMetadataInfo(result);
    expect(info.shapeZYX).toEqual(result.shapeZYX);
    expect(info.channels).toBe(1);
    expect(info.byteLength).toBeLessThan(1024);
    expect(() => getInferenceResultInfo(result)).toThrow(
      "Inference tensor byte count must be a safe integer",
    );
  });

  it("rejects unsafe display tile byte counts for metadata-only publications", () => {
    expect(() =>
      getInferenceMetadataInfo({
        ...makeResult(),
        channels: Number.MAX_SAFE_INTEGER,
      }),
    ).toThrow("Inference tile byte count must be a safe integer");
  });

  it("rejects oversized metadata", () => {
    expect(() =>
      getInferenceResultInfo({
        ...makeResult(),
        provenance: "x".repeat(1024 * 1024),
      }),
    ).toThrow("1 MiB");
  });

  it("accepts only opaque result IDs with no payload/query/path", () => {
    expect(parseInferenceUrl("inference://abc-123_DEF")).toBe("abc-123_DEF");
    for (const url of [
      "inference://",
      "inference://abc?data=1",
      "inference://abc/path",
      "other://abc",
    ]) {
      expect(() => parseInferenceUrl(url)).toThrow(
        "Invalid inference result URL",
      );
    }
  });
});

describe("inference chunk copies", () => {
  it("copies all channels in X-fastest order and survives transfer/redownload", () => {
    const { data, shapeZYX } = makeResult();
    const copy = copyInferenceResultChunk(
      data,
      shapeZYX,
      [0, 0, 0, 0],
      [5, 4, 3, 4],
    );
    expect(copy).toEqual(data);
    const delivered = structuredClone(copy, { transfer: [copy.buffer] });
    expect(copy.byteLength).toBe(0);
    delivered[0] = -1;
    expect(data[0]).toBe(0);
    expect(
      copyInferenceResultChunk(data, shapeZYX, [0, 0, 0, 0], [5, 4, 3, 4]),
    ).toEqual(data);
  });

  it("packs partial XYZ edge chunks and channel subsets", () => {
    const { data, shapeZYX } = makeResult();
    const expected = Float32Array.of(
      93,
      94,
      98,
      99,
      113,
      114,
      118,
      119,
      153,
      154,
      158,
      159,
      173,
      174,
      178,
      179,
    );
    expect(
      copyInferenceResultChunk(data, shapeZYX, [3, 2, 1, 1], [2, 2, 2, 2]),
    ).toEqual(expected);
  });

  it.each([1, 3, 7])(
    "copies C=%i without padding and bounds channel subsets",
    (channels) => {
      const shape = [3, 4, 5];
      const data = Float32Array.from({ length: channels * 60 }, (_, i) => i);
      expect(
        copyInferenceResultChunk(
          data,
          shape,
          [0, 0, 0, 0],
          [5, 4, 3, channels],
          channels,
        ),
      ).toEqual(data);
      expect(
        copyInferenceResultChunk(
          data,
          shape,
          [3, 2, 1, channels - 1],
          [2, 2, 2, 1],
          channels,
        ),
      ).toEqual(
        Float32Array.from(
          [33, 34, 38, 39, 53, 54, 58, 59],
          (x) => x + (channels - 1) * 60,
        ),
      );
      expect(() =>
        copyInferenceResultChunk(
          data,
          shape,
          [0, 0, 0, channels],
          [1, 1, 1, 1],
          channels,
        ),
      ).toThrow("outside result bounds");
      expect(() =>
        copyInferenceResultChunk(
          data.slice(1),
          shape,
          [0, 0, 0, 0],
          [1, 1, 1, 1],
          channels,
        ),
      ).toThrow("data length");
    },
  );

  it("rejects out-of-bounds chunks", () => {
    const { data, shapeZYX } = makeResult();
    expect(() =>
      copyInferenceResultChunk(data, shapeZYX, [4, 0, 0, 0], [2, 1, 1, 4]),
    ).toThrow("outside result bounds");
  });
});
