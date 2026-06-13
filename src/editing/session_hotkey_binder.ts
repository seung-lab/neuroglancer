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
 * @file Session-scoped keyboard shortcut layer for an active edit session.
 *
 * Per `docs/edit-session-integration/architecture/05-tools-and-cursor.md`
 * § "Tool activation hotkeys (v1)" and § "Routing mechanism", an active edit
 * session installs a session-scoped binding layer that overrides
 * neuroglancer's global hotkeys for the session's duration.
 *
 * Routing strategy (see also `07-data-flow.md` § H):
 *
 * Neuroglancer's global `KeyboardEventBinder` (`src/viewer.ts:1041`) is
 * permanently attached to `viewer.element` and consults
 * `viewer.inputEventMap`, which is an `EventActionMap`. `EventActionMap`
 * extends `HierarchicalMap` (`src/util/hierarchical_map.ts:45`) and supports
 * priority-based parent maps via `addParent(parent, priority)`. When
 * `priority > 0`, the parent's bindings take precedence over direct
 * bindings (see `HierarchicalMap.get`,
 * `src/util/hierarchical_map.ts:132`).
 *
 * We therefore install our session-scoped `EventActionMap` as a
 * high-priority parent of `viewer.inputEventMap`. The architecture doc's
 * conjectural `viewer.keyboardBinder.pushMap(...)` API does not exist
 * (`KeyboardEventBinder` itself has no stack — `src/util/keyboard_bindings.ts`),
 * but `addParent` is the canonical neuroglancer "layered binder" idiom and
 * is already used to compose default bindings
 * (`src/ui/default_input_event_bindings.ts:72-78`).
 *
 * Action listeners are registered on `viewer.element` (the same target the
 * global binder dispatches to via `dispatchEventAction`,
 * `src/util/event_action_map.ts:421`). On dispose, the parent linkage and
 * all listeners are removed; the global bindings (e.g., any default
 * `Ctrl+Z`) return to normal.
 */

import type { VoxelDataType } from "@zettaai/edit-session";

import { radiusToSize, sizeToRadius } from "#src/editing/brush_size_presets.js";
import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { HeldKeyTracker } from "#src/editing/held_key_tracker.js";
import {
  nextBrushValue,
  nextPresetSize,
  nextThresholdLow,
  nextThresholdHigh,
} from "#src/editing/painting_hotkey_math.js";
import {
  clampToVoxelDataType,
  voxelDataTypeRange,
} from "#src/editing/tool_runtimes/mask_coord.js";
import type { PaintingState } from "#src/editing/tool_runtimes/painting_tools.js";
import { RefCounted } from "#src/util/disposable.js";
import {
  EventActionMap,
  registerActionListener,
} from "#src/util/event_action_map.js";
import type { Viewer } from "#src/viewer.js";

// Priority must be > 0 so the session layer overrides direct bindings on
// `viewer.inputEventMap` (e.g. neuroglancer's global `keyb` → "toggle-scale-bar"
// in `src/ui/default_input_event_bindings.ts:28`).
const SESSION_HOTKEY_PRIORITY = 100;

// Centralised so the action ids stay in sync between the action map and the
// action-listener registrations below. Mirrors the v1 hotkey table in
// `docs/edit-session-integration/architecture/05-tools-and-cursor.md`.
const ACTION_IDS = {
  toolBrush: "edit-session-tool-brush",
  toolErase: "edit-session-tool-erase",
  toolFill: "edit-session-tool-fill",
  toolZExtrap: "edit-session-tool-zextrap",
  toolCorrespondence: "edit-session-tool-correspondence",
  cursorMode: "edit-session-cursor-mode",
  undo: "edit-session-undo",
  redo: "edit-session-redo",
  exitTool: "edit-session-exit-tool",
  // `+` / `-` — step brush *size* through the preset cycle.
  sizeDecr: "edit-session-size-decr",
  sizeIncr: "edit-session-size-incr",
  // `[` / `]` — brush value, or low/high threshold when L/H is held.
  valueDecr: "edit-session-value-decr",
  valueIncr: "edit-session-value-incr",
  // `L` / `H` — held-chord modifiers for the threshold bindings. Bound to a
  // no-op so they shadow the global `keyl`→recolor / `keyh`→help while a
  // session is active; the actual held state is read via `HeldKeyTracker`.
  noopLetter: "edit-session-noop-letter",
} as const;

