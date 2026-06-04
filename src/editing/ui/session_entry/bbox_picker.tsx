/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type {
  BboxAnnotationSelection,
  BboxEntry,
} from "#src/editing/ui/session_entry/bbox_candidates.js";

export const BBOX_EMPTY_STATE_TEXT =
  "No bounding-box annotations found. Create a bounding box in the " +
  "Annotations tab to scope an edit session.";

export function BboxPicker({
  entries,
  selectedKey,
  selection,
  onChange,
}: {
  entries: readonly BboxEntry[];
  selectedKey: string | undefined;
  selection: BboxAnnotationSelection | undefined;
  onChange: (key: string | undefined) => void;
}) {
  if (entries.length === 0) {
    return (
      <div class="neuroglancer-edit-session-entry-modal-bbox">
        <div class="neuroglancer-edit-session-entry-modal-bbox-empty">
          {BBOX_EMPTY_STATE_TEXT}
        </div>
      </div>
    );
  }
  return (
    <div class="neuroglancer-edit-session-entry-modal-bbox">
      <select
        class="neuroglancer-bbox-picker-select"
        value={selectedKey ?? ""}
        onChange={(e) => {
          const raw = (e.target as HTMLSelectElement).value;
          onChange(raw === "" ? undefined : raw);
        }}
      >
        {entries.map((entry) => {
          const desc = entry.annotation.description?.trim();
          const parts = [entry.annotationLayerName];
          if (desc) parts.push(desc);
          parts.push(entry.sizeLabel);
          return (
            <option key={entry.key} value={entry.key}>
              {parts.join(" · ")}
            </option>
          );
        })}
      </select>
      {selection !== undefined && (
        <div class="neuroglancer-edit-session-entry-modal-bbox-helper">
          {formatBboxHelperLine(selection)}
        </div>
      )}
    </div>
  );
}

function formatBboxHelperLine(selection: BboxAnnotationSelection): string {
  const w = Math.round(selection.voxelBbox[3] - selection.voxelBbox[0]);
  const h = Math.round(selection.voxelBbox[4] - selection.voxelBbox[1]);
  const d = Math.round(selection.voxelBbox[5] - selection.voxelBbox[2]);
  return `${selection.annotationLayerName} · ${w}×${h}×${d} voxels · from bounding-box annotation`;
}
