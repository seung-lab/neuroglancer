/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { Resolution } from "@zettaai/edit-session";
import { describe, it, expect } from "vitest";

import { computeBrushFootprintAxes } from "#src/editing/cursor/brush_cursor_footprint.js";
import type { DisplayDimensionRenderInfo } from "#src/navigation_state.js";

// Minimal `DisplayDimensionRenderInfo` covering only the fields the footprint
// helper reads (`displayRank`, `displayDimensionIndices`, `voxelPhysicalScales`).
function displayInfo(
  displayDimensionIndices: readonly number[],
  voxelPhysicalScales: readonly number[],
): DisplayDimensionRenderInfo {
  const displayRank = displayDimensionIndices.filter((i) => i >= 0).length;
  return {
    displayRank,
    displayDimensionIndices: Int32Array.from(displayDimensionIndices),
    voxelPhysicalScales: Float64Array.from(voxelPhysicalScales),
  } as unknown as DisplayDimensionRenderInfo;
}

// Identity XYZ display with 1 meter per display unit, so display-space lengths
// equal `radiusVoxels × voxelSizeNm × 1e-9`.
const IDENTITY_XYZ = displayInfo([0, 1, 2], [1, 1, 1]);

describe("computeBrushFootprintAxes", () => {
  it("is a round cursor for isotropic in-plane voxels (64×64×42)", () => {
    const res = Resolution.from([64, 64, 42]);
    const { offsetX, offsetY } = computeBrushFootprintAxes(3, res, IDENTITY_XYZ);
    // Each painted-plane axis maps to its own display slot.
    expect(offsetX[0]).toBeGreaterThan(0);
    expect(offsetY[1]).toBeGreaterThan(0);
    // Equal in-plane semi-axes → circle. (Was 66% wrong via Math.min picking z=42.)
    expect(offsetX[0] / offsetY[1]).toBeCloseTo(1, 6);
    // Visual radius = 3 + 0.5; 64 nm; 1 m/unit.
    expect(offsetX[0] / (3.5 * 64 * 1e-9)).toBeCloseTo(1, 6);
    // Off-axis components are zero.
    expect(offsetX[1]).toBe(0);
    expect(offsetX[2]).toBe(0);
    expect(offsetY[0]).toBe(0);
    expect(offsetY[2]).toBe(0);
  });

  it("is an ellipse for anisotropic in-plane voxels (56×432×16)", () => {
    const res = Resolution.from([56, 432, 16]);
    const { offsetX, offsetY } = computeBrushFootprintAxes(5, res, IDENTITY_XYZ);
    // Semi-axis ratio mirrors the in-plane voxel-size ratio exactly.
    expect(offsetX[0] / offsetY[1]).toBeCloseTo(56 / 432, 6);
  });

  it("scales each axis by its display voxelPhysicalScale", () => {
    const res = Resolution.from([64, 64, 42]);
    // X display axis is 2× coarser (meters per unit) than Y → half the length.
    const info = displayInfo([0, 1, 2], [2e-9, 1e-9, 1e-9]);
    const { offsetX, offsetY } = computeBrushFootprintAxes(3, res, info);
    expect(offsetX[0] / offsetY[1]).toBeCloseTo(0.5, 6);
  });

  it("collapses an undisplayed painted-plane axis to zero (edge-on)", () => {
    const res = Resolution.from([64, 64, 42]);
    // XZ view: global dim 0 (X) and 2 (Z) displayed; dim 1 (Y) is not.
    const info = displayInfo([0, 2, -1], [1, 1, 1]);
    const { offsetX, offsetY } = computeBrushFootprintAxes(3, res, info);
    expect(offsetX[0]).toBeGreaterThan(0);
    expect(offsetY[0]).toBe(0);
    expect(offsetY[1]).toBe(0);
    expect(offsetY[2]).toBe(0);
  });

  it("defaults to isotropic 1 nm when resolution is undefined", () => {
    const { offsetX, offsetY } = computeBrushFootprintAxes(
      3,
      undefined,
      IDENTITY_XYZ,
    );
    expect(offsetX[0] / offsetY[1]).toBeCloseTo(1, 6);
    expect(offsetX[0] / (3.5 * 1 * 1e-9)).toBeCloseTo(1, 6);
  });

  it("returns zero vectors for non-positive / non-finite radius", () => {
    const res = Resolution.from([64, 64, 42]);
    for (const r of [-1, -0.5, Number.NaN]) {
      const { offsetX, offsetY } = computeBrushFootprintAxes(r, res, IDENTITY_XYZ);
      expect(Array.from(offsetX)).toEqual([0, 0, 0]);
      expect(Array.from(offsetY)).toEqual([0, 0, 0]);
    }
  });
});
