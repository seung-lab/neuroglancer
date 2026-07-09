/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { Check, ChevronDown } from "lucide-preact";
import { createPortal } from "preact/compat";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";

interface PanelRect {
  left: number;
  width: number;
  /** Cap on the panel's own height; it scrolls internally past this. */
  maxHeight: number;
  /** Set when the panel opens downward (anchored below the trigger). */
  top?: number;
  /** Set when the panel flips upward (anchored above the trigger). */
  bottom?: number;
}

export interface ListboxOption {
  readonly key: string;
  readonly label: string;
}

/**
 * Single-select dropdown rendered as a real ARIA listbox: a trigger button
 * showing the current label + chevron, and a portaled popup of options.
 *
 * Keyboard model (the whole point of not using a native control here): Arrow
 * Up/Down, Home and End move a roving highlight *without* committing — the
 * panel stays open so the user can browse — and only Enter / Space / click
 * commit. Escape closes. Focus moves into the panel on open (onto the current
 * selection) and is handed back to the trigger before the panel unmounts on
 * close, so it never escapes the surrounding modal.
 *
 * Shared by the Region (bbox) and per-layer Resolution pickers.
 */
export function ListboxDropdown({
  options,
  value,
  onChange,
  disabled,
  ariaLabel,
}: {
  options: readonly ListboxOption[];
  value: string | undefined;
  onChange: (key: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<PanelRect | undefined>(undefined);
  // The keyboard-highlighted ("active") option — the listbox cursor. It moves
  // with the arrow keys independently of the committed selection.
  const [activeIndex, setActiveIndex] = useState(0);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<(HTMLDivElement | null)[]>([]);

  // The panel is portaled out of its container so it escapes any `overflow`
  // clipping; `position: fixed` then anchors it to the trigger. Recompute on
  // open and whenever the trigger moves (the modal body scrolls, window resize).
  //
  // A long option list (many bbox annotations) is capped to the space actually
  // available in the viewport and scrolls internally; when the trigger sits low
  // and the list won't fit below, the panel flips to open above it — so it can
  // never run off-screen regardless of where the trigger lands in a tall modal.
  const updateRect = useCallback(() => {
    const node = wrapperRef.current;
    if (node === null) return;
    const triggerRect = node.getBoundingClientRect();
    const triggerGap = 2;
    const viewportMargin = 8;
    const preferredMaxHeight = 320;
    const minHeight = 120;
    const spaceBelow =
      window.innerHeight - triggerRect.bottom - triggerGap - viewportMargin;
    const spaceAbove = triggerRect.top - triggerGap - viewportMargin;
    // Prefer opening downward; flip up only when the list won't fit below and
    // there is more room above.
    const openUpward =
      spaceBelow < preferredMaxHeight && spaceAbove > spaceBelow;
    const availableHeight = openUpward ? spaceAbove : spaceBelow;
    const maxHeight = Math.min(
      preferredMaxHeight,
      Math.max(minHeight, availableHeight),
    );
    setRect({
      left: triggerRect.left,
      width: triggerRect.width,
      maxHeight,
      top: openUpward ? undefined : triggerRect.bottom + triggerGap,
      bottom: openUpward
        ? window.innerHeight - triggerRect.top + triggerGap
        : undefined,
    });
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
        triggerRef.current?.focus();
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

  // Move real DOM focus to the active option whenever it changes while open
  // (and once the panel has been measured + mounted). Real focus — rather than
  // aria-activedescendant — keeps the roving-tabindex listbox simple.
  useEffect(() => {
    if (!open || rect === undefined) return;
    optionRefs.current[activeIndex]?.focus();
  }, [open, rect, activeIndex]);

  if (options.length === 0) return null;

  const currentIndex = options.findIndex((o) => o.key === value);
  const current = currentIndex >= 0 ? options[currentIndex] : options[0];
  const summary = current?.label ?? "";

  const commit = (key: string) => {
    onChange(key);
    setOpen(false);
    // Hand focus back to the trigger *before* the panel unmounts, so the
    // removed option can't drop focus to the global document — keeping
    // keyboard focus inside the surrounding modal.
    triggerRef.current?.focus();
  };

  const toggle = () => {
    if (!open) {
      // Open the cursor on the current selection (else the first option).
      setActiveIndex(currentIndex >= 0 ? currentIndex : 0);
    }
    setOpen((v) => !v);
  };

  const onPanelKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, options.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        break;
      case "Home":
        e.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        e.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        commit(options[activeIndex].key);
        break;
    }
  };

  return (
    <span ref={wrapperRef} class="neuroglancer-edit-session-listbox">
      <button
        ref={triggerRef}
        type="button"
        class="neuroglancer-edit-session-listbox-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={toggle}
      >
        <span class="neuroglancer-edit-session-listbox-summary">{summary}</span>
        <ChevronDown
          class="neuroglancer-edit-session-listbox-caret"
          size={16}
          aria-hidden="true"
        />
      </button>
      {open &&
        rect !== undefined &&
        createPortal(
          <div
            ref={panelRef}
            class="neuroglancer-edit-session-listbox-panel"
            role="listbox"
            tabIndex={-1}
            onKeyDown={onPanelKeyDown}
            style={{
              left: `${rect.left}px`,
              minWidth: `${rect.width}px`,
              maxHeight: `${rect.maxHeight}px`,
              ...(rect.top !== undefined && { top: `${rect.top}px` }),
              ...(rect.bottom !== undefined && { bottom: `${rect.bottom}px` }),
            }}
            // The panel is portaled into the modal backdrop, whose onClick
            // closes the modal. Stop clicks here so picking an option doesn't
            // bubble out and dismiss the whole dialog.
            onClick={(e) => e.stopPropagation()}
          >
            {options.map((o, i) => {
              const isSelected = o.key === value;
              return (
                <div
                  key={o.key}
                  ref={(el) => {
                    optionRefs.current[i] = el;
                  }}
                  class="neuroglancer-edit-session-listbox-option"
                  role="option"
                  aria-selected={isSelected}
                  // Roving tabindex: only the active option is in the tab order;
                  // arrow keys move focus between options without leaving the
                  // listbox.
                  tabIndex={i === activeIndex ? 0 : -1}
                  onClick={() => commit(o.key)}
                  onMouseEnter={() => setActiveIndex(i)}
                >
                  <span class="neuroglancer-edit-session-listbox-check">
                    {isSelected && <Check size={14} aria-hidden="true" />}
                  </span>
                  <span>{o.label}</span>
                </div>
              );
            })}
          </div>,
          // Portal into the modal backdrop (a transform-free `position: fixed`
          // ancestor with no overflow clip) so the panel keeps the modal's
          // CSS-variable tokens and font context. Falls back to <body> for any
          // non-modal usage.
          wrapperRef.current?.closest<HTMLElement>(
            ".neuroglancer-edit-session-entry-modal-backdrop",
          ) ?? document.body,
        )}
    </span>
  );
}
