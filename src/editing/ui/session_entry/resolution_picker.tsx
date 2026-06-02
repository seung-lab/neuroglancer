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
import { useEffect, useRef, useState } from "preact/hooks";

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
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: MouseEvent) => {
      const node = wrapperRef.current;
      if (node === null || !node.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocPointer);
    return () => document.removeEventListener("mousedown", onDocPointer);
  }, [open]);

  if (resolutions.length === 0) {
    return (
      <span class="neuroglancer-resolution-picker-empty">
        (no resolutions available)
      </span>
    );
  }

  const selectedSet = new Set(selected);
  const selectedInOrder = resolutions.filter((r) => selectedSet.has(r));
  const summary =
    selectedInOrder.length === 1
      ? selectedInOrder[0]
      : `resolutions (${selectedInOrder.length})`;

  const toggle = (r: Resolution, checked: boolean) => {
    const next: Resolution[] = [];
    for (const cand of resolutions) {
      const wasSelected = selectedSet.has(cand);
      const nowSelected = cand === r ? checked : wasSelected;
      if (nowSelected) next.push(cand);
    }
    onChange(next);
  };

  return (
    <span
      ref={wrapperRef}
      class="neuroglancer-resolution-picker-dropdown"
    >
      <button
        type="button"
        class="neuroglancer-resolution-picker-dropdown-trigger"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span class="neuroglancer-resolution-picker-dropdown-summary">
          {summary}
        </span>
        <span class="neuroglancer-resolution-picker-dropdown-caret">▾</span>
      </button>
      {open && (
        <div class="neuroglancer-resolution-picker-dropdown-panel">
          {resolutions.map((r) => (
            <label
              key={r}
              class="neuroglancer-resolution-picker-dropdown-option"
            >
              <input
                type="checkbox"
                checked={selectedSet.has(r)}
                onChange={(e) =>
                  toggle(r, (e.target as HTMLInputElement).checked)
                }
              />
              <span>{r}</span>
            </label>
          ))}
        </div>
      )}
    </span>
  );
}
