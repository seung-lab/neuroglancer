/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import "#src/editing/ui/session_sidebar.css";

import type {
  EditSession,
  HistorySnapshot,
  LayerId,
  SaveLayerOutcome,
  SaveResult,
  SessionError,
} from "@zetta-ai/edit-session";
import { Resolution } from "@zetta-ai/edit-session";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { ToolPanelHost } from "#src/editing/ui/tool_panel_host.js";
import type { SidePanelManager } from "#src/ui/side_panel.js";
import { SidePanel } from "#src/ui/side_panel.js";

// ---------------------------------------------------------------------------
// Tool table — single source of truth for label + hotkey hint display.
//
// Mirrors the v1 hotkey table in
// `docs/edit-session-integration/architecture/05-tools-and-cursor.md` and the
// keybindings installed by `src/editing/session_hotkey_binder.ts`. Keep both
// in sync if hotkeys change.
// ---------------------------------------------------------------------------

interface ToolRow {
  readonly toolId: string;
  readonly label: string;
  readonly hotkey: string;
  /** When true, render a "(disabled)" marker — clicking still activates. */
  readonly markDisabled: boolean;
}

const TOOL_ROWS: readonly ToolRow[] = [
  { toolId: "painting.brush", label: "Brush", hotkey: "B", markDisabled: false },
  { toolId: "painting.erase", label: "Eraser", hotkey: "E", markDisabled: false },
  { toolId: "painting.fill", label: "Fill", hotkey: "F", markDisabled: false },
  {
    toolId: "correspondence",
    label: "Correspondence",
    hotkey: "C",
    markDisabled: true,
  },
  {
    toolId: "z-extrapolation",
    label: "Z-extrapolation",
    hotkey: "Z",
    markDisabled: true,
  },
];

// ---------------------------------------------------------------------------
// Save All state machine
// ---------------------------------------------------------------------------

type SaveAllState =
  | { kind: "idle"; lastSavedAt?: number }
  | { kind: "saving"; controller: AbortController }
  | { kind: "done-success"; savedAt: number }
  | { kind: "done-partial"; failedLayers: readonly string[] };

interface PerLayerSaveStatus {
  readonly layerId: LayerId;
  readonly role: "writable" | "locked";
  readonly status: "succeeded" | "failed" | "skipped" | "partial" | "pending";
  readonly detail: string;
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

/**
 * Single side-panel slot owning the session header, status block, tool list,
 * active tool panel slot, history controls, action buttons, per-layer save
 * status, and error banner. Subscribes to `host.activeSession` for full
 * remount on session swap and to `session.on('active-tool-changed'|
 * 'history-changed'|'error', ...)` for in-session updates.
 *
 * Per `docs/edit-session-integration/architecture/04-ui-shell.md`
 * § "EditSessionSidebar", visibility is owned by
 * `host.editSessionPanelLocation` (toggled by the host on open/teardown);
 * this widget renders its placeholder body when no session is active.
 *
 * Save All implements the v1 state machine (`idle` → `saving` → `done-success`
 * | `done-partial` → `idle`) with `AbortController`-driven cancellation
 * routed through `host.cancelActiveSave()`. Per-layer status rows display
 * the library's `SaveLayerOutcome` shape (`succeeded` / `failed`); richer
 * states (`partial` / `skipped`) surface only through the `pending` flag
 * and the error banner / message text — extending `host.saveActive` to
 * return the richer host-side `SaveBackendResult` is left for a later step.
 */
export class EditSessionSidebar extends SidePanel {
  private readonly host: EditSessionHost;
  private readonly bodyElement: HTMLDivElement;
  private readonly toolPanelHost: ToolPanelHost;

  // Top-level section elements (created once, populated/rerendered on change).
  private readonly statusBlock: HTMLDivElement;
  private readonly toolListElement: HTMLDivElement;
  private readonly historyRowElement: HTMLDivElement;
  private readonly actionRowElement: HTMLDivElement;
  private readonly saveStatusElement: HTMLDivElement;
  private readonly errorBannerElement: HTMLDivElement;
  private readonly layerStatusListElement: HTMLDivElement;

