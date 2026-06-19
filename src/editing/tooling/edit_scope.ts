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
 * Edit lifecycle owner (TM-315 tooling redesign).
 *
 * The single place that opens, records, discards, and rolls back an `Edit`.
 * Tools express WHAT to write; this owns HOW the edit is managed:
 *  - the one-live-edit invariant (friendlier than the library's
 *    `ConcurrentEditError`, and a guard against integration bugs);
 *  - `runOperation` for one-shot ops (fill): open → fn → record, discard on throw;
 *  - `beginInteraction` for multi-event strokes: open → …writes… → commit | cancel;
 *  - `cancelLive` for activation teardown: roll back any edit left open when a
 *    tool is deactivated mid-stroke, so a half-applied stroke never lingers.
 */

import type { Edit, EditMeta, EditSession } from "@zettaai/edit-session";

/** Handle for a multi-event interaction (a stroke). Exactly one of
 * `commit` / `cancel` finalizes it. */
export interface InteractionHandle {
  /** The live edit — tools call `readChunk` / `withBatch` and apply batches on it. */
  readonly edit: Edit;
  /** Finalize as one undo entry. */
  commit(): void;
  /** Roll back every touched chunk; no undo entry. */
  cancel(): Promise<void>;
}

/**
 * Thrown by {@link EditScope.open} when an edit is already live. This is a
 * benign concurrency race during rapid painting (a new stroke starts a hair
 * before the previous stroke's async commit has settled), NOT an integration
 * bug — so callers downgrade it to a debug log rather than an alarming
 * user-facing error banner. A dedicated class lets the surfacing layer tell it
 * apart from real failures.
 */
export class LiveEditConflictError extends Error {
  readonly isLiveEditConflict = true as const;
  constructor() {
    super(
      "EditScope: an edit is already live; commit/cancel it before opening another",
    );
    this.name = "LiveEditConflictError";
  }
}

/** Type guard for {@link LiveEditConflictError} across module/bundle boundaries. */
export function isLiveEditConflictError(err: unknown): boolean {
  return (
    err instanceof LiveEditConflictError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { isLiveEditConflict?: unknown }).isLiveEditConflict === true)
  );
}

export class EditScope {
  private live: Edit | null = null;

  constructor(private readonly session: EditSession) {}

  /** True while an edit is open (a stroke in progress or an op running). */
  get hasLiveEdit(): boolean {
    return this.live !== null;
  }

  /**
   * Run a one-shot operation (e.g. fill): opens an edit, runs `fn`, records it
   * as one undo entry. Any throw rolls the edit back and re-throws.
   */
  async runOperation(
    meta: EditMeta,
    fn: (edit: Edit) => Promise<void>,
  ): Promise<void> {
    const edit = this.open(meta);
    try {
      await fn(edit);
      edit.record();
    } catch (err) {
      try {
        await edit.discard();
      } catch {
        // discard best-effort; surface the original error
      }
      throw err;
    } finally {
      this.live = null;
    }
  }

  /**
   * Begin a multi-event interaction (a stroke). The caller writes into
   * `handle.edit` across many events, then finalizes with exactly one of
   * `commit()` / `cancel()`.
   */
  beginInteraction(meta: EditMeta): InteractionHandle {
    const edit = this.open(meta);
    return {
      edit,
      commit: () => {
        if (this.live !== edit) return; // already finalized / superseded
        edit.record();
        this.live = null;
      },
      cancel: async () => {
        if (this.live !== edit) return;
        this.live = null;
        await edit.discard();
      },
    };
  }

  /**
   * Roll back any edit left open (tool deactivation / session teardown
   * mid-stroke). No-op when idle.
   */
  async cancelLive(): Promise<void> {
    const edit = this.live;
    if (edit === null) return;
    this.live = null;
    await edit.discard();
  }

  private open(meta: EditMeta): Edit {
    if (this.live !== null) {
      throw new LiveEditConflictError();
    }
    const edit = this.session.beginEdit(meta);
    this.live = edit;
    return edit;
  }
}
