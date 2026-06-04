/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import "#src/editing/ui/topbar/editing_topbar.css";

import type { EditSession } from "@zettaai/edit-session";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "preact/hooks";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { useSignal } from "#src/editing/ui/interop/use_signal.js";
import { useWatchable } from "#src/editing/ui/interop/use_watchable.js";
import { SaveTracker } from "#src/editing/ui/session_controls/save_tracker.js";
import { TopbarEditButton } from "#src/editing/ui/topbar/topbar_edit_button.js";
import { StatusMessage } from "#src/status.js";

// Synthetic tool id used for the "Cursor" row. Selecting it clears the active
// tool (no real library tool corresponds to it). Mirrors the legacy
// `tool_list.tsx` convention; kept here so deletion of the old session-controls
// root doesn't strand the constant.
export const CURSOR_TOOL_ID = "cursor";

interface ToolEntry {
  readonly toolId: string;
  readonly label: string;
  /** Hotkey suffix shown after `Ctrl+` in tooltips. */
  readonly hotkey: string;
  /**
   * Single-letter / ascii-art glyph used as the icon. The mockup uses real
   * SVGs; until those land, a short text glyph keeps the topbar functional
   * and accessible (the label and shortcut are also exposed via `title`).
   */
  readonly glyph: string;
  readonly markDisabled?: boolean;
}

const TOOL_ENTRIES: readonly ToolEntry[] = [
  { toolId: CURSOR_TOOL_ID, label: "Cursor", hotkey: "V", glyph: "↖" },
  { toolId: "painting.brush", label: "Brush", hotkey: "B", glyph: "B" },
  { toolId: "painting.erase", label: "Eraser", hotkey: "E", glyph: "E" },
  { toolId: "painting.fill", label: "Fill", hotkey: "F", glyph: "F" },
  // Z-extrap uses Ctrl+P (propagate) since Ctrl+Z is reserved for Undo. The
  // hotkey binder mirrors this choice — see session_hotkey_binder.ts. Future
  // engineers may pick another free letter if `P` becomes inconvenient.
  {
    toolId: "z-extrapolation",
    label: "Z-extrapolation",
    hotkey: "P",
    glyph: "Z",
    markDisabled: true,
  },
  {
    toolId: "correspondence",
    label: "Correspondence",
    hotkey: "R",
    glyph: "C",
    markDisabled: true,
  },
];

export function EditingTopbar({ host }: { host: EditSessionHost }) {
  const session = useWatchable(host.activeSession);
  // The Edit / Exit button is the only flex child of the topbar — that
  // keeps its X coordinate identical between idle and active states (the
  // topbar's natural width never changes). Active-session controls are
  // rendered into an absolutely-positioned trailing wrapper anchored to
  // the right edge of the Edit button; viewer.ts centers the topbar
  // between two flex:1 spacers so the cluster sits at the visual center
  // of the neuroglancer top row.
  return (
    <div class="neuroglancer-editing-topbar">
      <TopbarEditButton host={host} />
      {session !== undefined && (
        <div class="neuroglancer-editing-topbar-trailing">
          <ActiveTopbarControls host={host} session={session} />
        </div>
      )}
    </div>
  );
}

