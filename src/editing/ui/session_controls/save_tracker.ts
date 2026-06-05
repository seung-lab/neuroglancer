/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type {
  EditSession,
  LayerId,
  SaveLayerOutcome,
  SaveResult,
} from "@zettaai/edit-session";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { NullarySignal } from "#src/util/signal.js";

export type SaveAllState =
  | { kind: "idle"; lastSavedAt?: number }
  | { kind: "saving"; controller: AbortController }
  | { kind: "done-success"; savedAt: number }
  | { kind: "done-partial"; failedLayers: readonly string[] };

export interface PerLayerSaveStatus {
  readonly layerId: LayerId;
  readonly writable: boolean;
  readonly status: "succeeded" | "failed" | "skipped" | "partial" | "pending";
  readonly detail: string;
}

export class SaveTracker {
  readonly changed = new NullarySignal();

  private state_: SaveAllState = { kind: "idle" };
  private layerStatuses_: Map<string, PerLayerSaveStatus>;
  private saveStartedAt_ = 0;
  private autoClearTimer_: ReturnType<typeof setTimeout> | undefined;

  constructor(host: EditSessionHost, session: EditSession) {
    this.layerStatuses_ = initializeLayerStatuses(host, session);
  }

  get state(): SaveAllState {
    return this.state_;
  }

  get layerStatuses(): ReadonlyMap<string, PerLayerSaveStatus> {
    return this.layerStatuses_;
  }

  async startSave(host: EditSessionHost, session: EditSession): Promise<void> {
    if (this.state_.kind === "saving") return;
    if (!session.dirty.isDirty()) return;

    const controller = new AbortController();
    this.state_ = { kind: "saving", controller };
    this.saveStartedAt_ = Date.now();
    this.markAllWritablePending();
    this.changed.dispatch();

    let result: SaveResult | undefined;
    let thrownError: unknown;
    try {
      result = await host.saveActive(undefined, controller.signal);
    } catch (err) {
      thrownError = err;
    }

    if (thrownError !== undefined) {
      const message =
        thrownError instanceof Error ? thrownError.message : String(thrownError);
      this.applyGlobalFailure(message);
      this.changed.dispatch();
      return;
    }

    if (result === undefined) return;
    this.applySaveResult(result);
    this.changed.dispatch();
  }

  cancel(host: EditSessionHost): void {
    if (this.state_.kind !== "saving") return;
    try {
      this.state_.controller.abort();
    } catch {
      // Aborting an already-settled controller can throw; nothing to recover.
    }
    host.cancelActiveSave();
  }

  dispose(): void {
    if (this.autoClearTimer_ !== undefined) {
      clearTimeout(this.autoClearTimer_);
      this.autoClearTimer_ = undefined;
    }
  }

  private markAllWritablePending(): void {
    const next = new Map(this.layerStatuses_);
    for (const [key, entry] of next) {
      if (!entry.writable) continue;
      next.set(key, { ...entry, status: "pending", detail: "saving…" });
    }
    this.layerStatuses_ = next;
  }

  private applyGlobalFailure(message: string): void {
    const failedIds: string[] = [];
    const next = new Map(this.layerStatuses_);
    for (const [key, entry] of next) {
      if (!entry.writable) continue;
      next.set(key, {
        layerId: entry.layerId,
        writable: true,
        status: "failed",
        detail: message,
      });
      failedIds.push(key);
    }
    this.layerStatuses_ = next;
    this.state_ = { kind: "done-partial", failedLayers: failedIds };
  }

  private applySaveResult(result: SaveResult): void {
    const failedLayers: string[] = [];
    const next = new Map(this.layerStatuses_);
    for (const outcome of result.outcomes) {
      const existing = next.get(outcome.layerId as string);
      const writable = existing?.writable ?? true;
      const status = statusFromOutcome(outcome);
      const detail = detailFromOutcome(outcome, this.saveStartedAt_);
      next.set(outcome.layerId as string, {
        layerId: outcome.layerId,
        writable,
        status,
        detail,
      });
      if (status === "failed") {
        failedLayers.push(outcome.layerId as string);
      }
    }
    this.layerStatuses_ = next;

    if (result.overall === "all-succeeded" && failedLayers.length === 0) {
      const savedAt = Date.now();
      this.state_ = { kind: "done-success", savedAt };
      this.scheduleAutoClear(savedAt);
      return;
    }

    this.state_ = { kind: "done-partial", failedLayers: failedLayers.slice() };
  }

  private scheduleAutoClear(savedAt: number): void {
    if (this.autoClearTimer_ !== undefined) {
      clearTimeout(this.autoClearTimer_);
    }
    this.autoClearTimer_ = setTimeout(() => {
      this.autoClearTimer_ = undefined;
      this.state_ = { kind: "idle", lastSavedAt: savedAt };
      this.changed.dispatch();
    }, 3000);
  }
}

function initializeLayerStatuses(
  host: EditSessionHost,
  session: EditSession,
): Map<string, PerLayerSaveStatus> {
  const statuses = new Map<string, PerLayerSaveStatus>();
  const intent = host.state.value.value;
  const writableByLayer = new Map<string, boolean>();
  if (intent !== null) {
    for (const layer of intent.layers) {
      writableByLayer.set(layer.layerId, layer.writable);
    }
  }
  for (const sel of session.config.layers) {
    const writable = writableByLayer.get(sel.layerId) ?? true;
    if (!writable) {
      statuses.set(sel.layerId as string, {
        layerId: sel.layerId,
        writable,
        status: "skipped",
        detail: "read-only; not saved",
      });
    } else {
      statuses.set(sel.layerId as string, {
        layerId: sel.layerId,
        writable,
        status: "pending",
        detail: "no save yet",
      });
    }
  }
  return statuses;
}

function statusFromOutcome(
  outcome: SaveLayerOutcome,
): PerLayerSaveStatus["status"] {
  if (outcome.status === "succeeded") return "succeeded";
  const code = outcome.error?.code;
  if (code === "save-partial") return "partial";
  if (code === "save-skipped") return "skipped";
  return "failed";
}

function detailFromOutcome(
  outcome: SaveLayerOutcome,
  saveStartedAt: number,
): string {
  if (outcome.status === "succeeded") {
    const seconds = ((Date.now() - saveStartedAt) / 1000).toFixed(1);
    return `succeeded (${seconds}s)`;
  }
  return outcome.error?.message ?? "failed";
}
