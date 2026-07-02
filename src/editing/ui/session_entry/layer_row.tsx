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
import { useRef } from "preact/hooks";

import { useSignal } from "#src/editing/ui/interop/use_signal.js";
import type { BlockedScheme, LayerKind } from "#src/editing/ui/layer_kind.js";
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

const BLOCKED_SCHEME_LABEL: Record<BlockedScheme, string> = {
  calcada: "Calcada",
  graphene: "Graphene",
};

/**
 * Tooltip shown on the `Reference`/`Editable` segments when the layer's data
 * source scheme blocks it from the session entirely (TM-312).
 */
export function blockedSchemeTooltip(scheme: BlockedScheme): string {
  return `${BLOCKED_SCHEME_LABEL[scheme]} layers can't be used in an edit session — only Off is available.`;
}

const LAYER_KIND_LABEL: Record<LayerKind, string> = {
  image: "IMG",
  segmentation: "SEG",
};

export function LayerRow({
  name,
  layerKind,
  blockedScheme,
  regionBlockReason,
  state,
  resolutionModel,
  onRoleChange,
  readOnly = false,
}: {
  name: string;
  layerKind: LayerKind;
  blockedScheme: BlockedScheme | undefined;
  /**
   * Set when the edit region falls outside the layer's `voxel_offset + size`
   * bounds (TM-360). Blocks the layer to Off-only exactly like `blockedScheme`
   * — the string is the hover tooltip on the disabled Reference/Editable
   * segments. Region-dependent, so it clears when the user picks a region the
   * layer's bounds contain.
   */
  regionBlockReason?: string;
  state: LayerRowState;
  resolutionModel: ResolutionSelectionModel | undefined;
  onRoleChange: (role: LayerRole) => void;
  /**
   * Read-only display (TM-338): the role control becomes a non-interactive
   * indicator and the resolution renders as static text. Used by the
   * navigation tool's session-summary panel, which recaps an already-open
   * session's configuration rather than editing it.
   */
  readOnly?: boolean;
}) {
  useSignal(resolutionModel?.selectionChanged);

  const isOff = state.role === "off";
  const rowClass = isOff
    ? "neuroglancer-edit-session-entry-modal-layer-row neuroglancer-edit-session-entry-modal-layer-row-off"
    : "neuroglancer-edit-session-entry-modal-layer-row";

  let resolutionContent;
  if (readOnly) {
    // The session's selected resolutions are fixed once it's open — show them
    // as plain text (joined when a layer locked more than one).
    const text =
      state.resolutions.length > 0 ? state.resolutions.join(", ") : "—";
    resolutionContent = (
      <span class="neuroglancer-edit-session-entry-modal-layer-resolution-static">
        {text}
      </span>
    );
  } else if (state.loadState === "loading") {
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
      {readOnly ? (
        <RoleBadge role={state.role} />
      ) : (
        <RoleControl
          role={state.role}
          layerKind={layerKind}
          blockedScheme={blockedScheme}
          regionBlockReason={regionBlockReason}
          onChange={onRoleChange}
        />
      )}
    </div>
  );
}

/** Role labels, shared by the interactive control and the read-only badge. */
const ROLE_LABEL: Record<LayerRole, string> = {
  off: "Off",
  reference: "Reference",
  editable: "Editable",
};

/**
 * Static, non-interactive role indicator (TM-338). Shown instead of the
 * three-segment `RoleControl` in read-only contexts (the navigation summary),
 * where the role is fixed and the row must stay narrow for a side panel.
 */
function RoleBadge({ role }: { role: LayerRole }) {
  return (
    <span
      class="neuroglancer-edit-session-entry-modal-role-badge"
      data-role={role}
    >
      {ROLE_LABEL[role]}
    </span>
  );
}

interface RoleSegmentSpec {
  readonly value: LayerRole;
  readonly label: string;
  readonly tooltip: string;
  readonly disabled: boolean;
}

