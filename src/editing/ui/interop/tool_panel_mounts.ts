/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { EditSession } from "@zettaai/edit-session";
import type { ComponentType } from "preact";
import { createElement } from "preact";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { PanelMount } from "#src/editing/ui/interop/panel_mount.js";
import { Correspondence } from "#src/editing/ui/tool_settings/correspondence.js";
import { PaintingBrush } from "#src/editing/ui/tool_settings/painting_brush.js";
import { PaintingEraser } from "#src/editing/ui/tool_settings/painting_eraser.js";
import { PaintingFill } from "#src/editing/ui/tool_settings/painting_fill.js";
import { ZExtrapolation } from "#src/editing/ui/tool_settings/z_extrapolation.js";
import type { SidePanelManager } from "#src/ui/side_panel.js";
import type { TrackableSidePanelLocation } from "#src/ui/side_panel_location.js";
// Design tokens first (defines the --nge-* custom properties every editing
// stylesheet below resolves against), then the shared row/label/input styling
// for every tool-settings panel body. Imported here (rather than per-tool) so
// they load once for the whole subsystem.
import "#src/editing/ui/editing_theme.css";
import "#src/editing/ui/session_controls/session_controls.css";

/**
 * Per-tool side panel mounts (TM-294 rework). Each tool gets its own
 * dedicated PanelMount with a fixed title and a fixed settings body — the
 * body never reads `session.tools.getActiveToolId()`, so a stale active
 * tool can't produce a "ghost" panel. The host's `selectTool()` is the
 * single authority for which panel is visible at a time.
 */

type ToolSettingsComponent = ComponentType<{
  session: EditSession;
  host: EditSessionHost;
}>;

function buildToolPanel(
  sidePanelManager: SidePanelManager,
  host: EditSessionHost,
  title: string,
  location: TrackableSidePanelLocation,
  Body: ToolSettingsComponent,
): PanelMount<{ host: EditSessionHost }> {
  const PanelBody = ({ host }: { host: EditSessionHost }) => {
    const session = host.activeSession.value;
    if (session === undefined) {
      return createElement(
        "div",
        { class: "neuroglancer-tool-panel-host-placeholder" },
        "No active edit session.",
      );
    }
    return createElement(Body, { session, host });
  };
  return new PanelMount(sidePanelManager, location, {
    title,
    classNames: ["neuroglancer-edit-session-tool-panel"],
    component: PanelBody,
    getProps: () => ({ host }),
    subscribe: (rerender) => host.activeSession.changed.add(rerender),
    onClose: () => {
      // Closing only hides this panel — the active tool stays selected so
      // clicking the tool icon re-opens it.
      location.visible = false;
      return false;
    },
  });
}

export function makeBrushPanel(
  sidePanelManager: SidePanelManager,
  host: EditSessionHost,
): PanelMount<{ host: EditSessionHost }> {
  return buildToolPanel(
    sidePanelManager,
    host,
    "Brush",
    host.brushPanelLocation,
    PaintingBrush,
  );
}

export function makeEraserPanel(
  sidePanelManager: SidePanelManager,
  host: EditSessionHost,
): PanelMount<{ host: EditSessionHost }> {
  return buildToolPanel(
    sidePanelManager,
    host,
    "Eraser",
    host.eraserPanelLocation,
    PaintingEraser,
  );
}

export function makeFillPanel(
  sidePanelManager: SidePanelManager,
  host: EditSessionHost,
): PanelMount<{ host: EditSessionHost }> {
  return buildToolPanel(
    sidePanelManager,
    host,
    "Fill",
    host.fillPanelLocation,
    PaintingFill,
  );
}

export function makeZExtrapPanel(
  sidePanelManager: SidePanelManager,
  host: EditSessionHost,
): PanelMount<{ host: EditSessionHost }> {
  return buildToolPanel(
    sidePanelManager,
    host,
    "Z-extrapolation",
    host.zExtrapPanelLocation,
    ZExtrapolation as ToolSettingsComponent,
  );
}

export function makeCorrespondencePanel(
  sidePanelManager: SidePanelManager,
  host: EditSessionHost,
): PanelMount<{ host: EditSessionHost }> {
  return buildToolPanel(
    sidePanelManager,
    host,
    "Correspondence",
    host.correspondencePanelLocation,
    Correspondence as ToolSettingsComponent,
  );
}