  // Per-section state derived from the active session.
  private boundSession: EditSession | undefined;
  private unsubscribeActiveTool: (() => void) | undefined;
  private unsubscribeHistory: (() => void) | undefined;
  private unsubscribeError: (() => void) | undefined;
  private unsubscribeDirty: (() => void) | undefined;

  // Save All transient state.
  private saveAllState: SaveAllState = { kind: "idle" };
  private layerStatusByLayer = new Map<string, PerLayerSaveStatus>();
  private saveStatusTimer: ReturnType<typeof setTimeout> | undefined;
  private saveStartedAt = 0;

  constructor(sidePanelManager: SidePanelManager, host: EditSessionHost) {
    super(sidePanelManager, host.editSessionPanelLocation);
    this.host = host;

    this.addTitleBar({ title: "Edit Session" });

    this.bodyElement = document.createElement("div");
    this.bodyElement.classList.add("neuroglancer-edit-session-sidebar");
    this.addBody(this.bodyElement);

    // Build static section scaffolding once; renderers below mutate textContent
    // / children on every refresh.
    this.statusBlock = this.makeSection("Session");
    this.toolListElement = this.makeSection("Tools");
    const toolPanelSection = this.makeSection("Tool");
    this.toolPanelHost = this.registerDisposer(new ToolPanelHost(this.host));
    this.toolPanelHost.element.classList.add(
      "neuroglancer-edit-session-tool-panel-slot",
    );
    toolPanelSection.appendChild(this.toolPanelHost.element);

    this.historyRowElement = this.makeSection("History");
    this.actionRowElement = this.makeSection("Actions");

    this.saveStatusElement = document.createElement("div");
    this.saveStatusElement.classList.add("neuroglancer-edit-session-save-status");
    this.bodyElement.appendChild(this.saveStatusElement);

    this.errorBannerElement = document.createElement("div");
    this.errorBannerElement.classList.add(
      "neuroglancer-edit-session-error-banner",
    );
    this.errorBannerElement.style.display = "none";
    this.bodyElement.appendChild(this.errorBannerElement);

    const layerStatusSection = this.makeSection("Save status");
    this.layerStatusListElement = document.createElement("div");
    this.layerStatusListElement.classList.add(
      "neuroglancer-edit-session-layer-status-list",
    );
    layerStatusSection.appendChild(this.layerStatusListElement);

    // React to session lifecycle.
    this.registerDisposer(
      host.activeSession.changed.add(() => this.handleSessionChanged()),
    );
    this.handleSessionChanged();
  }

  /**
   * Override the inherited `close()` behavior. Per `04-ui-shell.md`, the
   * sidebar's close button discards the active session after confirmation
   * rather than merely hiding the panel.
   */
  override close(): void {
    const session = this.host.activeSession.value;
    if (session === undefined) {
      // No active session — just hide the panel.
      super.close();
      return;
    }
    const ok = window.confirm(
      "Close edit session? All unsaved edits will be discarded.",
    );
    if (!ok) return;
    void this.host.discardActive().catch(() => {
      // The host displays its own status; nothing further to do here.
    });
  }

  override disposed(): void {
    this.detachSession();
    if (this.saveStatusTimer !== undefined) {
      clearTimeout(this.saveStatusTimer);
      this.saveStatusTimer = undefined;
    }
    super.disposed();
  }

  // -- Section scaffolding helper -----------------------------------------

  private makeSection(title: string): HTMLDivElement {
    const section = document.createElement("div");
    section.classList.add("neuroglancer-edit-session-section");
    const titleEl = document.createElement("div");
    titleEl.classList.add("neuroglancer-edit-session-section-title");
    titleEl.textContent = title;
    section.appendChild(titleEl);
    this.bodyElement.appendChild(section);
    return section;
  }

  // -- Session lifecycle --------------------------------------------------

