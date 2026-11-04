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
  DEFAULT_WATERSHED_OPTIONS,
  MAX_WATERSHED_VOXELS,
  validateWatershedChannels,
  validateWatershedOptions,
  validateWatershedShape,
} from "#src/watershed/base.js";

describe("watershed validation", () => {
  it("allows exactly the bounded volume size and zero cleanup thresholds", () => {
    expect(validateWatershedShape([128, 128, 128])).toBe(MAX_WATERSHED_VOXELS);
    expect(() =>
      validateWatershedOptions({
        highThreshold: 1,
        lowThreshold: 0,
        sizeThreshold: 0,
        dustThreshold: 0,
      }),
    ).not.toThrow();
    expect(() =>
      validateWatershedOptions(DEFAULT_WATERSHED_OPTIONS),
    ).not.toThrow();
  });
  it("rejects sparse XYZ shapes and channel mappings", () => {
    const shape = new Array<number>(3);
    expect(() => validateWatershedShape(shape)).toThrow("three positive");
    shape[0] = shape[2] = 1;
    expect(() => validateWatershedShape(shape)).toThrow("three positive");
    const channels = new Array<number>(3);
    expect(() =>
      validateWatershedChannels(4, channels, DEFAULT_WATERSHED_OPTIONS),
    ).toThrow("three in-bounds");
    channels[0] = 0;
    channels[2] = 2;
    expect(() =>
      validateWatershedChannels(4, channels, DEFAULT_WATERSHED_OPTIONS),
    ).toThrow("three in-bounds");
  });

  it("accepts repeated channel mappings and optional normalized mask thresholds", () => {
    expect(() =>
      validateWatershedChannels(1, [0, 0, 0], DEFAULT_WATERSHED_OPTIONS),
    ).not.toThrow();
    expect(() =>
      validateWatershedChannels(4, [0, 0, 2], DEFAULT_WATERSHED_OPTIONS),
    ).not.toThrow();
    for (const maskThreshold of [0, 0.3, 1]) {
      const options = { ...DEFAULT_WATERSHED_OPTIONS, maskThreshold };
      expect(() => validateWatershedOptions(options)).not.toThrow();
      expect(() =>
        validateWatershedChannels(4, [0, 1, 2], options),
      ).not.toThrow();
    }
    expect(() =>
      validateWatershedChannels(3, [0, 1, 2], {
        ...DEFAULT_WATERSHED_OPTIONS,
        maskThreshold: 0.3,
      }),
    ).toThrow("at least four");
    expect(() =>
      validateWatershedChannels(4, [0, 1, 3], {
        ...DEFAULT_WATERSHED_OPTIONS,
        maskThreshold: 0.3,
      }),
    ).toThrow("mask, not an affinity");
  });
  it.each([
    [],
    [1, 2],
    [1, 2, 3, 4],
    [0, 2, 3],
    [1.5, 2, 3],
    [NaN, 2, 3],
    [Infinity, 2, 3],
    [129, 129, 129],
  ])("rejects unsafe shape %j", (...shape) => {
    expect(() => validateWatershedShape(shape)).toThrow();
  });
  it.each([
    { highThreshold: 0 },
    { highThreshold: NaN },
    { highThreshold: 1.01 },
    { lowThreshold: -0.01 },
    { lowThreshold: Infinity },
    { lowThreshold: 0.99999 },
    { lowThreshold: 0.9999899999 },
    { sizeThreshold: -1 },
    { sizeThreshold: 0.5 },
    { sizeThreshold: 2 ** 32 },
    { dustThreshold: NaN },
    { dustThreshold: 2 ** 32 },
    { maskThreshold: NaN },
    { maskThreshold: Infinity },
    { maskThreshold: -0.01 },
    { maskThreshold: 1.01 },
  ])("rejects invalid options %j", (options) => {
    expect(() =>
      validateWatershedOptions({
        ...DEFAULT_WATERSHED_OPTIONS,
        ...options,
      }),
    ).toThrow();
  });
});
