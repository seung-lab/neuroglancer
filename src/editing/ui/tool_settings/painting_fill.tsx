/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { EditSession } from "@zettaai/edit-session";
import { useCallback } from "preact/hooks";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { useEvent } from "#src/editing/ui/interop/use_event.js";
import { SegmentedControl } from "#src/editing/ui/segmented_control.js";
import { PaintingTargetPicker } from "#src/editing/ui/tool_settings/painting_target_picker.js";
import {
  PARAM_IDS,
  useParamFocus,
  useParamSelection,
  usePublishParams,
  useTargetParamDescriptors,
  valueDescriptor,
} from "#src/editing/ui/tool_settings/param_descriptors.js";
import { TargetValueField } from "#src/editing/ui/tool_settings/target_value_field.js";
import { useLayerVoxelType } from "#src/editing/ui/tool_settings/use_layer_voxel_type.js";

/**
 * Fill panel (TM-294): Target layer + resolution + Target value + the 2D/3D
 * mode toggle (TM-269). Drops the Size control and the Advanced section.
 */
export function PaintingFill({
  host,
}: {
  session: EditSession;
  host: EditSessionHost;
}) {
  const painting = host.painting!.state;
  const subscribe = useCallback(
    (h: () => void) => painting.changed.add(h),
    [painting],
  );
  useEvent(subscribe);
  const state = painting.getState();
  const targetVoxelType = useLayerVoxelType(host, state.targetLayerId);

  const selectedId = useParamSelection(host);
  const selectParam = useParamFocus(host);
  const targetDescriptors = useTargetParamDescriptors(host);
  usePublishParams(host, [
    ...targetDescriptors,
    valueDescriptor(painting, targetVoxelType),
  ]);

  return (
    <div class="neuroglancer-tool-panel neuroglancer-painting-fill-panel">
      <PaintingTargetPicker host={host} />
      <TargetValueField
        value={state.activeValue}
        voxelDataType={targetVoxelType}
        onCommit={(activeValue) => painting.patchState({ activeValue })}
        hint="The segment ID written into the filled region — every voxel the fill reaches is set to this value."
        highlighted={selectedId === PARAM_IDS.value}
        onSelect={() => selectParam(PARAM_IDS.value)}
      />
      <div
        class="neuroglancer-tool-panel-row neuroglancer-painting-fill-mode-row"
        data-tooltip="2D fills only the clicked section (Z fixed) — e.g. the interior of a shape drawn on one slice. 3D floods across sections."
      >
        <label>Fill mode</label>
        <SegmentedControl
          ariaLabel="Fill mode"
          value={state.fillMode}
          options={[
            { value: "2d", label: "2D" },
            { value: "3d", label: "3D" },
          ]}
          onChange={(fillMode) => painting.patchState({ fillMode })}
        />
      </div>
    </div>
  );
}
