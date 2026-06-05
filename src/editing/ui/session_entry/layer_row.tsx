/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { Resolution } from "@zettaai/edit-session";

import { useSignal } from "#src/editing/ui/interop/use_signal.js";
import type { LayerKind } from "#src/editing/ui/layer_kind.js";
import type { ResolutionSelectionModel } from "#src/editing/ui/session_entry/resolution_options.js";
import { ResolutionPicker } from "#src/editing/ui/session_entry/resolution_picker.js";

export type { LayerKind };

/**
 * Three-state role for a layer in the to-be-opened edit session.
 *
 * - `off` — layer not in the session. Loads dynamically as you move the
 *   camera (default Neuroglancer behavior). Does NOT count toward the
 *   session memory budget.
 * - `reference` — included, read-only. Locked in memory for the bbox region.
 *   Counts toward the memory budget.
 * - `editable` — included, writable. Locked in memory and accepts edits.
 *   Counts toward the memory budget.
 */
export type LayerRole = "off" | "reference" | "editable";

export interface LayerRowState {
  role: LayerRole;
  resolutions: readonly Resolution[];
  loadState: "loading" | "loaded" | "error";
  loadError: string | undefined;
  availableResolutions: readonly Resolution[];
}

/** Microcopy that hovers on each role segment (spec strings, verbatim). */
export const ROLE_TOOLTIP: Record<LayerRole, string> = {
  off:
    "Off — not in this session. Loads dynamically as you move the camera " +
    "(default Neuroglancer behavior) and doesn't use the session memory budget.",
  reference:
    "Reference — locked in memory for the bbox region, read-only. " +
    "Counts toward the memory budget.",
  editable:
    "Editable — locked in memory and writable. Counts toward the memory budget.",
};

/** Tooltip shown on the `Editable` segment when it's disabled (image layer). */
export const EDITABLE_DISABLED_TOOLTIP =
  "Image layers can't be edited — choose Off or Reference.";

const LAYER_KIND_LABEL: Record<LayerKind, string> = {
  image: "IMG",
  segmentation: "SEG",
};

export function LayerRow({
  name,
  layerKind,
  state,
  resolutionModel,
  onRoleChange,
}: {
  name: string;
  layerKind: LayerKind;
  state: LayerRowState;
  resolutionModel: ResolutionSelectionModel | undefined;
  onRoleChange: (role: LayerRole) => void;
}) {
  useSignal(resolutionModel?.selectionChanged);

  const isOff = state.role === "off";
  const rowClass = isOff
    ? "neuroglancer-edit-session-entry-modal-layer-row neuroglancer-edit-session-entry-modal-layer-row-off"
    : "neuroglancer-edit-session-entry-modal-layer-row";

  let resolutionContent;
  if (state.loadState === "loading") {
    resolutionContent = (
      <span class="neuroglancer-edit-session-entry-modal-layer-resolution-loading">
        (loading&hellip;)
      </span>
    );
  } else if (state.loadState === "error") {
    const errorText =
      state.loadError === "no resolutions"
        ? "(no resolutions available)"
        : `(unavailable: ${state.loadError})`;
    resolutionContent = (
      <span class="neuroglancer-edit-session-entry-modal-layer-resolution-error">
        {errorText}
      </span>
    );
  } else if (state.availableResolutions.length <= 1) {
    // Single-resolution (or zero, shouldn't happen here): render as static
    // text, no dropdown.
    const value = state.availableResolutions[0] ?? "";
    resolutionContent = (
      <span class="neuroglancer-edit-session-entry-modal-layer-resolution-static">
        {value}
      </span>
    );
  } else if (resolutionModel !== undefined) {
    resolutionContent = (
      <span
        data-tooltip="Choose the scale to load for this layer."
        class="neuroglancer-edit-session-entry-modal-layer-resolution-picker"
      >
        <ResolutionPicker
          resolutions={resolutionModel.resolutions}
          selected={resolutionModel.selectedResolutions}
          onChange={(values) => resolutionModel.setSelection(values)}
          disabled={isOff}
        />
      </span>
    );
  } else {
    resolutionContent = null;
  }

  const badgeClass =
    layerKind === "segmentation"
      ? "neuroglancer-edit-session-entry-modal-layer-kind neuroglancer-edit-session-entry-modal-layer-kind-segmentation"
      : "neuroglancer-edit-session-entry-modal-layer-kind neuroglancer-edit-session-entry-modal-layer-kind-image";

  return (
    <div class={rowClass}>
      <span class="neuroglancer-edit-session-entry-modal-layer-name">
        {name}
      </span>
      <span class={badgeClass}>{LAYER_KIND_LABEL[layerKind]}</span>
      <span class="neuroglancer-edit-session-entry-modal-layer-resolution-slot">
        {resolutionContent}
      </span>
      <RoleControl
        role={state.role}
        layerKind={layerKind}
        onChange={onRoleChange}
      />
    </div>
  );
}

function RoleControl({
  role,
  layerKind,
  onChange,
}: {
  role: LayerRole;
  layerKind: LayerKind;
  onChange: (role: LayerRole) => void;
}) {
  const editableDisabled = layerKind === "image";
  return (
    <div
      class="neuroglancer-edit-session-entry-modal-role-control"
      role="radiogroup"
      aria-label="Layer role"
    >
      <RoleSegment
        value="off"
        current={role}
        label="Off"
        tooltip={ROLE_TOOLTIP.off}
        disabled={false}
        onChange={onChange}
      />
      <RoleSegment
        value="reference"
        current={role}
        label="Reference"
        tooltip={ROLE_TOOLTIP.reference}
        disabled={false}
        onChange={onChange}
      />
      <RoleSegment
        value="editable"
        current={role}
        label="Editable"
        tooltip={editableDisabled ? EDITABLE_DISABLED_TOOLTIP : ROLE_TOOLTIP.editable}
        disabled={editableDisabled}
        onChange={onChange}
      />
    </div>
  );
}

function RoleSegment({
  value,
  current,
  label,
  tooltip,
  disabled,
  onChange,
}: {
  value: LayerRole;
  current: LayerRole;
  label: string;
  tooltip: string;
  disabled: boolean;
  onChange: (role: LayerRole) => void;
}) {
  const selected = value === current;
  const cls = [
    "neuroglancer-edit-session-entry-modal-role-segment",
    selected
      ? "neuroglancer-edit-session-entry-modal-role-segment-selected"
      : "",
    disabled ? "neuroglancer-edit-session-entry-modal-role-segment-disabled" : "",
  ]
    .filter(Boolean)
    .join(" ");
  // Wrap so the tooltip still shows while the segment is disabled (e.g. the
  // "Editable" segment on image layers explains why it's unavailable). A
  // disabled button emits no pointer events, so it drops to pointer-events:none
  // in CSS and hover falls through to this wrapper.
  return (
    <span
      class="neuroglancer-edit-session-entry-modal-role-segment-wrap"
      data-tooltip={tooltip}
    >
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        aria-disabled={disabled}
        disabled={disabled}
        class={cls}
        onClick={() => {
          if (disabled) return;
          if (selected) return;
          onChange(value);
        }}
      >
        {label}
      </button>
    </span>
  );
}