function RoleControl({
  role,
  layerKind,
  blockedScheme,
  regionBlockReason,
  onChange,
}: {
  role: LayerRole;
  layerKind: LayerKind;
  blockedScheme: BlockedScheme | undefined;
  regionBlockReason: string | undefined;
  onChange: (role: LayerRole) => void;
}) {
  // Both an unsupported scheme (calcada/graphene) and a region the layer holds
  // no data for (TM-360) block the layer to Off-only; the scheme reason wins
  // when both apply (it's the more fundamental problem).
  const blockTooltip =
    blockedScheme !== undefined
      ? blockedSchemeTooltip(blockedScheme)
      : regionBlockReason;
  const editableDisabled = blockTooltip !== undefined || layerKind === "image";
  const segments: readonly RoleSegmentSpec[] = [
    { value: "off", label: "Off", tooltip: ROLE_TOOLTIP.off, disabled: false },
    {
      value: "reference",
      label: "Reference",
      tooltip: blockTooltip ?? ROLE_TOOLTIP.reference,
      disabled: blockTooltip !== undefined,
    },
    {
      value: "editable",
      label: "Editable",
      tooltip:
        blockTooltip ??
        (editableDisabled ? EDITABLE_DISABLED_TOOLTIP : ROLE_TOOLTIP.editable),
      disabled: editableDisabled,
    },
  ];
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Move selection to a segment by index (radiogroup arrows both move focus AND
  // select, unlike the browse-only listbox); no-op on a disabled segment.
  const selectAt = (index: number) => {
    const seg = segments[index];
    if (seg === undefined || seg.disabled || seg.value === role) {
      btnRefs.current[index]?.focus();
      return;
    }
    onChange(seg.value);
    btnRefs.current[index]?.focus();
  };

  // Next enabled index in `dir`, wrapping, skipping disabled segments.
  const nextEnabled = (from: number, dir: number) => {
    const n = segments.length;
    for (let step = 1; step <= n; step++) {
      const idx = (from + dir * step + n * n) % n;
      if (!segments[idx].disabled) return idx;
    }
    return from;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const currentIndex = segments.findIndex((s) => s.value === role);
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault();
        selectAt(nextEnabled(currentIndex, 1));
        break;
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault();
        selectAt(nextEnabled(currentIndex, -1));
        break;
      case "Home":
        e.preventDefault();
        selectAt(nextEnabled(-1, 1));
        break;
      case "End":
        e.preventDefault();
        selectAt(nextEnabled(segments.length, -1));
        break;
    }
  };

  return (
    <div
      class="neuroglancer-edit-session-entry-modal-role-control"
      role="radiogroup"
      aria-label="Layer role"
      onKeyDown={onKeyDown}
    >
      {segments.map((seg, i) => (
        <RoleSegment
          key={seg.value}
          value={seg.value}
          current={role}
          label={seg.label}
          tooltip={seg.tooltip}
          disabled={seg.disabled}
          onChange={onChange}
          buttonRef={(el) => {
            btnRefs.current[i] = el;
          }}
        />
      ))}
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
  buttonRef,
}: {
  value: LayerRole;
  current: LayerRole;
  label: string;
  tooltip: string;
  disabled: boolean;
  onChange: (role: LayerRole) => void;
  buttonRef: (el: HTMLButtonElement | null) => void;
}) {
  const selected = value === current;
  const cls = [
    "neuroglancer-edit-session-entry-modal-role-segment",
    selected
      ? "neuroglancer-edit-session-entry-modal-role-segment-selected"
      : "",
    disabled
      ? "neuroglancer-edit-session-entry-modal-role-segment-disabled"
      : "",
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
        ref={buttonRef}
        type="button"
        role="radio"
        aria-checked={selected}
        aria-disabled={disabled}
        disabled={disabled}
        // Roving tabindex: only the selected segment is a tab stop, so Tab
        // lands on the group once and the arrow keys move within it.
        tabIndex={selected ? 0 : -1}
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
