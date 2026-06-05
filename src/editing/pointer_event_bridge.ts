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
  InputHandling,
  ModifierState,
  PointerButton,
  Tool,
  ToolInputEvent,
} from "@zettaai/edit-session";
import { NO_MODIFIERS, Resolution } from "@zettaai/edit-session";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { globalToTargetVoxel } from "#src/editing/raster/global_voxel_conversion.js";
import type { DisplayContext, RenderedPanel } from "#src/display_context.js";
import { RenderedDataPanel } from "#src/rendered_data_panel.js";
import { RefCounted } from "#src/util/disposable.js";

type PointerKind =
  | "pointer-down"
  | "pointer-move"
  | "pointer-up"
  | "pointer-cancel";

/**
 * Translates DOM pointer / wheel / key events on neuroglancer's slice and
 * perspective panels into the edit-session library's normalized
 * `ToolInputEvent`, and dispatches them to `session.tools.getActiveTool()`.
 *
 * Construction snapshots the current panels in `displayContext.panels` and
 * attaches listeners to each `RenderedDataPanel.element`. Panels added after
 * construction are picked up on each `updateStarted` tick — neuroglancer
 * does not expose a discrete panel-added/removed signal in this surface,
 * so we re-scan to attach to newly-seen panels and detach from removed
 * ones.
 *
 * Events are no-ops when no session is active or no tool is active — they
 * pass through to neuroglancer's standard handlers. Only when the active
 * tool returns `{ consumed: true }` from `handleInput` does the bridge call
 * `stopPropagation()` and `preventDefault()`. Translation failures are
 * caught and logged via the host's logger on the `'tooling'` channel — the
 * original DOM event is left untouched in that case.
 */
export class PointerEventBridge extends RefCounted {
  private readonly attached = new Map<RenderedDataPanel, () => void>();
  /**
   * In-flight paint stroke. While set, every `mouseState.changed` event
   * is forwarded to the tool as a synthetic `pointer-move` so the stroke
   * advances in lockstep with neuroglancer's (async) picking pipeline.
   * Set on `pointerdown` when a paint-like tool is active; cleared on
   * `pointerup` / `pointercancel`.
   */
  private activeStroke:
    | {
        readonly panel: RenderedDataPanel;
        unsubscribeMouseState: () => void;
        lastVoxel: readonly [number, number, number] | undefined;
      }
    | undefined;

  constructor(
    private readonly host: EditSessionHost,
    private readonly displayContext: DisplayContext,
  ) {
    super();
    this.scanAndAttach();
    this.registerDisposer(
      displayContext.updateStarted.add(() => this.scanAndAttach()),
    );
  }

  override disposed(): void {
    this.endActiveStroke();
    for (const detach of this.attached.values()) {
      try {
        detach();
      } catch {
        // best-effort detach during disposal
      }
    }
    this.attached.clear();
    super.disposed();
  }

  private scanAndAttach(): void {
    const seen = new Set<RenderedDataPanel>();
    for (const panel of this.displayContext.panels) {
      if (!(panel instanceof RenderedDataPanel)) continue;
      seen.add(panel);
      if (!this.attached.has(panel)) {
        this.attached.set(panel, this.attachPanel(panel));
      }
    }
    for (const [panel, detach] of this.attached) {
      if (seen.has(panel)) continue;
      try {
        detach();
      } catch {
        // ignore
      }
      this.attached.delete(panel);
    }
  }

