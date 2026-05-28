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
import { SessionControls } from "#src/editing/ui/session_controls/session_controls.js";
import type { SidePanelManager } from "#src/ui/side_panel.js";

export function makeEditSessionPanel(
  sidePanelManager: SidePanelManager,
  host: EditSessionHost,
): PanelMount<{ host: EditSessionHost }> {
  return new PanelMount(
    sidePanelManager,
    host.editSessionPanelLocation,
    {
      title: "Edit Session",
      classNames: ["neuroglancer-edit-session-sidebar"],
      component: SessionControls,
      getProps: () => ({ host }),
      subscribe: (rerender) => host.activeSession.changed.add(rerender),
      onClose: () => {
        if (host.activeSession.value === undefined) return;
        const ok = window.confirm(
          "Close edit session? All unsaved edits will be discarded.",
        );
        if (!ok) return false;
        void host.discardActive().catch(() => {});
        return false;
      },
    },
  );
}
