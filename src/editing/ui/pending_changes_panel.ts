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
 * @file "Pending Changes" side panel.
 *
 * Lifecycle manager for in-memory committed patches, live outside any
 * active edit session. Lists every layer with committed-but-not-saved
 * chunks; per-layer Save / Reset buttons; global Save All / Reset All
 * row. The panel is opened from a top-bar button (mirroring how Settings
 * / Help work) — visibility is owned by `EditSessionHost.pendingChangesPanelLocation`.
 *
 * Data source: `EditSessionHost.commitTarget` (an `NgCommitTarget`).
 * Refreshes whenever its `changed` signal fires.
 */

import type { LayerId } from "@zetta-ai/edit-session";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { SidePanel } from "#src/ui/side_panel.js";
import type { SidePanelManager } from "#src/ui/side_panel.js";
import { StatusMessage } from "#src/status.js";
import "#src/editing/ui/pending_changes_panel.css";

export class PendingChangesPanel extends SidePanel {
  private readonly host: EditSessionHost;
  private readonly listElement: HTMLDivElement;
  private readonly emptyMessageElement: HTMLDivElement;
  private readonly globalActionsElement: HTMLDivElement;
  private busy = false;

  constructor(sidePanelManager: SidePanelManager, host: EditSessionHost) {
    super(sidePanelManager, host.pendingChangesPanelLocation);
    this.host = host;

    this.addTitleBar({ title: "Pending Changes" });

    const body = document.createElement("div");
    body.classList.add("neuroglancer-pending-changes-panel");
    this.addBody(body);

    this.emptyMessageElement = document.createElement("div");
    this.emptyMessageElement.classList.add(
      "neuroglancer-pending-changes-empty",
    );
    this.emptyMessageElement.textContent =
      "No in-memory patches. Paint inside an edit session and Commit to " +
      "queue changes here.";
    body.appendChild(this.emptyMessageElement);

    this.listElement = document.createElement("div");
    this.listElement.classList.add("neuroglancer-pending-changes-list");
    body.appendChild(this.listElement);

    this.globalActionsElement = document.createElement("div");
    this.globalActionsElement.classList.add(
      "neuroglancer-pending-changes-global-actions",
    );
    body.appendChild(this.globalActionsElement);

    this.registerDisposer(
      host.commitTarget.changed.add(() => this.refresh()),
    );
    this.refresh();
  }

  private refresh(): void {
    const layerIds = this.host.commitTarget.pendingLayerIds();

    while (this.listElement.firstChild !== null) {
      this.listElement.removeChild(this.listElement.firstChild);
    }
    while (this.globalActionsElement.firstChild !== null) {
      this.globalActionsElement.removeChild(this.globalActionsElement.firstChild);
    }

    if (layerIds.length === 0) {
      this.emptyMessageElement.style.display = "block";
      return;
    }
    this.emptyMessageElement.style.display = "none";

    for (const layerId of layerIds) {
      this.listElement.appendChild(this.buildLayerRow(layerId));
    }

    const saveAllBtn = document.createElement("button");
    saveAllBtn.type = "button";
    saveAllBtn.classList.add("primary");
    saveAllBtn.textContent = "Save all to backend";
    saveAllBtn.disabled = this.busy;
    saveAllBtn.addEventListener("click", () => {
      void this.runSave(undefined);
    });
    this.globalActionsElement.appendChild(saveAllBtn);

    const resetAllBtn = document.createElement("button");
    resetAllBtn.type = "button";
    resetAllBtn.classList.add("danger");
    resetAllBtn.textContent = "Reset all";
    resetAllBtn.disabled = this.busy;
    resetAllBtn.addEventListener("click", () => {
      this.runReset(undefined);
    });
    this.globalActionsElement.appendChild(resetAllBtn);
  }

  private buildLayerRow(layerId: LayerId): HTMLDivElement {
    const row = document.createElement("div");
    row.classList.add("neuroglancer-pending-changes-row");

    const label = document.createElement("div");
    label.classList.add("neuroglancer-pending-changes-row-label");
    const name = document.createElement("span");
    name.classList.add("neuroglancer-pending-changes-row-name");
    name.textContent = String(layerId);
    label.appendChild(name);
    const count = document.createElement("span");
    count.classList.add("neuroglancer-pending-changes-row-count");
    const chunkCount = this.host.commitTarget.countLayerChunks(layerId);
    count.textContent = `${chunkCount} chunk${chunkCount === 1 ? "" : "s"}`;
    label.appendChild(count);
    row.appendChild(label);

    const actions = document.createElement("div");
    actions.classList.add("neuroglancer-pending-changes-row-actions");

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.textContent = "Save";
    saveBtn.disabled = this.busy;
    saveBtn.addEventListener("click", () => {
      void this.runSave([layerId]);
    });
    actions.appendChild(saveBtn);

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.classList.add("danger");
    resetBtn.textContent = "Reset";
    resetBtn.disabled = this.busy;
    resetBtn.addEventListener("click", () => {
      this.runReset(layerId);
    });
    actions.appendChild(resetBtn);

    row.appendChild(actions);
    return row;
  }

  private runReset(layerId: LayerId | undefined): void {
    const target =
      layerId === undefined ? "all layers" : `layer "${String(layerId)}"`;
    const ok = window.confirm(
      `Discard all in-memory patches for ${target}? This cannot be undone.`,
    );
    if (!ok) return;
    if (layerId === undefined) {
      this.host.resetAllCommitted();
    } else {
      this.host.resetLayer(layerId);
    }
  }

  private async runSave(
    layerIds: readonly LayerId[] | undefined,
  ): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.refresh();
    try {
      const result = await this.host.saveCommitted(layerIds);
      const failed = result.outcomes.filter((o) => o.status === "failed");
      if (failed.length === 0) {
        if (result.outcomes.length === 0) {
          StatusMessage.showTemporaryMessage("Nothing to save.", 3000);
        } else {
          StatusMessage.showTemporaryMessage(
            `Saved ${result.outcomes.length} layer(s) to backend.`,
            4000,
          );
        }
      } else {
        const summary = failed
          .map((o) =>
            o.status === "failed"
              ? `${o.layerId}: ${o.error.message}`
              : "",
          )
          .filter((s) => s.length > 0)
          .join("; ");
        StatusMessage.showTemporaryMessage(
          `Save partially failed: ${summary}`,
          8000,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      StatusMessage.showTemporaryMessage(`Save threw: ${message}`, 8000);
    } finally {
      this.busy = false;
      this.refresh();
    }
  }
}
