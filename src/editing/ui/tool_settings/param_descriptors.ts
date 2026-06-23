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
 * @file Shared parameter-descriptor builders for the paint tool panels (TM-337).
 *
 * The Ctrl+Arrow keyboard scheme cycles the panel's enabled parameters in
 * render order. To keep the cycle order in lock-step with the UI, each paint
 * panel builds an ordered list of {@link ParamDescriptor}s from its current
 * render state and publishes it into the session {@link PaintParamCursor} via
 * {@link usePublishParams}. The descriptor closures read painting state *live*
 * (not a render snapshot) so the status readout the binder queries synchronously
 * right after a change reflects the new value.
 */

import type { LayerId, Resolution, VoxelDataType } from "@zettaai/edit-session";
import { layerId as toLayerId } from "@zettaai/edit-session";
import { useCallback, useEffect } from "preact/hooks";

import { radiusToSize, sizeToRadius } from "#src/editing/brush_size_presets.js";
import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { nextPresetSize } from "#src/editing/painting_hotkey_math.js";
import { clampToVoxelDataType } from "#src/editing/tool_runtimes/mask_coord.js";
import type { PaintingState } from "#src/editing/tool_runtimes/painting_tools.js";
import {
  enumDescriptor,
  numberDescriptor,
  type ParamDescriptor,
} from "#src/editing/tool_runtimes/param_cursor.js";
import { useEvent } from "#src/editing/ui/interop/use_event.js";
import { useWatchable } from "#src/editing/ui/interop/use_watchable.js";

/** Re-exported so panels don't double-import the math helper. */
export { nextPresetSize, radiusToSize, sizeToRadius };

/**
 * Stable ids for the adjustable parameters, shared between descriptor building
 * and the panel's selected-row highlight. Kept identical across tools (e.g.
 * `size`) so the selection survives a brush↔eraser switch.
 */
export const PARAM_IDS = {
  targetLayer: "target-layer",
  targetResolution: "target-resolution",
  size: "size",
  value: "value",
  referenceLayer: "reference-layer",
  referenceResolution: "reference-resolution",
  thresholdLow: "threshold-low",
  thresholdHigh: "threshold-high",
  minComponent: "min-component",
  binaryClosing: "binary-closing",
  filterComponentsFirst: "filter-components-first",
} as const;

/** Class added to the tool-panel row whose parameter is keyboard-selected. */
export const SELECTED_ROW_CLASS = "neuroglancer-tool-panel-row--selected";

/**
 * Build the row `class` string, appending {@link SELECTED_ROW_CLASS} when `id`
 * is the keyboard-selected parameter.
 */
export function rowClass(
  base: string,
  id: string,
  selectedId: string | undefined,
): string {
  return selectedId === id ? `${base} ${SELECTED_ROW_CLASS}` : base;
}

/**
 * Subscribe to the param cursor and return the currently-selected parameter id
 * (or `undefined`). Panels use it to outline the selected row.
 */
export function useParamSelection(host: EditSessionHost): string | undefined {
  const cursor = host.painting?.paramCursor;
  const subscribe = useCallback(
    (h: () => void) => cursor?.changed.add(h) ?? (() => {}),
    [cursor],
  );
  useEvent(cursor !== undefined ? subscribe : undefined);
  return cursor?.getSelectedId();
}

/**
 * Capture-phase handler props that focus parameter `id` for the Ctrl+Arrow
 * scheme when the user interacts with a control inside the row (TM-345). Spread
 * onto the row element (or a control). Capture phase is used so it fires for the
 * non-bubbling `focus` event and still wins if an inner control stops
 * propagation; `pointerdown` covers mouse/touch (sliders, dropdowns, toggles)
 * and `focus` covers keyboard tabbing into inputs.
 */
export function paramFocusHandlers(
  select: (id: string) => void,
  id: string,
): {
  onPointerDownCapture: () => void;
  onFocusCapture: () => void;
} {
  return {
    onPointerDownCapture: () => select(id),
    onFocusCapture: () => select(id),
  };
}

/**
 * Returns a stable setter that focuses a parameter by id in the session param
 * cursor (TM-345). Panels call it from {@link paramFocusHandlers} so clicking or
 * focusing a field's control makes that field the Ctrl+Arrow target.
 */
export function useParamFocus(host: EditSessionHost): (id: string) => void {
  const cursor = host.painting?.paramCursor;
  return useCallback((id: string) => cursor?.select(id), [cursor]);
}

/**
 * Publish `descriptors` into the session param cursor for as long as the panel
 * is mounted. Republishes on every render so the captured closures stay current
 * (`publish` only dispatches when the id set / selection actually changes), and
 * clears the cursor on unmount so a stale list never lingers after a tool switch.
 */
