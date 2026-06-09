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

import { ListboxDropdown } from "#src/editing/ui/session_entry/listbox_dropdown.js";

/**
 * Per-layer resolution picker. A thin adapter over the shared
 * {@link ListboxDropdown}: maps resolutions to options and the single current
 * selection back to a one-element array (exactly one resolution may be
 * selected per layer for now).
 */
export function ResolutionPicker({
  resolutions,
  selected,
  onChange,
  disabled,
}: {
  resolutions: readonly Resolution[];
  selected: readonly Resolution[];
  onChange: (values: readonly Resolution[]) => void;
  disabled?: boolean;
}) {
  if (resolutions.length === 0) {
    return (
      <span class="neuroglancer-resolution-picker-empty">
        (no resolutions available)
      </span>
    );
  }

  const selectedSet = new Set(selected);
  const current = resolutions.find((r) => selectedSet.has(r));
  const options = resolutions.map((r) => ({ key: r, label: r }));

  return (
    <ListboxDropdown
      options={options}
      value={current}
      onChange={(key) => onChange([key as Resolution])}
      disabled={disabled}
      ariaLabel="Resolution"
    />
  );
}
