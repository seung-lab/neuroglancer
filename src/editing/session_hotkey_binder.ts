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
  accelStepsPerSecond,
  nextBrushValue,
  nextPresetSize,
  nextThresholdLow,
  nextThresholdHigh,
} from "#src/editing/painting_hotkey_math.js";
import { ParamStatusOverlay } from "#src/editing/param_status_overlay.js";
import {
  clampToVoxelDataType,
  voxelDataTypeRange,
} from "#src/editing/tool_runtimes/mask_coord.js";
import type { PaintingState } from "#src/editing/tool_runtimes/painting_tools.js";
import type { PaintParamCursor } from "#src/editing/tool_runtimes/param_cursor.js";
import type { EditKeybindOverrides } from "#src/editing/tooling/tooling_persist.js";
import {
  getEditSessionKeybinds,
  type EditSessionKeybinds,
} from "#src/ui/custom_keybinds.js";
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
  // Ctrl+Left / Ctrl+Right (Option+Arrow on macOS) — move the parameter
  // selection cursor through the active tool panel's enabled controls (TM-337).
  paramPrev: "edit-session-param-prev",
  paramNext: "edit-session-param-next",
  // Ctrl+Up / Ctrl+Down (Option+Arrow on macOS) — increment / decrement the
  // selected parameter, with hold-to-accelerate for numeric params.
  paramIncr: "edit-session-param-incr",
  paramDecr: "edit-session-param-decr",
  // `L` / `H` — held-chord modifiers for the threshold bindings. Bound to a
  // no-op so they shadow the global `keyl`→recolor / `keyh`→help while a
  // session is active; the actual held state is read via `HeldKeyTracker`.
  noopLetter: "edit-session-noop-letter",
} as const;

/**
 * User-configurable edit hotkeys (TM-315). Friendly name → default key event
 * identifier(s). Overridable per-deployment via the `editSession` section of
 * `config/custom-keybinds.json`; merged in `mergeEditKeybinds`. The fixed
 * bindings (escape, the L/H chord shadows) are NOT user-configurable and are
 * added directly in the action map.
 */
export type EditKeybindName =
  | "brush"
  | "erase"
  | "fill"
  | "zextrap"
  | "cursor"
  | "undo"
  | "redo"
  | "sizeDecrease"
  | "sizeIncrease"
  | "valueDecrease"
  | "valueIncrease"
  | "paramPrev"
  | "paramNext"
  | "paramIncrease"
  | "paramDecrease";

/** True when running on macOS (best-effort; false in non-browser contexts). */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform ?? "";
  const ua = navigator.userAgent ?? "";
  return /mac/i.test(platform) || /mac os x/i.test(ua);
}

/**
 * Default keys for the Ctrl+Arrow parameter scheme (TM-337), chosen per
 * platform: macOS reserves `Ctrl+Arrow` for Spaces / Mission Control at the
 * window-server level — the browser never receives those events and
 * `preventDefault` can't reclaim them — so macOS uses `Option(Alt)+Arrow`
 * instead, which the OS leaves free. Windows/Linux keep `Ctrl+Arrow` (matches
 * the ticket; no system conflict there). Pure + exported so the binder and the
 * unit tests agree on the mapping. Still user-overridable like the other binds.
 */
export function paramArrowDefaults(mac: boolean): {
  paramPrev: readonly string[];
  paramNext: readonly string[];
  paramIncrease: readonly string[];
  paramDecrease: readonly string[];
} {
  const mod = mac ? "alt" : "control";
  return {
    paramPrev: [`${mod}+arrowleft`],
    paramNext: [`${mod}+arrowright`],
    paramIncrease: [`${mod}+arrowup`],
    paramDecrease: [`${mod}+arrowdown`],
  };
}

const DEFAULT_EDIT_KEYBINDS: Record<EditKeybindName, readonly string[]> = {
  brush: ["control+keyb"],
  erase: ["control+keye"],
  fill: ["control+keyf"],
  zextrap: ["control+keyx"],
  cursor: ["control+keyv"],
  undo: ["control+keyz", "meta+keyz"],
  redo: ["control+shift+keyz", "meta+shift+keyz"],
  sizeDecrease: ["minus", "numpadsubtract"],
  sizeIncrease: ["equal", "shift+equal", "numpadadd"],
  valueDecrease: ["bracketleft"],
  valueIncrease: ["bracketright"],
  ...paramArrowDefaults(isMacPlatform()),
};

