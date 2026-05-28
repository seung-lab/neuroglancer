/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { Resolution } from "@zetta-ai/edit-session";

import { useSignal } from "#src/editing/ui/interop/use_signal.js";
import { ResolutionPicker } from "#src/editing/ui/session_entry/resolution_picker.js";
import type { ResolutionSelectionModel } from "#src/editing/ui/session_entry/resolution_options.js";

export interface LayerRowState {
  included: boolean;
  locked: boolean;
  resolution: Resolution | undefined;
  loadState: "loading" | "loaded" | "error";
  loadError: string | undefined;
  resolutions: readonly Resolution[];
}

export function LayerRow({
  name,
  state,
  resolutionModel,
  onIncludedChange,
  onLockedChange,
}: {
  name: string;
  state: LayerRowState;
  resolutionModel: ResolutionSelectionModel | undefined;
  onIncludedChange: (v: boolean) => void;
  onLockedChange: (v: boolean) => void;
}) {
  useSignal(resolutionModel?.selectionChanged);

  const rowClass = state.included
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
  } else if (state.resolutions.length === 1) {
    resolutionContent = (
      <span class="neuroglancer-edit-session-entry-modal-layer-resolution-static">
        {state.resolutions[0]}
      </span>
    );
  } else if (resolutionModel !== undefined) {
    resolutionContent = (
      <ResolutionPicker
        resolutions={resolutionModel.resolutions}
        selected={resolutionModel.selection}
        onChange={(v) => resolutionModel.select(v)}
      />
    );
  } else {
    resolutionContent = null;
  }

  return (
    <div class={rowClass}>
      <label class="neuroglancer-edit-session-entry-modal-layer-include">
        <input
          type="checkbox"
          checked={state.included}
          onChange={(e) =>
            onIncludedChange((e.target as HTMLInputElement).checked)
          }
        />
        <span class="neuroglancer-edit-session-entry-modal-layer-name">
          {name}
        </span>
      </label>
      <span class="neuroglancer-edit-session-entry-modal-layer-resolution">
        <span class="neuroglancer-edit-session-entry-modal-layer-resolution-label">
          Resolution:
        </span>
        <span class="neuroglancer-edit-session-entry-modal-layer-resolution-slot">
          {resolutionContent}
        </span>
      </span>
      <label class="neuroglancer-edit-session-entry-modal-layer-lock">
        <input
          type="checkbox"
          checked={state.locked}
          disabled={!state.included}
          onChange={(e) =>
            onLockedChange((e.target as HTMLInputElement).checked)
          }
        />
        <span>Read-only</span>
      </label>
    </div>
  );
}
