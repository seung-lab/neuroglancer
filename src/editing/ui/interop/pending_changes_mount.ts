/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { createElement, render } from "preact";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { PendingChanges } from "#src/editing/ui/session_controls/pending_changes.js";
import type { SidePanelManager } from "#src/ui/side_panel.js";
import { SidePanel } from "#src/ui/side_panel.js";

export class PendingChangesPanelMount extends SidePanel {
  private readonly host: EditSessionHost;
  private readonly bodyElement: HTMLDivElement;

  constructor(sidePanelManager: SidePanelManager, host: EditSessionHost) {
    super(sidePanelManager, host.pendingChangesPanelLocation);
    this.host = host;

    this.addTitleBar({ title: "Pending Changes" });

    this.bodyElement = document.createElement("div");
    this.addBody(this.bodyElement);

    this.renderBody();
  }

  private renderBody(): void {
    render(
      createElement(PendingChanges, { host: this.host }),
      this.bodyElement,
    );
  }

  override disposed(): void {
    render(null, this.bodyElement);
    super.disposed();
  }
}