  private handleSessionChanged(): void {
    const session = this.host.activeSession.value;
    if (session === this.boundSession) return;
    this.detachSession();
    if (session === undefined) {
      this.renderEmpty();
      return;
    }
    this.boundSession = session;
    this.unsubscribeActiveTool = session.on("active-tool-changed", () => {
      this.renderToolList();
    });
    this.unsubscribeHistory = session.on("history-changed", () => {
      this.renderHistoryRow();
    });
    this.unsubscribeError = session.on("error", (err) => {
      this.showErrorFromSession(err);
    });
    this.unsubscribeDirty = session.dirty.on("dirty-changed", () => {
      this.renderActionRow();
    });
    this.initializeLayerStatuses();
    this.renderAll();
  }

  private detachSession(): void {
    for (const unsubscribe of [
      this.unsubscribeActiveTool,
      this.unsubscribeHistory,
      this.unsubscribeError,
      this.unsubscribeDirty,
    ]) {
      if (unsubscribe !== undefined) {
        try {
          unsubscribe();
        } catch {
          // best-effort
        }
      }
    }
    this.unsubscribeActiveTool = undefined;
    this.unsubscribeHistory = undefined;
    this.unsubscribeError = undefined;
    this.unsubscribeDirty = undefined;
    this.boundSession = undefined;
    this.saveAllState = { kind: "idle" };
    this.layerStatusByLayer.clear();
  }

  // -- Empty-state render --------------------------------------------------

  private renderEmpty(): void {
    clearChildren(this.statusBlock, /*keepTitle=*/ true);
    clearChildren(this.toolListElement, /*keepTitle=*/ true);
    clearChildren(this.historyRowElement, /*keepTitle=*/ true);
    clearChildren(this.actionRowElement, /*keepTitle=*/ true);
    clearChildren(this.layerStatusListElement);
    this.saveStatusElement.textContent = "";
    this.hideErrorBanner();
    const empty = document.createElement("div");
    empty.classList.add("neuroglancer-edit-session-status-row");
    empty.textContent = "No active session.";
    this.statusBlock.appendChild(empty);
  }

  // -- Full render --------------------------------------------------------

  private renderAll(): void {
    this.renderStatusBlock();
    this.renderToolList();
    this.renderHistoryRow();
    this.renderActionRow();
    this.renderLayerStatusList();
    this.renderSaveStatusText();
  }

  // -- Status block -------------------------------------------------------

  private renderStatusBlock(): void {
    clearChildren(this.statusBlock, /*keepTitle=*/ true);
    const session = this.boundSession;
    if (session === undefined) return;

    const region = session.config.region;
    const bbox = region.bbox;
    const w = Math.max(0, bbox[3] - bbox[0]);
    const h = Math.max(0, bbox[4] - bbox[1]);
    const d = Math.max(0, bbox[5] - bbox[2]);
    const voxelSizeNm = Resolution.toVoxelSize(region.resolution);
    const regionRow = document.createElement("div");
    regionRow.classList.add("neuroglancer-edit-session-status-row");
    regionRow.textContent =
      `Region: ${w}x${h}x${d} @ ` +
      `${formatNm(voxelSizeNm[0])}x` +
      `${formatNm(voxelSizeNm[1])}x` +
      `${formatNm(voxelSizeNm[2])}nm`;
    this.statusBlock.appendChild(regionRow);

    const layersRow = document.createElement("div");
    layersRow.classList.add("neuroglancer-edit-session-status-row");
    const intent = this.host.state.value.value;
    const roleByLayer = new Map<string, "writable" | "locked">();
    if (intent !== null) {
      for (const layer of intent.layers) {
        roleByLayer.set(layer.layerId, layer.role);
      }
    }
    const parts = session.config.layers.map((sel) => {
      const role = roleByLayer.get(sel.layerId) ?? "writable";
      const flag = role === "writable" ? "w" : "r";
      return `${sel.layerId} (${flag})`;
    });
    layersRow.textContent = `Layers: ${parts.join(", ")}`;
    this.statusBlock.appendChild(layersRow);
  }

  // -- Tool list ----------------------------------------------------------

