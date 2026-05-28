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
import { useSignal } from "#src/editing/ui/interop/use_signal.js";

export function PendingChangesButton({ host }: { host: EditSessionHost }) {
  useSignal(host.commitTarget.changed);
  const pendingCount = host.commitTarget.pendingLayerIds().length;

  const toggle = () => {
    const location = host.pendingChangesPanelLocation;
    location.visible = !location.visible;
  };

  return (
    <button
      type="button"
      class="neuroglancer-pending-changes-toggle"
      title="Pending Changes — review / save / discard in-memory patches"
      onClick={toggle}
    >
      Pending Changes
      {pendingCount > 0 && (
        <span class="neuroglancer-pending-changes-badge">{pendingCount}</span>
      )}
    </button>
  );
}
