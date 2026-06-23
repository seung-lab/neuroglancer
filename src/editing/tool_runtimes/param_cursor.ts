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
 * @file Keyboard parameter cursor for the paint tool panels (TM-337).
 *
 * The Ctrl+Arrow keyboard scheme lets the user select a tool-panel parameter
 * and nudge it without leaving the canvas. To keep the cycle order in lock-step
 * with what the panel actually renders — so any future parameter added to the
 * panel automatically joins the rotation and disabled rows are skipped — the
 * panel is the source of truth: on each render it *publishes* an ordered list of
 * {@link ParamDescriptor}s (render order, enabled controls only) into this
 * cursor, and the session hotkey binder *consumes* it.
 *
 * This module is framework-free (no Preact, no DOM) so it can live alongside the
 * other consumer-owned paint runtime state and be reached by both the React
 * panels (publish) and the non-React `EditSessionHotkeyBinder` (consume).
 */

import { NullarySignal } from "#src/util/signal.js";

/** What a descriptor represents, which decides how `adjust` behaves. */
export type ParamKind = "number" | "enum" | "boolean";

/**
 * One adjustable tool-panel parameter, published by the active tool's settings
 * panel. The closures (`format` / `adjust`) capture the panel's current state,
 * so they are rebuilt on every render — the cursor always invokes the latest
 * published descriptor. `id` is a stable key (used for the selection cursor and
 * the panel's selected-row highlight); it must be unique within a published
 * list and stable across renders so the selection survives re-publishes.
 */
export interface ParamDescriptor {
  readonly id: string;
  /** Human label for the status readout + highlight (e.g. "Size"). */
  readonly label: string;
  readonly kind: ParamKind;
  /** Display string for the current value (e.g. "17", a layer name, "On"). */
  format(): string;
  /**
   * Apply a change in direction `dir` (+1 increment / -1 decrement). For
   * `number` params, `magnitude` is the number of unit steps to apply this
   * tick (>= 1) — this is what the hold-to-accelerate ramp drives. `enum`
   * params move one option per call and `boolean` params toggle, both ignoring
   * `magnitude`.
   */
  adjust(dir: number, magnitude: number): void;
}

/**
 * Build a numeric descriptor. `apply` receives the signed number of unit steps
 * to apply (direction already folded in), so the panel keeps its own stepping
 * rule (preset cycle, ±1 + dtype clamp, threshold clamp, …).
 */
export function numberDescriptor(opts: {
  id: string;
  label: string;
  format: () => string;
  apply: (signedSteps: number) => void;
}): ParamDescriptor {
  return {
    id: opts.id,
    label: opts.label,
    kind: "number",
    format: opts.format,
    adjust: (dir, magnitude) => {
      const steps = Math.sign(dir) * Math.max(1, Math.round(magnitude));
      if (steps !== 0) opts.apply(steps);
    },
  };
}

/**
 * Build an enum descriptor over `options`. The `options`/`index` getters are
 * read live (so the status readout reflects the post-change value, which the
 * binder queries synchronously right after `adjust`). Ctrl+Up/Down moves one
 * option toward the requested direction and clamps at both ends (no wrap), so a
 * layer picker doesn't jump from the last layer back to the first.
 */
export function enumDescriptor(opts: {
  id: string;
  label: string;
  options: () => readonly string[];
  /** Index of the current option, or -1 when none is selected. */
  index: () => number;
  select: (index: number) => void;
  /** Optional display override; defaults to the raw option string. */
  format?: (option: string) => string;
}): ParamDescriptor {
  return {
    id: opts.id,
    label: opts.label,
    kind: "enum",
    format: () => {
      const o = opts.options()[opts.index()];
      if (o === undefined) return "—";
      return opts.format !== undefined ? opts.format(o) : o;
    },
    adjust: (dir) => {
      const options = opts.options();
      const n = options.length;
      if (n === 0) return;
      const i = opts.index();
      const cur = i < 0 ? 0 : i;
      const next = Math.max(0, Math.min(n - 1, cur + Math.sign(dir)));
      if (next !== i) opts.select(next);
    },
  };
}

/**
 * Build a boolean descriptor. `value` is read live (see {@link enumDescriptor}).
 * Ctrl+Up sets it on, Ctrl+Down sets it off (rather than a blind toggle), so the
 * direction maps to a predictable end state.
 */
