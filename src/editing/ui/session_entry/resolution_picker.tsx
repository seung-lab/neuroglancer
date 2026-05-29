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
  isSelected,
  onToggle,
  disabled,
}: {
  resolutions: readonly Resolution[];
  isSelected: (value: Resolution) => boolean;
  onToggle: (value: Resolution, checked: boolean) => void;
  disabled?: boolean;
}) {
  if (resolutions.length === 0) {
    return (
      <span class="neuroglancer-resolution-picker-empty">
        (no resolutions available)
      </span>
    );
  }
  return (
    <span class="neuroglancer-resolution-picker">
      {resolutions.map((r) => (
        <label key={r} class="neuroglancer-resolution-picker-option">
          <input
            type="checkbox"
            checked={isSelected(r)}
            disabled={disabled}
            onChange={(e) => onToggle(r, (e.target as HTMLInputElement).checked)}
          />
          <span>{r}</span>
        </label>
      ))}
    </span>
  );
}
