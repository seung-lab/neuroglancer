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
import type { InferenceGeometry, Zyx } from "#src/inference/geometry.js";
import { getRetainedOutputShape } from "#src/inference/geometry.js";
import {
  INPUT_SHAPE,
  OUTPUT_SHAPE,
  MAX_MODEL_BYTES,
  MAX_RESULT_BYTES,
  makeModelGeometry,
  makeNooversegGeometry,
  validateModelGeometry,
  validateModelMetadata,
  validateLegacyModelMetadata,
} from "#src/inference/model.js";

const dynamic = {
  inputNames: ["volume:0"],
  outputNames: ["prediction/upsampled"],
  inputShape: [1, 1, 24, 64, 64],
  outputShape: [1, 1, 48, 128, 128],
};
const spacing: Zyx = [40, 16, 10];
const legacy = {
  inputNames: ["input"],
  outputNames: ["output"],
  inputShape: INPUT_SHAPE,
  outputShape: OUTPUT_SHAPE,
};

describe("bounded concrete model metadata", () => {
  it("accepts arbitrary names, one output channel and supersampled spatial dimensions", () => {
    expect(() => validateModelMetadata(dynamic)).not.toThrow();
    expect(() => validateModelMetadata(legacy)).not.toThrow();
    expect(() =>
      validateModelMetadata({ ...dynamic, outputShape: [1, 7, 3, 5, 9] }),
    ).not.toThrow();
  });

  it.each(["inputNames", "outputNames"] as const)(
    "rejects absent/ambiguous/empty %s",
    (field) => {
      for (const names of [[], ["a", "b"], [""]])
        expect(() =>
          validateModelMetadata({ ...dynamic, [field]: names }),
        ).toThrow("exactly one");
    },
  );

  it.each(["inputShape", "outputShape"] as const)(
    "rejects nonconcrete, nonpositive, unsafe and non-rank-five %s",
    (field) => {
      const invalid: readonly unknown[][] = [
        [1, 1, 2, 3],
        [1, 1, 2, 3, 4, 5],
        [2, 1, 2, 3, 4],
        [1, 1, 0, 3, 4],
        [1, 1, -1, 3, 4],
        [1, 1, 2.5, 3, 4],
        [1, 1, NaN, 3, 4],
        [1, 1, Infinity, 3, 4],
        [1, 1, Number.MAX_SAFE_INTEGER + 1, 3, 4],
        [1, 1, "depth", 3, 4],
        [1, 1, "24", 3, 4],
        [1, 1, undefined, 3, 4],
        [1, 0, 2, 3, 4],
      ];
      for (const shape of invalid)
        expect(() =>
          validateModelMetadata({
            ...dynamic,
            [field]: shape,
          } as typeof dynamic),
        ).toThrow();
      expect(() =>
        validateModelMetadata({ ...dynamic, inputShape: [1, 2, 2, 3, 4] }),
      ).toThrow();
    },
  );

  it("bounds both raw tensors before allocation, including safe dimensions with unsafe products", () => {
    for (const [field, limit] of [
      ["inputShape", MAX_MODEL_BYTES],
      ["outputShape", MAX_RESULT_BYTES],
    ] as const) {
      expect(() =>
        validateModelMetadata({ ...dynamic, [field]: [1, 1, 1, 1, limit / 4] }),
      ).not.toThrow();
      expect(() =>
        validateModelMetadata({
          ...dynamic,
          [field]: [1, 1, 1, 1, limit / 4 + 1],
        }),
      ).toThrow("byte limit");
      expect(() =>
        validateModelMetadata({
          ...dynamic,
          [field]: [1, 1, 2 ** 30, 2 ** 30, 2 ** 30],
        }),
      ).toThrow("byte limit");
    }
    expect(() =>
      validateModelMetadata({
        ...dynamic,
        outputShape: [1, 1024, 48, 128, 128],
      }),
    ).toThrow("byte limit");
  });

  it("keeps exact v1 names/shapes separate from the general contract", () => {
    expect(() => validateLegacyModelMetadata(legacy)).not.toThrow();
    expect(() => validateLegacyModelMetadata(dynamic)).toThrow(
      "Unsupported model profile",
    );
    expect(() =>
      validateLegacyModelMetadata({ ...legacy, inputNames: ["other"] }),
    ).toThrow();
    expect(() =>
      validateLegacyModelMetadata({
        ...legacy,
        outputShape: [1, 1, 20, 80, 80],
      }),
    ).toThrow();
  });
});

