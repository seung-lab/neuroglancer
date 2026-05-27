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
 * @file v1 stub panel for the `z-extrapolation` tool.
 *
 * Per `docs/edit-session-integration/architecture/04-ui-shell.md` §
 * "CorrespondencePanel / ZExtrapolationPanel", v1 ships a placeholder with a
 * disabled Propagate slice button. Wiring depends on remote service
 * contracts that land in a later phase.
 */

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { RefCounted } from "#src/util/disposable.js";

/**
 * Side-panel placeholder for the z-extrapolation tool. v1 renders informational
 * text and a disabled action button; reserved as an integration point.
 */
export class ZExtrapolationPanel extends RefCounted {
  readonly element: HTMLElement;

  constructor(host: EditSessionHost) {
    super();
    this.element = document.createElement("div");
    this.element.classList.add(
      "neuroglancer-tool-panel",
      "neuroglancer-z-extrapolation-panel",
    );

    const msg = document.createElement("p");
    msg.classList.add("neuroglancer-tool-panel-placeholder");
    msg.textContent = "Z-extrapolation tool is not available in v1.";
    this.element.appendChild(msg);

    const buttons = document.createElement("div");
    buttons.classList.add("neuroglancer-tool-panel-row");
    const propagate = document.createElement("button");
    propagate.type = "button";
    propagate.textContent = "Propagate slice";
    propagate.disabled = true;
    buttons.appendChild(propagate);

    this.element.appendChild(buttons);

    // Subscribe so the panel can react in case the host wants to switch the
    // placeholder copy when a session ends mid-life. v1 keeps the same text.
    this.registerDisposer(host.activeSession.changed.add(() => {}));
  }

  override disposed(): void {
    while (this.element.firstChild !== null) {
      this.element.removeChild(this.element.firstChild);
    }
    super.disposed();
  }
}