function ActiveTopbarControls({
  host,
  session,
}: {
  host: EditSessionHost;
  session: EditSession;
}) {
  // Lazily construct + dispose a SaveTracker. The old session-controls panel
  // owned this; now the topbar does. A single tracker per active session
  // keeps the unsaved-count badge and Save-all controls coherent.
  const saveTrackerRef = useRef<SaveTracker | undefined>(undefined);
  if (saveTrackerRef.current === undefined) {
    saveTrackerRef.current = new SaveTracker(host, session);
  }
  const saveTracker = saveTrackerRef.current;
  useEffect(() => () => saveTracker.dispose(), [saveTracker]);

  // Force a re-render on tool / history / dirty changes — the underlying
  // session is a mutable bag and Preact has no way to know to re-render.
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const unsubs = [
      session.on("active-tool-changed", () => bump(0)),
      session.on("history-changed", () => bump(0)),
      session.dirty.on("dirty-changed", () => bump(0)),
    ];
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [session]);
  useSignal(saveTracker.changed);

  const knownToolIds = useMemo(
    () => new Set(session.tools.toolIds),
    // `toolIds` is set at construction; safe to memo on session identity.
    [session],
  );
  const activeToolId = session.tools.getActiveToolId();
  const snapshot = session.getHistory();
  const hasDirty = session.dirty.isDirty();
  const saveAvailable = useWatchable(host.saveBackendAvailable);
  const isSaving = saveTracker.state.kind === "saving";

  // Number of layers with unsaved chunks. We approximate using the
  // SaveTracker statuses: writable layers in non-succeeded state count as
  // pending. Falls back to a coarse "1" when dirty but no per-layer info.
  const pendingCount = useMemo(() => {
    if (!hasDirty) return 0;
    let count = 0;
    for (const entry of saveTracker.layerStatuses.values()) {
      if (!entry.writable) continue;
      if (entry.status === "succeeded") continue;
      count += 1;
    }
    return count > 0 ? count : 1;
  }, [hasDirty, saveTracker.layerStatuses]);

  const handleToolClick = useCallback(
    (toolId: string) => {
      try {
        if (toolId === CURSOR_TOOL_ID) {
          host.selectTool(undefined);
          return;
        }
        if (toolId === activeToolId) {
          // Re-clicking the active tool's icon toggles only that tool's
          // panel — the active tool stays selected so the icon remains
          // highlighted. Matches the X-close behavior on the panel itself.
          host.toggleToolPanel(toolId);
          return;
        }
        host.selectTool(toolId);
      } catch (err) {
        StatusMessage.showTemporaryMessage(
          err instanceof Error ? err.message : String(err),
          4000,
        );
      }
    },
    [host, activeToolId],
  );

  const runUndo = useCallback(async () => {
    try {
      await session.undo();
    } catch (err) {
      StatusMessage.showTemporaryMessage(
        err instanceof Error ? err.message : String(err),
        3000,
      );
    }
  }, [session]);

  const runRedo = useCallback(async () => {
    try {
      await session.redo();
    } catch (err) {
      StatusMessage.showTemporaryMessage(
        err instanceof Error ? err.message : String(err),
        3000,
      );
    }
  }, [session]);

  const runSaveAll = useCallback(() => {
    void saveTracker.startSave(host, session);
  }, [saveTracker, host, session]);

  const cancelSave = useCallback(() => {
    saveTracker.cancel(host);
  }, [saveTracker, host]);

  return (
    <>
      <div
        class="neuroglancer-editing-topbar-group"
        role="toolbar"
        aria-label="Save"
      >
        {isSaving ? (
          <button
            type="button"
            class="neuroglancer-editing-topbar-save-button saving"
            onClick={cancelSave}
            title="Cancel in-flight save"
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            class="neuroglancer-editing-topbar-save-button"
            disabled={!hasDirty || !saveAvailable}
            title={
              saveAvailable
                ? "Save all dirty layers to the backend"
                : "Saving is unavailable — no save backend is registered."
            }
            onClick={runSaveAll}
          >
            Save all
            {pendingCount > 0 && (
              <span class="neuroglancer-editing-topbar-badge">
                {pendingCount}
              </span>
            )}
          </button>
        )}
      </div>

      <div class="neuroglancer-editing-topbar-divider" />

      <div
        class="neuroglancer-editing-topbar-group"
        role="toolbar"
        aria-label="Editing tools"
      >
        {TOOL_ENTRIES.filter(
          (entry) =>
            entry.toolId === CURSOR_TOOL_ID || knownToolIds.has(entry.toolId),
        ).map((entry) => {
          const isActive =
            entry.toolId === CURSOR_TOOL_ID
              ? activeToolId === undefined
              : entry.toolId === activeToolId;
          return (
            <button
              key={entry.toolId}
              type="button"
              class={
                "neuroglancer-editing-topbar-tool" +
                (isActive ? " active" : "") +
                (entry.markDisabled ? " disabled" : "")
              }
              title={`${entry.label} · Ctrl+${entry.hotkey}`}
              aria-label={`${entry.label} (Ctrl+${entry.hotkey})`}
              onClick={() => handleToolClick(entry.toolId)}
            >
              <span class="neuroglancer-editing-topbar-tool-glyph">
                {entry.glyph}
              </span>
            </button>
          );
        })}
      </div>

      <div class="neuroglancer-editing-topbar-divider" />

      <div
        class="neuroglancer-editing-topbar-group"
        role="toolbar"
        aria-label="History"
      >
        <button
          type="button"
          class="neuroglancer-editing-topbar-icon-button"
          disabled={!snapshot.canUndo}
          title={`Undo · Ctrl+Z${snapshot.undoDescription ? `\n${snapshot.undoDescription}` : ""}`}
          onClick={() => void runUndo()}
        >
          {"↶"}
        </button>
        <button
          type="button"
          class="neuroglancer-editing-topbar-icon-button"
          disabled={!snapshot.canRedo}
          title={`Redo · Ctrl+Shift+Z${snapshot.redoDescription ? `\n${snapshot.redoDescription}` : ""}`}
          onClick={() => void runRedo()}
        >
          {"↷"}
        </button>
      </div>
    </>
  );
}
