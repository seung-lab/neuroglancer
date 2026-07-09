/**
 * @license
 * Copyright 2026 Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { AlignmentModel } from "#src/alignment_link/alignment_link_math.js";
import type {
  AlignmentLinkStatus,
  AlignmentLinkUi,
} from "#src/alignment_link/ui/interop/use_alignment_link_status.js";
import { ToggleSwitch } from "#src/editing/ui/toggle_switch.js";

// Side effect: ensures the --nge-* tokens exist even when no editing panel is
// mounted (same convention as the confirm dialog / session-entry modal).
import "#src/editing/ui/editing_theme.css";
import "#src/alignment_link/ui/alignment_link.css";

const MODELS: Array<{ value: AlignmentModel; label: string }> = [
  { value: "local", label: "Local affine (auto)" },
  { value: "translation", label: "Translation" },
  { value: "similarity", label: "Similarity" },
  { value: "affine", label: "Affine" },
];

function statusText(status: AlignmentLinkStatus): {
  text: string;
  tone: "muted" | "warn" | "error";
} {
  if (!status.enabled) {
    return { text: "Off — views move independently", tone: "muted" };
  }
  if (status.error !== undefined) {
    return { text: status.error, tone: "error" };
  }
  if (status.lineCount === 0) {
    return { text: "waiting for alignment lines", tone: "muted" };
  }
  if (status.directionPending) {
    return {
      text: "direction pending — move both views onto a matching feature, or swap manually",
      tone: "warn",
    };
  }
  const rotation =
    status.rotationDeg !== undefined && Math.abs(status.rotationDeg) >= 0.05
      ? ` · ${status.rotationDeg.toFixed(1)}°`
      : "";
  const mirrored = status.mirrored ? " · mirrored" : "";
  return {
    text: `${status.fitMode ?? "?"} · ${status.lineCount} line${
      status.lineCount === 1 ? "" : "s"
    } · ${status.annotationLayerName ?? "?"}${rotation}${mirrored}`,
    tone: "muted",
  };
}

/**
 * Section of the layer-group viewer's context menu (the dropdown holding the
 * Position / Cross-section orientation / ... link selectors) that controls
 * the annotation-linked view sync. Purely presentational: depends only on the
 * `AlignmentLinkUi` seam (use_alignment_link_status.ts), which the parent menu
 * provides. The link is global to the side-by-side pair — the same section
 * appears in every layer group's menu.
 */
export function AlignmentLinkMenuSection({ link }: { link: AlignmentLinkUi }) {
  const { status } = link;
  const line = statusText(status);
  const layerNames = [
    ...new Set([
      ...link.annotationLayerNames,
      ...(status.configuredLayerName !== undefined
        ? [status.configuredLayerName]
        : []),
    ]),
  ];

  return (
    <div class="neuroglancer-alignment-link-menu-section">
      <div class="neuroglancer-alignment-link-row">
        <span class="neuroglancer-alignment-link-title">
          Annotation alignment link
        </span>
        <ToggleSwitch
          checked={status.enabled}
          ariaLabel="Link views via alignment line annotations"
          tooltip="Sync both views through a transform fitted from the alignment line annotations"
          onChange={(checked) => link.setEnabled(checked)}
        />
      </div>
      <label class="neuroglancer-alignment-link-row">
        <span>Lines from</span>
        <select
          value={status.configuredLayerName ?? ""}
          disabled={!status.enabled}
          onChange={(event) => {
            const value = (event.target as HTMLSelectElement).value;
            link.setLayerName(value === "" ? undefined : value);
          }}
        >
          <option value="">Auto (first layer with lines)</option>
          {layerNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label class="neuroglancer-alignment-link-row">
        <span>Transform</span>
        <select
          value={status.model}
          disabled={!status.enabled}
          onChange={(event) =>
            link.setModel(
              (event.target as HTMLSelectElement).value as AlignmentModel,
            )
          }
        >
          {MODELS.map((model) => (
            <option key={model.value} value={model.value}>
              {model.label}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        class="neuroglancer-alignment-link-swap"
        disabled={!status.enabled}
        title="Flip which line endpoint belongs to which view"
        onClick={() => link.swapDirection()}
      >
        ⇄ Swap direction
      </button>
      <div
        class={`neuroglancer-alignment-link-status neuroglancer-alignment-link-status-${line.tone}`}
      >
        {line.text}
      </div>
    </div>
  );
}
