/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { PanelMount } from "#src/editing/ui/interop/panel_mount.js";
import { PendingChanges } from "#src/editing/ui/session_controls/pending_changes.js";
import type { SidePanelManager } from "#src/ui/side_panel.js";

export function makePendingChangesPanel(
  sidePanelManager: SidePanelManager,
  host: EditSessionHost,
): PanelMount<{ host: EditSessionHost }> {
  return new PanelMount(
    sidePanelManager,
    host.pendingChangesPanelLocation,
    {
      title: "Pending Changes",
      component: PendingChanges,
      getProps: () => ({ host }),
    },
  );
}
