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
 * @file Tool-panel host — single sidebar slot that mounts the panel for the
 * currently active edit-session tool.
 *
 * Per `docs/edit-session-integration/architecture/04-ui-shell.md` §
 * "ToolPanelHost", this widget owns one `<div>` slot. It subscribes to
 * `EditSessionHost.activeSession.changed`; while a session is open it also
 * subscribes to `session.on('active-tool-changed', ...)` and remounts the
 * panel from `toolPanelRegistry` on every switch. The previous panel is
 * disposed before the new one is constructed.
 */

import type { EditSession } from "@zetta-ai/edit-session";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import {
  type ToolPanel,
  toolPanelRegistry,
} from "#src/editing/ui/tool_panels/registry.js";
import { RefCounted } from "#src/util/disposable.js";

/**
 * Sidebar slot that mounts the per-tool panel for the active tool, swapping
 * it on `session.on('active-tool-changed', ...)`. Owns the mounted panel's
 * lifecycle: a previously mounted panel is disposed before the next one is
 * constructed, and on session close / host disposal.
 */
export class ToolPanelHost extends RefCounted {
  readonly element: HTMLElement;

  private mountedPanel: ToolPanel | undefined;
  private unsubscribeActiveTool: (() => void) | undefined;
  private boundSession: EditSession | undefined;

  constructor(private readonly host: EditSessionHost) {
    super();
    this.element = document.createElement("div");
    this.element.classList.add("neuroglancer-tool-panel-host");

    this.registerDisposer(
      host.activeSession.changed.add(() => this.handleSessionChanged()),
    );

    // Initial sync (a session may already be active at construction time).
    this.handleSessionChanged();
  }

  override disposed(): void {
    this.detachSession();
    this.mountPanelForTool(undefined);
    while (this.element.firstChild !== null) {
      this.element.removeChild(this.element.firstChild);
    }
    super.disposed();
  }

  private handleSessionChanged(): void {
    const session = this.host.activeSession.value;
    if (session === this.boundSession) return;

    // Tear down any binding to the previous session before attaching to the
    // new one.
    this.detachSession();

    if (session === undefined) {
      this.mountPanelForTool(undefined);
      return;
    }

    this.boundSession = session;
    this.unsubscribeActiveTool = session.on("active-tool-changed", (payload) => {
      this.mountPanelForTool(payload.to);
    });
    this.mountPanelForTool(session.tools.getActiveToolId());
  }

  private detachSession(): void {
    if (this.unsubscribeActiveTool !== undefined) {
      try {
        this.unsubscribeActiveTool();
      } catch {
        // ignore — best-effort unsubscribe.
      }
      this.unsubscribeActiveTool = undefined;
    }
    this.boundSession = undefined;
  }

  /**
   * Dispose any previously mounted panel and mount the one registered for
   * `toolId`. When `toolId` is undefined or no factory is registered for it,
   * the slot is left showing a placeholder message.
   */
  private mountPanelForTool(toolId: string | undefined): void {
    if (this.mountedPanel !== undefined) {
      const previous = this.mountedPanel;
      this.mountedPanel = undefined;
      try {
        if (previous.element.parentNode === this.element) {
          this.element.removeChild(previous.element);
        }
      } catch {
        // ignore — DOM detach is best-effort.
      }
      try {
        previous.dispose();
      } catch {
        // ignore — panel teardown must not abort the swap.
      }
    }

    // Clear any placeholder text left over from a previous "no tool" state.
    while (this.element.firstChild !== null) {
      this.element.removeChild(this.element.firstChild);
    }

    if (toolId === undefined) {
      this.appendPlaceholder("No tool selected.");
      return;
    }
    const factory = toolPanelRegistry.get(toolId);
    if (factory === undefined) {
      this.appendPlaceholder(`No panel registered for tool "${toolId}".`);
      return;
    }
    const panel = factory(this.host);
    this.mountedPanel = panel;
    this.element.appendChild(panel.element);
  }

  private appendPlaceholder(message: string): void {
    const node = document.createElement("p");
    node.classList.add("neuroglancer-tool-panel-host-placeholder");
    node.textContent = message;
    this.element.appendChild(node);
  }
}
