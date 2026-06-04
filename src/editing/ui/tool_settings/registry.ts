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

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { Correspondence } from "#src/editing/ui/tool_settings/correspondence.js";
import { PaintingBrush } from "#src/editing/ui/tool_settings/painting_brush.js";
import { PaintingEraser } from "#src/editing/ui/tool_settings/painting_eraser.js";
import { PaintingFill } from "#src/editing/ui/tool_settings/painting_fill.js";
import { ZExtrapolation } from "#src/editing/ui/tool_settings/z_extrapolation.js";

type ToolSettingsProps = { session: EditSession; host: EditSessionHost };

const registry = new Map<string, ComponentType<ToolSettingsProps>>([
  ["painting.brush", PaintingBrush],
  ["painting.erase", PaintingEraser],
  ["painting.fill", PaintingFill],
  ["correspondence", Correspondence as ComponentType<ToolSettingsProps>],
  ["z-extrapolation", ZExtrapolation as ComponentType<ToolSettingsProps>],
]);

export function getToolSettings(
  toolId: string,
): ComponentType<ToolSettingsProps> | undefined {
  return registry.get(toolId);
}
