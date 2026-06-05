/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { createPortal } from "preact/compat";
import { useRef } from "preact/hooks";

import { useModalDialog } from "#src/editing/ui/interop/use_modal_dialog.js";

import "#src/editing/ui/confirm_dialog.css";

const TITLE_ID = "neuroglancer-confirm-dialog-title";
const MESSAGE_ID = "neuroglancer-confirm-dialog-message";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  /** Primary action label. Use verb + object, e.g. "Discard and exit". */
  confirmLabel: string;
  cancelLabel?: string;
  /** Tints the confirm button as a destructive action. */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Styled replacement for `window.confirm`, matching the edit-session modal's
 * visual vocabulary. Renders nothing when closed; mounts its own portal so it
 * sits above the viewer regardless of where it's used.
 *
 * The cancel (safe) action is first in the DOM, so the focus trap autofocuses
 * it — Escape and the default focused control both resolve to "don't do the
 * destructive thing".
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  if (!props.open) return null;
  return createPortal(<ConfirmDialogBody {...props} />, document.body);
}

function ConfirmDialogBody({
  title,
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalDialog({ active: true, containerRef: dialogRef, onClose: onCancel });

  const confirmClass = [
    "neuroglancer-confirm-dialog-btn",
    "neuroglancer-confirm-dialog-btn-primary",
    destructive ? "neuroglancer-confirm-dialog-btn-destructive" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div class="neuroglancer-confirm-dialog-backdrop" onClick={onCancel}>
      <div
        ref={dialogRef}
        class="neuroglancer-confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        aria-describedby={MESSAGE_ID}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div id={TITLE_ID} class="neuroglancer-confirm-dialog-title">
          {title}
        </div>
        <div id={MESSAGE_ID} class="neuroglancer-confirm-dialog-message">
          {message}
        </div>
        <div class="neuroglancer-confirm-dialog-actions">
          <button
            type="button"
            class="neuroglancer-confirm-dialog-btn"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button type="button" class={confirmClass} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