  private renderToolList(): void {
    clearChildren(this.toolListElement, /*keepTitle=*/ true);
    const session = this.boundSession;
    if (session === undefined) return;
    const knownToolIds = new Set(session.tools.toolIds);
    const activeToolId = session.tools.getActiveToolId();
    for (const row of TOOL_ROWS) {
      // Skip rows whose tool isn't registered on this session (defensive —
      // the host registers all v1 tools by default).
      if (!knownToolIds.has(row.toolId)) continue;
      const rowEl = document.createElement("div");
      rowEl.classList.add("neuroglancer-edit-session-tool-row");
      if (row.toolId === activeToolId) rowEl.classList.add("active");
      if (row.markDisabled) rowEl.classList.add("disabled");
      const radio = document.createElement("span");
      radio.classList.add("neuroglancer-edit-session-tool-radio");
      rowEl.appendChild(radio);
      const label = document.createElement("span");
      label.classList.add("neuroglancer-edit-session-tool-label");
      label.textContent = row.label;
      if (row.markDisabled) {
        const marker = document.createElement("span");
        marker.classList.add("neuroglancer-edit-session-tool-disabled-marker");
        marker.textContent = "(disabled)";
        label.appendChild(marker);
      }
      rowEl.appendChild(label);
      const hotkey = document.createElement("span");
      hotkey.classList.add("neuroglancer-edit-session-tool-hotkey");
      hotkey.textContent = `[${row.hotkey}]`;
      rowEl.appendChild(hotkey);
      rowEl.addEventListener("click", () => {
        const current = this.boundSession;
        if (current === undefined) return;
        try {
          current.setActiveTool(row.toolId);
        } catch (err) {
          this.showErrorMessage(
            err instanceof Error ? err.message : String(err),
          );
        }
      });
      this.toolListElement.appendChild(rowEl);
    }
  }

  // -- History row --------------------------------------------------------

  private renderHistoryRow(): void {
    clearChildren(this.historyRowElement, /*keepTitle=*/ true);
    const session = this.boundSession;
    if (session === undefined) return;
    const snapshot: HistorySnapshot = session.getHistory();
    const row = document.createElement("div");
    row.classList.add("neuroglancer-edit-session-history-row");
    const undoBtn = document.createElement("button");
    undoBtn.type = "button";
    undoBtn.textContent = "Undo";
    undoBtn.disabled = !snapshot.canUndo;
    if (snapshot.undoDescription !== undefined) {
      undoBtn.title = snapshot.undoDescription;
    }
    undoBtn.addEventListener("click", () => {
      void this.runUndo();
    });
    row.appendChild(undoBtn);
    const undoHint = document.createElement("span");
    undoHint.classList.add("neuroglancer-edit-session-history-hint");
    undoHint.textContent = "(Ctrl+Z)";
    row.appendChild(undoHint);

    const redoBtn = document.createElement("button");
    redoBtn.type = "button";
    redoBtn.textContent = "Redo";
    redoBtn.disabled = !snapshot.canRedo;
    if (snapshot.redoDescription !== undefined) {
      redoBtn.title = snapshot.redoDescription;
    }
    redoBtn.addEventListener("click", () => {
      void this.runRedo();
    });
    row.appendChild(redoBtn);
    const redoHint = document.createElement("span");
    redoHint.classList.add("neuroglancer-edit-session-history-hint");
    redoHint.textContent = "(Ctrl+Shift+Z)";
    row.appendChild(redoHint);

    const count = document.createElement("span");
    count.classList.add("neuroglancer-edit-session-history-count");
    const total = countEntries(snapshot);
    count.textContent = `${total} ${total === 1 ? "entry" : "entries"}`;
    row.appendChild(count);

    this.historyRowElement.appendChild(row);
  }

