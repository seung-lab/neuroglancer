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
import { createPortal } from "preact/compat";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";

interface PanelRect {
  top: number;
  left: number;
  width: number;
}

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
  const [rect, setRect] = useState<PanelRect | undefined>(undefined);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // The panel is portaled to <body> so it escapes the layers card's
  // `overflow: hidden` clipping context; `position: fixed` then anchors it to
  // the trigger. Recompute on open and whenever the trigger moves (the modal
  // body scrolls, the window resizes).
  const updateRect = useCallback(() => {
    const node = wrapperRef.current;
    if (node === null) return;
    const r = node.getBoundingClientRect();
    setRect({ top: r.bottom + 2, left: r.left, width: r.width });
  }, []);

  useEffect(() => {
    if (!open) return;
    updateRect();

    const onDocPointer = (e: MouseEvent) => {
      const target = e.target as Node;
      const inTrigger = wrapperRef.current?.contains(target) ?? false;
      const inPanel = panelRef.current?.contains(target) ?? false;
      if (!inTrigger && !inPanel) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    // Capture phase catches scrolls on the modal body (scroll doesn't bubble).
    window.addEventListener("scroll", updateRect, true);
    window.addEventListener("resize", updateRect);
    document.addEventListener("mousedown", onDocPointer);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("scroll", updateRect, true);
      window.removeEventListener("resize", updateRect);
      document.removeEventListener("mousedown", onDocPointer);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, updateRect]);

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
    <span ref={wrapperRef} class="neuroglancer-resolution-picker-dropdown">
      <button
        type="button"
        class="neuroglancer-resolution-picker-dropdown-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span class="neuroglancer-resolution-picker-dropdown-summary">
          {summary}
        </span>
        <span class="neuroglancer-resolution-picker-dropdown-caret">▾</span>
      </button>
      {open &&
        rect !== undefined &&
        createPortal(
          <div
            ref={panelRef}
            class="neuroglancer-resolution-picker-dropdown-panel"
            role="listbox"
            aria-multiselectable="true"
            style={{
              top: `${rect.top}px`,
              left: `${rect.left}px`,
              minWidth: `${rect.width}px`,
            }}
          >
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
          </div>,
          // Portal into the modal backdrop (a transform-free `position: fixed`
          // ancestor with no overflow clip) rather than <body>, so the panel
          // keeps the modal's CSS-variable tokens and font context. Falls back
          // to <body> for any non-modal usage.
          wrapperRef.current?.closest<HTMLElement>(
            ".neuroglancer-edit-session-entry-modal-backdrop",
          ) ?? document.body,
        )}
    </span>
  );
}
