/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { EditSession } from "@zettaai/edit-session";
import { useCallback } from "preact/hooks";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { useWatchable } from "#src/editing/ui/interop/use_watchable.js";
import type { SaveTracker } from "#src/editing/ui/session_controls/save_tracker.js";

const NO_SAVE_BACKEND_HINT =
  "Saving is unavailable — no save backend is registered.";

export function SessionActions({
  host,
  session,
  saveTracker,
  onError,
}: {
  host: EditSessionHost;
  session: EditSession;
  saveTracker: SaveTracker;
  onError: (msg: string) => void;
}) {
  const hasDirty = session.dirty.isDirty();
  const isSaving = saveTracker.state.kind === "saving";
  const saveAvailable = useWatchable(host.saveBackendAvailable);

  const runCommit = useCallback(async () => {
    if (!session.dirty.isDirty()) return;
    const ok = window.confirm(
      "Commit all session edits? This ends the editing session. " +
        "Painted patches stay visible on the layer until you start a new " +
        "session or reload — they are NOT yet sent to the backend (use " +
        "Save All for that).",
    );
    if (!ok) return;
    try {
      await host.commitActive();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }, [session, host, onError]);

  const runDiscard = useCallback(async () => {
    const ok = window.confirm(
      "Discard all session edits? This cannot be undone.",
    );
    if (!ok) return;
    try {
      await host.discardActive();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }, [host, onError]);

  const startSave = useCallback(() => {
    void saveTracker.startSave(host, session);
  }, [saveTracker, host, session]);

  const cancelSave = useCallback(() => {
    saveTracker.cancel(host);
  }, [saveTracker, host]);

  return (
    <div class="neuroglancer-edit-session-section">
      <div class="neuroglancer-edit-session-section-title">Actions</div>
      <div class="neuroglancer-edit-session-action-row">
        <button
          type="button"
          disabled={!hasDirty || isSaving}
          onClick={() => void runCommit()}
        >
          Commit
        </button>
        {isSaving ? (
          <button
            type="button"
            class="saving"
            onClick={cancelSave}
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            disabled={!hasDirty || !saveAvailable}
            title={saveAvailable ? undefined : NO_SAVE_BACKEND_HINT}
            onClick={startSave}
          >
            Save All
          </button>
        )}
        <button
          type="button"
          class="danger"
          disabled={isSaving}
          onClick={() => void runDiscard()}
        >
          Discard
        </button>
      </div>
    </div>
  );
}
