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
import { mountComponent } from "#src/editing/ui/interop/component_mount.js";
import { PendingChangesButton } from "#src/editing/ui/session_controls/pending_changes_button.js";
import { RefCounted } from "#src/util/disposable.js";

export class PendingChangesButtonMount extends RefCounted {
  readonly element: HTMLElement;

  constructor(host: EditSessionHost) {
    super();
    this.element = document.createElement("div");
    this.element.style.display = "contents";
    this.registerDisposer(
      mountComponent(this.element, PendingChangesButton, { host }),
    );
  }
}
