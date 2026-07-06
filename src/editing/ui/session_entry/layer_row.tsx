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
import type { LucideIcon } from "lucide-preact";
import {
  FileX,
  Info,
  Layers,
  LoaderCircle,
  RefreshCw,
  Scan,
  TriangleAlert,
  WifiOff,
} from "lucide-preact";
import { useRef } from "preact/hooks";

import { useSignal } from "#src/editing/ui/interop/use_signal.js";
import type { LayerKind } from "#src/editing/ui/layer_kind.js";
import type {
  LayerAvailability,
  LayerErrorCode,
  LayerLoadError,
  OptionReasonCode,
} from "#src/editing/ui/session_entry/layer_availability.js";
import {
  CONSTRAINT_COPY,
  ERROR_COPY,
  RETRY_ARIA_LABEL,
} from "#src/editing/ui/session_entry/layer_availability.js";
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
  /**
   * Effective role — what the session will actually use. Forced to `off`
   * whenever the layer's availability doesn't permit the user's intent (a
   * tier-1 error, or a constraint disabling the picked option). Counters and
   * the memory estimate read THIS, never {@link intent}.
   */
  role: LayerRole;
  /**
   * Last role the user explicitly picked, preserved across availability
   * changes so it can be restored when the layer becomes usable again (retry
   * succeeds, region moves back into bounds). Distinct from the effective
   * {@link role}.
   */
  intent: LayerRole;
  resolutions: readonly Resolution[];
  loadState: "loading" | "loaded" | "error";
  /** Structured tier-1 error (set iff `loadState === "error"`). */
  error: LayerLoadError | undefined;
  /**
   * A retriable (`fetch-failed`) layer is being re-validated in place. The
   * error badge stays, its retry icon becomes a spinner, and the role control
   * stays forced to `off` until the attempt settles.
   */
  retrying: boolean;
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

/** Icon shown inside each tier-1 error badge. */
const ERROR_BADGE_ICON: Record<LayerErrorCode, LucideIcon> = {
  "no-metadata": TriangleAlert,
  "no-scales": Layers,
  "fetch-failed": WifiOff,
  "unsupported-format": FileX,
};

/** Icon shown inside each tier-2 status chip. */
const CONSTRAINT_CHIP_ICON: Record<OptionReasonCode, LucideIcon> = {
  "unsupported-in-session": Info,
  "no-region-overlap": Scan,
};

