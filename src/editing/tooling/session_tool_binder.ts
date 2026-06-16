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
 * Session-scoped tool binder (TM-315 tooling redesign).
 *
 * Owns active-tool selection and the active tool's `EditToolActivation` for
 * the lifetime of one edit session. Created on session open, disposed on
 * close — so edit tools exist ONLY in a session (constraint B), never in the
 * standalone viewer. This is our analogue of NG's `GlobalToolBinder`, but
 * session-scoped, persistent-selection (not momentary key-held), and driven by
 * our own Preact UI rather than the tool palette.
 *
 * Selecting a tool disposes the previous activation (which rolls back any
 * in-flight edit and removes input bindings) and activates the new one. The
 * `activeToolId` watchable is what the topbar, cursor overlay, and hotkey
 * layer subscribe to.
 */

import type { EditScope } from "#src/editing/tooling/edit_scope.js";
import type {
  EditTool,
  EditToolContext,
} from "#src/editing/tooling/edit_tool.js";
import { EditToolActivation } from "#src/editing/tooling/edit_tool_activation.js";
import type { ToolRegistry } from "#src/editing/tooling/tool_registry.js";
import type { WatchableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import type { Viewer } from "#src/viewer.js";

interface ActiveEntry {
  readonly tool: EditTool;
  readonly activation: EditToolActivation;
}

export class SessionToolBinder extends RefCounted {
  private active: ActiveEntry | undefined;

  constructor(
    private readonly viewer: Viewer,
    private readonly registry: ToolRegistry,
    private readonly context: EditToolContext,
    /**
     * Active-tool id (undefined = cursor mode). Owned by the host so it stays
     * stable across sessions; the binder writes it. Subscribed by UI + cursor
     * + hotkeys.
     */
    private readonly activeToolId: WatchableValue<string | undefined>,
    /** Shared edit scope — one live edit at a time across all tools. */
    private readonly editScope: EditScope,
  ) {
    super();
  }

  /** The currently-active tool instance, or undefined in cursor mode. */
  get activeTool(): EditTool | undefined {
    return this.active?.tool;
  }

  /**
   * Select `toolId` (or undefined for cursor mode). Disposes the previous
   * activation (rolling back any in-flight edit) and activates the new tool.
   * No-op when already active.
   */
  select(toolId: string | undefined): void {
    if (this.activeToolId.value === toolId && this.active?.tool.id === toolId) {
      return;
    }
    this.deactivate();
    if (toolId === undefined) {
      this.activeToolId.value = undefined;
      return;
    }
    const def = this.registry.get(toolId);
    if (def === undefined) {
      this.context.logger.warn(
        "editing",
        `SessionToolBinder.select: unknown tool id "${toolId}"`,
      );
      this.activeToolId.value = undefined;
      return;
    }
    const tool = def.createTool(this.context);
    const activation = new EditToolActivation(this.viewer, this.editScope);
    tool.activate(activation);
    this.active = { tool, activation };
    this.activeToolId.value = toolId;
  }

  private deactivate(): void {
    const active = this.active;
    if (active === undefined) return;
    this.active = undefined;
    try {
      active.activation.dispose();
    } catch {
      // best-effort teardown
    }
  }

  override disposed(): void {
    this.deactivate();
    this.activeToolId.value = undefined;
    super.disposed();
  }
}
