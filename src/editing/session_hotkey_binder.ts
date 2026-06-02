/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * @file Session-scoped keyboard shortcut layer for an active edit session.
 *
 * Per `docs/edit-session-integration/architecture/05-tools-and-cursor.md`
 * § "Tool activation hotkeys (v1)" and § "Routing mechanism", an active edit
 * session installs a session-scoped binding layer that overrides
 * neuroglancer's global hotkeys for the session's duration.
 *
 * Routing strategy (see also `07-data-flow.md` § H):
 *
 * Neuroglancer's global `KeyboardEventBinder` (`src/viewer.ts:1041`) is
 * permanently attached to `viewer.element` and consults
 * `viewer.inputEventMap`, which is an `EventActionMap`. `EventActionMap`
 * extends `HierarchicalMap` (`src/util/hierarchical_map.ts:45`) and supports
 * priority-based parent maps via `addParent(parent, priority)`. When
 * `priority > 0`, the parent's bindings take precedence over direct
 * bindings (see `HierarchicalMap.get`,
 * `src/util/hierarchical_map.ts:132`).
 *
 * We therefore install our session-scoped `EventActionMap` as a
 * high-priority parent of `viewer.inputEventMap`. The architecture doc's
 * conjectural `viewer.keyboardBinder.pushMap(...)` API does not exist
 * (`KeyboardEventBinder` itself has no stack — `src/util/keyboard_bindings.ts`),
 * but `addParent` is the canonical neuroglancer "layered binder" idiom and
 * is already used to compose default bindings
 * (`src/ui/default_input_event_bindings.ts:72-78`).
 *
 * Action listeners are registered on `viewer.element` (the same target the
 * global binder dispatches to via `dispatchEventAction`,
 * `src/util/event_action_map.ts:421`). On dispose, the parent linkage and
 * all listeners are removed; the global bindings (e.g., any default
 * `Ctrl+Z`) return to normal.
 */

import type { PaintingTools } from "@zettaai/edit-session";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { RefCounted } from "#src/util/disposable.js";
import {
  EventActionMap,
  registerActionListener,
} from "#src/util/event_action_map.js";
import type { Viewer } from "#src/viewer.js";

// Priority must be > 0 so the session layer overrides direct bindings on
// `viewer.inputEventMap` (e.g. neuroglancer's global `keyb` → "toggle-scale-bar"
// in `src/ui/default_input_event_bindings.ts:28`).
const SESSION_HOTKEY_PRIORITY = 100;

const MIN_BRUSH_RADIUS = 1;
const MAX_BRUSH_RADIUS = 64;

// Centralised so the action ids stay in sync between the action map and the
// action-listener registrations below. Mirrors the v1 hotkey table in
// `docs/edit-session-integration/architecture/05-tools-and-cursor.md`.
const ACTION_IDS = {
  toolBrush: "edit-session-tool-brush",
  toolErase: "edit-session-tool-erase",
  toolFill: "edit-session-tool-fill",
  toolZExtrap: "edit-session-tool-zextrap",
  toolCorrespondence: "edit-session-tool-correspondence",
  undo: "edit-session-undo",
  redo: "edit-session-redo",
  exitTool: "edit-session-exit-tool",
  brushDecr: "edit-session-brush-decr",
  brushIncr: "edit-session-brush-incr",
} as const;

// Library tool ids (see `node_modules/@zettaai/edit-session/dist/index.d.mts`
// lines 1178, 1213, 1425, 1568, and 1148 for the `StrokeTool` toolId values).
const TOOL_ID_BRUSH = "painting.brush";
const TOOL_ID_ERASE = "painting.erase";
const TOOL_ID_FILL = "painting.fill";
const TOOL_ID_Z_EXTRAP = "z-extrapolation";
const TOOL_ID_CORRESPONDENCE = "correspondence";
const TOOL_ID_PAINTING = "painting";

/**
 * Installs a session-scoped keyboard shortcut layer for the duration of an
 * active `EditSession`. Constructed by `EditSessionHost` on session-open
 * and disposed on session-end; the host owns the lifecycle.
 */
