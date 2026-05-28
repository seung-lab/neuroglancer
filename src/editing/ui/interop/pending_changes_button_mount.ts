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
import { RefCounted } from "#src/util/disposable.js";

export class PendingChangesButtonMount extends RefCounted {
  readonly element: HTMLButtonElement;
  private readonly badge: HTMLSpanElement;

  constructor(private readonly host: EditSessionHost) {
    super();

    const button = document.createElement("button");
    button.type = "button";
    button.classList.add("neuroglancer-pending-changes-toggle");
    button.title =
      "Pending Changes — review / save / discard in-memory patches";
    button.textContent = "Pending Changes";

    this.badge = document.createElement("span");
    this.badge.classList.add("neuroglancer-pending-changes-badge");
    this.badge.style.display = "none";
    button.appendChild(this.badge);

    button.addEventListener("click", this.onClick);
    this.element = button;

    this.registerDisposer(host.commitTarget.changed.add(() => this.refresh()));
    this.refresh();
  }

  private refresh = (): void => {
    const layerIds = this.host.commitTarget.pendingLayerIds();
    if (layerIds.length === 0) {
      this.badge.style.display = "none";
      this.badge.textContent = "";
    } else {
      this.badge.style.display = "";
      this.badge.textContent = String(layerIds.length);
    }
  };

  private onClick = (): void => {
    const location = this.host.pendingChangesPanelLocation;
    location.visible = !location.visible;
  };

  override disposed(): void {
    this.element.removeEventListener("click", this.onClick);
    super.disposed();
  }
}
