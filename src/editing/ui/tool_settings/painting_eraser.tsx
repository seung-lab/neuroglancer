/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { EditSession, PaintingTools } from "@zettaai/edit-session";
import { useCallback } from "preact/hooks";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { useEvent } from "#src/editing/ui/interop/use_event.js";
import { PaintingTargetPicker } from "#src/editing/ui/tool_settings/painting_target_picker.js";

const MAX_SIZE = 129; // size = radius*2+1; max radius 64.
const MIN_SIZE = 1;

function clampSize(value: number): number {
  if (!Number.isFinite(value)) return 1;
  const n = Math.round(value);
  const odd = n % 2 === 0 ? n + 1 : n;
  return Math.max(MIN_SIZE, Math.min(MAX_SIZE, odd));
}

function sizeToRadius(size: number): number {
  return Math.max(0, Math.floor((size - 1) / 2));
}

function radiusToSize(radius: number): number {
  return Math.max(0, Math.floor(radius)) * 2 + 1;
}

/**
 * Eraser panel (TM-294 simplification): Target layer + resolution + Size
 * slider with editable numeric input. Drops the legacy preset row, the
 * "Erase value" display, and the Advanced section — the eraser always
 * writes the implicit `eraseValue` (0n) and never uses a mask.
 */
export function PaintingEraser({
  session,
  host,
}: {
  session: EditSession;
  host: EditSessionHost;
}) {
  const painting = session.tools.getTool<PaintingTools>("painting");
  const subscribe = useCallback(
    (h: () => void) => painting.on("changed", h),
    [painting],
  );
  useEvent(subscribe);
  const state = painting.getState();

  const onSizeInput = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const size = clampSize(input.valueAsNumber);
    painting.patchState({ radius: sizeToRadius(size) });
  };

  const size = radiusToSize(state.radius);

  return (
    <div class="neuroglancer-tool-panel neuroglancer-painting-eraser-panel">
      <PaintingTargetPicker session={session} host={host} />
      <div class="neuroglancer-tool-panel-row">
        <label>Size</label>
        <input
          type="range"
          min={MIN_SIZE}
          max={MAX_SIZE}
          step={2}
          value={size}
          onInput={onSizeInput}
        />
        <input
          type="number"
          min={MIN_SIZE}
          max={MAX_SIZE}
          step={2}
          value={size}
          onChange={onSizeInput}
        />
      </div>
    </div>
  );
}
