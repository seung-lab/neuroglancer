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
  1, 3, 5, 9, 17, 33, 65, 129, 257, 513, 1025,
];

/** size → radius (`radius = (size - 1) / 2`). */
export function sizeToRadius(size: number): number {
  return Math.max(0, Math.floor((size - 1) / 2));
}

/** radius → size (`size = radius * 2 + 1`). */
export function radiusToSize(radius: number): number {
  return Math.max(0, Math.floor(radius)) * 2 + 1;
}
