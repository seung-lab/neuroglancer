/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import "#src/editing/ui/editing_theme.css";
import "#src/editing/ui/topbar/editing_topbar.css";

import type { EditSession } from "@zettaai/edit-session";
import type { LucideIcon } from "lucide-preact";
import {
  Eraser,
  LocateFixed,
  MousePointer2,
  PaintBucket,
  Paintbrush,
  Redo2,
  Undo2,
} from "lucide-preact";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "preact/hooks";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import {
  formatKeyIdentifier,
  keyboardEventToIdentifier,
} from "#src/editing/keybind_event.js";
import {
  effectiveEditKeybinds,
  type EditKeybindName,
} from "#src/editing/session_hotkey_binder.js";
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

/** Pixel size for all topbar Lucide icons — consistent across the toolbar. */
const TOOL_ICON_SIZE = 17;

interface ToolEntry {
  readonly toolId: string;
  readonly label: string;
  /** The configurable keybind action this tool's button rebinds. */
  readonly keybind: EditKeybindName;
  /**
   * Lucide icon component rendered as the button's glyph. Icons inherit the
   * button's `color` via `stroke="currentColor"`, so all visual states
   * (rest / hover / active / disabled) are driven by CSS — never by swapping
   * the icon. The label and shortcut remain exposed via `title`/`aria-label`.
   */
  readonly Icon: LucideIcon;
  readonly markDisabled?: boolean;
}