describe("model-derived geometry", () => {
  it("infers spacing, channels, one-eighth crops and centered voxel origins", () => {
    const geometry = makeModelGeometry(dynamic, spacing);
    expect(geometry).toEqual({
      inputShape: [24, 64, 64],
      inputSpacing: spacing,
      rawOutputShape: [48, 128, 128],
      outputSpacing: [20, 8, 5],
      rawOutputOrigin: [-10, -4, -2.5],
      cropBefore: [6, 16, 16],
      cropAfter: [6, 16, 16],
      outputChannels: 1,
    });
    expect(getRetainedOutputShape(geometry)).toEqual([36, 96, 96]);
    expect(() => validateModelGeometry(dynamic, geometry)).not.toThrow();
  });

  it("preserves the legacy fixture geometry exactly", () => {
    expect(makeModelGeometry(legacy, spacing)).toEqual(
      makeNooversegGeometry(spacing),
    );
  });

  it("uses explicit output spacing with centered physical FOV", () => {
    const geometry = makeModelGeometry(dynamic, spacing, [10, 4, 2]);
    expect(geometry.outputSpacing).toEqual([10, 4, 2]);
    expect(geometry.rawOutputOrigin).toEqual([225, 250, 188]);
    for (let axis = 0; axis < 3; ++axis)
      expect(
        geometry.rawOutputOrigin[axis] +
          ((geometry.rawOutputShape[axis] - 1) * geometry.outputSpacing[axis]) /
            2,
      ).toBe(
        ((geometry.inputShape[axis] - 1) * geometry.inputSpacing[axis]) / 2,
      );
  });

  it("supports small/odd outputs and does not alias caller spacing", () => {
    const inputSpacing: [number, number, number] = [3, 5, 7];
    const outputSpacing: [number, number, number] = [1, 2, 3];
    const geometry = makeModelGeometry(
      { ...dynamic, outputShape: [1, 2, 7, 9, 1] },
      inputSpacing,
      outputSpacing,
    );
    expect(geometry.cropBefore).toEqual([0, 1, 0]);
    expect(geometry.outputChannels).toBe(2);
    inputSpacing[0] = outputSpacing[0] = 100;
    expect(geometry.inputSpacing[0]).toBe(3);
    expect(geometry.outputSpacing[0]).toBe(1);
  });

  it("rejects mismatched shapes/channels, malformed geometry and invalid spacings without defaults", () => {
    const geometry = makeModelGeometry(dynamic, spacing);
    const invalid: Partial<InferenceGeometry>[] = [
      { inputShape: [20, 64, 64] },
      { rawOutputShape: [24, 64, 64] },
      { outputChannels: 4 },
      { inputSpacing: [0, 1, 1] },
      { outputSpacing: [-1, 1, 1] },
      { rawOutputOrigin: [NaN, 0, 0] },
      { cropBefore: [48, 0, 0] },
      { cropAfter: [0.5, 0, 0] },
    ];
    for (const change of invalid)
      expect(() =>
        validateModelGeometry(dynamic, { ...geometry, ...change }),
      ).toThrow();
    for (const invalidSpacing of [
      [0, 1, 1],
      [-1, 1, 1],
      [NaN, 1, 1],
      [Infinity, 1, 1],
    ] as const) {
      expect(() => makeModelGeometry(dynamic, invalidSpacing)).toThrow();
      expect(() =>
        makeModelGeometry(dynamic, spacing, invalidSpacing),
      ).toThrow();
    }
    expect(() =>
      makeModelGeometry({ ...dynamic, inputShape: [1, 1, 0, 64, 64] }, spacing),
    ).toThrow();
    expect(() =>
      validateModelGeometry(
        { ...dynamic, outputShape: [1, 1, 1, 1, MAX_RESULT_BYTES] },
        geometry,
      ),
    ).toThrow("byte limit");
  });
});