const EDIT_KEYBIND_ACTION: Record<EditKeybindName, string> = {
  brush: ACTION_IDS.toolBrush,
  erase: ACTION_IDS.toolErase,
  fill: ACTION_IDS.toolFill,
  zextrap: ACTION_IDS.toolZExtrap,
  cursor: ACTION_IDS.cursorMode,
  undo: ACTION_IDS.undo,
  redo: ACTION_IDS.redo,
  sizeDecrease: ACTION_IDS.sizeDecr,
  sizeIncrease: ACTION_IDS.sizeIncr,
  valueDecrease: ACTION_IDS.valueDecr,
  valueIncrease: ACTION_IDS.valueIncr,
  paramPrev: ACTION_IDS.paramPrev,
  paramNext: ACTION_IDS.paramNext,
  paramIncrease: ACTION_IDS.paramIncr,
  paramDecrease: ACTION_IDS.paramDecr,
};

/**
 * Build the `key → action` map for the session input layer: defaults overridden
 * by `overrides` (the `editSession` section of `custom-keybinds.json`), plus the
 * fixed (non-configurable) bindings. Last write wins on key collisions. Pure +
 * exported for unit testing.
 */
export function mergeEditKeybinds(
  overrides: EditSessionKeybinds | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(EDIT_KEYBIND_ACTION) as EditKeybindName[]) {
    const override = overrides?.[name];
    const keys =
      override !== undefined
        ? Array.isArray(override)
          ? override
          : [override]
        : DEFAULT_EDIT_KEYBINDS[name];
    for (const key of keys) {
      out[key] = EDIT_KEYBIND_ACTION[name];
    }
  }
  // Fixed bindings — not user-configurable.
  out["escape"] = ACTION_IDS.exitTool;
  // Shadow the global `keyl` (recolor) / `keyh` (help) so holding them as chord
  // modifiers doesn't trigger those while a session is active.
  out["keyl"] = ACTION_IDS.noopLetter;
  out["keyh"] = ACTION_IDS.noopLetter;
  return out;
}

/**
 * The configurable edit-hotkey action names, in display order. Exported so the
 * topbar rebind UI can iterate them without re-declaring the list.
 */
export const EDIT_KEYBIND_NAMES = Object.keys(
  EDIT_KEYBIND_ACTION,
) as EditKeybindName[];

/**
 * Resolve the EFFECTIVE key identifier(s) bound to each configurable action,
 * applying the same precedence the binder uses: built-in defaults ←
 * `custom-keybinds.json` ← per-user runtime overrides. A whole-list replace per
 * action name. Pure + exported so the UI can display the live binding and the
 * behaviour stays in lock-step with {@link buildEditActionBindings}.
 */
export function effectiveEditKeybinds(
  perUser: EditKeybindOverrides | undefined,
): Record<EditKeybindName, readonly string[]> {
  const config = getEditSessionKeybinds();
  const out = {} as Record<EditKeybindName, readonly string[]>;
  for (const name of EDIT_KEYBIND_NAMES) {
    const chosen =
      perUser?.[name] ?? config?.[name] ?? DEFAULT_EDIT_KEYBINDS[name];
    out[name] = Array.isArray(chosen) ? chosen : [chosen];
  }
  return out;
}

/**
 * Resolve the live `key → action` map from the three layers, lowest priority
 * first: built-in defaults ← `custom-keybinds.json` `editSession` overrides ←
 * per-user runtime overrides (`host.editKeybindOverrides`). A per-user entry
 * replaces the whole key list for that action name. `mergeEditKeybinds` folds
 * in the defaults and the fixed bindings.
 */