// Library tool ids (see `node_modules/@zettaai/edit-session/dist/index.d.mts`
// lines 1178, 1213, 1425, 1568, and 1148 for the `StrokeTool` toolId values).
const TOOL_ID_BRUSH = "painting.brush";
const TOOL_ID_ERASE = "painting.erase";
const TOOL_ID_FILL = "painting.fill";
const TOOL_ID_Z_EXTRAP = "z-extrapolation";
const TOOL_ID_CORRESPONDENCE = "correspondence";

/**
 * Installs a session-scoped keyboard shortcut layer for the duration of an
 * active `EditSession`. Constructed by `EditSessionHost` on session-open
 * and disposed on session-end; the host owns the lifecycle.
 */
export class EditSessionHotkeyBinder extends RefCounted {
  // Held-key state for the L/H threshold chords (see `held_key_tracker.ts`).
  private readonly tracker: HeldKeyTracker;
  // Cached voxel-value range per mask image layer, used to clamp threshold
  // adjustments. Resolved lazily on first threshold keypress for a layer.
  private readonly thresholdRangeByLayer = new Map<
    string,
    { min: number; max: number }
  >();
  private readonly thresholdRangePending = new Set<string>();
  // Cached voxel data type per target layer, used to clamp brush-value
  // (+/-) adjustments to the layer's representable range. Resolved lazily on
  // first value keypress for a layer, mirroring the threshold cache above.
  private readonly targetTypeByLayer = new Map<string, VoxelDataType>();
  private readonly targetTypePending = new Set<string>();

