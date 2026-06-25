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
 * Serialization of consumer tool state for the persisted `editSession` block
 * (TM-315, decision C). Captures the active tool id + the painting family
 * config (size, value, erase value, mask, target binding) so a reload restores
 * the user's tool setup. Lives separately from the host so the encode/parse
 * round-trip is unit-testable in isolation.
 *
 * `activeValue` / `eraseValue` are `number | bigint` (segment ids). JSON has no
 * bigint, so they are stored type-tagged and decoded back to the original kind.
 * Everything else in the mask/config is already JSON-safe (numbers, strings,
 * booleans). Parsing is intentionally tolerant: any malformed field drops the
 * whole tooling block (the session still restores, tools fall back to
 * defaults).
 */

import type { LayerId, Resolution } from "@zettaai/edit-session";

import type {
  FillMode,
  PaintingMaskConfig,
} from "#src/editing/tool_runtimes/paint_types.js";
import { DEFAULT_COVERAGE_THRESHOLD } from "#src/editing/tool_runtimes/paint_types.js";
import type { PaintingSharedState } from "#src/editing/tool_runtimes/painting_tools.js";

/** Type-tagged numeric/bigint value, JSON-safe. */
type SerializedValue =
  | { readonly t: "n"; readonly v: number }
  | { readonly t: "b"; readonly v: string };

interface SerializedPainting {
  readonly targetLayerId: string;
  readonly targetResolution: string;
  readonly radius: number;
  readonly activeValue: SerializedValue;
  readonly eraseValue: SerializedValue;
  readonly mask: PaintingMaskConfig | null;
  /** Fill connectivity mode (TM-269). Optional: older blocks default to 2D. */
  readonly fillMode?: FillMode;
}

/** Coerce an unknown to a `FillMode`, defaulting to `"2d"` (the app default). */
function parseFillMode(x: unknown): FillMode {
  return x === "3d" ? "3d" : "2d";
}

/** Per-user edit-hotkey overrides: friendly action name → key identifier(s). */
export type EditKeybindOverrides = {
  readonly [name: string]: readonly string[];
};

export interface ToolingPersistState {
  /** Active tool id, or null for cursor mode. */
  readonly activeToolId: string | null;
  /** Painting family config; absent if it could not be parsed. */
  readonly painting?: SerializedPainting;
  /**
   * Per-user edit-hotkey overrides (TM-315). Merged over the build-time
   * `custom-keybinds.json` defaults by the session hotkey binder. Absent when
   * the user has not rebound anything.
   */
  readonly keybinds?: EditKeybindOverrides;
}

function serializeValue(value: number | bigint): SerializedValue {
  return typeof value === "bigint"
    ? { t: "b", v: value.toString() }
    : { t: "n", v: value };
}

function serializePainting(state: PaintingSharedState): SerializedPainting {
  return {
    targetLayerId: state.targetLayerId,
    targetResolution: state.targetResolution,
    radius: state.radius,
    activeValue: serializeValue(state.activeValue),
    eraseValue: serializeValue(state.eraseValue),
    mask: state.mask ?? null,
    fillMode: state.fillMode,
  };
}

/**
 * Build the persisted tooling block from the live tool state. `keybinds` are
 * the per-user edit-hotkey overrides (omitted from the output when empty).
 */
export function serializeTooling(
  activeToolId: string | undefined,
  painting: PaintingSharedState,
  keybinds?: EditKeybindOverrides,
): ToolingPersistState {
  const base: ToolingPersistState = {
    activeToolId: activeToolId ?? null,
    painting: serializePainting(painting),
  };
  if (keybinds !== undefined && Object.keys(keybinds).length > 0) {
    return { ...base, keybinds };
  }
  return base;
}

// -- Parsing (tolerant) -----------------------------------------------------

