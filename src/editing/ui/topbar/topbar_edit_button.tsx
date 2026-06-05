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
import { useCallback, useState } from "preact/hooks";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
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

  const handleExit = useCallback(async () => {
    // Read dirty state at click time, not render time — this component
    // doesn't subscribe to `session.dirty` events, so a render-time
    // snapshot would be stale once the user starts painting.
    const session = host.activeSession.value;
    if (session === undefined) return;
    const dirty =
      session.dirty.isDirty() || host.hasPendingCommittedChanges();
    if (dirty) {
      const ok = window.confirm(
        "Exit edit session? Unsaved changes will be discarded.",
      );
      if (!ok) return;
    }
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
    if (isActive) {
      void handleExit();
      return;
    }
    setOpen(true);
  }, [isActive, handleExit]);

  return (
    <>
      <button
        type="button"
        class={
          "neuroglancer-editing-topbar-edit-button" +
          (isActive ? " active" : "")
        }
        title={
          isActive
            ? "Exit edit session"
            : "Open the edit-session entry modal"
        }
        onClick={handleClick}
      >
        <Pencil size={16} aria-hidden="true" />
        {isActive ? "Exit session" : "Edit"}
      </button>
      <SessionEntryModal
        open={open}
        onClose={() => setOpen(false)}
        host={host}
      />
    </>
  );
}
