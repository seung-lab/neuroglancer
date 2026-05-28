/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { EditSession, HistorySnapshot } from "@zetta-ai/edit-session";
import { useCallback } from "preact/hooks";

export function HistoryControls({
  session,
  snapshot,
  onError,
}: {
  session: EditSession;
  snapshot: HistorySnapshot;
  onError: (msg: string) => void;
}) {
  const totalEntries = countEntries(snapshot);

  const runUndo = useCallback(async () => {
    try {
      await session.undo();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }, [session, onError]);

  const runRedo = useCallback(async () => {
    try {
      await session.redo();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }, [session, onError]);

  return (
    <div class="neuroglancer-edit-session-section">
      <div class="neuroglancer-edit-session-section-title">History</div>
      <div class="neuroglancer-edit-session-history-row">
        <button
          type="button"
          disabled={!snapshot.canUndo}
          title={snapshot.undoDescription}
          onClick={() => void runUndo()}
        >
          Undo
        </button>
        <span class="neuroglancer-edit-session-history-hint">(Ctrl+Z)</span>
        <button
          type="button"
          disabled={!snapshot.canRedo}
          title={snapshot.redoDescription}
          onClick={() => void runRedo()}
        >
          Redo
        </button>
        <span class="neuroglancer-edit-session-history-hint">(Ctrl+Shift+Z)</span>
        <span class="neuroglancer-edit-session-history-count">
          {`${totalEntries} ${totalEntries === 1 ? "entry" : "entries"}`}
        </span>
      </div>
    </div>
  );
}

function countEntries(snapshot: HistorySnapshot): number {
  if (snapshot.canUndo && snapshot.canRedo) return 2;
  if (snapshot.canUndo || snapshot.canRedo) return 1;
  return 0;
}