export class EditSessionHotkeyBinder extends RefCounted {
  constructor(host: EditSessionHost, viewer: Viewer) {
    super();

    // Build the session's `EventActionMap`. Note the keys are bare event
    // identifiers (no `key:` phase prefix — `parseEventIdentifier` only
    // accepts `at` / `bubble` phases; the architecture doc's `key:keyb`
    // syntax would throw). Modifier-free letter keys do not include
    // `control?+`/`meta?+` opt-ins, so `Ctrl+B` / `Cmd+B` fall through to
    // any global binding for those chords.
    const actionMap = EventActionMap.fromObject({
      keyb: ACTION_IDS.toolBrush,
      keye: ACTION_IDS.toolErase,
      keyf: ACTION_IDS.toolFill,
      keyz: ACTION_IDS.toolZExtrap,
      keyc: ACTION_IDS.toolCorrespondence,
      "control+keyz": ACTION_IDS.undo,
      "control+shift+keyz": ACTION_IDS.redo,
      "meta+keyz": ACTION_IDS.undo,
      "meta+shift+keyz": ACTION_IDS.redo,
      escape: ACTION_IDS.exitTool,
      bracketleft: ACTION_IDS.brushDecr,
      bracketright: ACTION_IDS.brushIncr,
    });
    actionMap.label = "Edit session";

    // Install as a high-priority parent of the viewer's input map. The
    // returned thunk both removes the parent linkage and is safe to call
    // exactly once on dispose.
    const detachParent = viewer.inputEventMap.addParent(
      actionMap,
      SESSION_HOTKEY_PRIORITY,
    );
    this.registerDisposer(detachParent);

    // Camera-pan-during-paint mapping. While a paint-like tool is active:
    //
    // - Plain left-click+drag must NOT pan. We override `at:mousedown0`
    //   with a no-op action whose listener doesn't exist, which shadows
    //   neuroglancer's default `translate-via-mouse-drag` binding from the
    //   slice/perspective panels. The synthesized `mousedown` itself still
    //   fires (Chrome only suppresses subsequent `mousemove` events when
    //   `preventDefault` is called on the upstream `pointerdown` —
    //   suppressing the action via the binding map avoids that pitfall).
    //
    // - Ctrl/Cmd+left-click+drag pans normally. We map those into the
    //   existing `translate-via-mouse-drag` action.
    const navMap = EventActionMap.fromObject({
      "at:mousedown0": {
        action: "edit-session-noop-mousedown",
        stopPropagation: true,
      },
      "at:control+mousedown0": {
        action: "translate-via-mouse-drag",
        stopPropagation: true,
      },
      "at:meta+mousedown0": {
        action: "translate-via-mouse-drag",
        stopPropagation: true,
      },
    });
    navMap.label = "Edit session navigation";
    const detachSliceNav = viewer.inputEventBindings.sliceView.addParent(
      navMap,
      SESSION_HOTKEY_PRIORITY,
    );
    const detachPerspectiveNav =
      viewer.inputEventBindings.perspectiveView.addParent(
        navMap,
        SESSION_HOTKEY_PRIORITY,
      );
    this.registerDisposer(detachSliceNav);
    this.registerDisposer(detachPerspectiveNav);

    const target = viewer.element;

    const activateTool = (toolId: string) => {
      const session = host.activeSession.value;
      if (session === undefined) return;
      try {
        session.setActiveTool(toolId);
      } catch (err) {
        host.logger.warn(
          "session",
          `Failed to activate tool ${toolId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    };

    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.toolBrush, () => {
        activateTool(TOOL_ID_BRUSH);
      }),
    );
    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.toolErase, () => {
        activateTool(TOOL_ID_ERASE);
      }),
    );
    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.toolFill, () => {
        activateTool(TOOL_ID_FILL);
      }),
    );
    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.toolZExtrap, () => {
        activateTool(TOOL_ID_Z_EXTRAP);
      }),
    );
    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.toolCorrespondence, () => {
        activateTool(TOOL_ID_CORRESPONDENCE);
      }),
    );

    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.undo, (event) => {
        const session = host.activeSession.value;
        if (session === undefined) return;
        event.stopPropagation();
        void session.undo().catch((err) => {
          host.logger.warn(
            "session",
            `Undo failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }),
    );

    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.redo, (event) => {
        const session = host.activeSession.value;
        if (session === undefined) return;
        event.stopPropagation();
        void session.redo().catch((err) => {
          host.logger.warn(
            "session",
            `Redo failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }),
    );

    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.exitTool, (event) => {
        const session = host.activeSession.value;
        if (session === undefined) return;
        event.stopPropagation();
        try {
          session.clearActiveTool();
        } catch (err) {
          host.logger.warn(
            "session",
            `Clear active tool failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }),
    );

    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.brushDecr, () => {
        adjustBrushRadius(host, -1);
      }),
    );
    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.brushIncr, () => {
        adjustBrushRadius(host, +1);
      }),
    );
  }
}

function adjustBrushRadius(host: EditSessionHost, delta: number): void {
  const session = host.activeSession.value;
  if (session === undefined) return;
  const activeId = session.tools.getActiveToolId();
  if (activeId !== TOOL_ID_BRUSH && activeId !== TOOL_ID_ERASE) return;
  let painting: PaintingTools;
  try {
    painting = session.tools.getTool<PaintingTools>(TOOL_ID_PAINTING);
  } catch (err) {
    host.logger.warn(
      "session",
      `PaintingTools unavailable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  const current = painting.getState().radius;
  const next =
    delta < 0
      ? Math.max(MIN_BRUSH_RADIUS, current + delta)
      : Math.min(MAX_BRUSH_RADIUS, current + delta);
  if (next === current) return;
  painting.patchState({ radius: next });
}