function buildEditActionBindings(
  perUser: EditKeybindOverrides | undefined,
): Record<string, string> {
  const config = getEditSessionKeybinds();
  const merged: { [name: string]: string | readonly string[] } = {
    ...config,
  };
  if (perUser !== undefined) {
    for (const [name, keys] of Object.entries(perUser)) {
      merged[name] = keys;
    }
  }
  return mergeEditKeybinds(merged);
}

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

  // Center-screen readout for the Ctrl+Arrow parameter scheme (TM-337).
  private readonly statusOverlay: ParamStatusOverlay;
  // Active hold-to-accelerate session for Ctrl+Up / Ctrl+Down, or null when no
  // arrow is held. `accum` carries fractional steps between animation frames.
  private ramp: {
    dir: number;
    arrowCode: string;
    startMs: number;
    lastMs: number;
    accum: number;
    rafId: number;
  } | null = null;

  // The viewer whose `inputEventMap` we parent our session layer onto. Stored
  // so `rebuildActionMap` can re-attach after a runtime rebind.
  private viewer!: Viewer;
  // Detaches the currently-installed session action map; replaced on each
  // rebuild and called on dispose.
  private detachActionMap: (() => void) | undefined;

  constructor(
    private readonly host: EditSessionHost,
    viewer: Viewer,
  ) {
    super();
    this.tracker = this.registerDisposer(new HeldKeyTracker(viewer.element));
    this.statusOverlay = this.registerDisposer(new ParamStatusOverlay());
    this.registerDisposer(() => this.stopRamp());

    // Build the session's `EventActionMap` from the configurable edit keybinds
    // (defaults + `custom-keybinds.json` `editSession` overrides + per-user
    // runtime rebinds) plus the fixed bindings (TM-315). Keys are bare event
    // identifiers (no `key:` phase prefix — `parseEventIdentifier` only accepts
    // `at` / `bubble` phases). Edit hotkeys are Ctrl-prefixed by default (avoid
    // accidental firing while typing + no global conflict); bracket/size keys
    // stay unprefixed but are session-scoped so they don't shadow defaults
    // outside a session.
    //
    // The map is rebuilt live when the user rebinds a hotkey: we detach the old
    // parent and install a freshly built one. The action LISTENERS below are
    // keyed by action id (not by key), so they survive a rebuild untouched —
    // only the key→action routing changes.
    this.viewer = viewer;
    this.rebuildActionMap(host.editKeybindOverrides.value);
    this.registerDisposer(
      host.editKeybindOverrides.changed.add(() => {
        this.rebuildActionMap(host.editKeybindOverrides.value);
      }),
    );
    this.registerDisposer(() => {
      if (this.detachActionMap !== undefined) {
        try {
          this.detachActionMap();
        } catch {
          // best-effort detach during disposal
        }
        this.detachActionMap = undefined;
      }
    });

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

    // Ctrl+Arrow parameter scheme (TM-337; Option+Arrow on macOS). Left/Right
    // move the selection cursor through the active panel's enabled parameters;
    // Up/Down nudge the selected one (hold to accelerate for numeric params).
    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.paramPrev, (event) => {
        if (this.moveParam(-1)) event.stopPropagation();
      }),
    );
    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.paramNext, (event) => {
        if (this.moveParam(+1)) event.stopPropagation();
      }),
    );
    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.paramIncr, (event) => {
        if (this.startParamRamp(+1, "arrowup")) event.stopPropagation();
      }),
    );
    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.paramDecr, (event) => {
        if (this.startParamRamp(-1, "arrowdown")) event.stopPropagation();
      }),
    );
    // `L` / `H` are bound only to keep the global recolor/help actions from
    // firing while held; the handler itself does nothing.
    this.registerDisposer(
      registerActionListener(target, ACTION_IDS.noopLetter, () => {}),
    );
  }

  /**
   * (Re)build the session-scoped `EventActionMap` from the current keybind
   * layers and install it as a high-priority parent of the viewer's input map,
   * detaching any previously-installed one. Called once at construction and
   * again whenever the user rebinds a hotkey at runtime.
   */
  private rebuildActionMap(overrides: EditKeybindOverrides | undefined): void {
    if (this.detachActionMap !== undefined) {
      try {
        this.detachActionMap();
      } catch {
        // best-effort detach of the previous map
      }
      this.detachActionMap = undefined;
    }
    const actionMap = EventActionMap.fromObject(
      buildEditActionBindings(overrides),
    );
    actionMap.label = "Edit session";
    // `addParent` returns a thunk that removes the parent linkage; safe to call
    // exactly once.
    this.detachActionMap = this.viewer.inputEventMap.addParent(
      actionMap,
      SESSION_HOTKEY_PRIORITY,
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

  // -- Ctrl+Arrow parameter scheme (TM-337) ---------------------------------

  /** The active session's parameter cursor, or undefined when unavailable. */
  private getCursor(): PaintParamCursor | undefined {
    return this.host.painting?.paramCursor;
  }

  /** True while a brush/eraser/fill tool is active (the scheme's scope). */
  private isPaintToolActive(): boolean {
    return isPaintLikeToolId(this.host.activeToolId.value);
  }

  /** Surface the currently-selected parameter + its value in the center readout. */
  private showSelected(cursor: PaintParamCursor): void {
    const sel = cursor.selected();
    if (sel !== undefined) {
      this.statusOverlay.show(`${sel.label}: ${sel.format()}`);
    }
  }

  /**
   * Ctrl+Left / Ctrl+Right: move the selection cursor through the active panel's
   * enabled parameters. Returns whether the keypress was handled (so the caller
   * stops propagation only then, leaving the binding inert outside a paint tool).
   */
  private moveParam(dir: number): boolean {
    if (!this.isPaintToolActive()) return false;
    const cursor = this.getCursor();
    if (cursor === undefined || cursor.getDescriptors().length === 0) {
      return false;
    }
    cursor.moveSelection(dir);
    this.showSelected(cursor);
    return true;
  }

  /**
   * Ctrl+Up / Ctrl+Down: begin a hold-to-accelerate session for the selected
   * parameter. Applies one step immediately (so a tap always nudges by one),
   * then — for numeric params — an animation-frame loop integrates the
   * acceleration curve while the arrow stays held. Enum/boolean params step once
   * and do not accelerate. Auto-repeat key-downs are ignored while a session is
   * already running. Returns whether the keypress was handled.
   */
  private startParamRamp(dir: number, arrowCode: string): boolean {
    if (!this.isPaintToolActive()) return false;
    const cursor = this.getCursor();
    if (cursor === undefined || cursor.getDescriptors().length === 0) {
      return false;
    }
    // Already running (OS auto-repeat or the opposite arrow): keep the first.
    if (this.ramp !== null) return true;
    const sel = cursor.ensureSelection();
    if (sel === undefined) return false;
    sel.adjust(dir, 1);
    this.showSelected(cursor);
    const now = performance.now();
    this.ramp = {
      dir,
      arrowCode,
      startMs: now,
      lastMs: now,
      accum: 0,
      rafId: requestAnimationFrame(this.rampTick),
    };
    return true;
  }

  /** Animation-frame step of the active hold-to-accelerate session. */
  private readonly rampTick = (): void => {
    const ramp = this.ramp;
    if (ramp === null) return;
    const cursor = this.getCursor();
    const sel = cursor?.selected();
    // Stop on release of the arrow or the chord modifier, a tool switch, or a
    // vanished cursor. The modifier is Ctrl (Win/Linux) or Option (macOS), and
    // may be rebound, so accept any of Ctrl/Alt/Meta rather than a specific one.
    const modifierHeld =
      this.tracker.isHeld("controlleft") ||
      this.tracker.isHeld("controlright") ||
      this.tracker.isHeld("altleft") ||
      this.tracker.isHeld("altright") ||
      this.tracker.isHeld("metaleft") ||
      this.tracker.isHeld("metaright");
    if (
      sel === undefined ||
      !this.isPaintToolActive() ||
      !this.tracker.isHeld(ramp.arrowCode) ||
      !modifierHeld
    ) {
      this.stopRamp();
      return;
    }
    // Only numeric params accelerate; enum/boolean already stepped once.
    if (sel.kind === "number") {
      const t = performance.now();
      const dt = (t - ramp.lastMs) / 1000;
      ramp.lastMs = t;
      ramp.accum += accelStepsPerSecond(t - ramp.startMs) * dt;
      const steps = Math.floor(ramp.accum);
      if (steps >= 1) {
        ramp.accum -= steps;
        sel.adjust(ramp.dir, steps);
        this.showSelected(cursor!);
      }
    }
    ramp.rafId = requestAnimationFrame(this.rampTick);
  };

  /** Cancel the active hold-to-accelerate session, if any. */
  private stopRamp(): void {
    if (this.ramp !== null) {
      cancelAnimationFrame(this.ramp.rafId);
      this.ramp = null;
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
