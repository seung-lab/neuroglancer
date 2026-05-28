/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { EditSession, PaintingTools } from "@zetta-ai/edit-session";
import { useCallback } from "preact/hooks";

import { useEvent } from "#src/editing/ui/interop/use_event.js";

const SIZE_PRESETS: readonly number[] = [1, 3, 5, 9, 17, 33, 65];
const MIN_PRESET_INDEX = 0;
const MAX_PRESET_INDEX = SIZE_PRESETS.length - 1;

function sizeToRadius(size: number): number {
  return Math.max(0, Math.floor(size / 2));
}

function radiusToSize(radius: number): number {
  return radius * 2 + 1;
}

function sizeToNearestPresetIndex(size: number): number {
  if (!Number.isFinite(size)) return 0;
  let bestIdx = 0;
  let bestDelta = Math.abs(SIZE_PRESETS[0] - size);
  for (let i = 1; i < SIZE_PRESETS.length; ++i) {
    const delta = Math.abs(SIZE_PRESETS[i] - size);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function radiusToPresetIndex(radius: number): number {
  return sizeToNearestPresetIndex(radiusToSize(radius));
}

function applyPresetByIndex(painting: PaintingTools, rawIndex: number): void {
  const clamped = Math.max(
    MIN_PRESET_INDEX,
    Math.min(MAX_PRESET_INDEX, Math.round(rawIndex)),
  );
  painting.patchState({ radius: sizeToRadius(SIZE_PRESETS[clamped]) });
}

export function PaintingEraser({ session }: { session: EditSession }) {
  const painting = session.tools.getTool<PaintingTools>("painting");
  const subscribe = useCallback(
    (h: () => void) => painting.on("changed", h),
    [painting],
  );
  useEvent(subscribe);
  const state = painting.getState();

  const idx = radiusToPresetIndex(state.radius);
  const size = SIZE_PRESETS[idx];

  return (
    <div class="neuroglancer-tool-panel neuroglancer-painting-eraser-panel">
      <div class="neuroglancer-tool-panel-row">
        <label>Size</label>
        <input
          type="range"
          min={MIN_PRESET_INDEX}
          max={MAX_PRESET_INDEX}
          step={1}
          value={idx}
          onInput={(e) =>
            applyPresetByIndex(painting, (e.currentTarget as HTMLInputElement).valueAsNumber)
          }
        />
        <input
          type="number"
          min={SIZE_PRESETS[MIN_PRESET_INDEX]}
          max={SIZE_PRESETS[MAX_PRESET_INDEX]}
          step={1}
          style={{ width: "5ch" }}
          value={size}
          onChange={(e) =>
            applyPresetByIndex(
              painting,
              sizeToNearestPresetIndex((e.currentTarget as HTMLInputElement).valueAsNumber),
            )
          }
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              const currentIdx = radiusToPresetIndex(painting.getState().radius);
              applyPresetByIndex(painting, currentIdx + (e.key === "ArrowUp" ? 1 : -1));
            }
          }}
        />
      </div>
      <div class="neuroglancer-tool-panel-row">
        <label>Presets</label>
        <div class="neuroglancer-tool-panel-presets">
          {SIZE_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              class={preset === size ? "active" : undefined}
              onClick={() => painting.patchState({ radius: sizeToRadius(preset) })}
            >
              {preset}
            </button>
          ))}
        </div>
      </div>
      <div class="neuroglancer-tool-panel-row">
        <label>Erase value</label>
        <span class="neuroglancer-tool-panel-readonly">
          {state.eraseValue.toString()}
        </span>
      </div>
    </div>
  );
}
