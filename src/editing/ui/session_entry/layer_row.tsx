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
import type { ResolutionSelectionModel } from "#src/editing/ui/session_entry/resolution_options.js";
import { ResolutionPicker } from "#src/editing/ui/session_entry/resolution_picker.js";

export type LayerKind = "image" | "segmentation";

export interface LayerRowState {
  /**
   * When true the layer participates in the session and its bbox-intersecting
   * chunks are held in PERMANENT residency (protected from GPU and system
   * memory eviction). When false the layer is not part of the session — base
   * Neuroglancer LRU governs it.
   */
  locked: boolean;
  /**
   * When true the layer is a paint target (overlay attached). Only meaningful
   * when `locked` is true. Defaults follow layer kind: segmentation → true,
   * image → false.
   */
  writable: boolean;
  resolutions: readonly Resolution[];
  loadState: "loading" | "loaded" | "error";
  loadError: string | undefined;
  availableResolutions: readonly Resolution[];
}

export function LayerRow({
  name,
  layerKind,
  state,
  resolutionModel,
  onLockedChange,
  onWritableChange,
}: {
  name: string;
  layerKind: LayerKind;
  state: LayerRowState;
  resolutionModel: ResolutionSelectionModel | undefined;
  onLockedChange: (v: boolean) => void;
  onWritableChange: (v: boolean) => void;
}) {
  useSignal(resolutionModel?.selectionChanged);

  const rowClass = state.locked
    ? "neuroglancer-edit-session-entry-modal-layer-row"
    : "neuroglancer-edit-session-entry-modal-layer-row neuroglancer-edit-session-entry-modal-layer-row-excluded";

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
  } else if (state.availableResolutions.length === 1) {
    resolutionContent = (
      <span class="neuroglancer-edit-session-entry-modal-layer-resolution-static">
        {state.availableResolutions[0]}
      </span>
    );
  } else if (resolutionModel !== undefined) {
    resolutionContent = (
      <ResolutionPicker
        resolutions={resolutionModel.resolutions}
        selected={resolutionModel.selectedResolutions}
        onChange={(values) => resolutionModel.setSelection(values)}
        disabled={!state.locked}
      />
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
      <label class="neuroglancer-edit-session-entry-modal-layer-include">
        <input
          type="checkbox"
          checked={state.locked}
          onChange={(e) =>
            onLockedChange((e.target as HTMLInputElement).checked)
          }
        />
        <span class="neuroglancer-edit-session-entry-modal-layer-name">
          {name}
        </span>
        <span class={badgeClass}>{layerKind}</span>
      </label>
      <span class="neuroglancer-edit-session-entry-modal-layer-resolution">
        <span class="neuroglancer-edit-session-entry-modal-layer-resolution-label">
          Resolutions:
        </span>
        <span class="neuroglancer-edit-session-entry-modal-layer-resolution-slot">
          {resolutionContent}
        </span>
      </span>
      <label class="neuroglancer-edit-session-entry-modal-layer-lock">
        <input
          type="checkbox"
          checked={state.writable}
          disabled={!state.locked}
          onChange={(e) =>
            onWritableChange((e.target as HTMLInputElement).checked)
          }
        />
        <span>Writable</span>
      </label>
    </div>
  );
}
