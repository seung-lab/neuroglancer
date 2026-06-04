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
import { useCallback, useState } from "preact/hooks";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { useEvent } from "#src/editing/ui/interop/use_event.js";
import { PaintingTargetPicker } from "#src/editing/ui/tool_settings/painting_target_picker.js";

type FillMode = "2d" | "3d";

/**
 * Fill panel (TM-294): Target layer + resolution + Target value + a
 * 2D/3D mode switch. Drops the Size control and the Advanced section.
 *
 * Note: the 2D/3D switch is currently a UI-only stub. The library's
 * `PaintCompute.fill3d` is the only fill mode available today; the host
 * compute can flip strategy based on this mode once the library gains
 * `fill2d`. Until then, both modes call the same underlying fill — the
 * setting is preserved so users can lock-in their preference now.
 */
export function PaintingFill({
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

  const [mode, setMode] = useState<FillMode>("3d");

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
      <PaintingTargetPicker session={session} host={host} />
      <div class="neuroglancer-tool-panel-row">
        <label>Mode</label>
        <div class="neuroglancer-tool-panel-segmented" role="tablist">
          <button
            type="button"
            class={mode === "2d" ? "active" : undefined}
            title="Fill connected voxels within the current XY slice"
            aria-pressed={mode === "2d"}
            onClick={() => setMode("2d")}
          >
            2D
          </button>
          <button
            type="button"
            class={mode === "3d" ? "active" : undefined}
            title="Fill connected voxels in 3D (across Z)"
            aria-pressed={mode === "3d"}
            onClick={() => setMode("3d")}
          >
            3D
          </button>
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
