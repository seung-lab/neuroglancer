/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { ParamInput } from "#src/editing/ui/tool_settings/param_input.js";
import "#src/editing/ui/tool_settings/painting_threshold.css";

/** Parse a finite number from raw text, or null if empty/invalid. */
function parseFinite(raw: string): number | null {
  const n = Number(raw);
  return raw.trim() !== "" && Number.isFinite(n) ? n : null;
}

/**
 * Dual-handle threshold control: a single rail carrying two draggable
 * circles (low / high) over a highlighted in-range fill, with the numeric
 * low/high inputs aligned to the rail's ends below it.
 *
 * The two handles are clamped against each other — the low handle can never
 * pass the high handle and vice-versa — so `onChange` always emits a valid
 * `low <= high` pair. Clamping lives here so callers can patch state
 * directly without re-validating.
 */
export function PaintingThreshold({
  min,
  max,
  low,
  high,
  showHandles = true,
  disabled = false,
  onChange,
}: {
  min: number;
  max: number;
  low: number;
  high: number;
  /**
   * Whether to render the draggable rail. Disabled for unbounded ranges
   * (e.g. float32) where a slider is meaningless — only the numeric
   * low/high fields are shown.
   */
  showHandles?: boolean;
  /** When true the control is read-only: handles are hidden and fields locked. */
  disabled?: boolean;
  onChange: (low: number, high: number) => void;
}) {
  const span = max - min || 1;
  const lowPct = ((low - min) / span) * 100;
  const highPct = ((high - min) / span) * 100;

  const emitLow = (value: number) => {
    if (!Number.isFinite(value)) return;
    onChange(Math.min(Math.max(value, min), high), high);
  };
  const emitHigh = (value: number) => {
    if (!Number.isFinite(value)) return;
    onChange(low, Math.max(Math.min(value, max), low));
  };

  const onLowSlide = (e: Event) =>
    emitLow((e.currentTarget as HTMLInputElement).valueAsNumber);
  const onHighSlide = (e: Event) =>
    emitHigh((e.currentTarget as HTMLInputElement).valueAsNumber);

  return (
    <div class="neuroglancer-painting-threshold">
      {showHandles && !disabled && (
        <div class="neuroglancer-painting-threshold-track">
          <div class="neuroglancer-painting-threshold-rail" />
          <div
            class="neuroglancer-painting-threshold-fill"
            style={{ left: `${lowPct}%`, width: `${highPct - lowPct}%` }}
          />
          {/* The low handle sits on top so it stays grabbable even when the
              two handles overlap at the same value. */}
          <input
            type="range"
            class="neuroglancer-painting-threshold-handle neuroglancer-painting-threshold-handle-low"
            min={min}
            max={max}
            value={low}
            aria-label="Threshold low"
            onInput={onLowSlide}
          />
          <input
            type="range"
            class="neuroglancer-painting-threshold-handle neuroglancer-painting-threshold-handle-high"
            min={min}
            max={max}
            value={high}
            aria-label="Threshold high"
            onInput={onHighSlide}
          />
        </div>
      )}
      <div class="neuroglancer-painting-threshold-fields">
        <label class="neuroglancer-painting-threshold-field">
          <ParamInput<number>
            type="number"
            min={min}
            max={max}
            value={low}
            parse={parseFinite}
            onCommit={emitLow}
            disabled={disabled}
          />
          <span>low</span>
        </label>
        <label class="neuroglancer-painting-threshold-field neuroglancer-painting-threshold-field-high">
          <ParamInput<number>
            type="number"
            min={min}
            max={max}
            value={high}
            parse={parseFinite}
            onCommit={emitHigh}
            disabled={disabled}
          />
          <span>high</span>
        </label>
      </div>
    </div>
  );
}
