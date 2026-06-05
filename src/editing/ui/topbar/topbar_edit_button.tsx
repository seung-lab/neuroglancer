/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { Pencil } from "lucide-preact";
import { useCallback, useEffect, useState } from "preact/hooks";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { ConfirmDialog } from "#src/editing/ui/confirm_dialog.js";
import { useWatchable } from "#src/editing/ui/interop/use_watchable.js";
import { SessionEntryModal } from "#src/editing/ui/session_entry/session_entry.js";
import { StatusMessage } from "#src/status.js";

import "#src/editing/ui/topbar/editing_topbar.css";

/**
 * Right-most control in the editing topbar: opens the entry modal when no
 * session is active; doubles as the "Exit session" button when one is.
 *
 * Modal lifecycle follows Contract 1 of TM-294/TM-295: this component owns
 * `open` state and renders `<SessionEntryModal open onClose host>` from
 * TM-295. The modal handles its own portal and dismiss.
 */
export function TopbarEditButton({ host }: { host: EditSessionHost }) {
  const sessionOrUndefined = useWatchable(host.activeSession);
  const isActive = sessionOrUndefined !== undefined;

  const [open, setOpen] = useState(false);
  const [preselectBboxKey, setPreselectBboxKey] = useState<string | undefined>(
    undefined,
  );
  const [confirmExitOpen, setConfirmExitOpen] = useState(false);

  // The quick edit-region flow (TM-290) draws a box, then asks the topbar to
  // open the modal pre-selected on that box.
  useEffect(
    () =>
      host.requestSessionEntry.add((key?: string) => {
        setPreselectBboxKey(key);
        setOpen(true);
      }),
    [host],
  );

  const discardActive = useCallback(async () => {
    try {
      await host.discardActive();
    } catch (err) {
      StatusMessage.showTemporaryMessage(
        `Failed to exit session: ${err instanceof Error ? err.message : String(err)}`,
        5000,
      );
    }
  }, [host]);

  const handleClick = useCallback(() => {
    if (!isActive) {
      setOpen(true);
      return;
    }
    // Read dirty state at click time, not render time — this component
    // doesn't subscribe to `session.dirty` events, so a render-time
    // snapshot would be stale once the user starts painting.
    const session = host.activeSession.value;
    if (session === undefined) return;
    const dirty = session.dirty.isDirty() || host.hasPendingCommittedChanges();
    if (dirty) {
      setConfirmExitOpen(true);
      return;
    }
    void discardActive();
  }, [isActive, host, discardActive]);

  return (
    <>
      <button
        type="button"
        class={
          "neuroglancer-editing-topbar-edit-button" +
          (isActive ? " active" : "")
        }
        data-tooltip={
          isActive ? "Exit edit session" : "Open the edit-session entry modal"
        }
        onClick={handleClick}
      >
        <Pencil size={16} aria-hidden="true" />
        {isActive ? "Exit session" : "Edit"}
      </button>
      <SessionEntryModal
        open={open}
        onClose={() => {
          setOpen(false);
          setPreselectBboxKey(undefined);
        }}
        host={host}
        preselectBboxKey={preselectBboxKey}
      />
      <ConfirmDialog
        open={confirmExitOpen}
        title="Exit edit session?"
        message="You have unsaved changes. Exiting now will discard them."
        confirmLabel="Discard and exit"
        cancelLabel="Keep editing"
        destructive
        onConfirm={() => {
          setConfirmExitOpen(false);
          void discardActive();
        }}
        onCancel={() => setConfirmExitOpen(false)}
      />
    </>
  );
}
