/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { BboxEntry } from "#src/editing/ui/session_entry/bbox_candidates.js";

export function BboxPicker({
  entries,
  selectedKey,
  onChange,
}: {
  entries: readonly BboxEntry[];
  selectedKey: string | undefined;
  onChange: (key: string | undefined) => void;
}) {
  if (entries.length === 0) {
    return (
      <select class="neuroglancer-bbox-picker-select" disabled>
        <option value="">(no bounding-box annotations found)</option>
      </select>
    );
  }
  return (
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
  );
}
