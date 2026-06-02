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
import { useEffect, useState } from "preact/hooks";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { getToolSettings } from "#src/editing/ui/tool_settings/registry.js";

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
    <div class="neuroglancer-edit-session-section">
      <div class="neuroglancer-edit-session-section-title">Tool</div>
      <div class="neuroglancer-edit-session-tool-panel-slot">
        {Panel !== undefined
          ? <Panel session={session} host={host} />
          : (
            <p class="neuroglancer-tool-panel-host-placeholder">
              {activeToolId === undefined
                ? "No tool selected."
                : `No panel registered for tool "${activeToolId}".`}
            </p>
          )}
      </div>
    </div>
  );
}
