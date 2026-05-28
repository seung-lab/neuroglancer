/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { createElement } from "preact";
import { render } from "preact";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { SessionControls } from "#src/editing/ui/session_controls/session_controls.js";
import type { SidePanelManager } from "#src/ui/side_panel.js";
import { SidePanel } from "#src/ui/side_panel.js";

export class SessionPanelMount extends SidePanel {
  private readonly host: EditSessionHost;
  private readonly bodyElement: HTMLDivElement;

  constructor(sidePanelManager: SidePanelManager, host: EditSessionHost) {
    super(sidePanelManager, host.editSessionPanelLocation);
    this.host = host;

    this.addTitleBar({ title: "Edit Session" });

    this.bodyElement = document.createElement("div");
    this.bodyElement.classList.add("neuroglancer-edit-session-sidebar");
    this.addBody(this.bodyElement);

    this.registerDisposer(
      host.activeSession.changed.add(() => this.renderBody()),
    );
    this.renderBody();
  }

  private renderBody(): void {
    render(
      createElement(SessionControls, { host: this.host }),
      this.bodyElement,
    );
  }

  override close(): void {
    const session = this.host.activeSession.value;
    if (session === undefined) {
      super.close();
      return;
    }
    const ok = window.confirm(
      "Close edit session? All unsaved edits will be discarded.",
    );
    if (!ok) return;
    void this.host.discardActive().catch(() => {});
  }

  override disposed(): void {
    render(null, this.bodyElement);
    super.disposed();
  }
}
