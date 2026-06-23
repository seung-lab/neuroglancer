/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { Copy } from "lucide-preact";

import type {
  BboxAnnotationSelection,
  BboxEntry,
} from "#src/editing/ui/session_entry/bbox_candidates.js";
import { ListboxDropdown } from "#src/editing/ui/session_entry/listbox_dropdown.js";
import { setClipboard } from "#src/util/clipboard.js";

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
  const options = entries.map((entry) => {
    const desc = entry.annotation.description?.trim();
    // Lead with the lower-corner coordinate: a bounding box is identified by
    // *where* it is (matching how the Annotations panel lists them), not by its
    // size. Two equal-size boxes are otherwise indistinguishable here. Size
    // stays as trailing metadata.
    const parts = [entry.annotationLayerName];
    if (desc) parts.push(desc);
    parts.push(`(${formatCoords(entry.voxelBbox.slice(0, 3))})`);
    parts.push(entry.sizeLabel);
    return { key: entry.key, label: parts.join(" · ") };
  });

  return (
    <div class="neuroglancer-edit-session-entry-modal-bbox">
      <ListboxDropdown
        options={options}
        value={selectedKey}
        onChange={(key) => onChange(key)}
        ariaLabel="Region"
      />
      {selection !== undefined && <BboxDetails selection={selection} />}
    </div>
  );
}

/**
 * Read-out of the selected region's lower/upper corner coordinates plus voxel
 * extent, mirroring the post-session `NavigationSummary` so the modal and the
 * summary describe a region identically. Coordinates carry a copy button; there
 * is no go-to here because no session (and thus no active region) exists yet.
 */
function BboxDetails({ selection }: { selection: BboxAnnotationSelection }) {
  const { voxelBbox } = selection;
  const w = Math.round(voxelBbox[3] - voxelBbox[0]);
  const h = Math.round(voxelBbox[4] - voxelBbox[1]);
  const d = Math.round(voxelBbox[5] - voxelBbox[2]);
  return (
    <div class="neuroglancer-edit-session-entry-modal-bbox-helper">
      <div class="neuroglancer-edit-session-entry-modal-bbox-coords">
        <CoordRow label="Lower" coords={voxelBbox.slice(0, 3)} />
        <CoordRow label="Upper" coords={voxelBbox.slice(3, 6)} />
      </div>
      <div class="neuroglancer-edit-session-entry-modal-bbox-extent">
        {w}×{h}×{d} voxels · {selection.annotationLayerName}
      </div>
    </div>
  );
}

function CoordRow({
  label,
  coords,
}: {
  label: string;
  coords: readonly number[];
}) {
  const text = formatCoords(coords);
  return (
    <div class="neuroglancer-edit-session-entry-modal-bbox-coord-row">
      <span class="neuroglancer-edit-session-entry-modal-bbox-coord-label">
        {label}
      </span>
      <span class="neuroglancer-edit-session-entry-modal-bbox-coord-value">
        {text}
      </span>
      <button
        type="button"
        class="neuroglancer-edit-session-entry-modal-bbox-coord-btn"
        title="Copy coordinate"
        aria-label={`Copy ${label} coordinate`}
        onClick={() => setClipboard(text)}
      >
        <Copy size={13} aria-hidden="true" />
      </button>
    </div>
  );
}

function formatCoords(coords: readonly number[]): string {
  return coords.map((c) => Math.floor(c)).join(", ");
}