export function usePublishParams(
  host: EditSessionHost,
  descriptors: readonly ParamDescriptor[],
): void {
  const cursor = host.painting?.paramCursor;
  useEffect(() => {
    cursor?.publish(descriptors);
  });
  useEffect(() => () => cursor?.publish([]), [cursor]);
}

/**
 * Target layer (+ resolution when the layer exposes more than one) descriptors,
 * shared by all three paint panels via the `PaintingTargetPicker`. Mirrors the
 * picker's writable-layer derivation and patch logic, reading host/painting
 * state live. Returns `[]` when there are no writable layers (the picker hides
 * itself in that case).
 */
export function useTargetParamDescriptors(
  host: EditSessionHost,
): ParamDescriptor[] {
  useWatchable(host.state.value);
  const painting = host.painting?.state;
  const subscribe = useCallback(
    (h: () => void) => painting?.changed.add(h) ?? (() => {}),
    [painting],
  );
  useEvent(painting !== undefined ? subscribe : undefined);

  if (painting === undefined) return [];
  const intent = host.state.value.value;
  if (intent === null) return [];
  const writable = intent.layers.filter((l) => l.writable);
  if (writable.length === 0) return [];

  const currentLayerId = () => {
    const id = painting.getState().targetLayerId;
    return writable.some((l) => l.layerId === id) ? id : writable[0].layerId;
  };
  const currentLayer = () =>
    writable.find((l) => l.layerId === currentLayerId()) ?? writable[0];
  const layerOptions = writable.map((l) => l.layerId);

  const out: ParamDescriptor[] = [];
  out.push(
    enumDescriptor({
      id: PARAM_IDS.targetLayer,
      label: "Target layer",
      options: () => layerOptions,
      index: () => layerOptions.indexOf(currentLayerId()),
      select: (i) => {
        const next = writable[i];
        if (next === undefined) return;
        const targetResolution = painting.getState().targetResolution;
        const nextResolution = next.resolutions.includes(targetResolution)
          ? targetResolution
          : next.resolutions[0];
        painting.patchState({
          targetLayerId: toLayerId(next.layerId) as LayerId,
          targetResolution: nextResolution,
        });
      },
    }),
  );

  // Resolution is only changeable when the layer has more than one scale (the
  // picker renders a static readout otherwise), so it joins the rotation only
  // then — exactly the "available for changing" rule.
  const resolutions = currentLayer().resolutions;
  if (resolutions.length > 1) {
    const currentResolution = () => {
      const r = painting.getState().targetResolution;
      return resolutions.includes(r) ? r : resolutions[0];
    };
    out.push(
      enumDescriptor({
        id: PARAM_IDS.targetResolution,
        label: "Target resolution",
        options: () => resolutions,
        index: () => resolutions.indexOf(currentResolution()),
        select: (i) => {
          const r = resolutions[i] as Resolution | undefined;
          if (r !== undefined) painting.patchState({ targetResolution: r });
        },
      }),
    );
  }
  return out;
}

/** Brush/eraser size descriptor: steps the preset cycle, reading state live. */
export function sizeDescriptor(painting: PaintingState): ParamDescriptor {
  return numberDescriptor({
    id: PARAM_IDS.size,
    label: "Size",
    format: () => String(radiusToSize(painting.getState().radius)),
    apply: (steps) => {
      const dir = Math.sign(steps);
      let size = radiusToSize(painting.getState().radius);
      for (let i = 0; i < Math.abs(steps); i++)
        size = nextPresetSize(size, dir);
      const radius = sizeToRadius(size);
      if (radius !== painting.getState().radius)
        painting.patchState({ radius });
    },
  });
}

/**
 * Brush/fill target-value descriptor: ±1 per step, clamped to the target
 * layer's representable range (bigint-preserving for uint64). float32 uses the
 * same ±1 logic — no special-casing (per the ticket). When the dtype is not yet
 * resolved, falls back to ≥0 stepping.
 */
export function valueDescriptor(
  painting: PaintingState,
  voxelType: VoxelDataType | undefined,
): ParamDescriptor {
  return numberDescriptor({
    id: PARAM_IDS.value,
    label: "Value",
    format: () => String(painting.getState().activeValue),
    apply: (steps) => {
      const v = painting.getState().activeValue;
      const stepped = typeof v === "bigint" ? v + BigInt(steps) : v + steps;
      let next: number | bigint;
      if (voxelType === undefined) {
        next =
          typeof stepped === "bigint"
            ? stepped < 0n
              ? 0n
              : stepped
            : stepped < 0
              ? 0
              : stepped;
      } else {
        next = clampToVoxelDataType(voxelType, stepped);
      }
      if (next !== v) painting.patchState({ activeValue: next });
    },
  });
}
