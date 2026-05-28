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
import { DEFAULT_RADIUS_CYCLE } from "@zetta-ai/edit-session";
import { useCallback } from "preact/hooks";

import { useEvent } from "#src/editing/ui/interop/use_event.js";

function clampRadius(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(64, Math.round(value)));
}

export function PaintingBrush({ session }: { session: EditSession }) {
  const painting = session.tools.getTool<PaintingTools>("painting");
  const subscribe = useCallback(
    (h: () => void) => painting.on("changed", h),
    [painting],
  );
  useEvent(subscribe);
  const state = painting.getState();

  const onRadiusInput = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    painting.patchState({ radius: clampRadius(input.valueAsNumber) });
  };

  const onRadiusChange = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    painting.patchState({ radius: clampRadius(input.valueAsNumber) });
  };

  const onTargetChange = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const raw = input.value.trim();
    try {
      const parsed = BigInt(raw);
      painting.patchState({ activeValue: parsed });
    } catch {
      input.value = painting.getState().activeValue.toString();
    }
  };

  return (
    <div class="neuroglancer-tool-panel neuroglancer-painting-brush-panel">
      <div class="neuroglancer-tool-panel-row">
        <label>Radius</label>
        <input
          type="range"
          min={1}
          max={64}
          step={1}
          value={state.radius}
          onInput={onRadiusInput}
        />
        <input
          type="number"
          min={1}
          max={64}
          step={1}
          value={state.radius}
          onChange={onRadiusChange}
        />
      </div>
      <div class="neuroglancer-tool-panel-row">
        <label>Presets</label>
        <div class="neuroglancer-tool-panel-presets">
          {DEFAULT_RADIUS_CYCLE.map((preset) => (
            <button
              key={preset}
              type="button"
              class={preset === state.radius ? "active" : undefined}
              onClick={() => painting.patchState({ radius: preset })}
            >
              {preset}
            </button>
          ))}
        </div>
      </div>
      <div class="neuroglancer-tool-panel-row">
        <label>Target value</label>
        <input
          type="text"
          inputMode="numeric"
          value={state.activeValue.toString()}
          onChange={onTargetChange}
        />
      </div>
    </div>
  );
}