/** Sanitize a layer name into an id fragment for aria wiring. */
function idFragment(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function LayerRow({
  name,
  layerKind,
  availability,
  state,
  resolutionModel,
  onRoleChange,
  onRetry,
  readOnly = false,
}: {
  name: string;
  layerKind: LayerKind;
  /**
   * Structured availability (TM-374). Undefined only in `readOnly` recaps,
   * where the role is fixed and no availability treatment applies.
   */
  availability?: LayerAvailability;
  state: LayerRowState;
  resolutionModel: ResolutionSelectionModel | undefined;
  onRoleChange: (role: LayerRole) => void;
  /** Re-validate this single layer (fetch-failed retry). */
  onRetry?: () => void;
  /**
   * Read-only display (TM-338): the role control becomes a non-interactive
   * indicator and the resolution renders as static text. Used by the
   * navigation tool's session-summary panel, which recaps an already-open
   * session's configuration rather than editing it.
   */
  readOnly?: boolean;
}) {
  useSignal(resolutionModel?.selectionChanged);

  const isError = availability?.kind === "error";
  // The single session constraint disabling Reference/Editable, if any. Both
  // options share one OptionAvailability, so a disabled `reference` is the
  // constraint (a disabled `editable` alone is the image-kind rule, not a
  // tier-2 note).
  const constraint =
    availability?.kind === "ok" && !availability.reference.enabled
      ? availability.reference
      : undefined;

  // Name + type-badge brightness encodes ONE axis: session participation. Any
  // row whose effective mode is Off — user-chosen, restricted, or errored —
  // dims; only Reference/Editable rows stay full contrast. The status chip and
  // segmented control carry the health/changeable distinctions.
  const isOff = state.role === "off";
  const rowClass = "neuroglancer-edit-session-entry-modal-layer-row";

  const idBase = `neuroglancer-edit-session-layer-${idFragment(name)}`;
  const reasonId = `${idBase}-reason`;
  const detailId = `${idBase}-detail`;

  // The always-present accessible reason text (visually hidden). Disabled
  // segments point their aria-describedby here so screen readers announce why.
  let reasonText: string | undefined;
  if (isError && availability?.kind === "error") {
    reasonText = ERROR_COPY[availability.code].tooltip;
  } else if (constraint !== undefined && !constraint.enabled) {
    reasonText =
      constraint.detail ?? CONSTRAINT_COPY[constraint.reason].chipLabel;
  }

  const nameClass = [
    "neuroglancer-edit-session-entry-modal-layer-name",
    isOff ? "neuroglancer-edit-session-entry-modal-layer-name-dim" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const badgeClass = [
    "neuroglancer-edit-session-entry-modal-layer-kind",
    layerKind === "segmentation"
      ? "neuroglancer-edit-session-entry-modal-layer-kind-segmentation"
      : "neuroglancer-edit-session-entry-modal-layer-kind-image",
    isOff ? "neuroglancer-edit-session-entry-modal-layer-kind-dim" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div class={rowClass}>
      <span class={nameClass}>{name}</span>
      <span class={badgeClass}>{LAYER_KIND_LABEL[layerKind]}</span>
      <span class="neuroglancer-edit-session-entry-modal-layer-resolution-slot">
        <ResolutionSlot
          readOnly={readOnly}
          state={state}
          availability={availability}
          resolutionModel={resolutionModel}
          detailId={detailId}
          onRetry={onRetry}
        />
      </span>
      {readOnly ? (
        <RoleBadge role={state.role} />
      ) : (
        <RoleControl
          role={state.role}
          layerKind={layerKind}
          availability={availability}
          reasonId={reasonText !== undefined ? reasonId : undefined}
          onChange={onRoleChange}
        />
      )}
      {reasonText !== undefined && (
        <span
          id={reasonId}
          class="neuroglancer-edit-session-entry-modal-visually-hidden"
        >
          {reasonText}
        </span>
      )}
    </div>
  );
}

/**
 * The middle column: exactly one same-width element per row — resolution
 * dropdown/value (healthy), tier-1 error badge, or a tier-2 neutral status
 * chip. The full explanation always lives in the element's tooltip.
 */
function ResolutionSlot({
  readOnly,
  state,
  availability,
  resolutionModel,
  detailId,
  onRetry,
}: {
  readOnly: boolean;
  state: LayerRowState;
  availability: LayerAvailability | undefined;
  resolutionModel: ResolutionSelectionModel | undefined;
  detailId: string;
  onRetry?: () => void;
}) {
  if (readOnly) {
    // The session's selected resolutions are fixed once it's open — show them
    // as plain text (joined when a layer locked more than one).
    const text =
      state.resolutions.length > 0 ? state.resolutions.join(", ") : "—";
    return (
      <span class="neuroglancer-edit-session-entry-modal-layer-resolution-static">
        {text}
      </span>
    );
  }

  if (availability?.kind === "error") {
    return (
      <ErrorBadge
        code={availability.code}
        retriable={availability.retriable}
        detail={availability.detail ?? state.error?.detail}
        detailId={detailId}
        retrying={state.retrying}
        onRetry={onRetry}
      />
    );
  }

  // Healthy layer whose only selectable option is Off (a session constraint):
  // a neutral status chip fills the slot (same width as a dropdown/badge), with
  // the full wording in its tooltip + accessible description.
  if (availability?.kind === "ok" && availability.reference.enabled === false) {
    return (
      <ConstraintChip
        reason={availability.reference.reason}
        detail={availability.reference.detail}
        detailId={detailId}
      />
    );
  }

  if (state.loadState === "loading") {
    return (
      <span class="neuroglancer-edit-session-entry-modal-layer-resolution-loading">
        (loading&hellip;)
      </span>
    );
  }

  const isOff = state.role === "off";
  if (state.availableResolutions.length <= 1) {
    // Single-resolution (or zero, shouldn't happen here): render as static
    // text, no dropdown.
    const value = state.availableResolutions[0] ?? "";
    return (
      <span class="neuroglancer-edit-session-entry-modal-layer-resolution-static">
        {value}
      </span>
    );
  }
  if (resolutionModel !== undefined) {
    return (
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
  }
  return null;
}

/** Tier-1 error badge; carries a retry affordance for `fetch-failed`. */
function ErrorBadge({
  code,
  retriable,
  detail,
  detailId,
  retrying,
  onRetry,
}: {
  code: LayerErrorCode;
  retriable: boolean;
  detail: string | undefined;
  detailId: string;
  retrying: boolean;
  onRetry?: () => void;
}) {
  const copy = ERROR_COPY[code];
  const Icon = ERROR_BADGE_ICON[code];
  const badgeClass = [
    "neuroglancer-edit-session-entry-modal-layer-badge",
    `neuroglancer-edit-session-entry-modal-layer-badge-${copy.tone}`,
  ].join(" ");
  return (
    <span class="neuroglancer-edit-session-entry-modal-layer-badge-group">
      <span
        class={badgeClass}
        // The badge is focusable so the tooltip (and its detail) is reachable
        // by keyboard, not hover-only.
        tabIndex={0}
        data-tooltip={copy.tooltip}
        aria-describedby={detail !== undefined ? detailId : undefined}
      >
        <Icon size={13} aria-hidden={true} />
        <span>{copy.badgeLabel}</span>
      </span>
      {detail !== undefined && (
        <span
          id={detailId}
          class="neuroglancer-edit-session-entry-modal-visually-hidden"
        >
          {detail}
        </span>
      )}
      {retriable && onRetry !== undefined && (
        <button
          type="button"
          class="neuroglancer-edit-session-entry-modal-layer-retry"
          aria-label={RETRY_ARIA_LABEL}
          data-tooltip={RETRY_ARIA_LABEL}
          disabled={retrying}
          aria-busy={retrying}
          onClick={() => {
            if (!retrying) onRetry();
          }}
        >
          {retrying ? (
            <LoaderCircle
              size={15}
              aria-hidden={true}
              class="neuroglancer-edit-session-entry-modal-spin"
            />
          ) : (
            <RefreshCw size={15} aria-hidden={true} />
          )}
        </button>
      )}
    </span>
  );
}

/**
 * Tier-2 neutral status chip in the middle slot (muted/gray — visually distinct
 * from the danger/warning error badges). Shows a short label; the full wording
 * is in the tooltip and an accessible description.
 */
function ConstraintChip({
  reason,
  detail,
  detailId,
}: {
  reason: OptionReasonCode;
  detail: string | undefined;
  detailId: string;
}) {
  const Icon = CONSTRAINT_CHIP_ICON[reason];
  return (
    <span class="neuroglancer-edit-session-entry-modal-layer-badge-group">
      <span
        class="neuroglancer-edit-session-entry-modal-layer-badge neuroglancer-edit-session-entry-modal-layer-badge-neutral"
        // Focusable so the tooltip/detail is keyboard-reachable, not hover-only.
        tabIndex={0}
        data-tooltip={detail}
        aria-describedby={detail !== undefined ? detailId : undefined}
      >
        <Icon size={13} aria-hidden={true} />
        <span>{CONSTRAINT_COPY[reason].chipLabel}</span>
      </span>
      {detail !== undefined && (
        <span
          id={detailId}
          class="neuroglancer-edit-session-entry-modal-visually-hidden"
        >
          {detail}
        </span>
      )}
    </span>
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
  availability,
  reasonId,
  onChange,
}: {
  role: LayerRole;
  layerKind: LayerKind;
  availability: LayerAvailability | undefined;
  /** aria-describedby target announced on disabled segments. */
  reasonId: string | undefined;
  onChange: (role: LayerRole) => void;
}) {
  const isError = availability?.kind === "error";
  const refOption =
    availability?.kind === "ok" ? availability.reference : undefined;
  const editOption =
    availability?.kind === "ok" ? availability.editable : undefined;

  // Reference is blocked by any tier-1 error or a session constraint.
  const referenceDisabled = isError || refOption?.enabled === false;
  // Editable is additionally blocked on image layers (a display-kind rule
  // outside the availability taxonomy).
  const editableDisabled =
    isError || editOption?.enabled === false || layerKind === "image";

  const constraintDetail =
    refOption !== undefined && !refOption.enabled
      ? refOption.detail
      : undefined;

  // The control is non-operable when a tier-1 error forces Off, or a tier-2
  // constraint leaves Off as the only option. Then the selected Off is an
  // absence of choice, so the whole control renders muted — accent blue is
  // reserved for selections the user can actually make (TM-374 items 5/6).
  const controlDisabled = isError || referenceDisabled;
  const controlClass = [
    "neuroglancer-edit-session-entry-modal-role-control",
    controlDisabled
      ? "neuroglancer-edit-session-entry-modal-role-control-disabled"
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  const segments: readonly RoleSegmentSpec[] = [
    { value: "off", label: "Off", tooltip: ROLE_TOOLTIP.off, disabled: false },
    {
      value: "reference",
      label: "Reference",
      tooltip: constraintDetail ?? ROLE_TOOLTIP.reference,
      disabled: referenceDisabled,
    },
    {
      value: "editable",
      label: "Editable",
      tooltip:
        constraintDetail ??
        (layerKind === "image"
          ? EDITABLE_DISABLED_TOOLTIP
          : ROLE_TOOLTIP.editable),
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
      class={controlClass}
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
          describedBy={seg.disabled ? reasonId : undefined}
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
  describedBy,
  onChange,
  buttonRef,
}: {
  value: LayerRole;
  current: LayerRole;
  label: string;
  tooltip: string;
  disabled: boolean;
  describedBy: string | undefined;
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
  // in CSS and hover falls through to this wrapper. Disabled segments stay
  // focusable (aria-disabled, not the `disabled` attribute) so screen readers
  // reach the aria-describedby reason and the tooltip shows on focus.
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
        aria-describedby={describedBy}
        // Roving tabindex for the enabled segments (only the selected one is a
        // tab stop, so arrows move within the group). Disabled segments stay
        // individually focusable (tabIndex 0) so keyboard/SR users reach their
        // aria-describedby reason and the focus tooltip.
        tabIndex={disabled || selected ? 0 : -1}
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