export function booleanDescriptor(opts: {
  id: string;
  label: string;
  value: () => boolean;
  set: (value: boolean) => void;
  onText?: string;
  offText?: string;
}): ParamDescriptor {
  return {
    id: opts.id,
    label: opts.label,
    kind: "boolean",
    format: () =>
      opts.value() ? (opts.onText ?? "On") : (opts.offText ?? "Off"),
    adjust: (dir) => {
      const next = dir > 0;
      if (next !== opts.value()) opts.set(next);
    },
  };
}

/**
 * Holds the published parameter list and the selection cursor. One instance per
 * session lives on `ConsumerPaintingTools`; the active paint tool's panel keeps
 * it populated and the hotkey binder drives the selection + value changes.
 */
export class PaintParamCursor {
  readonly changed = new NullarySignal();
  private descriptors: readonly ParamDescriptor[] = [];
  private selectedId: string | undefined;

  getDescriptors(): readonly ParamDescriptor[] {
    return this.descriptors;
  }

  getSelectedId(): string | undefined {
    return this.selectedId;
  }

  /** The currently-selected descriptor, or `undefined` if none. */
  selected(): ParamDescriptor | undefined {
    if (this.selectedId === undefined) return undefined;
    return this.descriptors.find((d) => d.id === this.selectedId);
  }

  /**
   * Replace the published descriptor list. Called by the active tool's panel on
   * each render with freshly-captured closures, so the stored list is ALWAYS
   * replaced; `changed` is dispatched only when the set of ids or the selection
   * actually changed, so a re-publish that merely refreshes closures does not
   * trigger a (potentially looping) re-render of the panel highlight.
   *
   * Selection reconciliation: keep the same id when it still exists; otherwise
   * clamp the previous index into the new list; default to the first entry when
   * nothing was selected; clear when the list is empty.
   */
  publish(descriptors: readonly ParamDescriptor[]): void {
    const prevId = this.selectedId;
    const prevIndex = this.descriptors.findIndex((d) => d.id === prevId);
    const idsChanged =
      descriptors.length !== this.descriptors.length ||
      descriptors.some((d, i) => d.id !== this.descriptors[i]?.id);

    let nextId: string | undefined;
    if (descriptors.length === 0) {
      nextId = undefined;
    } else if (
      prevId !== undefined &&
      descriptors.some((d) => d.id === prevId)
    ) {
      nextId = prevId;
    } else if (prevIndex >= 0) {
      nextId = descriptors[Math.min(prevIndex, descriptors.length - 1)].id;
    } else {
      nextId = descriptors[0].id;
    }

    this.descriptors = descriptors;
    if (nextId !== this.selectedId || idsChanged) {
      this.selectedId = nextId;
      this.changed.dispatch();
    }
  }

  /**
   * Select a specific parameter by id, e.g. when the user clicks or focuses its
   * control in the panel so the Ctrl+Arrow scheme follows the touched field
   * (TM-345). No-ops when the id is already selected or isn't a currently
   * published (adjustable) descriptor, so interacting with a disabled row never
   * moves the cursor onto a parameter the keyboard can't change.
   */
  select(id: string): void {
    if (id === this.selectedId) return;
    if (!this.descriptors.some((d) => d.id === id)) return;
    this.selectedId = id;
    this.changed.dispatch();
  }

  /**
   * Move the selection cursor by `dir` (+1 next / -1 prev), wrapping at both
   * ends. When nothing is selected yet, selects the first entry regardless of
   * direction. Returns the newly-selected descriptor (or `undefined` if the
   * list is empty).
   */
  moveSelection(dir: number): ParamDescriptor | undefined {
    const n = this.descriptors.length;
    if (n === 0) {
      if (this.selectedId !== undefined) {
        this.selectedId = undefined;
        this.changed.dispatch();
      }
      return undefined;
    }
    const cur = this.descriptors.findIndex((d) => d.id === this.selectedId);
    let next: number;
    if (cur < 0) {
      next = 0;
    } else {
      const step = Math.sign(dir) || 1;
      next = (((cur + step) % n) + n) % n;
    }
    this.selectedId = this.descriptors[next].id;
    this.changed.dispatch();
    return this.descriptors[next];
  }

  /**
   * Ensure something is selected (defaulting to the first entry) and return it.
   * Used when a value-change hotkey fires before the user has moved the cursor.
   */
  ensureSelection(): ParamDescriptor | undefined {
    if (this.descriptors.length === 0) {
      this.selectedId = undefined;
      return undefined;
    }
    if (this.selected() === undefined) {
      this.selectedId = this.descriptors[0].id;
      this.changed.dispatch();
    }
    return this.selected();
  }
}
