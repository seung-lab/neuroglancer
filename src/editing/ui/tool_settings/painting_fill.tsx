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

export function PaintingFill({ session }: { session: EditSession }) {
  const painting = session.tools.getTool<PaintingTools>("painting");
  const subscribe = useCallback(
    (h: () => void) => painting.on("changed", h),
    [painting],
  );
  useEvent(subscribe);
  const state = painting.getState();

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
    <div class="neuroglancer-tool-panel neuroglancer-painting-fill-panel">
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
