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

export function ResolutionPicker({
  resolutions,
  selected,
  onChange,
}: {
  resolutions: readonly Resolution[];
  selected: Resolution | undefined;
  onChange: (value: Resolution | undefined) => void;
}) {
  if (resolutions.length === 0) {
    return (
      <select class="neuroglancer-resolution-picker-select" disabled>
        <option value="">(no resolutions available)</option>
      </select>
    );
  }
  return (
    <select
      class="neuroglancer-resolution-picker-select"
      value={selected ?? ""}
      onChange={(e) => {
        const raw = (e.target as HTMLSelectElement).value;
        onChange(resolutions.find((r) => r === raw));
      }}
    >
      {resolutions.map((r) => (
        <option key={r} value={r}>
          {r}
        </option>
      ))}
    </select>
  );
}
