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
 * @file Idle (no-session) keyboard shortcut layer (TM-290).
 *
 * Installs `Ctrl+E` / `Cmd+E` → "quick edit-region capture" for the whole
 * viewer lifetime. Unlike `EditSessionHotkeyBinder` (which is session-scoped),
 * this binder is always installed but only acts when NO session is active:
 *
 *   - During a session, `EditSessionHotkeyBinder` installs `control+keye →
 *     erase` at a higher priority (`SESSION_HOTKEY_PRIORITY = 100`), so this
 *     lower-priority binding is shadowed.
 *   - The handler additionally guards via `host.beginQuickRegionCapture()`,
 *     which is a no-op while a session is active.
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

const ACTION_QUICK_REGION = "edit-session-quick-region";

export class IdleEditHotkeyBinder extends RefCounted {
  constructor(host: EditSessionHost, viewer: Viewer) {
    super();

    const actionMap = EventActionMap.fromObject({
      "control+keye": ACTION_QUICK_REGION,
      "meta+keye": ACTION_QUICK_REGION,
    });
    actionMap.label = "Edit (idle)";

    this.registerDisposer(
      viewer.inputEventMap.addParent(actionMap, IDLE_HOTKEY_PRIORITY),
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
