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
import { TargetValueField } from "#src/editing/ui/tool_settings/target_value_field.js";

/**
 * Fill panel (TM-294): Target layer + resolution + Target value. Drops the
 * Size control and the Advanced section.
 *
 * The 2D/3D mode switch is hidden for now (TM-269): the only fill mode the
 * library implements is the 3D flood (`PaintCompute.fill3d`), so the toggle
 * had nothing to drive. Fill always runs in 3D. Re-introduce the switch once
 * the library gains a real `fill2d` path.
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

  return (
    <div class="neuroglancer-tool-panel neuroglancer-painting-fill-panel">
      <PaintingTargetPicker session={session} host={host} />
      <TargetValueField
        value={state.activeValue}
        onCommit={(activeValue) => painting.patchState({ activeValue })}
        hint="The segment ID written into the filled region — every voxel the fill reaches is set to this value."
      />
    </div>
  );
}
