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
  buildNgState,
  formatResolution,
  type FixturesIndex,
  type Scenario,
} from "#tests/editing/harness/build_ng_state.js";

// Hermetic in-memory index (mirrors a few `fixtures.json` rows so the test does
// not depend on `generate.py` having run).
const INDEX: FixturesIndex = {
  bucket: "zetta-editing-test",
  fixtures: [
    {
      id: "img_u8_raw",
      kind: "image",
      dtype: "uint8",
      encoding: "raw",
      chunk: [64, 64, 16],
      offset: [0, 0, 0],
      size: [128, 128, 16],
      resolutions: [[16, 16, 40]],
      source: "precomputed://gs://zetta-editing-test/img_u8_raw",
    },
    {
      id: "seg_u32_raw_offset",
      kind: "segmentation",
      dtype: "uint32",
      encoding: "raw",
      chunk: [64, 64, 16],
      offset: [128, 128, 8],
      size: [128, 128, 16],
      resolutions: [[16, 16, 40]],
      source: "precomputed://gs://zetta-editing-test/seg_u32_raw_offset",
    },
    {
      id: "seg_u64_multires",
      kind: "segmentation",
      dtype: "uint64",
      encoding: "compressed_segmentation",
      chunk: [64, 64, 16],
      offset: [0, 0, 0],
      size: [128, 128, 16],
      resolutions: [
        [16, 16, 40],
        [32, 32, 40],
      ],
      source: "precomputed://gs://zetta-editing-test/seg_u64_multires",
    },
  ],
};

const twoLayer: Scenario = {
  name: "image-locked + seg-target-writable",
  layers: [
    { fixtureId: "img_u8_raw", role: "image", writable: false },
    { fixtureId: "seg_u64_multires", role: "target", writable: true },
  ],
};

describe("buildNgState", () => {
  it("emits a layer per scenario layer with the fixture source + type", () => {
    const state = buildNgState(twoLayer, INDEX) as any;
    expect(state.layers).toHaveLength(2);
    const [img, seg] = state.layers;
    expect(img).toMatchObject({
      type: "image",
      name: "img_u8_raw",
      source: "precomputed://gs://zetta-editing-test/img_u8_raw",
    });
    expect(seg).toMatchObject({
      type: "segmentation",
      name: "seg_u64_multires",
      segments: [],
    });
  });

  it("writes an editSession block with per-layer writable + resolutions", () => {
    const state = buildNgState(twoLayer, INDEX) as any;
    expect(state.editSession.layers).toEqual([
      { layerId: "img_u8_raw", resolutions: ["16x16x40"], writable: false },
      {
        layerId: "seg_u64_multires",
        resolutions: ["16x16x40", "32x32x40"], // multi-resolution preserved
        writable: true,
      },
    ]);
    // The writable layer is the selected one.
    expect(state.selectedLayer.layer).toBe("seg_u64_multires");
  });

  it("derives the region from the TARGET fixture offset + size", () => {
    // Target offset [0,0,0], size [128,128,16].
    const state = buildNgState(twoLayer, INDEX) as any;
    expect(state.editSession.region.lo).toEqual([0, 0, 0]);
    expect(state.editSession.region.hi).toEqual([128, 128, 16]);
    // Dimensions from the target's base resolution (16,16,40 nm → metres).
    expect(state.dimensions).toEqual({
      x: [1.6e-8, "m"],
      y: [1.6e-8, "m"],
      z: [4.0e-8, "m"],
    });
  });

  it("frames the region with a default crossSectionScale; centre = region centre", () => {
    const state = buildNgState(twoLayer, INDEX) as any;
    // max(regionSize x,y)=128 → 128/600 ≈ 0.213 (voxels-per-pixel-ish).
    expect(state.crossSectionScale).toBeCloseTo(128 / 600, 5);
    expect(state.position).toEqual([64, 64, 8]); // centre of [0,0,0]–[128,128,16]
  });

  it("respects an explicit crossSectionScale override", () => {
    const scenario: Scenario = {
      name: "zoomed",
      layers: [
        { fixtureId: "seg_u64_multires", role: "target", writable: true },
      ],
      crossSectionScale: 0.05,
    };
    const state = buildNgState(scenario, INDEX) as any;
    expect(state.crossSectionScale).toBe(0.05);
  });

  it("honors a non-zero target voxelOffset in the region lo", () => {
    const scenario: Scenario = {
      name: "offset-target",
      layers: [
        { fixtureId: "seg_u32_raw_offset", role: "target", writable: true },
      ],
      regionSize: [64, 64, 8],
    };
    const state = buildNgState(scenario, INDEX) as any;
    expect(state.editSession.region.lo).toEqual([128, 128, 8]);
    expect(state.editSession.region.hi).toEqual([192, 192, 16]);
  });

  it("auto-derives a brush tool with a mask when an image layer is present", () => {
    const state = buildNgState(twoLayer, INDEX) as any;
    const painting = state.editSession.tooling.painting;
    expect(state.editSession.tooling.activeToolId).toBe("painting.brush");
    expect(painting.targetLayerId).toBe("seg_u64_multires");
    expect(painting.mask.imageLayerId).toBe("img_u8_raw");
  });

  it("omits the mask when there is no image layer", () => {
    const scenario: Scenario = {
      name: "no-image",
      layers: [
        { fixtureId: "seg_u64_multires", role: "target", writable: true },
      ],
    };
    const state = buildNgState(scenario, INDEX) as any;
    expect(state.editSession.tooling.painting.mask).toBeUndefined();
  });

  it("rewrites sources via sourceFor (e.g. http test-data server)", () => {
    const state = buildNgState(twoLayer, INDEX, {
      sourceFor: (f) =>
        `precomputed://http://localhost:8080/editing/buckets/zetta-editing-test/${f.id}`,
    }) as any;
    expect(state.layers[0].source).toBe(
      "precomputed://http://localhost:8080/editing/buckets/zetta-editing-test/img_u8_raw",
    );
  });

  it("throws on an unknown fixture id", () => {
    const scenario: Scenario = {
      name: "bad",
      layers: [{ fixtureId: "nope", role: "target", writable: true }],
    };
    expect(() => buildNgState(scenario, INDEX)).toThrow(/not in the index/);
  });

  it("throws when no layer is a target", () => {
    const scenario: Scenario = {
      name: "no-target",
      layers: [{ fixtureId: "img_u8_raw", role: "image", writable: false }],
    };
    expect(() => buildNgState(scenario, INDEX)).toThrow(/no target layer/);
  });

  it("throws when an image role points at a segmentation fixture", () => {
    const scenario: Scenario = {
      name: "role-mismatch",
      layers: [
        { fixtureId: "seg_u64_multires", role: "image", writable: false },
        { fixtureId: "seg_u32_raw_offset", role: "target", writable: true },
      ],
    };
    expect(() => buildNgState(scenario, INDEX)).toThrow(
      /kind is "segmentation"/,
    );
  });

  it("formatResolution joins with x", () => {
    expect(formatResolution([16, 16, 40])).toBe("16x16x40");
  });
});
