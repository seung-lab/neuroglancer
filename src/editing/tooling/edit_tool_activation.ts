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
 * Per-activation scope for an edit tool (TM-315 tooling redesign).
 *
 * Mirrors neuroglancer's `ToolActivation` pattern (`src/ui/tool.ts`): a
 * `RefCounted` scope that lives exactly while a tool is active and binds its
 * input the same way NG's own tools do — high-priority parent `EventActionMap`
 * layered on the viewer's input maps, plus `registerActionListener` action
 * handlers. Everything registered here is torn down when the activation is
 * disposed (tool switch / session close), so input bindings and any in-flight
 * edit are released automatically.
 *
 * We deliberately do NOT extend NG's `Tool` / `GlobalToolBinder`: that binder
 * models momentary key-held / palette tools and is global, which fights our
 * persistent, session-scoped selection with its own Preact UI. We adopt the
 * activation *pattern* and the `EventActionMap` system (the rebindable layer),
 * not the palette/binder.
 */

import type { EditScope } from "#src/editing/tooling/edit_scope.js";
import { RefCounted } from "#src/util/disposable.js";
import type { EventActionMap } from "#src/util/event_action_map.js";
import { registerActionListener } from "#src/util/event_action_map.js";
import type { Viewer } from "#src/viewer.js";

/**
 * Priority for activation-scoped input maps. Must be > 0 so the active tool's
 * bindings override the viewer's direct/global bindings while it is active
 * (matches the session hotkey layer's priority).
 */
const ACTIVATION_INPUT_PRIORITY = 100;

export class EditToolActivation extends RefCounted {
  constructor(
    private readonly viewer: Viewer,
    /** The edit scope this activation drives; rolled back on dispose. */
    readonly editScope: EditScope,
  ) {
    super();
  }

  /**
   * Layer `map` as a high-priority parent of the viewer's global input map for
   * this activation's lifetime. Bindings in `map` (e.g. brush param hotkeys)
   * override conflicting globals while the tool is active and are removed on
   * dispose.
   */
  bindInputEventMap(map: EventActionMap): void {
    const detach = this.viewer.inputEventMap.addParent(
      map,
      ACTIVATION_INPUT_PRIORITY,
    );
    this.registerDisposer(detach);
  }

  /**
   * Layer `map` as a high-priority parent of the slice + perspective panel
   * input maps for this activation's lifetime. Used for camera-navigation
   * overrides (e.g. suppressing pan while a paint stroke is in progress).
   */
  bindPanelInputEventMap(map: EventActionMap): void {
    const detachSlice = this.viewer.inputEventBindings.sliceView.addParent(
      map,
      ACTIVATION_INPUT_PRIORITY,
    );
    const detachPerspective =
      this.viewer.inputEventBindings.perspectiveView.addParent(
        map,
        ACTIVATION_INPUT_PRIORITY,
      );
    this.registerDisposer(detachSlice);
    this.registerDisposer(detachPerspective);
  }

  /** Register an action listener on the viewer element, scoped to this activation. */
  bindAction(action: string, listener: (event: Event) => void): void {
    this.registerDisposer(
      registerActionListener(this.viewer.element, action, listener),
    );
  }

  override disposed(): void {
    // Roll back any edit left open by an interrupted stroke before releasing
    // input bindings.
    void this.editScope.cancelLive();
    super.disposed();
  }
}
