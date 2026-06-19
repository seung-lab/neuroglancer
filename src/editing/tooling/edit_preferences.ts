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
 * `editPreferences` — the **out-of-session-lifecycle state of edit-session
 * components** (TM-336). Unlike `editSession` (which describes one concrete
 * open session and is nulled on teardown), this block persists the last-used
 * choices of everything that lives *outside* a single session's lifecycle, so
 * the next session can be seeded with them. It is the source for:
 *
 *   - autofilling the resolution picker in the enter-edit-session modal
 *     (`resolutions`), and
 *   - seeding brush / active-tool / keybind defaults at session open
 *     (`tooling`).
 *
 * Nothing here is ever trusted as ground truth: every value is re-validated
 * against fresh layer metadata when consumed (a remembered resolution missing
 * from the freshly-computed `availableResolutions` is dropped; a stale tool
 * binding is dropped by `paintingPatchFromPersist`). So no stale/cached data
 * can surface and no conflict detection is required — the modal output stays
 * the source of truth for the actual open.
 */

import type { Resolution as ResolutionType } from "@zettaai/edit-session";

import type { ToolingPersistState } from "#src/editing/tooling/tooling_persist.js";
import { parseTooling } from "#src/editing/tooling/tooling_persist.js";
import { WatchableValue } from "#src/trackable_value.js";
import { NullarySignal } from "#src/util/signal.js";
import type { Trackable } from "#src/util/trackable.js";

export interface EditPreferences {
  /**
   * Last-used resolution selection, keyed per `layerId`. The value is a list
   * (architected for multi-resolution-per-layer, TM-336) even though today the
   * modal selects exactly one resolution per layer. Re-validated against fresh
   * `availableResolutions` at modal open; stale entries are dropped and an
   * empty result falls back to the modal default.
   */
  readonly resolutions?: {
    readonly [layerId: string]: readonly ResolutionType[];
  };
  /**
   * Cross-session tool state: painting family config + active tool id +
   * per-user keybind overrides. Same shape as `editSession.tooling`, but
   * survives session teardown so an open → close → open flow keeps the user's
   * tool setup.
   */
  readonly tooling?: ToolingPersistState;
}

/**
 * Trackable wrapping the `editPreferences` block on `ngState`. The value is
 * `null` until the user has opened at least one session. Deliberately NOT
 * cleared on session teardown — that is the whole point of the block.
 */
export class TrackableEditPreferences implements Trackable {
  readonly value = new WatchableValue<EditPreferences | null>(null);
  readonly changed = new NullarySignal();

  constructor() {
    this.value.changed.add(this.changed.dispatch);
  }

  toJSON(): EditPreferences | null {
    return this.value.value;
  }

  restoreState(x: unknown): void {
    try {
      this.value.value = parseEditPreferences(x);
    } catch {
      this.reset();
    }
  }

  reset(): void {
    this.value.value = null;
  }
}

/**
 * Resolve the entry-modal autofill for one layer (TM-336): the remembered
 * resolutions intersected with what the layer currently offers, in `available`
 * order (matching the picker's normalization). Returns `undefined` when nothing
 * survives — the caller then keeps the modal default (highest resolution)
 * rather than autofilling an empty, un-submittable selection. This is the
 * re-validation that makes memoized resolutions safe against stale data.
 */
export function validateRememberedResolutions(
  remembered: readonly ResolutionType[] | undefined,
  available: readonly ResolutionType[],
): readonly ResolutionType[] | undefined {
  if (remembered === undefined) return undefined;
  const wanted = new Set(remembered);
  const kept = available.filter((r) => wanted.has(r));
  return kept.length > 0 ? kept : undefined;
}

/** Parse the per-layer resolution map. Tolerant: skips malformed entries. */
function parseResolutions(
  x: unknown,
): { [layerId: string]: readonly ResolutionType[] } | undefined {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return undefined;
  const out: { [layerId: string]: readonly ResolutionType[] } = {};
  for (const [layerId, raw] of Object.entries(x as Record<string, unknown>)) {
    if (!Array.isArray(raw)) continue;
    const resolutions = raw.filter(
      (r): r is ResolutionType => typeof r === "string",
    );
    if (resolutions.length > 0) out[layerId] = resolutions;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Parse a persisted `editPreferences` block. Tolerant: a malformed sub-block is
 * dropped rather than discarding the whole thing. Returns `null` when there is
 * nothing usable.
 */
export function parseEditPreferences(x: unknown): EditPreferences | null {
  if (x === null || x === undefined) return null;
  if (typeof x !== "object") throw new Error("not-an-object");
  const obj = x as Record<string, unknown>;
  const resolutions = parseResolutions(obj.resolutions);
  const tooling = parseTooling(obj.tooling);
  if (resolutions === undefined && tooling === undefined) return null;
  return {
    ...(resolutions !== undefined ? { resolutions } : {}),
    ...(tooling !== undefined ? { tooling } : {}),
  };
}
