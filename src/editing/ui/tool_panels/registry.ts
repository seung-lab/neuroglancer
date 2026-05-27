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
 * @file Tool-panel registry — open extension point for per-tool side panels.
 *
 * Keys are library tool ids (verified against
 * `node_modules/@zetta-ai/edit-session/dist/index.d.mts`): `painting.brush`,
 * `painting.erase`, `painting.fill`, `correspondence`, `z-extrapolation`.
 *
 * Per `docs/edit-session-integration/architecture/04-ui-shell.md` §
 * "Tool-panel registry", a future tool registers its panel factory here.
 */

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import type { RefCounted } from "#src/util/disposable.js";

import { CorrespondencePanel } from "#src/editing/ui/tool_panels/correspondence_panel.js";
import { PaintingBrushPanel } from "#src/editing/ui/tool_panels/painting_brush_panel.js";
import { PaintingEraserPanel } from "#src/editing/ui/tool_panels/painting_eraser_panel.js";
import { PaintingFillPanel } from "#src/editing/ui/tool_panels/painting_fill_panel.js";
import { ZExtrapolationPanel } from "#src/editing/ui/tool_panels/z_extrapolation_panel.js";

export interface ToolPanel extends RefCounted {
  readonly element: HTMLElement;
}

export type ToolPanelFactory = (host: EditSessionHost) => ToolPanel;

export const toolPanelRegistry: ReadonlyMap<string, ToolPanelFactory> = new Map<
  string,
  ToolPanelFactory
>([
  ["painting.brush", (host) => new PaintingBrushPanel(host)],
  ["painting.erase", (host) => new PaintingEraserPanel(host)],
  ["painting.fill", (host) => new PaintingFillPanel(host)],
  ["correspondence", (host) => new CorrespondencePanel(host)],
  ["z-extrapolation", (host) => new ZExtrapolationPanel(host)],
]);
