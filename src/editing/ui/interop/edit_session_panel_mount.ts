/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { createElement } from "preact";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { PanelMount } from "#src/editing/ui/interop/panel_mount.js";
import { ActiveToolSettings } from "#src/editing/ui/session_controls/active_tool_settings.js";
import type { SidePanelManager } from "#src/ui/side_panel.js";

/**
 * Single side-panel slot that renders the **active tool's** settings (per
 * TM-294). Replaces the legacy "Edit Session" sidebar root — the per-tool
 * settings registry decides which body to mount based on the active tool id.
 *
 * - Selecting a tool flips `editSessionPanelLocation.visible` to true (driven
 *   by the topbar).
 * - The X-close button on the panel closes it without ending the session
 *   (visible=false). Re-clicking the tool icon re-opens it.
 * - The title bar shows the active tool's name so the user always knows
 *   which tool's settings they have open.
 */
export function makeEditSessionPanel(
  sidePanelManager: SidePanelManager,
  host: EditSessionHost,
): PanelMount<{ host: EditSessionHost }> {
  const getTitle = () => {
    const session = host.activeSession.value;
    if (session === undefined) return "Edit Session";
    return toolPanelTitle(session.tools.getActiveToolId());
  };
  return new PanelMount(sidePanelManager, host.editSessionPanelLocation, {
    title: getTitle(),
    getTitle,
    classNames: ["neuroglancer-edit-session-tool-panel"],
    component: ActiveToolPanelBody,
    getProps: () => ({ host }),
    subscribe: (rerender) => {
      // Re-render whenever the active session changes (new tool registry
      // available) OR the currently-active tool changes inside that session.
      let innerUnsub: (() => void) | undefined;
      const installInner = () => {
        if (innerUnsub !== undefined) {
          innerUnsub();
          innerUnsub = undefined;
        }
        const s = host.activeSession.value;
        if (s === undefined) return;
        innerUnsub = s.on("active-tool-changed", () => rerender());
      };
      installInner();
      const sessionUnsub = host.activeSession.changed.add(() => {
        installInner();
        rerender();
      });
      return () => {
        sessionUnsub();
        if (innerUnsub !== undefined) innerUnsub();
      };
    },
    onClose: () => {
      // Closing the panel does NOT end the session — just hide. Re-clicking
      // the active tool icon (or selecting another tool) reopens.
      host.editSessionPanelLocation.visible = false;
      return false;
    },
  });
}

function ActiveToolPanelBody({ host }: { host: EditSessionHost }) {
  const session = host.activeSession.value;
  if (session === undefined) {
    return createElement(
      "div",
      { class: "neuroglancer-tool-panel-host-placeholder" },
      "No active edit session.",
    );
  }
  return createElement(ActiveToolSettings, { session, host });
}

function toolPanelTitle(toolId: string | undefined): string {
  switch (toolId) {
    case "painting.brush":
      return "Brush";
    case "painting.erase":
      return "Eraser";
    case "painting.fill":
      return "Fill";
    case "z-extrapolation":
      return "Z-extrapolation";
    case "correspondence":
      return "Correspondence";
    case undefined:
      return "Edit Session";
    default:
      return "Tool";
  }
}
