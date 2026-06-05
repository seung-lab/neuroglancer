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
 * @file Pure value math for the painting hotkeys (TM-292).
 *
 * Side-effect-free helpers that the session hotkey binder uses to compute the
 * next brush size / value / threshold. Kept separate so they can be unit
 * tested without a viewer, session, or DOM. All steps are fixed at ±1
 * (`Math.sign(dir)`); `dir` only carries direction.
 */

import { BRUSH_SIZE_PRESETS } from "#src/editing/brush_size_presets.js";

function clampNumber(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * Next preset brush *size* from `size` in direction `dir`. Steps one entry
 * through {@link BRUSH_SIZE_PRESETS} when `size` is a preset; otherwise snaps
 * to the nearest preset in the requested direction. Clamps at both ends (no
 * wrap) and is a no-op when already past the last preset in `dir`.
 */
export function nextPresetSize(size: number, dir: number): number {
  const presets = BRUSH_SIZE_PRESETS;
  const step = Math.sign(dir);
  const idx = presets.indexOf(size);
  if (idx !== -1) {
    const ni = clampNumber(idx + step, 0, presets.length - 1);
    return presets[ni];
  }
  // Off-preset (e.g. a custom size typed in the panel): snap toward `dir`.
  if (step > 0) {
    for (const v of presets) if (v > size) return v;
    return size; // already at/above the largest preset
  }
  let res: number | undefined;
  for (const v of presets) {
    if (v < size) res = v;
    else break;
  }
  return res ?? size; // already at/below the smallest preset
}

/** Next brush value (label id) ±1, clamped to ≥ 0. Preserves bigint vs number. */
export function nextBrushValue(
  value: number | bigint,
  dir: number,
): number | bigint {
  const step = Math.sign(dir);
  if (typeof value === "bigint") {
    const next = value + BigInt(step);
    return next < 0n ? 0n : next;
  }
  const next = value + step;
  return next < 0 ? 0 : next;
}

/** Next low threshold ±1, clamped to `[min, high]` (never crosses high). */
export function nextThresholdLow(
  low: number,
  high: number,
  min: number,
  dir: number,
): number {
  return clampNumber(low + Math.sign(dir), min, high);
}

/** Next high threshold ±1, clamped to `[low, max]` (never crosses low). */
export function nextThresholdHigh(
  low: number,
  high: number,
  max: number,
  dir: number,
): number {
  return clampNumber(high + Math.sign(dir), low, max);
}
