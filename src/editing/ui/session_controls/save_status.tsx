/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { useSignal } from "#src/editing/ui/interop/use_signal.js";
import type { SaveTracker, SaveAllState } from "#src/editing/ui/session_controls/save_tracker.js";

export function SaveStatus({ saveTracker }: { saveTracker: SaveTracker }) {
  useSignal(saveTracker.changed);
  const state = saveTracker.state;

  return (
    <>
      <SaveStatusText state={state} />
      <div class="neuroglancer-edit-session-section">
        <div class="neuroglancer-edit-session-section-title">Save status</div>
        <div class="neuroglancer-edit-session-layer-status-list">
          {Array.from(saveTracker.layerStatuses.values()).map((entry) => (
            <div
              key={entry.layerId as string}
              class={
                "neuroglancer-edit-session-layer-status " +
                entry.status +
                (!entry.writable ? " locked" : "")
              }
            >
              <span class="neuroglancer-edit-session-layer-status-dot" />
              <div>
                <div class="neuroglancer-edit-session-layer-status-name">
                  {entry.layerId as string}
                </div>
                <div class="neuroglancer-edit-session-layer-status-detail">
                  {entry.detail}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function SaveStatusText({ state }: { state: SaveAllState }) {
  let text = "";
  let extraClass = "";
  if (state.kind === "saving") {
    text = "Saving…";
  } else if (state.kind === "done-success") {
    text = `Saved at ${formatTime(state.savedAt)}`;
    extraClass = " success";
  } else if (state.kind === "done-partial") {
    text =
      state.failedLayers.length > 0
        ? `Failed: ${state.failedLayers.join(", ")}`
        : "Save failed.";
    extraClass = " warning";
  } else if (state.kind === "idle" && state.lastSavedAt !== undefined) {
    text = `Last saved at ${formatTime(state.lastSavedAt)}`;
  }

  if (text === "") return null;

  return (
    <div class={"neuroglancer-edit-session-save-status" + extraClass}>
      {text}
    </div>
  );
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