  constructor(
    private readonly host: EditSessionHost,
    viewer: Viewer,
  ) {
    super();
    this.tracker = this.registerDisposer(new HeldKeyTracker(viewer.element));

    // Build the session's `EventActionMap`. Note the keys are bare event
    // identifiers (no `key:` phase prefix — `parseEventIdentifier` only
    // accepts `at` / `bubble` phases; the architecture doc's `key:keyb`
    // syntax would throw).
    //
    // TM-294 moved tool activation to **Ctrl-prefixed** bindings (and the
    // matching `meta+` chord for macOS so Cmd works too). The previous
    // bare-letter bindings were prone to firing accidentally while typing
    // into input boxes outside the viewer. Bracket-based brush sizing
    // stays unprefixed since it has no global conflict.
    //
    // Z-extrapolation cannot use `Ctrl+Z` (reserved for Undo). We pick
    // `Ctrl+P` ("propagate"); engineers may swap to another free letter
    // later if `P` becomes inconvenient. Correspondence keeps `Ctrl+R`
    // ("relate") — `Ctrl+C` is reserved for clipboard copy.
    const actionMap = EventActionMap.fromObject({
      "control+keyb": ACTION_IDS.toolBrush,
      "control+keye": ACTION_IDS.toolErase,
      "control+keyf": ACTION_IDS.toolFill,
      "control+keyv": ACTION_IDS.cursorMode,
      "control+keyz": ACTION_IDS.undo,
      "control+shift+keyz": ACTION_IDS.redo,
      "meta+keyz": ACTION_IDS.undo,
      "meta+shift+keyz": ACTION_IDS.redo,
      escape: ACTION_IDS.exitTool,
      // Brush size presets: `+` / `-` (main row, with or without shift, plus
      // numpad). `getEventKeyName` reports `event.code` lowercased.
      minus: ACTION_IDS.sizeDecr,
      numpadsubtract: ACTION_IDS.sizeDecr,
      equal: ACTION_IDS.sizeIncr,
      "shift+equal": ACTION_IDS.sizeIncr,
      numpadadd: ACTION_IDS.sizeIncr,
      // Brush value (or low/high threshold when L/H is held).
      bracketleft: ACTION_IDS.valueDecr,
      bracketright: ACTION_IDS.valueIncr,
      // Shadow the global `keyl` (recolor) / `keyh` (help) so holding them as
      // chord modifiers doesn't trigger those while a session is active.
      keyl: ACTION_IDS.noopLetter,
      keyh: ACTION_IDS.noopLetter,
    });
    actionMap.label = "Edit session";

    // Install as a high-priority parent of the viewer's input map. The
    // returned thunk both removes the parent linkage and is safe to call
    // exactly once on dispose.
    const detachParent = viewer.inputEventMap.addParent(
      actionMap,
      SESSION_HOTKEY_PRIORITY,
    );
    this.registerDisposer(detachParent);

    // Camera-pan navigation maps. Swapped based on the active tool:
    //
    // - `paintNavMap` — while brush/eraser/fill is active. Plain left-click
    //   must NOT pan (otherwise click+drag would pan instead of paint), so
    //   `at:mousedown0` is shadowed by a no-op action (the synthesized
    //   `mousedown` itself still fires; Chrome only suppresses subsequent
    //   `mousemove` events when `preventDefault` is called on the upstream
    //   `pointerdown`). Ctrl/Cmd+left-click+drag pans via the existing
    //   `translate-via-mouse-drag` action.
    //
    // - `cursorNavMap` — while no tool / a non-paint tool is active. It is
    //   empty so every native neuroglancer binding falls through unchanged:
    //   plain click+drag pans via the default `translate-via-mouse-drag`, and
    //   `Ctrl+click` creates an annotation via the default
    //   `at:control+mousedown0 → annotate` binding (from
    //   `getDefaultRenderedDataPanelBindings`). Native shortcuts are only
    //   shadowed while a paint-like tool is active (see `paintNavMap`).
    const ctrlMetaPanEntries = {
      "at:control+mousedown0": {
        action: "translate-via-mouse-drag",
        stopPropagation: true,
      },
      "at:meta+mousedown0": {
        action: "translate-via-mouse-drag",
        stopPropagation: true,
      },
    } as const;
    const paintNavMap = EventActionMap.fromObject({
      "at:mousedown0": {
        action: "edit-session-noop-mousedown",
        stopPropagation: true,
      },
      ...ctrlMetaPanEntries,
    });
    paintNavMap.label = "Edit session navigation (paint)";
    const cursorNavMap = EventActionMap.fromObject({});
    cursorNavMap.label = "Edit session navigation (cursor)";

    let detachNav: (() => void) | undefined;
    const applyNavMode = (toolId: string | undefined) => {
      if (detachNav !== undefined) {
        try {
          detachNav();
        } catch {
          // best-effort detach
        }
        detachNav = undefined;
      }
      const map = isPaintLikeToolId(toolId) ? paintNavMap : cursorNavMap;
      const detachSlice = viewer.inputEventBindings.sliceView.addParent(
        map,
        SESSION_HOTKEY_PRIORITY,
      );
      const detachPerspective =
        viewer.inputEventBindings.perspectiveView.addParent(
          map,
          SESSION_HOTKEY_PRIORITY,
        );
      detachNav = () => {
        detachSlice();
        detachPerspective();
      };
    };
    // Active-tool selection is consumer-owned (TM-315): drive nav mode off the
    // host's `activeToolId` watchable instead of the removed library event.
    applyNavMode(host.activeToolId.value);
    this.registerDisposer(
      host.activeToolId.changed.add(() =>
        applyNavMode(host.activeToolId.value),
      ),
    );
    this.registerDisposer(() => {
      if (detachNav !== undefined) {
        try {
          detachNav();
        } catch {
          // best-effort detach during disposal
        }
        detachNav = undefined;
      }
    });

    const target = viewer.element;

    const activateTool = (toolId: string) => {
      // Route through host.selectTool so hotkey activation keeps tool-panel
      // visibility in sync (see TM-294 rework: per-tool panel mounts).
      host.selectTool(toolId);
    };

    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.toolBrush, () => {
        activateTool(TOOL_ID_BRUSH);
      }),
    );
    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.toolErase, () => {
        activateTool(TOOL_ID_ERASE);
      }),
    );
    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.toolFill, () => {
        activateTool(TOOL_ID_FILL);
      }),
    );
    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.toolZExtrap, () => {
        activateTool(TOOL_ID_Z_EXTRAP);
      }),
    );
    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.toolCorrespondence, () => {
        activateTool(TOOL_ID_CORRESPONDENCE);
      }),
    );

    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.undo, (event) => {
        const session = host.activeSession.value;
        if (session === undefined) return;
        event.stopPropagation();
        void session.undo().catch((err) => {
          host.logger.warn(
            "session",
            `Undo failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }),
    );

    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.redo, (event) => {
        const session = host.activeSession.value;
        if (session === undefined) return;
        event.stopPropagation();
        void session.redo().catch((err) => {
          host.logger.warn(
            "session",
            `Redo failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }),
    );

    const clearActiveTool = (event: Event) => {
      if (host.activeSession.value === undefined) return;
      event.stopPropagation();
      // Route through host.selectTool so Escape / Ctrl+V also closes the
      // per-tool panels (TM-294 rework).
      host.selectTool(undefined);
    };
    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.exitTool, clearActiveTool),
    );
    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.cursorMode, clearActiveTool),
    );

    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.sizeDecr, () => {
        this.stepBrushSize(-1);
      }),
    );
    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.sizeIncr, () => {
        this.stepBrushSize(+1);
      }),
    );
    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.valueDecr, () => {
        this.onBracket(-1);
      }),
    );
    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.valueIncr, () => {
        this.onBracket(+1);
      }),
    );
    // `L` / `H` are bound only to keep the global recolor/help actions from
    // firing while held; the handler itself does nothing.
    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.noopLetter, () => {}),
    );
  }

  // -- Painting adjustments -------------------------------------------------

  /** Returns the shared painting state, or `undefined` if unavailable. */
  private getPainting(): PaintingState | undefined {
    return this.host.painting?.state;
  }

  /** `+` / `-`: step brush size through the preset cycle (brush + eraser). */
  private stepBrushSize(dir: number): void {
    const activeId = this.host.activeToolId.value;
    if (activeId !== TOOL_ID_BRUSH && activeId !== TOOL_ID_ERASE) return;
    const painting = this.getPainting();
    if (painting === undefined) return;
    const size = radiusToSize(painting.getState().radius);
    const nextSize = nextPresetSize(size, dir);
    if (nextSize === size) return;
    painting.patchState({ radius: sizeToRadius(nextSize) });
  }

  /**
   * `[` / `]`: low/high threshold when L/H is held, else the brush value.
   * Only active for the brush tool.
   */
  private onBracket(dir: number): void {
    if (this.host.activeToolId.value !== TOOL_ID_BRUSH) return;
    const painting = this.getPainting();
    if (painting === undefined) return;
    if (this.tracker.isHeld("keyh")) {
      this.adjustThreshold(painting, "high", dir);
    } else if (this.tracker.isHeld("keyl")) {
      this.adjustThreshold(painting, "low", dir);
    } else {
      this.adjustValue(painting, dir);
    }
  }

  /**
   * Step the brush value ±1 and clamp it to the target layer's data type
   * range (so +/- can't push the value past e.g. uint8's 255 or below int8's
   * −128). Mirrors {@link adjustThreshold}: the dtype is resolved + cached per
   * layer on first use; an unresolved/failed lookup falls back to plain ±1
   * stepping so the hotkey still works.
   */
  private adjustValue(painting: PaintingState, dir: number): void {
    const layerId = painting.getState().targetLayerId;
    const cached = this.targetTypeByLayer.get(layerId);
    if (cached !== undefined) {
      this.applyValue(painting, dir, cached);
      return;
    }
    if (this.targetTypePending.has(layerId)) return;
    this.targetTypePending.add(layerId);
    this.host.layerMetadataSource.resolve(layerId).then(
      (meta) => {
        this.targetTypePending.delete(layerId);
        this.targetTypeByLayer.set(layerId, meta.voxelDataType);
        this.applyValue(painting, dir, meta.voxelDataType);
      },
      (err: unknown) => {
        this.targetTypePending.delete(layerId);
        this.host.logger.warn(
          "session",
          `Value range unavailable for ${layerId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        this.applyValue(painting, dir, undefined);
      },
    );
  }

  private applyValue(
    painting: PaintingState,
    dir: number,
    type: VoxelDataType | undefined,
  ): void {
    // Re-read state: it may have changed during an async dtype resolve.
    const value = painting.getState().activeValue;
    if (type === undefined) {
      // Dtype unknown (resolve failed): fall back to ≥0-only stepping.
      const next = nextBrushValue(value, dir);
      if (next !== value) painting.patchState({ activeValue: next });
      return;
    }
    // Step ±1 (preserving bigint vs number), then clamp to the layer's
    // representable range. The clamp supplies BOTH bounds — including the
    // negative minimum for signed types — so we must NOT pre-floor at 0.
    const step = Math.sign(dir);
    const stepped =
      typeof value === "bigint" ? value + BigInt(step) : value + step;
    const next = clampToVoxelDataType(type, stepped);
    if (next === value) return;
    painting.patchState({ activeValue: next });
  }

  private adjustThreshold(
    painting: PaintingState,
    which: "low" | "high",
    dir: number,
  ): void {
    const mask = painting.getState().mask;
    if (mask === undefined) return; // thresholds only apply with a mask
    const layerId = mask.imageLayerId;
    const cached = this.thresholdRangeByLayer.get(layerId);
    if (cached !== undefined) {
      this.applyThreshold(painting, which, dir, cached);
      return;
    }
    // Resolve + cache the image dtype range once, then apply this adjustment.
    if (this.thresholdRangePending.has(layerId)) return;
    this.thresholdRangePending.add(layerId);
    this.host.layerMetadataSource.resolve(mask.imageLayerId).then(
      (meta) => {
        this.thresholdRangePending.delete(layerId);
        const range = voxelDataTypeRange(meta.voxelDataType);
        if (range === null) return;
        this.thresholdRangeByLayer.set(layerId, range);
        this.applyThreshold(painting, which, dir, range);
      },
      (err: unknown) => {
        this.thresholdRangePending.delete(layerId);
        this.host.logger.warn(
          "session",
          `Threshold range unavailable for ${layerId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      },
    );
  }

  private applyThreshold(
    painting: PaintingState,
    which: "low" | "high",
    dir: number,
    range: { min: number; max: number },
  ): void {
    // Re-read mask: state may have changed during an async range resolve.
    const mask = painting.getState().mask;
    if (mask === undefined) return;
    if (which === "low") {
      const low = nextThresholdLow(
        mask.thresholdLow,
        mask.thresholdHigh,
        range.min,
        dir,
      );
      if (low === mask.thresholdLow) return;
      painting.patchState({ mask: { ...mask, thresholdLow: low } });
    } else {
      const high = nextThresholdHigh(
        mask.thresholdLow,
        mask.thresholdHigh,
        range.max,
        dir,
      );
      if (high === mask.thresholdHigh) return;
      painting.patchState({ mask: { ...mask, thresholdHigh: high } });
    }
  }
}

function isPaintLikeToolId(toolId: string | undefined): boolean {
  return (
    toolId === TOOL_ID_BRUSH ||
    toolId === TOOL_ID_ERASE ||
    toolId === TOOL_ID_FILL
  );
}
