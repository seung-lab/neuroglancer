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
  nextBrushValue,
  nextPresetSize,
  nextThresholdHigh,
  nextThresholdLow,
} from "#src/editing/painting_hotkey_math.js";

// Presets: [1, 3, 5, 9, 15, 25, 43, 75, 131, 229, 401, 701, 1000].
describe("nextPresetSize", () => {
  it("steps one preset up/down from a preset member", () => {
    expect(nextPresetSize(5, +1)).toBe(9);
    expect(nextPresetSize(5, -1)).toBe(3);
  });

  it("clamps at both ends (no wrap)", () => {
    expect(nextPresetSize(1, -1)).toBe(1);
    expect(nextPresetSize(1000, +1)).toBe(1000);
  });

  it("snaps an off-preset size toward the requested direction", () => {
    expect(nextPresetSize(7, +1)).toBe(9);
    expect(nextPresetSize(7, -1)).toBe(5);
  });

  it("is a no-op above the largest preset when increasing", () => {
    expect(nextPresetSize(2000, +1)).toBe(2000);
    expect(nextPresetSize(2000, -1)).toBe(1000);
  });

  it("only uses the sign of dir (fixed step)", () => {
    expect(nextPresetSize(5, +10)).toBe(9);
    expect(nextPresetSize(5, -10)).toBe(3);
  });
});

describe("nextBrushValue", () => {
  it("adjusts numbers by ±1 and clamps at 0", () => {
    expect(nextBrushValue(5, +1)).toBe(6);
    expect(nextBrushValue(5, -1)).toBe(4);
    expect(nextBrushValue(0, -1)).toBe(0);
  });

  it("preserves bigint and clamps at 0n", () => {
    expect(nextBrushValue(5n, +1)).toBe(6n);
    expect(nextBrushValue(0n, -1)).toBe(0n);
    expect(typeof nextBrushValue(5n, +1)).toBe("bigint");
  });
});

describe("nextThresholdLow", () => {
  it("moves ±1 within [min, high]", () => {
    expect(nextThresholdLow(10, 200, 0, -1)).toBe(9);
    expect(nextThresholdLow(10, 200, 0, +1)).toBe(11);
  });

  it("never crosses high or drops below min", () => {
    expect(nextThresholdLow(10, 10, 0, +1)).toBe(10); // can't exceed high
    expect(nextThresholdLow(0, 200, 0, -1)).toBe(0); // can't go below min
  });
});

describe("nextThresholdHigh", () => {
  it("moves ±1 within [low, max]", () => {
    expect(nextThresholdHigh(10, 200, 255, +1)).toBe(201);
    expect(nextThresholdHigh(10, 200, 255, -1)).toBe(199);
  });

  it("never crosses low or exceeds max", () => {
    expect(nextThresholdHigh(10, 10, 255, -1)).toBe(10); // can't drop below low
    expect(nextThresholdHigh(10, 255, 255, +1)).toBe(255); // can't exceed max
  });
});
