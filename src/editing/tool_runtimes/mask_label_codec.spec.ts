/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest";

import {
  buildLabelMap,
  delabelizeMaskSlice,
  labelizeMaskSlice,
  MAX_TRACKED_SEGMENTS,
  TooManyTrackedSegmentsError,
} from "#src/editing/tool_runtimes/mask_label_codec.js";

describe("buildLabelMap", () => {
  it("numbers ids 1..N in first-seen order", () => {
    const { idToLabel, labelToId } = buildLabelMap([30n, 10n, 20n]);
    expect(idToLabel.get(30n)).toBe(1);
    expect(idToLabel.get(10n)).toBe(2);
    expect(idToLabel.get(20n)).toBe(3);
    expect(labelToId.get(1)).toBe(30n);
    expect(labelToId.get(2)).toBe(10n);
    expect(labelToId.get(3)).toBe(20n);
  });

  it("drops background (0n) and duplicate ids", () => {
    const { idToLabel } = buildLabelMap([0n, 5n, 5n, 7n, 0n]);
    expect(idToLabel.size).toBe(2);
    expect(idToLabel.get(5n)).toBe(1);
    expect(idToLabel.get(7n)).toBe(2);
  });

  it("accepts exactly 255 distinct ids", () => {
    const ids = Array.from({ length: MAX_TRACKED_SEGMENTS }, (_, i) =>
      BigInt(i + 1),
    );
    const { idToLabel } = buildLabelMap(ids);
    expect(idToLabel.size).toBe(255);
  });

  it("throws when more than 255 distinct ids are tracked", () => {
    const ids = Array.from({ length: 256 }, (_, i) => BigInt(i + 1));
    expect(() => buildLabelMap(ids)).toThrow(TooManyTrackedSegmentsError);
  });
});

describe("labelizeMaskSlice", () => {
  it("maps tracked ids to labels and everything else to 0 (bigint input)", () => {
    const { idToLabel } = buildLabelMap([100n, 200n]);
    const values = BigUint64Array.from([100n, 0n, 200n, 999n]);
    expect([...labelizeMaskSlice(values, idToLabel)]).toEqual([1, 0, 2, 0]);
  });

  it("widens numeric (uint32) values to bigint for the lookup", () => {
    const { idToLabel } = buildLabelMap([100n, 200n]);
    const values = Uint32Array.from([100, 200, 0, 200]);
    expect([...labelizeMaskSlice(values, idToLabel)]).toEqual([1, 2, 0, 2]);
  });
});

describe("delabelizeMaskSlice", () => {
  it("decodes labels to ids and gates the write mask", () => {
    const { labelToId } = buildLabelMap([100n, 200n]);
    const { ids, valueMask } = delabelizeMaskSlice([1, 0, 2, 1], labelToId);
    expect([...ids]).toEqual([100n, 0n, 200n, 100n]);
    expect([...valueMask]).toEqual([1, 0, 1, 1]);
  });

  it("leaves unknown labels unwritten (id 0n, gate 0)", () => {
    const { labelToId } = buildLabelMap([100n]);
    const { ids, valueMask } = delabelizeMaskSlice([9, 1], labelToId);
    expect([...ids]).toEqual([0n, 100n]);
    expect([...valueMask]).toEqual([0, 1]);
  });

  it("round-trips through labelize when every voxel is tracked", () => {
    const { idToLabel, labelToId } = buildLabelMap([7n, 8n, 9n]);
    const original = BigUint64Array.from([7n, 8n, 9n, 8n, 7n]);
    const labels = labelizeMaskSlice(original, idToLabel);
    const { ids } = delabelizeMaskSlice(labels, labelToId);
    expect([...ids]).toEqual([...original]);
  });
});