  private async runUndo(): Promise<void> {
    const session = this.boundSession;
    if (session === undefined) return;
    try {
      await session.undo();
    } catch (err) {
      this.showErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  private async runRedo(): Promise<void> {
    const session = this.boundSession;
    if (session === undefined) return;
    try {
      await session.redo();
    } catch (err) {
      this.showErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  // -- Action row ---------------------------------------------------------

  private renderActionRow(): void {
    clearChildren(this.actionRowElement, /*keepTitle=*/ true);
    const session = this.boundSession;
    if (session === undefined) return;
    const row = document.createElement("div");
    row.classList.add("neuroglancer-edit-session-action-row");
    const isSaving = this.saveAllState.kind === "saving";
    const hasDirty = isSessionDirty(session);

    const commitBtn = document.createElement("button");
    commitBtn.type = "button";
    commitBtn.textContent = "Commit";
    commitBtn.disabled = !hasDirty || isSaving;
    commitBtn.addEventListener("click", () => {
      void this.runCommit();
    });
    row.appendChild(commitBtn);

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    if (isSaving) {
      saveBtn.textContent = "Cancel";
      saveBtn.classList.add("saving");
      saveBtn.disabled = false;
      saveBtn.addEventListener("click", () => this.cancelSaveAll());
    } else {
      saveBtn.textContent = "Save All";
      saveBtn.disabled = !hasDirty;
      saveBtn.addEventListener("click", () => {
        void this.startSaveAll();
      });
    }
    row.appendChild(saveBtn);

    const discardBtn = document.createElement("button");
    discardBtn.type = "button";
    discardBtn.textContent = "Discard";
    discardBtn.classList.add("danger");
    discardBtn.disabled = isSaving;
    discardBtn.addEventListener("click", () => {
      void this.runDiscard();
    });
    row.appendChild(discardBtn);

    this.actionRowElement.appendChild(row);
  }

  private async runCommit(): Promise<void> {
    const session = this.boundSession;
    if (session === undefined) return;
    if (!isSessionDirty(session)) return;
    const ok = window.confirm(
      "Commit all session edits? This will end the session.",
    );
    if (!ok) return;
    try {
      await this.host.commitActive();
    } catch (err) {
      this.showErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  private async runDiscard(): Promise<void> {
    const session = this.boundSession;
    if (session === undefined) return;
    const ok = window.confirm(
      "Discard all session edits? This cannot be undone.",
    );
    if (!ok) return;
    try {
      await this.host.discardActive();
    } catch (err) {
      this.showErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  // -- Save All state machine ---------------------------------------------

  private async startSaveAll(): Promise<void> {
    const session = this.boundSession;
    if (session === undefined) return;
    if (this.saveAllState.kind === "saving") return;
    if (!isSessionDirty(session)) return;

    this.hideErrorBanner();
    const controller = new AbortController();
    this.saveAllState = { kind: "saving", controller };
    this.saveStartedAt = Date.now();
    this.markAllWritableLayersPending();
    this.renderActionRow();
    this.renderLayerStatusList();
    this.saveStatusElement.textContent = "Saving…";
    this.saveStatusElement.classList.remove("success", "warning");

    let result: SaveResult | undefined;
    let thrownError: unknown;
    try {
      result = await this.host.saveActive(undefined, controller.signal);
    } catch (err) {
      thrownError = err;
    }

    // The session may have ended between the call and the resolution; bail
    // out gracefully if so.
    if (this.boundSession === undefined) return;

    if (thrownError !== undefined) {
      this.saveAllState = {
        kind: "done-partial",
        failedLayers: this.writableLayerIds(),
      };
      const message =
        thrownError instanceof Error
          ? thrownError.message
          : String(thrownError);
      this.showErrorMessage(`Save failed: ${message}`);
      // Mark every writable layer as failed so the user sees the breakdown.
      for (const layerId of this.writableLayerIds()) {
        this.layerStatusByLayer.set(layerId, {
          layerId: layerId as LayerId,
          role: "writable",
          status: "failed",
          detail: message,
        });
      }
      this.renderActionRow();
      this.renderLayerStatusList();
      this.renderSaveStatusText();
      return;
    }

    if (result === undefined) return; // Defensive; should not happen.
    this.applySaveResult(result);
  }

  private cancelSaveAll(): void {
    if (this.saveAllState.kind !== "saving") return;
    try {
      this.saveAllState.controller.abort();
    } catch {
      // ignore
    }
    this.host.cancelActiveSave();
  }

  private applySaveResult(result: SaveResult): void {
    const failedLayers: string[] = [];
    for (const outcome of result.outcomes) {
      const role = this.roleForLayer(outcome.layerId);
      const status = this.statusFromOutcome(outcome);
      const detail = this.detailFromOutcome(outcome);
      this.layerStatusByLayer.set(outcome.layerId as string, {
        layerId: outcome.layerId,
        role,
        status,
        detail,
      });
      if (status === "failed") {
        failedLayers.push(outcome.layerId);
      }
    }

    if (result.overall === "all-succeeded" && failedLayers.length === 0) {
      const savedAt = Date.now();
      this.saveAllState = { kind: "done-success", savedAt };
      this.renderActionRow();
      this.renderLayerStatusList();
      this.renderSaveStatusText();
      if (this.saveStatusTimer !== undefined) clearTimeout(this.saveStatusTimer);
      this.saveStatusTimer = setTimeout(() => {
        this.saveStatusTimer = undefined;
        // After 3s, return to idle but keep per-layer rows visible.
        this.saveAllState = { kind: "idle", lastSavedAt: savedAt };
        if (this.boundSession === undefined) return;
        this.renderActionRow();
        this.renderSaveStatusText();
      }, 3000);
      return;
    }

    this.saveAllState = {
      kind: "done-partial",
      failedLayers: failedLayers.slice(),
    };
    if (failedLayers.length > 0) {
      this.showErrorMessage(
        `Some layers failed to save: ${failedLayers.join(", ")}`,
      );
    }
    this.renderActionRow();
    this.renderLayerStatusList();
    this.renderSaveStatusText();
  }

  // -- Per-layer save status helpers --------------------------------------

  /**
   * Seed `layerStatusByLayer` with a row per known layer so the section is
   * never empty (even before the first save).
   */
  private initializeLayerStatuses(): void {
    this.layerStatusByLayer.clear();
    const intent = this.host.state.value.value;
    const session = this.boundSession;
    if (session === undefined) return;
    const roleByLayer = new Map<string, "writable" | "locked">();
    if (intent !== null) {
      for (const layer of intent.layers) {
        roleByLayer.set(layer.layerId, layer.role);
      }
    }
    for (const sel of session.config.layers) {
      const role = roleByLayer.get(sel.layerId) ?? "writable";
      if (role === "locked") {
        this.layerStatusByLayer.set(sel.layerId as string, {
          layerId: sel.layerId,
          role,
          status: "skipped",
          detail: "read-only; not saved",
        });
      } else {
        this.layerStatusByLayer.set(sel.layerId as string, {
          layerId: sel.layerId,
          role,
          status: "pending",
          detail: "no save yet",
        });
      }
    }
  }

  private markAllWritableLayersPending(): void {
    for (const [key, entry] of this.layerStatusByLayer) {
      if (entry.role !== "writable") continue;
      this.layerStatusByLayer.set(key, {
        ...entry,
        status: "pending",
        detail: "saving…",
      });
    }
  }

  private writableLayerIds(): string[] {
    const ids: string[] = [];
    for (const entry of this.layerStatusByLayer.values()) {
      if (entry.role === "writable") ids.push(entry.layerId as string);
    }
    return ids;
  }

  private roleForLayer(layerId: LayerId): "writable" | "locked" {
    const existing = this.layerStatusByLayer.get(layerId as string);
    return existing?.role ?? "writable";
  }

  /**
   * Map the library's `SaveLayerOutcome` (`succeeded | failed`) onto the
   * UI's richer status set. The host-side `NgSaveTarget` collapses
   * `partial` and `skipped` into `failed`, but its `SessionError.code`
   * preserves the distinction (`save-partial` / `save-skipped` /
   * `save-failed`) — read it here to render the dot accordingly.
   */
  private statusFromOutcome(
    outcome: SaveLayerOutcome,
  ): PerLayerSaveStatus["status"] {
    if (outcome.status === "succeeded") return "succeeded";
    const code = outcome.error?.code;
    if (code === "save-partial") return "partial";
    if (code === "save-skipped") return "skipped";
    return "failed";
  }

  private detailFromOutcome(outcome: SaveLayerOutcome): string {
    if (outcome.status === "succeeded") {
      const seconds = ((Date.now() - this.saveStartedAt) / 1000).toFixed(1);
      return `succeeded (${seconds}s)`;
    }
    return outcome.error?.message ?? "failed";
  }

  // -- Layer status list rendering ----------------------------------------

  private renderLayerStatusList(): void {
    clearChildren(this.layerStatusListElement);
    for (const entry of this.layerStatusByLayer.values()) {
      const row = document.createElement("div");
      row.classList.add("neuroglancer-edit-session-layer-status");
      row.classList.add(entry.status);
      if (entry.role === "locked") row.classList.add("locked");
      const dot = document.createElement("span");
      dot.classList.add("neuroglancer-edit-session-layer-status-dot");
      row.appendChild(dot);
      const text = document.createElement("div");
      const name = document.createElement("div");
      name.classList.add("neuroglancer-edit-session-layer-status-name");
      name.textContent = entry.layerId as string;
      text.appendChild(name);
      const detail = document.createElement("div");
      detail.classList.add("neuroglancer-edit-session-layer-status-detail");
      detail.textContent = entry.detail;
      text.appendChild(detail);
      row.appendChild(text);
      this.layerStatusListElement.appendChild(row);
    }
  }

  // -- Save-status text line ----------------------------------------------

  private renderSaveStatusText(): void {
    const state = this.saveAllState;
    this.saveStatusElement.classList.remove("success", "warning");
    if (state.kind === "saving") {
      this.saveStatusElement.textContent = "Saving…";
    } else if (state.kind === "done-success") {
      this.saveStatusElement.textContent = `Saved at ${formatTime(state.savedAt)}`;
      this.saveStatusElement.classList.add("success");
    } else if (state.kind === "done-partial") {
      this.saveStatusElement.textContent =
        state.failedLayers.length > 0
          ? `Failed: ${state.failedLayers.join(", ")}`
          : "Save failed.";
      this.saveStatusElement.classList.add("warning");
    } else if (state.kind === "idle" && state.lastSavedAt !== undefined) {
      this.saveStatusElement.textContent = `Last saved at ${formatTime(state.lastSavedAt)}`;
    } else {
      this.saveStatusElement.textContent = "";
    }
  }

  // -- Error banner -------------------------------------------------------

  private showErrorMessage(message: string): void {
    this.errorBannerElement.textContent = message;
    this.errorBannerElement.style.display = "block";
  }

  private showErrorFromSession(err: SessionError): void {
    if (err.kind === "fatal") {
      this.showErrorMessage(`Session error: ${err.message}`);
    } else {
      this.showErrorMessage(err.message);
    }
  }

  private hideErrorBanner(): void {
    this.errorBannerElement.textContent = "";
    this.errorBannerElement.style.display = "none";
  }
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function isSessionDirty(session: EditSession): boolean {
  return session.dirty.isDirty();
}

function clearChildren(el: HTMLElement, keepTitle = false): void {
  let first = el.firstChild;
  if (keepTitle && first !== null) first = first.nextSibling;
  while (first !== null) {
    const next = first.nextSibling;
    el.removeChild(first);
    first = next;
  }
}

function countEntries(snapshot: HistorySnapshot): number {
  // The library does not expose an `entries` count on the snapshot — we use
  // `canUndo`/`canRedo` as a coarse signal that "something exists" and
  // surface the underlying journal's depths via private fields would be
  // brittle. For v1, approximate total entries with `0 | 1 | 2+` based on
  // availability — the architecture spec calls for a counter (`3 entries`),
  // and a follow-up step will expose `undoDepth + redoDepth` on the public
  // surface.
  if (snapshot.canUndo && snapshot.canRedo) return 2;
  if (snapshot.canUndo || snapshot.canRedo) return 1;
  return 0;
}

function formatNm(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Math.abs(value - Math.round(value)) < 1e-6) {
    return String(Math.round(value));
  }
  return value.toFixed(2);
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
