/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * @file Brush size presets (TM-292).
 *
 * The user-facing brush parameter is *size* (a voxel count, always odd); the
 * library state stores *radius* (`size = radius * 2 + 1`). The `+` / `-`
 * hotkeys cycle through these preset sizes, and `EditSessionHost` seeds the
 * library's `radiusCycle` from them. This is the single source of truth —
 * the library's former `DEFAULT_RADIUS_CYCLE` export is being removed.
 */

/** Preset brush sizes the `+` / `-` hotkeys step through. */
export const BRUSH_SIZE_PRESETS: readonly number[] = [
  1, 3, 5, 9, 15, 25, 43, 75, 131, 229, 401, 701, 1000,
];

export const MIN_BRUSH_SIZE = 1;
export const MAX_BRUSH_SIZE = 1000; // size = radius * 2 + 1.

/**
 * Normalise a raw size to a valid brush size: a finite, odd integer within
 * [MIN_BRUSH_SIZE, MAX_BRUSH_SIZE]. Non-finite input falls back to the minimum.
 * Size is a voxel count and must be odd, so even values snap up by one. Shared
 * by the Brush and Eraser panels (and applied on commit, never per-keystroke).
 */
export function clampBrushSize(value: number): number {
  if (!Number.isFinite(value)) return MIN_BRUSH_SIZE;
  const n = Math.round(value);
  const odd = n % 2 === 0 ? n + 1 : n;
  return Math.max(MIN_BRUSH_SIZE, Math.min(MAX_BRUSH_SIZE, odd));
}

/** size → radius (`radius = (size - 1) / 2`). */
export function sizeToRadius(size: number): number {
  return Math.max(0, Math.floor((size - 1) / 2));
}

/** radius → size (`size = radius * 2 + 1`). */
export function radiusToSize(radius: number): number {
  return Math.max(0, Math.floor(radius)) * 2 + 1;
}
