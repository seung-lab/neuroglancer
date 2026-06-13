/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { Resolution } from "@zettaai/edit-session";

import type { DisplayContext, RenderedPanel } from "#src/display_context.js";
import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { globalToTargetVoxel } from "#src/editing/raster/global_voxel_conversion.js";
import type { SliceProjectionInfo } from "#src/editing/raster/slice_pixel_to_voxel.js";
import {
  slicePixelToGlobalPosition,
  slicePixelToTargetVoxel,
} from "#src/editing/raster/slice_pixel_to_voxel.js";
import { paintProfiler } from "#src/editing/tool_runtimes/paint_profiler.js";
import type {
  InputHandling,
  ModifierState,
  PointerButton,
  Tool,
  ToolInputEvent,
} from "#src/editing/tool_runtimes/tool_input.js";
import { NO_MODIFIERS } from "#src/editing/tool_runtimes/tool_input.js";
import { RenderedDataPanel } from "#src/rendered_data_panel.js";
import { SliceViewPanel } from "#src/sliceview/panel.js";
import { RefCounted } from "#src/util/disposable.js";
import { vec3 } from "#src/util/geom.js";

type PointerKind =
  | "pointer-down"
  | "pointer-move"
  | "pointer-up"
  | "pointer-cancel";

type VoxelPos = readonly [number, number, number];

/** How a stroke's positions are sourced (see {@link ActiveStrokeState}). */
type StrokeSource = "slice" | "perspective";

/**
 * Per-`pointermove` snapshot for the synchronous slice transform, reused across
 * that event's coalesced samples (see `sliceContext`). `originLeft`/`originTop`
 * convert a client pixel to a panel-relative pixel.
 */
interface SliceContext {
  readonly proj: SliceProjectionInfo;
  readonly navPosition: ArrayLike<number>;
  readonly globalScaleNm: readonly [number, number, number];
  readonly voxelSize: readonly [number, number, number];
  readonly originLeft: number;
  readonly originTop: number;
}

/**
 * Per-stroke dispatch state: a free-running sample buffer drained one segment
 * at a time (TM-320 / TM-321).
 *
 * Input arrives at the full pointer-event rate and is appended to `samples` in
 * O(1) — the raw stroke-sample buffer. A consumer drains it: at most ONE stroke
 * `handleInput` is dispatched at a time (`inFlight`); while one is in flight,
 * samples keep accumulating, and when it settles `drainStroke` takes the WHOLE
 * accumulated buffer as one coalesced segment (`to` = last sample, the rest as
 * `viaVoxelPositions`). The compute rasterizes the whole polyline as one
 * footprint, so coverage is exact and morphology stays at one worker round-trip
 * per *delivered* segment — the dispatch cadence adapts to op throughput and the
 * queue can never grow beyond one op. This is self-balancing backpressure with
 * zero sample loss.
 *
 * Position source depends on the panel (`source`):
 *  - `slice`: the DOM `pointermove` handler converts every coalesced event
 *    synchronously to a voxel (no GPU pick lag, no dropped sub-frame samples).
 *  - `perspective`: no synchronous slice transform exists, so we keep the
 *    legacy path — subscribe to `mouseState.changed` and read the (pick-pass)
 *    `unsnappedPosition` once per frame.
 */
