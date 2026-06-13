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
 * Edit tool registry (TM-315 tooling redesign).
 *
 * One `ToolDefinition` per tool is the single point of truth for that tool's
 * identity, replacing today's string-keyed smearing across the dispatcher,
 * cursor classifier, hotkey table, panel-location switch, and settings map.
 * Reviving correspondence / z-extrapolation later is "register one definition",
 * not edits across six files.
 *
 * The registry is intentionally UI-agnostic: it holds behavioral metadata
 * (policy, cursor kind, activation hotkey, panel key) and a tool factory. The
 * Preact settings-component mapping stays in the UI layer (`ui/tool_settings`),
 * keyed by the same id.
 */

import type {
  EditTool,
  EditToolContext,
  InteractionPolicyKind,
} from "#src/editing/tooling/edit_tool.js";

/** Cursor overlay kind a tool drives (undefined => no brush cursor). */
export type ToolCursorKind = "brush" | "eraser" | "fill" | undefined;

export interface ToolDefinition {
  readonly id: string;
  readonly interactionPolicy: InteractionPolicyKind;
  /** Brush-cursor overlay kind, if any. */
  readonly cursorKind: ToolCursorKind;
  /**
   * Activation hotkey event identifier (NG `EventActionMap` syntax, e.g.
   * "control+keyb"). Bound session-scoped; rebindable via NG. Optional.
   */
  readonly activationHotkey?: string;
  /** Side-panel key for this tool's settings panel (host panel-location map). */
  readonly panelKey: string;
  /** Construct the tool instance for an open session. */
  createTool(ctx: EditToolContext): EditTool;
}

export class ToolRegistry {
  private readonly defs = new Map<string, ToolDefinition>();

  register(def: ToolDefinition): void {
    if (this.defs.has(def.id)) {
      throw new Error(`ToolRegistry: duplicate tool id "${def.id}"`);
    }
    this.defs.set(def.id, def);
  }

  get(id: string | undefined): ToolDefinition | undefined {
    return id === undefined ? undefined : this.defs.get(id);
  }

  has(id: string | undefined): boolean {
    return id !== undefined && this.defs.has(id);
  }

  ids(): readonly string[] {
    return [...this.defs.keys()];
  }

  all(): readonly ToolDefinition[] {
    return [...this.defs.values()];
  }
}
