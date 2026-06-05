/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { RefObject } from "preact";
import { useEffect } from "preact/hooks";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/**
 * Standard modal-dialog behavior for a portaled `role="dialog"` element:
 *
 *  - Autofocuses the first focusable control on open (falls back to the
 *    container itself so screen readers land inside the dialog).
 *  - Traps Tab / Shift+Tab within the container.
 *  - Closes on Escape (delegated to `onClose`, which may itself veto, e.g.
 *    while a submit is in flight).
 *  - Restores focus to whatever was focused before the dialog opened.
 *  - Stops keydown propagation so Neuroglancer's global single-key tool
 *    hotkeys (M / C / F / P, …) don't fire while the dialog owns input.
 *
 * The caller owns the container ref and must memoize `onClose` so the focus
 * setup effect doesn't re-run (and re-autofocus) on every render.
 */
export function useModalDialog({
  active,
  containerRef,
  onClose,
}: {
  active: boolean;
  containerRef: RefObject<HTMLElement>;
  onClose: () => void;
}): void {
  // Focus management: autofocus on open, restore on close. Depends only on
  // `active` so a changing `onClose` identity can't retrigger autofocus.
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (container === null) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const initial = focusableWithin(container)[0];
    if (initial !== undefined) {
      initial.focus();
    } else {
      container.tabIndex = -1;
      container.focus();
    }

    return () => {
      if (previouslyFocused !== null && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [active, containerRef]);

  // Key handling: Escape to close, Tab to cycle within the dialog, and
  // swallow everything else so it never reaches Neuroglancer's hotkeys.
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (container === null) return;

    const onKeyDown = (e: KeyboardEvent) => {
      // Isolate the dialog from the viewer's global key bindings.
      e.stopPropagation();

      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }

      if (e.key !== "Tab") return;
      const items = focusableWithin(container);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const activeEl = document.activeElement;
      if (e.shiftKey) {
        if (activeEl === first || !container.contains(activeEl)) {
          e.preventDefault();
          last.focus();
        }
      } else if (activeEl === last || !container.contains(activeEl)) {
        e.preventDefault();
        first.focus();
      }
    };

    container.addEventListener("keydown", onKeyDown);
    return () => container.removeEventListener("keydown", onKeyDown);
  }, [active, containerRef, onClose]);
}