interface ActiveStrokeState {
  readonly panel: RenderedDataPanel;
  readonly source: StrokeSource;
  /** Releases the `mouseState.changed` subscription (perspective only; no-op for slice). */
  unsubscribeMouseState: () => void;
  /** Last voxel dispatched — used to dedup repeat positions. */
  lastVoxel: VoxelPos | undefined;
  /** True while a dispatched `handleInput` promise has not settled. */
  inFlight: boolean;
  /**
   * Raw stroke-sample buffer: resampled voxels appended since the last
   * dispatch, oldest first. The whole buffer drains as one coalesced segment.
   */
  samples: VoxelPos[];
  /**
   * True while an idle→dispatch drain is scheduled on the next animation frame
   * (TM-317 fix 2): caps dispatch at the display refresh rate and collapses
   * multiple `pointermove`s within a frame into a single coalesced segment,
   * instead of one synchronous compute per delivered move.
   */
  drainScheduled: boolean;
  /**
   * Deferred stroke finish (`pointer-up` / `pointer-cancel`), dispatched
   * after the sample buffer drains so the library records history AFTER
   * the last segment has applied. `event === undefined` ends the stroke
   * without delivering a finish event (parity with the non-camera-locked
   * dispatch path, which never reaches the tool).
   */
  finish: { readonly event: ToolInputEvent | undefined } | undefined;
  /**
   * Callbacks released when the stroke fully drains (idle, no finish left).
   * Used to chain the NEXT stroke's `pointer-down` behind this stroke when
   * the user starts a new stroke while this one is still draining — the
   * shared library StrokeTool must see strictly ordered down/move/up.
   */
  onDrained: (() => void)[];
}

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
   * In-flight paint stroke. While set, each new position (coalesced
   * `pointermove` samples for a slice stroke, or `mouseState.changed` for a
   * perspective stroke) is appended to the sample buffer and drained one
   * segment at a time (see `ActiveStrokeState`), so the stroke never queues
   * more than one tool op. Set on `pointerdown` when a paint-like tool is
   * active; cleared on `pointerup` / `pointercancel` (the detached stroke
   * object keeps draining its remaining buffer).
   */
  private activeStroke: ActiveStrokeState | undefined;
  /**
   * Pending `requestAnimationFrame` handles for idle→dispatch drains (one per
   * stroke), tracked so disposal can cancel them. See `scheduleStrokeDrain`.
   */
  private readonly drainHandles = new Set<number>();

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
    for (const handle of this.drainHandles) cancelAnimationFrame(handle);
    this.drainHandles.clear();
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
      const cameraLocked = this.isCameraLockedForEvent(ev);
      const strokeStart = cameraLocked && ev.button === 0;
      const prev = this.activeStroke;
      if (strokeStart && prev !== undefined && this.strokeHasWork(prev)) {
        // The previous stroke is still draining its coalesced queue (its
        // deferred pointer-up included). Chain this stroke's pointer-down
        // behind it so the shared library StrokeTool sees strictly ordered
        // down/move/up events; the gate releases within one op.
        const event = this.translatePointer(panel, ev, "pointer-down");
        this.consume(ev);
        const stroke = this.beginStrokeForwarding(panel, { gated: true });
        prev.onDrained.push(() => {
          if (event !== undefined) {
            this.dispatchStrokeEvent(stroke, event);
          } else {
            stroke.inFlight = false;
            this.drainStroke(stroke);
          }
        });
        return;
      }
      const result = this.dispatch(ev, () =>
        this.translatePointer(panel, ev, "pointer-down"),
      );
      if (strokeStart) {
        // Gate the first moves behind the pointer-down op itself, so the
        // down-stamp and the first segment can't interleave.
        this.beginStrokeForwarding(
          panel,
          result instanceof Promise ? { downOp: result } : {},
        );
      }
    };
    const onPointerMove = (ev: PointerEvent) => {
      // Keep the brush cursor on the pointer synchronously (TM-325): paint
      // input no longer waits for the pick pass, so the cursor must not either.
      this.updateSliceCursorCenter(panel, ev);
      // A slice stroke is driven directly from `pointermove`: convert every
      // coalesced sample synchronously and feed the sample buffer (TM-320).
      // Other cases fall through to the standard dispatch (which skips
      // `pointermove` for paint tools — perspective strokes are driven from
      // `mouseState.changed` instead).
      const stroke = this.activeStroke;
      if (
        stroke !== undefined &&
        stroke.panel === panel &&
        stroke.source === "slice"
      ) {
        this.forwardSliceCoalescedMove(stroke, ev);
        return;
      }
      this.dispatch(ev, () => this.translatePointer(panel, ev, "pointer-move"));
    };
    const onPointerUp = (ev: PointerEvent) => {
      if (this.requestStrokeFinish(panel, ev, "pointer-up")) return;
      this.dispatch(ev, () => this.translatePointer(panel, ev, "pointer-up"));
      this.endActiveStroke();
    };
    const onPointerCancel = (ev: PointerEvent) => {
      if (this.requestStrokeFinish(panel, ev, "pointer-cancel")) return;
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

  /**
   * Returns the tool's `handleInput` result (or `undefined` when the event
   * never reached the tool) so stroke begin can gate behind the pointer-down
   * op.
   */
  private dispatch(
    ev: Event,
    translate: () => ToolInputEvent | undefined,
  ): InputHandling | Promise<InputHandling> | undefined {
    const session = this.host.activeSession.value;
    if (session === undefined) return;
    const tool: Tool | undefined = this.activeTool();
    if (tool === undefined || tool.handleInput === undefined) return;

    // Camera lock: when a paint-like tool is active and the user is using
    // primary-button input WITHOUT Ctrl/Cmd, prevent neuroglancer's pan from
    // ever starting (otherwise click+drag = pan instead of brush stroke).
    // With Ctrl/Cmd held we bail BEFORE running the tool so the event falls
    // through to neuroglancer for default pan handling.
    const cameraLocked = this.isCameraLockedForEvent(ev);
    if (
      this.isPointerEvent(ev) &&
      this.isPaintLikeTool(tool) &&
      !cameraLocked
    ) {
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
        "editing",
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
        "editing",
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
          "editing",
          `PointerEventBridge: tool.handleInput rejected: ${stringifyError(err)}`,
        ),
      );
    }
    if (shouldStopPropagation) this.consume(ev);
    return result;
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

  /**
   * The currently-active consumer tool, resolved from the host's active-tool
   * id and its painting tools (TM-315). Replaces the library's removed
   * `session.tools.getActiveTool()`.
   */
  private activeTool(): Tool | undefined {
    return this.host.painting?.getTool(this.host.activeToolId.value);
  }

  private isCameraLockedForEvent(ev: Event): boolean {
    if (!this.isPointerEvent(ev)) return false;
    const session = this.host.activeSession.value;
    if (session === undefined) return false;
    const tool = this.activeTool();
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
    const voxelPosition = this.resolveVoxelForPointer(panel, ev);
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

  private translateKey(
    ev: KeyboardEvent,
    phase: "down" | "up",
  ): ToolInputEvent {
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

  private isActiveToolPaintLike(): boolean {
    const tool = this.activeTool();
    return tool !== undefined && this.isPaintLikeTool(tool);
  }

  /**
   * Resolve the target voxel for a pointer event. On a slice panel with a
   * paint-like tool active, use the synchronous slice transform (full rate, no
   * pick-pass lag); otherwise fall back to the pick-driven `mouseState`
   * position (perspective panels, non-paint tools).
   */
  private resolveVoxelForPointer(
    panel: RenderedDataPanel,
    ev: PointerEvent,
  ): VoxelPos | undefined {
    if (panel instanceof SliceViewPanel && this.isActiveToolPaintLike()) {
      const ctx = this.sliceContext(panel);
      if (ctx !== undefined) {
        return this.voxelFromClient(ctx, ev.clientX, ev.clientY);
      }
    }
    return this.resolveVoxelPosition();
  }

  /**
   * Snapshot everything needed to map a client pixel on `panel` to a target
   * voxel synchronously, computed once per `pointermove` and reused across that
   * event's coalesced samples. Returns undefined when prerequisites are missing
   * (no active tool resolution / global scale, or the viewport is not yet laid
   * out) so callers fall back to the pick-driven path.
   */
  private sliceContext(panel: SliceViewPanel): SliceContext | undefined {
    const targetResolution = this.host.activeToolWorkingResolution();
    const globalScaleNm = this.host.globalVoxelSizeNm();
    if (targetResolution === undefined || globalScaleNm === undefined) {
      return undefined;
    }
    const vp = panel.renderViewport;
    if (vp.width <= 0 || vp.height <= 0) return undefined;
    const pp = panel.sliceView.projectionParameters.value;
    const { displayDimensionRenderInfo } = pp;
    const el = panel.element;
    const bounds = el.getBoundingClientRect();
    const proj: SliceProjectionInfo = {
      invViewProjectionMat: pp.invViewProjectionMat,
      width: vp.width,
      height: vp.height,
      logicalWidth: vp.logicalWidth,
      logicalHeight: vp.logicalHeight,
      visibleLeftFraction: vp.visibleLeftFraction,
      visibleTopFraction: vp.visibleTopFraction,
      displayDimensionIndices:
        displayDimensionRenderInfo.displayDimensionIndices,
      displayRank: displayDimensionRenderInfo.displayRank,
    };
    return {
      proj,
      navPosition: this.host.viewer.navigationState.position.value,
      globalScaleNm,
      voxelSize: Resolution.toVoxelSize(targetResolution),
      originLeft: bounds.left + el.clientLeft,
      originTop: bounds.top + el.clientTop,
    };
  }

  private voxelFromClient(
    ctx: SliceContext,
    clientX: number,
    clientY: number,
  ): VoxelPos {
    return slicePixelToTargetVoxel(
      ctx.proj,
      ctx.navPosition,
      clientX - ctx.originLeft,
      clientY - ctx.originTop,
      ctx.globalScaleNm,
      ctx.voxelSize,
    );
  }

  /**
   * Feed the brush cursor a synchronous global center (TM-325) so it tracks the
   * pointer as tightly as the pick-independent paint does. Set on every slice
   * paint `pointermove` (hover or active stroke); cleared otherwise so the
   * cursor falls back to the pick-driven `mouseState` (perspective panels,
   * non-paint tools).
   */
  private updateSliceCursorCenter(
    panel: RenderedDataPanel,
    ev: PointerEvent,
  ): void {
    const cursor = this.host.brushCursor;
    if (cursor === undefined) return;
    if (!(panel instanceof SliceViewPanel) || !this.isActiveToolPaintLike()) {
      cursor.setSliceCenterOverride(undefined);
      return;
    }
    const ctx = this.sliceContext(panel);
    if (ctx === undefined) {
      cursor.setSliceCenterOverride(undefined);
      return;
    }
    const global = slicePixelToGlobalPosition(
      ctx.proj,
      ctx.navPosition,
      ev.clientX - ctx.originLeft,
      ev.clientY - ctx.originTop,
    );
    cursor.setSliceCenterOverride(
      vec3.fromValues(global[0], global[1], global[2]),
    );
  }

  /** Coalesced samples of a pointermove, or the event itself when unsupported. */
  private coalescedEvents(ev: PointerEvent): readonly PointerEvent[] {
    const events =
      typeof ev.getCoalescedEvents === "function"
        ? ev.getCoalescedEvents()
        : [];
    return events.length > 0 ? events : [ev];
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

  private beginStrokeForwarding(
    panel: RenderedDataPanel,
    opts: { downOp?: Promise<InputHandling>; gated?: boolean } = {},
  ): ActiveStrokeState {
    this.endActiveStroke();
    const source: StrokeSource =
      panel instanceof SliceViewPanel ? "slice" : "perspective";
    const stroke: ActiveStrokeState = {
      panel,
      source,
      unsubscribeMouseState: () => {},
      lastVoxel: undefined,
      // Gated until the pointer-down op settles (or, for a chained stroke,
      // until the previous stroke drains and the deferred down dispatches).
      inFlight: opts.downOp !== undefined || opts.gated === true,
      samples: [],
      drainScheduled: false,
      finish: undefined,
      onDrained: [],
    };
    if (source === "perspective") {
      // No synchronous slice transform for 3D views — drive moves from the
      // pick-updated mouseState, as before. Slice strokes are driven from the
      // DOM `pointermove` handler instead (see `forwardSliceCoalescedMove`).
      const mouseState = this.host.viewer.mouseState;
      stroke.unsubscribeMouseState = mouseState.changed.add(() =>
        this.forwardPointerMoveFromMouseState(panel),
      );
    }
    this.activeStroke = stroke;
    if (opts.downOp !== undefined) {
      // `dispatch` already logs rejections; here we only need the settle
      // signal to open the gate.
      const settle = () => {
        stroke.inFlight = false;
        this.drainStroke(stroke);
      };
      opts.downOp.then(settle, settle);
    }
    return stroke;
  }

  /**
   * Stop feeding the active stroke and detach it. The detached stroke object
   * keeps draining whatever is already queued (its in-flight op's settle
   * handler drives `drainStroke`); only the mouseState subscription and the
   * `activeStroke` slot are released here.
   */
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

  private strokeHasWork(stroke: ActiveStrokeState): boolean {
    return (
      stroke.inFlight ||
      stroke.samples.length > 0 ||
      stroke.finish !== undefined
    );
  }

  /**
   * Defer the stroke finish (`pointer-up` / `pointer-cancel`) behind the
   * stroke's coalesced queue, so the library records history AFTER the last
   * segment has applied. Returns false when there is no active stroke on
   * `panel` or it is idle — the caller falls back to the direct dispatch
   * path, which is then equivalent.
   */
  private requestStrokeFinish(
    panel: RenderedDataPanel,
    ev: PointerEvent,
    kind: "pointer-up" | "pointer-cancel",
  ): boolean {
    const stroke = this.activeStroke;
    if (stroke === undefined || stroke.panel !== panel) return false;
    if (!this.strokeHasWork(stroke)) return false;
    const cameraLocked = this.isCameraLockedForEvent(ev);
    // Without the camera lock (Ctrl/Cmd held) the direct path would never
    // deliver the event to the tool — mirror that by ending the stroke with
    // no finish event.
    const event = cameraLocked
      ? this.translatePointer(panel, ev, kind)
      : undefined;
    if (kind === "pointer-cancel") {
      // A canceled stroke must not paint its trailing coalesced segment.
      stroke.samples = [];
    }
    stroke.finish = { event };
    this.endActiveStroke();
    // Flush now rather than waiting for the scheduled frame drain (TM-317
    // fix 2), so the stroke commits deterministically on pointer-up: dispatch
    // any buffered samples (their settle then drives the finish) or the finish
    // directly. A pending frame drain, if any, no-ops once this has run.
    if (!stroke.inFlight) this.drainStroke(stroke);
    if (cameraLocked) this.consume(ev);
    return true;
  }

  /**
   * Verify the stroke's session and paint tool are still live; tear the stroke
   * down and return false otherwise. Shared by both position sources.
   */
  private strokeStillPaintable(): boolean {
    if (this.host.activeSession.value === undefined) {
      this.endActiveStroke();
      return false;
    }
    const tool = this.activeTool();
    if (
      tool === undefined ||
      tool.handleInput === undefined ||
      !this.isPaintLikeTool(tool)
    ) {
      this.endActiveStroke();
      return false;
    }
    return true;
  }

  /**
   * Append a resampled voxel to the stroke's sample buffer, deduping repeats
   * (against the buffer tail, or the last dispatched voxel when empty).
   */
  private pushStrokeSample(stroke: ActiveStrokeState, voxel: VoxelPos): void {
    const last =
      stroke.samples.length > 0
        ? stroke.samples[stroke.samples.length - 1]
        : stroke.lastVoxel;
    if (
      last !== undefined &&
      last[0] === voxel[0] &&
      last[1] === voxel[1] &&
      last[2] === voxel[2]
    ) {
      return;
    }
    stroke.samples.push(voxel);
  }

  /**
   * Slice stroke position source (TM-320): convert every coalesced sample of a
   * DOM `pointermove` synchronously and append it to the buffer, then kick the
   * drain if idle. Full pointer-event rate, no pick-pass lag, no dropped
   * sub-frame samples.
   */
  private forwardSliceCoalescedMove(
    stroke: ActiveStrokeState,
    ev: PointerEvent,
  ): void {
    if (!this.strokeStillPaintable()) return;
    const panel = stroke.panel;
    if (!(panel instanceof SliceViewPanel)) return;
    const ctx = this.sliceContext(panel);
    if (ctx === undefined) return;
    for (const e of this.coalescedEvents(ev)) {
      this.pushStrokeSample(
        stroke,
        this.voxelFromClient(ctx, e.clientX, e.clientY),
      );
    }
    if (!stroke.inFlight) this.scheduleStrokeDrain(stroke);
  }

  /**
   * Perspective stroke position source: read the pick-updated mouseState once
   * per frame (no synchronous transform for 3D views) and append it.
   */
  private forwardPointerMoveFromMouseState(panel: RenderedDataPanel): void {
    const stroke = this.activeStroke;
    if (stroke === undefined || stroke.panel !== panel) return;
    if (!this.strokeStillPaintable()) return;
    const voxelPosition = this.resolveVoxelPosition();
    if (voxelPosition === undefined) return;
    this.pushStrokeSample(stroke, voxelPosition);
    if (!stroke.inFlight) this.scheduleStrokeDrain(stroke);
  }

  /**
   * Coalesce idle→dispatch to one per animation frame (TM-317 fix 2). While a
   * stroke is idle, accumulating samples schedule a single rAF drain rather
   * than dispatching synchronously per `pointermove`; multiple moves in a frame
   * then collapse into one coalesced segment, bounding main-thread compute to
   * the refresh rate. Settle-driven drains stay immediate (see `drainStroke`
   * callers), so a slow (worker) brush gains no extra latency. The handle is
   * captured per stroke so a detached stroke still flushes; disposal cancels
   * all pending handles.
   */
  private scheduleStrokeDrain(stroke: ActiveStrokeState): void {
    if (stroke.drainScheduled) return;
    stroke.drainScheduled = true;
    const handle = requestAnimationFrame(() => {
      this.drainHandles.delete(handle);
      stroke.drainScheduled = false;
      if (!stroke.inFlight) this.drainStroke(stroke);
    });
    this.drainHandles.add(handle);
  }

  /**
   * Dispatch the next work once the in-flight op has settled: drain the WHOLE
   * accumulated sample buffer as one coalesced segment (`to` = last sample,
   * the rest as `viaVoxelPositions`), then the deferred finish, and when empty
   * release anything chained behind this stroke (a deferred next-stroke
   * pointer-down).
   */
  private drainStroke(stroke: ActiveStrokeState): void {
    if (stroke.inFlight) return;
    if (stroke.samples.length > 0) {
      const samples = stroke.samples;
      stroke.samples = [];
      const to = samples[samples.length - 1];
      const via = samples.slice(0, -1);
      this.dispatchStrokeMove(stroke, to, via);
      return;
    }
    if (stroke.finish !== undefined) {
      const event = stroke.finish.event;
      stroke.finish = undefined;
      if (event !== undefined) {
        this.dispatchStrokeEvent(stroke, event);
        return;
      }
    }
    const callbacks = stroke.onDrained.splice(0);
    for (const cb of callbacks) cb();
  }

  private dispatchStrokeMove(
    stroke: ActiveStrokeState,
    voxelPosition: VoxelPos,
    via: readonly VoxelPos[],
  ): void {
    stroke.lastVoxel = voxelPosition;
    const mouseState = this.host.viewer.mouseState;
    const event: ToolInputEvent = {
      kind: "pointer-move",
      button: "primary",
      voxelPosition,
      ...(via.length > 0 ? { viaVoxelPositions: via } : {}),
      screenPosition: [mouseState.pageX ?? 0, mouseState.pageY ?? 0],
      panelHint: panelKind(stroke.panel),
      at: nowMs(),
      modifiers: NO_MODIFIERS,
    };
    if (paintProfiler.enabled && via.length > 0) {
      paintProfiler.count("segments.coalescedVia", via.length);
    }
    this.dispatchStrokeEvent(stroke, event);
  }

  /**
   * Dispatch one stroke event to the active paint tool and wire its settle
   * into the drain loop. Any failure (session/tool gone, sync throw) drops
   * the remaining queue but still releases chained strokes.
   */
  private dispatchStrokeEvent(
    stroke: ActiveStrokeState,
    event: ToolInputEvent,
  ): void {
    const session = this.host.activeSession.value;
    const tool = this.activeTool();
    if (
      session === undefined ||
      tool === undefined ||
      tool.handleInput === undefined ||
      !this.isPaintLikeTool(tool)
    ) {
      stroke.inFlight = false;
      stroke.samples = [];
      stroke.finish = undefined;
      this.drainStroke(stroke);
      return;
    }
    // Profiling (Step 1): time the WHOLE handleInput — compute
    // (`applyBrushStroke`, bucketed as `0.stroke(total)`) plus the library apply
    // (`withBatch` + `applyPaintBatch`). `4.handleInput(total) - 0.stroke(total)`
    // is the apply half. (GPU upload happens later on the render frame and is
    // not captured here — read it from a Performance flame chart.)
    const profileMove = paintProfiler.enabled && event.kind === "pointer-move";
    const applyStart = profileMove ? performance.now() : 0;
    let result: InputHandling | Promise<InputHandling>;
    try {
      result = tool.handleInput(event);
    } catch (err) {
      this.host.logger.error(
        "editing",
        `PointerEventBridge: stroke handleInput threw: ${stringifyError(err)}`,
      );
      stroke.inFlight = false;
      this.drainStroke(stroke);
      return;
    }
    if (result instanceof Promise) {
      stroke.inFlight = true;
      result
        .catch((err) =>
          this.host.logger.error(
            "editing",
            `PointerEventBridge: stroke handleInput rejected: ${stringifyError(err)}`,
          ),
        )
        .finally(() => {
          if (profileMove) {
            paintProfiler.record(
              "4.handleInput(total)",
              performance.now() - applyStart,
            );
          }
          stroke.inFlight = false;
          this.drainStroke(stroke);
        });
    } else {
      if (profileMove) {
        paintProfiler.record(
          "4.handleInput(total)",
          performance.now() - applyStart,
        );
      }
      stroke.inFlight = false;
      this.drainStroke(stroke);
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
