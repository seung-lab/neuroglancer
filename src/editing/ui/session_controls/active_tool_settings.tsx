/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import "#src/editing/ui/session_controls/session_controls.css";

import type { EditSession } from "@zettaai/edit-session";
import { useEffect, useState } from "preact/hooks";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { getToolSettings } from "#src/editing/ui/tool_settings/registry.js";

/**
 * Body of the per-tool side panel. The panel mount handles the title bar +
 * X-close; this component just renders the active tool's settings
 * (`tool_settings/registry.ts`) or a placeholder when no tool is active.
 */
export function ActiveToolSettings({
  session,
  host,
}: {
  session: EditSession;
  host: EditSessionHost;
}) {
  const [activeToolId, setActiveToolId] = useState<string | undefined>(
    session.tools.getActiveToolId(),
  );

  useEffect(() => {
    setActiveToolId(session.tools.getActiveToolId());
    return session.on("active-tool-changed", (payload) => {
      setActiveToolId(payload.to);
    });
  }, [session]);

  const Panel = activeToolId !== undefined
    ? getToolSettings(activeToolId)
    : undefined;

  return (
    <div class="neuroglancer-edit-session-tool-panel-body">
      {Panel !== undefined
        ? <Panel session={session} host={host} />
        : (
          <p class="neuroglancer-tool-panel-host-placeholder">
            {activeToolId === undefined
              ? "No tool selected. Pick one from the topbar."
              : `No panel registered for tool "${activeToolId}".`}
          </p>
        )}
    </div>
  );
}