  private attachPanel(panel: RenderedDataPanel): () => void {
    const el = panel.element;
    const onPointer = (kind: PointerKind) => (ev: PointerEvent) =>
      this.dispatch(ev, () => this.translatePointer(panel, ev, kind));
    const onPointerDown = (ev: PointerEvent) => {
      // Camera lock: when a paint-like tool (brush/erase/fill) is active and
      // the user clicks WITHOUT Ctrl/Cmd, prevent neuroglancer's pan from
      // starting (otherwise click+drag = pan instead of brush stroke). We
      // do NOT call `setPointerCapture` here — Chrome suppresses the
      // compatibility `mousemove` events for the captured pointer, which
      // would prevent the panel's pick-pass from running and freeze both
      // the cursor and the stroke. The trade-off is that releasing the
      // pointer outside the panel won't fire a pointerup on the panel; the
      // active stroke ends instead on the next pointermove that arrives
      // (or on pointerup if the cursor re-enters). With Ctrl/Cmd held we
      // bail entirely from `dispatch` so the event falls through to
      // neuroglancer's pan binding.
      this.dispatch(ev, () => this.translatePointer(panel, ev, "pointer-down"));
      const cameraLocked = this.isCameraLockedForEvent(ev);
      if (cameraLocked && ev.button === 0) {
        this.beginStrokeForwarding(panel);
      }
    };
    const onPointerMove = onPointer("pointer-move");
    const onPointerUp = (ev: PointerEvent) => {
      this.dispatch(ev, () => this.translatePointer(panel, ev, "pointer-up"));
      this.endActiveStroke();
    };
    const onPointerCancel = (ev: PointerEvent) => {
      this.dispatch(ev, () =>
        this.translatePointer(panel, ev, "pointer-cancel"),
      );
      this.endActiveStroke();
    };
    const onWheel = (ev: WheelEvent) =>
      this.dispatch(ev, () => this.translateWheel(ev));
    const onKeyDown = (ev: KeyboardEvent) =>
      this.dispatch(ev, () => this.translateKey(ev, "down"));
    const onKeyUp = (ev: KeyboardEvent) =>
      this.dispatch(ev, () => this.translateKey(ev, "up"));

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerCancel);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("keyup", onKeyUp);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerCancel);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("keyup", onKeyUp);
    };
  }

  private dispatch(
    ev: Event,
    translate: () => ToolInputEvent | undefined,
  ): void {
    const session = this.host.activeSession.value;
    if (session === undefined) return;
    const tool: Tool | undefined = session.tools.getActiveTool();
    if (tool === undefined || tool.handleInput === undefined) return;

    // Camera lock: when a paint-like tool is active and the user is using
    // primary-button input WITHOUT Ctrl/Cmd, prevent neuroglancer's pan from
    // ever starting (otherwise click+drag = pan instead of brush stroke).
    // With Ctrl/Cmd held we bail BEFORE running the tool so the event falls
    // through to neuroglancer for default pan handling.
    const cameraLocked = this.isCameraLockedForEvent(ev);
    if (this.isPointerEvent(ev) && this.isPaintLikeTool(tool) && !cameraLocked) {
      return;
    }

    // For paint-like tools, DOM `pointermove` is NOT a reliable position
    // source — `mouseState.unsnappedPosition` lags by one frame because of
    // the async pick-pass. The stroke is driven from `mouseState.changed`
    // via `beginStrokeForwarding`. Skip pointermove dispatch here to avoid
    // sending stale-position moves that confuse the library's StrokeTool.
    if (
      this.isPointerEvent(ev) &&
      ev.type === "pointermove" &&
      this.isPaintLikeTool(tool)
    ) {
      return;
    }

    let translated: ToolInputEvent | undefined;
    try {
      translated = translate();
    } catch (err) {
      this.host.logger.error(
        "tooling",
        `PointerEventBridge: translation failed: ${stringifyError(err)}`,
      );
      return;
    }
    if (translated === undefined) return;
    let result: InputHandling | Promise<InputHandling>;
    try {
      result = tool.handleInput(translated);
    } catch (err) {
      this.host.logger.error(
        "tooling",
        `PointerEventBridge: tool.handleInput threw: ${stringifyError(err)}`,
      );
      return;
    }
    const shouldStopPropagation = this.shouldStopPropagation(
      ev,
      result,
      cameraLocked,
    );
    if (result instanceof Promise) {
      // Async tools can't retroactively change propagation — they must
      // return a sync `{consumed: true}` if they want to block the camera.
      // We still capture rejections.
      result.catch((err) =>
        this.host.logger.error(
          "tooling",
          `PointerEventBridge: tool.handleInput rejected: ${stringifyError(err)}`,
        ),
      );
    }
    if (shouldStopPropagation) this.consume(ev);
  }

  /**
   * Decide whether to stop propagation for this event.
   *
   * Critically, we do NOT stop propagation for `pointermove` even when the
   * camera is locked. Reason: neuroglancer's `RenderedDataPanel` listens to
   * `pointermove` to schedule pick passes that update `mouseState` — which
   * is what both the brush cursor overlay and our own `resolveVoxelPosition`
   * read from. If we stopPropagation on pointermove, mouseState freezes, the
   * cursor stops following the mouse, and the brush stamps the same voxel
   * repeatedly. The camera lock is preserved instead by stopping
   * `pointerdown` (which is what would start a pan via neuroglancer's
   * `at:mousedown0` -> `translate-via-mouse-drag` binding); once the pan
   * never starts, propagating subsequent moves is harmless.
   */
  private shouldStopPropagation(
    ev: Event,
    result: InputHandling | Promise<InputHandling>,
    cameraLocked: boolean,
  ): boolean {
    if (this.isPointerEvent(ev) && ev.type === "pointermove") {
      return false;
    }
    if (cameraLocked) return true;
    if (!(result instanceof Promise) && result.consumed) return true;
    return false;
  }

  private consume(ev: Event): void {
    ev.stopPropagation();
    // Intentionally NOT calling `preventDefault` on pointer events here.
    // Chrome interprets `preventDefault` on `pointerdown` as a signal to
    // suppress ALL synthesized mouse events for the rest of the gesture —
    // not just `mousedown`. That breaks every downstream system that
    // depends on `mousemove` (including the panel's pick-pass, which is
    // what updates `mouseState.unsnappedPosition`). Pan-start is instead
    // suppressed by the session's `at:mousedown0` no-op binding in
    // `EditSessionHotkeyBinder`. For non-pointer events (e.g. wheel) the
    // tool can ask to `preventDefault` by returning `consumed: true` —
    // route those through a separate code path if/when needed.
    if (
      !this.isPointerEvent(ev) &&
      typeof (ev as { preventDefault?: () => void }).preventDefault ===
        "function"
    ) {
      ev.preventDefault();
    }
  }

  private isPointerEvent(ev: Event): ev is PointerEvent {
    return typeof PointerEvent !== "undefined" && ev instanceof PointerEvent;
  }

  private isPaintLikeTool(tool: Tool): boolean {
    const id = tool.id;
    return (
      id === "painting.brush" ||
      id === "painting.erase" ||
      id === "painting.fill"
    );
  }

  private isCameraLockedForEvent(ev: Event): boolean {
    if (!this.isPointerEvent(ev)) return false;
    const session = this.host.activeSession.value;
    if (session === undefined) return false;
    const tool = session.tools.getActiveTool();
    if (tool === undefined || !this.isPaintLikeTool(tool)) return false;
    // Ctrl / Cmd = explicit "pan instead of paint" — release the lock.
    if (ev.ctrlKey || ev.metaKey) return false;
    return true;
  }

  private translatePointer(
    panel: RenderedDataPanel,
    ev: PointerEvent,
    kind: PointerKind,
  ): ToolInputEvent | undefined {
    const modifiers = extractModifiers(ev);
    const at = nowMs();
    if (kind === "pointer-cancel") {
      return { kind: "pointer-cancel", at, modifiers };
    }
    const voxelPosition = this.resolveVoxelPosition();
    if (voxelPosition === undefined) return undefined;
    const screenPosition: readonly [number, number] = [ev.clientX, ev.clientY];
    const panelHint = panelKind(panel);
    if (kind === "pointer-move") {
      const button: PointerButton | "none" =
        ev.buttons === 0 ? "none" : domButtonToPointer(ev.button);
      return {
        kind: "pointer-move",
        button,
        voxelPosition,
        screenPosition,
        panelHint,
        at,
        modifiers,
      };
    }
    if (kind === "pointer-up") {
      return {
        kind: "pointer-up",
        button: domButtonToPointer(ev.button),
        voxelPosition,
        at,
        modifiers,
      };
    }
    return {
      kind: "pointer-down",
      button: domButtonToPointer(ev.button),
      voxelPosition,
      screenPosition,
      panelHint,
      at,
      modifiers,
    };
  }

  private translateWheel(ev: WheelEvent): ToolInputEvent | undefined {
    const voxelPosition = this.resolveVoxelPosition();
    if (voxelPosition === undefined) return undefined;
    return {
      kind: "wheel",
      deltaY: ev.deltaY,
      voxelPosition,
      at: nowMs(),
      modifiers: extractModifiers(ev),
    };
  }

  private translateKey(ev: KeyboardEvent, phase: "down" | "up"): ToolInputEvent {
    return {
      kind: "key",
      phase,
      key: ev.key,
      at: nowMs(),
      modifiers: extractModifiers(ev),
    };
  }

  private resolveVoxelPosition():
    | readonly [number, number, number]
    | undefined {
    const session = this.host.activeSession.value;
    if (session === undefined) return undefined;
    const mouseState = this.host.viewer.mouseState;
    if (!mouseState.active) return undefined;
    const pos = mouseState.unsnappedPosition;
    if (pos === undefined || pos.length < 3) return undefined;
    // `mouseState.unsnappedPosition` is in the viewer's global coordinate
    // space. Each tool, however, interprets `voxelPosition` in its own working
    // resolution's voxel grid (painting / z-extrapolation `targetResolution`,
    // correspondence `writeResolution`), and the library clips every write to
    // session bounds derived in that same frame (`computeSessionVoxelBounds`).
    // We must therefore rescale through physical nanometers — never use the
    // raw position, and never `resolveVoxelAddress` (it subtracts the layer's
    // voxelOffset, yielding chunk-grid-local coords; the library expects
    // absolute scale voxels). Without this, an annotation captured at a
    // resolution other than the active tool's makes every stroke land outside
    // the session bounds and get clipped — the brush silently does nothing
    // (TM-298). When the frame data is missing (no active tool, degenerate
    // coordinate space) fall back to the raw position, which is exactly
    // correct whenever the two resolutions already match.
    const targetResolution = this.host.activeToolWorkingResolution();
    const globalScaleNm = this.host.globalVoxelSizeNm();
    if (targetResolution === undefined || globalScaleNm === undefined) {
      return [pos[0], pos[1], pos[2]];
    }
    return globalToTargetVoxel(
      [pos[0], pos[1], pos[2]],
      globalScaleNm,
      Resolution.toVoxelSize(targetResolution),
    );
  }

  // -- Stroke forwarding --------------------------------------------------
  // The DOM `pointermove` event fires synchronously, BEFORE
  // `mouseState.unsnappedPosition` has been recomputed for the new pixel
  // (the pick-pass that updates it is GPU-async). Reading `mouseState`
  // inside a pointermove handler returns the previous frame's position, so
  // the library tool sees the same voxel repeatedly and the stroke doesn't
  // advance.
  //
  // Instead, while a stroke is in flight we subscribe to
  // `mouseState.changed` and dispatch a synthetic `pointer-move` to the
  // tool each time the position resolves. The library sees a fresh
  // position on every update and the stroke moves correctly.

  private beginStrokeForwarding(panel: RenderedDataPanel): void {
    this.endActiveStroke();
    const mouseState = this.host.viewer.mouseState;
    const unsub = mouseState.changed.add(() =>
      this.forwardPointerMoveFromMouseState(panel),
    );
    this.activeStroke = {
      panel,
      unsubscribeMouseState: unsub,
      lastVoxel: undefined,
    };
  }

  private endActiveStroke(): void {
    const stroke = this.activeStroke;
    if (stroke === undefined) return;
    try {
      stroke.unsubscribeMouseState();
    } catch {
      // ignore
    }
    this.activeStroke = undefined;
  }

  private forwardPointerMoveFromMouseState(panel: RenderedDataPanel): void {
    const stroke = this.activeStroke;
    if (stroke === undefined || stroke.panel !== panel) return;
    const session = this.host.activeSession.value;
    if (session === undefined) {
      this.endActiveStroke();
      return;
    }
    const tool = session.tools.getActiveTool();
    if (
      tool === undefined ||
      tool.handleInput === undefined ||
      !this.isPaintLikeTool(tool)
    ) {
      this.endActiveStroke();
      return;
    }
    const voxelPosition = this.resolveVoxelPosition();
    if (voxelPosition === undefined) return;
    if (
      stroke.lastVoxel !== undefined &&
      stroke.lastVoxel[0] === voxelPosition[0] &&
      stroke.lastVoxel[1] === voxelPosition[1] &&
      stroke.lastVoxel[2] === voxelPosition[2]
    ) {
      return;
    }
    stroke.lastVoxel = voxelPosition;
    const mouseState = this.host.viewer.mouseState;
    const event: ToolInputEvent = {
      kind: "pointer-move",
      button: "primary",
      voxelPosition,
      screenPosition: [mouseState.pageX ?? 0, mouseState.pageY ?? 0],
      panelHint: panel.constructor.name,
      at: nowMs(),
      modifiers: NO_MODIFIERS,
    };
    try {
      const result = tool.handleInput(event);
      if (result instanceof Promise) {
        result.catch((err) =>
          this.host.logger.error(
            "tooling",
            `PointerEventBridge: stroke handleInput rejected: ${stringifyError(err)}`,
          ),
        );
      }
    } catch (err) {
      this.host.logger.error(
        "tooling",
        `PointerEventBridge: stroke handleInput threw: ${stringifyError(err)}`,
      );
    }
  }
}

function domButtonToPointer(button: number): PointerButton {
  switch (button) {
    case 0:
      return "primary";
    case 2:
      return "secondary";
    case 1:
      return "auxiliary";
    default:
      return "primary";
  }
}

function extractModifiers(
  ev: PointerEvent | KeyboardEvent | WheelEvent,
): ModifierState {
  if (!ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
    return NO_MODIFIERS;
  }
  return {
    shift: ev.shiftKey,
    ctrl: ev.ctrlKey,
    alt: ev.altKey,
    meta: ev.metaKey,
  };
}

function nowMs(): number {
  return Date.now();
}

function panelKind(panel: RenderedPanel): string {
  return panel.constructor.name;
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