function parseValue(x: unknown): number | bigint | undefined {
  if (typeof x !== "object" || x === null) return undefined;
  const o = x as Record<string, unknown>;
  if (o.t === "n" && typeof o.v === "number") return o.v;
  if (o.t === "b" && typeof o.v === "string") {
    try {
      return BigInt(o.v);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseMask(x: unknown): PaintingMaskConfig | null | undefined {
  if (x === null) return null;
  if (typeof x !== "object") return undefined;
  const o = x as Record<string, unknown>;
  if (
    typeof o.imageLayerId !== "string" ||
    typeof o.imageResolution !== "string" ||
    typeof o.thresholdLow !== "number" ||
    typeof o.thresholdHigh !== "number" ||
    typeof o.minComponentSize !== "number" ||
    typeof o.binaryClosing !== "number" ||
    typeof o.filterComponentsFirst !== "boolean" ||
    // Optional (added TM-339); reject only a present-but-wrong-typed value so
    // older persisted configs without the field still parse.
    (o.coverageThreshold !== undefined &&
      typeof o.coverageThreshold !== "number")
  ) {
    return undefined;
  }
  return {
    imageLayerId: o.imageLayerId as LayerId,
    imageResolution: o.imageResolution as Resolution,
    thresholdLow: o.thresholdLow,
    thresholdHigh: o.thresholdHigh,
    coverageThreshold:
      typeof o.coverageThreshold === "number"
        ? o.coverageThreshold
        : DEFAULT_COVERAGE_THRESHOLD,
    minComponentSize: o.minComponentSize,
    binaryClosing: o.binaryClosing,
    filterComponentsFirst: o.filterComponentsFirst,
  };
}

function parsePainting(x: unknown): SerializedPainting | undefined {
  if (typeof x !== "object" || x === null) return undefined;
  const o = x as Record<string, unknown>;
  if (
    typeof o.targetLayerId !== "string" ||
    typeof o.targetResolution !== "string" ||
    typeof o.radius !== "number"
  ) {
    return undefined;
  }
  const activeValue = parseValue(o.activeValue);
  const eraseValue = parseValue(o.eraseValue);
  const mask = parseMask(o.mask);
  if (
    activeValue === undefined ||
    eraseValue === undefined ||
    mask === undefined
  ) {
    return undefined;
  }
  return {
    targetLayerId: o.targetLayerId,
    targetResolution: o.targetResolution,
    radius: o.radius,
    activeValue: serializeValue(activeValue),
    eraseValue: serializeValue(eraseValue),
    mask,
    fillMode: parseFillMode(o.fillMode),
  };
}

/**
 * Parse the per-user keybind overrides. Tolerant: skips any malformed entry
 * (non-string keys list) rather than dropping the whole block. Returns
 * undefined when there is nothing usable.
 */
function parseKeybinds(x: unknown): EditKeybindOverrides | undefined {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return undefined;
  const o = x as Record<string, unknown>;
  const out: { [name: string]: readonly string[] } = {};
  for (const [name, raw] of Object.entries(o)) {
    const keys = Array.isArray(raw)
      ? raw.filter((k): k is string => typeof k === "string")
      : typeof raw === "string"
        ? [raw]
        : [];
    if (keys.length > 0) out[name] = keys;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Parse a persisted tooling block. Returns undefined when absent/malformed. */
export function parseTooling(x: unknown): ToolingPersistState | undefined {
  if (x === null || x === undefined) return undefined;
  if (typeof x !== "object") return undefined;
  const o = x as Record<string, unknown>;
  const activeToolId =
    o.activeToolId === null
      ? null
      : typeof o.activeToolId === "string"
        ? o.activeToolId
        : undefined;
  if (activeToolId === undefined) return undefined;
  const painting =
    o.painting === undefined ? undefined : parsePainting(o.painting);
  if (o.painting !== undefined && painting === undefined) return undefined;
  const keybinds = parseKeybinds(o.keybinds);
  const result: ToolingPersistState = { activeToolId };
  return {
    ...result,
    ...(painting !== undefined ? { painting } : {}),
    ...(keybinds !== undefined ? { keybinds } : {}),
  };
}

/**
 * Resolve a persisted painting config into a `PaintingSharedState` patch,
 * validated against the session's layers. Returns the patch to apply, or
 * undefined if the target binding is no longer valid (the caller keeps
 * defaults). A persisted mask referencing a missing layer is dropped while the
 * rest of the config still applies.
 *
 * `allowedByLayer` maps each session layer to the resolutions the session
 * actually opened (and the host preloads/pins). A persisted
 * `mask.imageResolution` that is NOT among them is repaired to the layer's
 * first allowed resolution rather than restored verbatim: the image layer's
 * datasource pyramid usually contains finer scales the session never pinned, so
 * a stale value would otherwise drive every masked stamp to cold-read native
 * full-resolution EM (a 10–20 s/chunk stall). Repairing keeps masking on at a
 * resident scale instead of dropping it.
 */
export function paintingPatchFromPersist(
  p: SerializedPainting,
  allowedByLayer: ReadonlyMap<string, readonly Resolution[]>,
): Partial<PaintingSharedState> | undefined {
  if (!allowedByLayer.has(p.targetLayerId)) return undefined;
  const activeValue = parseValue(p.activeValue);
  const eraseValue = parseValue(p.eraseValue);
  if (activeValue === undefined || eraseValue === undefined) return undefined;
  const mask = repairMaskResolution(p.mask, allowedByLayer);
  return {
    targetLayerId: p.targetLayerId as LayerId,
    targetResolution: p.targetResolution as Resolution,
    radius: p.radius,
    activeValue,
    eraseValue,
    mask,
    fillMode: parseFillMode(p.fillMode),
  };
}

/**
 * Validate a persisted mask against the session's opened resolutions. Returns:
 *   • `undefined` — no mask persisted, or its image layer is gone from the
 *     session (dropped, same as the missing-target-layer behavior).
 *   • the mask unchanged — its `imageResolution` is one the session opened.
 *   • the mask with `imageResolution` swapped for the layer's first allowed
 *     resolution — a stale/finer value the session never pinned.
 */
function repairMaskResolution(
  mask: PaintingMaskConfig | null,
  allowedByLayer: ReadonlyMap<string, readonly Resolution[]>,
): PaintingMaskConfig | undefined {
  if (mask === null) return undefined;
  const allowed = allowedByLayer.get(mask.imageLayerId);
  if (allowed === undefined || allowed.length === 0) return undefined;
  if (allowed.includes(mask.imageResolution)) return mask;
  return { ...mask, imageResolution: allowed[0] };
}
