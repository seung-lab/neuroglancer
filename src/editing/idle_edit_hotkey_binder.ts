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
 * @file Idle (no-session) keyboard shortcut layer (TM-290, TM-344).
 *
 * Installs two idle edit-session chords for the whole viewer lifetime:
 *
 *   - `Ctrl+E` / `Cmd+E` → open the Enter-Edit-Session modal directly, without
 *     drawing a region (dispatches `requestSessionEntry` with no bbox).
 *   - `Ctrl+Shift+E` / `Cmd+Shift+E` → "quick edit-region capture": draw a
 *     2-corner box, then open the modal pre-selected on that box.
 *
 * Unlike `EditSessionHotkeyBinder` (which is session-scoped), this binder is
 * always installed but only acts when NO session is active:
 *
 *   - During a session, `EditSessionHotkeyBinder` installs `control+keye →
 *     erase` at a higher priority (`SESSION_HOTKEY_PRIORITY = 100`), so these
 *     lower-priority bindings are shadowed.
 *   - The handlers additionally guard on `host.activeSession`, no-op'ing while
 *     a session is active.
 *
 * Uses the same `addParent(map, priority)` idiom as the session binder rather
 * than touching the shared `default_input_event_bindings.ts`, keeping all
 * edit hotkeys isolated in the editing domain.
 */

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { RefCounted } from "#src/util/disposable.js";
import {
  EventActionMap,
  registerActionListener,
} from "#src/util/event_action_map.js";
import type { Viewer } from "#src/viewer.js";

// Lower than `SESSION_HOTKEY_PRIORITY` (100) so an active session's bindings
// win, but > 0 so it overrides any direct global binding on the same chord.
const IDLE_HOTKEY_PRIORITY = 50;

const ACTION_OPEN_ENTRY = "edit-session-open-entry";
const ACTION_QUICK_REGION = "edit-session-quick-region";

export class IdleEditHotkeyBinder extends RefCounted {
  constructor(host: EditSessionHost, viewer: Viewer) {
    super();

    const actionMap = EventActionMap.fromObject({
      "control+keye": ACTION_OPEN_ENTRY,
      "meta+keye": ACTION_OPEN_ENTRY,
      "control+shift+keye": ACTION_QUICK_REGION,
      "meta+shift+keye": ACTION_QUICK_REGION,
    });
    actionMap.label = "Edit (idle)";

    this.registerDisposer(
      viewer.inputEventMap.addParent(actionMap, IDLE_HOTKEY_PRIORITY),
    );

    this.registerDisposer(
      registerActionListener(viewer.element, ACTION_OPEN_ENTRY, (event) => {
        // No-op while a session is active; otherwise open the entry modal
        // directly, with no pre-selected region.
        if (host.activeSession.value !== undefined) return;
        event.stopPropagation();
        host.requestSessionEntry.dispatch(undefined);
      }),
    );

    this.registerDisposer(
      registerActionListener(viewer.element, ACTION_QUICK_REGION, (event) => {
        // No-op while a session is active; otherwise begins capture.
        if (host.activeSession.value !== undefined) return;
        event.stopPropagation();
        host.beginQuickRegionCapture();
      }),
    );
  }
}