const TOOL_ENTRIES: readonly ToolEntry[] = [
  {
    toolId: CURSOR_TOOL_ID,
    label: "Cursor",
    keybind: "cursor",
    Icon: MousePointer2,
  },
  {
    toolId: "painting.brush",
    label: "Brush",
    keybind: "brush",
    Icon: Paintbrush,
  },
  { toolId: "painting.erase", label: "Eraser", keybind: "erase", Icon: Eraser },
  {
    toolId: "painting.fill",
    label: "Fill",
    keybind: "fill",
    Icon: PaintBucket,
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
      // Active-tool selection is consumer-owned on the host (TM-315).
      host.activeToolId.changed.add(() => bump(0)),
      // The tool registry is built asynchronously after the session opens; this
      // re-renders once it lands (and when it's torn down) so the tool buttons
      // appear/disappear with it.
      host.toolingChanged.add(() => bump(0)),
      session.on("history-changed", () => bump(0)),
      session.dirty.on("dirty-changed", () => bump(0)),
    ];
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [session, host]);
  useSignal(saveTracker.changed);

  // Registry-driven: which toolbar buttons are enabled comes from the tools
  // actually registered for this session (TM-315), not a hardcoded list.
  // Computed inline (not memoized) so each `toolingChanged` bump re-reads the
  // registry — it does not exist yet on the first render after session-open.
  const knownToolIds = new Set(host.toolRegistry?.ids() ?? []);
  const activeToolId = host.activeToolId.value;
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

  // -- Runtime hotkey rebinding (TM-315) ----------------------------------
  // The effective binding per action (defaults ← custom-keybinds.json ←
  // per-user overrides). Recomputed whenever the user rebinds.
  const overrides = useWatchable(host.editKeybindOverrides);
  const effective = useMemo(
    () => effectiveEditKeybinds(overrides),
    [overrides],
  );
  const hotkeyLabel = useCallback(
    (name: EditKeybindName): string => {
      const keys = effective[name];
      return keys.length > 0 ? formatKeyIdentifier(keys[0]) : "unbound";
    },
    [effective],
  );

  // The action currently awaiting a key-capture, or null when not rebinding.
  const [capturing, setCapturing] = useState<EditKeybindName | null>(null);
  useEffect(() => {
    if (capturing === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Swallow the keypress so it neither triggers a session hotkey nor types
      // into anything while we are capturing.
      event.preventDefault();
      event.stopPropagation();
      // Escape cancels the capture without binding.
      if (event.code === "Escape") {
        setCapturing(null);
        return;
      }
      const identifier = keyboardEventToIdentifier(event);
      if (identifier === undefined) return; // lone modifier — keep waiting
      host.setEditKeybind(capturing, [identifier]);
      setCapturing(null);
      StatusMessage.showTemporaryMessage(
        `Bound "${capturing}" to ${formatKeyIdentifier(identifier)}`,
        2500,
      );
    };
    // Capture phase so we intercept before the session-scoped action map.
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [capturing, host]);

  const startRebind = useCallback((name: EditKeybindName, event: Event) => {
    // Right-click (or the dedicated affordance) — never open the browser
    // context menu here.
    event.preventDefault();
    setCapturing(name);
    StatusMessage.showTemporaryMessage(
      `Press a key combination for "${name}" — Esc to cancel`,
      4000,
    );
  }, []);

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

  const teleportToRegion = useCallback(() => {
    if (!host.teleportToActiveRegionCenter()) {
      StatusMessage.showTemporaryMessage("No active edit region", 3000);
    }
  }, [host]);

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
            data-tooltip="Cancel in-flight save"
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            class="neuroglancer-editing-topbar-save-button"
            disabled={!hasDirty || !saveAvailable}
            data-tooltip={
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
          const { Icon } = entry;
          const isCapturing = capturing === entry.keybind;
          const keyLabel = hotkeyLabel(entry.keybind);
          return (
            <button
              key={entry.toolId}
              type="button"
              class={
                "neuroglancer-editing-topbar-tool" +
                (isActive ? " active" : "") +
                (isCapturing ? " capturing" : "") +
                (entry.markDisabled ? " disabled" : "")
              }
              data-tooltip={
                isCapturing
                  ? `Press a key for ${entry.label} · Esc to cancel`
                  : `${entry.label} · ${keyLabel}\nRight-click to rebind`
              }
              aria-label={`${entry.label} (${keyLabel})`}
              onClick={() => handleToolClick(entry.toolId)}
              onContextMenu={(e) => startRebind(entry.keybind, e)}
            >
              <Icon size={TOOL_ICON_SIZE} aria-hidden="true" />
            </button>
          );
        })}
      </div>

      <div class="neuroglancer-editing-topbar-divider" />

      <div
        class="neuroglancer-editing-topbar-group"
        role="toolbar"
        aria-label="View"
      >
        <button
          type="button"
          class="neuroglancer-editing-topbar-icon-button"
          aria-label="Center view on edit region"
          data-tooltip="Center view on edit region"
          onClick={teleportToRegion}
        >
          <LocateFixed size={TOOL_ICON_SIZE} aria-hidden="true" />
        </button>
      </div>

      <div class="neuroglancer-editing-topbar-divider" />

      <div
        class="neuroglancer-editing-topbar-group"
        role="toolbar"
        aria-label="History"
      >
        <button
          type="button"
          class={
            "neuroglancer-editing-topbar-icon-button" +
            (capturing === "undo" ? " capturing" : "")
          }
          disabled={!snapshot.canUndo}
          aria-label={`Undo (${hotkeyLabel("undo")})`}
          data-tooltip={
            capturing === "undo"
              ? "Press a key for Undo · Esc to cancel"
              : `Undo · ${hotkeyLabel("undo")}\nRight-click to rebind${snapshot.undoDescription ? `\n${snapshot.undoDescription}` : ""}`
          }
          onClick={() => void runUndo()}
          onContextMenu={(e) => startRebind("undo", e)}
        >
          <Undo2 size={TOOL_ICON_SIZE} aria-hidden="true" />
        </button>
        <button
          type="button"
          class={
            "neuroglancer-editing-topbar-icon-button" +
            (capturing === "redo" ? " capturing" : "")
          }
          disabled={!snapshot.canRedo}
          aria-label={`Redo (${hotkeyLabel("redo")})`}
          data-tooltip={
            capturing === "redo"
              ? "Press a key for Redo · Esc to cancel"
              : `Redo · ${hotkeyLabel("redo")}\nRight-click to rebind${snapshot.redoDescription ? `\n${snapshot.redoDescription}` : ""}`
          }
          onClick={() => void runRedo()}
          onContextMenu={(e) => startRebind("redo", e)}
        >
          <Redo2 size={TOOL_ICON_SIZE} aria-hidden="true" />
        </button>
      </div>
    </>
  );
}
