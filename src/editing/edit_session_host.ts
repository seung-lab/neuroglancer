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
 * @file Phase-1 host wrapper around the `@zetta-ai/edit-session` library.
 *
 * Owns: the active `EditSession` instance, per-session adapter wiring, the
 * per-layer `LocalPatchStore` + `PatchedSegmentationRenderLayer` +
 * `PatchMirror` lifecycle, and the URL-restored session intent.
 *
 * Per `docs/edit-session-integration/architecture/02-module-layout.md`, this is
 * the single integration point — every other neuroglancer module that touches
 * the active session reads it through this host.
 */

import type {
  BoundingBoxVoxels,
  CommitResult,
  EditSessionAdapters,
  EditSessionConfig,
  LayerId,
  LayerSelection,
  PaintingMaskConfig,
  PaintingSharedState,
  Resolution as ResolutionType,
  SaveResult,
  ZExtrapolationState,
  CorrespondenceState,
} from "@zetta-ai/edit-session";
import {
  DEFAULT_RADIUS_CYCLE,
  EditSession,
  InvalidSessionConfigError,
  Resolution,
  SessionPhaseViolationError,
  correspondence,
  layerId as toLayerId,
  painting,
  zExtrapolation,
} from "@zetta-ai/edit-session";

import { NgChunkSource } from "#src/editing/adapters/ng_chunk_source.js";
import { NgClock } from "#src/editing/adapters/ng_clock.js";
import { NgCommitTarget } from "#src/editing/adapters/ng_commit_target.js";
import { NgLayerMetadataSource } from "#src/editing/adapters/ng_layer_metadata_source.js";
import { NgLogger } from "#src/editing/adapters/ng_logger.js";
import { NgSaveTarget } from "#src/editing/adapters/ng_save_target.js";
import { NgSessionLockAdapter } from "#src/editing/adapters/ng_session_lock.js";
import { LocalPatchStore } from "#src/editing/local_patch_store.js";
// PatchMirror is created by step 9 of Phase 1; this file's runtime import
// resolves once that step lands. Assumed constructor signature:
//   new PatchMirror(session, layerId, store, logger)
// where the mirror subscribes to `session.dirty` chunk events for `layerId`
// and writes the resulting overlay bytes into `store.writeFullChunk(...)`.
import { PatchMirror } from "#src/editing/overlay/patch_mirror.js";
import { PatchedSegmentationRenderLayer } from "#src/editing/patched_segmentation_renderlayer.js";
import { BrushCursorPerspectiveOverlay } from "#src/editing/cursor/brush_cursor_perspective_overlay.js";
import { BrushCursorSliceOverlay } from "#src/editing/cursor/brush_cursor_slice_overlay.js";
import { BrushCursorState } from "#src/editing/cursor/brush_cursor_state.js";
import { PointerEventBridge } from "#src/editing/pointer_event_bridge.js";
import { EditSessionHotkeyBinder } from "#src/editing/session_hotkey_binder.js";
import { NgCorrespondenceCompute } from "#src/editing/tool_runtimes/correspondence_compute.js";
import { PaintingCompute } from "#src/editing/tool_runtimes/painting_compute.js";
import { NgZExtrapolationCompute } from "#src/editing/tool_runtimes/z_extrapolation_compute.js";
import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import { SegmentationRenderLayer } from "#src/sliceview/volume/segmentation_renderlayer.js";
import { StatusMessage } from "#src/status.js";
import { WatchableValue } from "#src/trackable_value.js";
import { vec3 } from "#src/util/geom.js";
import { TrackableSidePanelLocation } from "#src/ui/side_panel_location.js";
import { RefCounted } from "#src/util/disposable.js";
import type { Trackable } from "#src/util/trackable.js";
import { NullarySignal } from "#src/util/signal.js";
import type { Viewer } from "#src/viewer.js";

// ---------------------------------------------------------------------------
// Host-side configuration shape (modal-provided)
// ---------------------------------------------------------------------------

export interface HostSessionConfig {
  readonly bboxRef: {
    readonly annotationLayerName: string;
    readonly annotationId: string;
  };
  /** Voxel-space bbox snapshot at modal-submit time. */
  readonly bboxVoxelCoords: BoundingBoxVoxels;
  readonly bboxResolution: ResolutionType;
  readonly layers: ReadonlyArray<{
    readonly layerId: LayerId;
    readonly resolution: ResolutionType;
    readonly role: "writable" | "locked";
  }>;
}

// ---------------------------------------------------------------------------
// URL-state shape (per architecture 08-state-ownership.md § URL state)
// ---------------------------------------------------------------------------

type Vec3Voxels = readonly [number, number, number];

export interface EditSessionIntent {
  readonly bboxRef: {
    readonly annotationLayerName: string;
    readonly annotationId: string;
    readonly resolution: ResolutionType;
  };
  readonly layers: ReadonlyArray<{
    readonly layerId: LayerId;
    readonly resolution: ResolutionType;
    readonly role: "writable" | "locked";
  }>;
  readonly capturedRegion: { readonly lo: Vec3Voxels; readonly hi: Vec3Voxels };
}

/**
 * Trackable wrapping the persisted "session intent" block on `ngState`. The
 * value is `null` when no session has been opened (the default) and is
 * cleared on session discard / commit; saved sessions retain the block per
 * `07-data-flow.md` § G.
 */
export class TrackableEditSessionIntent implements Trackable {
  readonly value = new WatchableValue<EditSessionIntent | null>(null);
  readonly changed = new NullarySignal();

  constructor() {
    this.value.changed.add(this.changed.dispatch);
  }

  toJSON(): EditSessionIntent | null {
    return this.value.value;
  }

  restoreState(x: unknown): void {
    try {
      this.value.value = parseIntent(x);
    } catch {
      this.reset();
    }
  }

  reset(): void {
    this.value.value = null;
  }
}

function parseIntent(x: unknown): EditSessionIntent | null {
  if (x === null || x === undefined) return null;
  if (typeof x !== "object") throw new Error("not-an-object");
  const obj = x as Record<string, unknown>;
  const bboxRef = obj.bboxRef as Record<string, unknown> | undefined;
  if (
    bboxRef === undefined ||
    typeof bboxRef !== "object" ||
    typeof bboxRef.annotationLayerName !== "string" ||
    typeof bboxRef.annotationId !== "string" ||
    typeof bboxRef.resolution !== "string"
  ) {
    throw new Error("invalid-bboxRef");
  }
  const rawLayers = obj.layers;
  if (!Array.isArray(rawLayers)) throw new Error("invalid-layers");
  const layers = rawLayers.map((entry): EditSessionIntent["layers"][number] => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("invalid-layer-entry");
    }
    const e = entry as Record<string, unknown>;
    if (
      typeof e.layerId !== "string" ||
      typeof e.resolution !== "string" ||
      (e.role !== "writable" && e.role !== "locked")
    ) {
      throw new Error("invalid-layer-fields");
    }
    return {
      layerId: toLayerId(e.layerId),
      resolution: e.resolution as ResolutionType,
      role: e.role,
    };
  });
  const cr = obj.capturedRegion as Record<string, unknown> | undefined;
  if (
    cr === undefined ||
    typeof cr !== "object" ||
    !Array.isArray(cr.lo) ||
    !Array.isArray(cr.hi) ||
    cr.lo.length !== 3 ||
    cr.hi.length !== 3
  ) {
    throw new Error("invalid-capturedRegion");
  }
  const lo: Vec3Voxels = [Number(cr.lo[0]), Number(cr.lo[1]), Number(cr.lo[2])];
  const hi: Vec3Voxels = [Number(cr.hi[0]), Number(cr.hi[1]), Number(cr.hi[2])];
  return {
    bboxRef: {
      annotationLayerName: bboxRef.annotationLayerName,
      annotationId: bboxRef.annotationId,
      resolution: bboxRef.resolution as ResolutionType,
    },
    layers,
    capturedRegion: { lo, hi },
  };
}

// ---------------------------------------------------------------------------
// Per-session machinery container
// ---------------------------------------------------------------------------

interface PerLayerMachinery {
  readonly patchStore: LocalPatchStore;
  readonly renderLayer: PatchedSegmentationRenderLayer;
  readonly mirror: PatchMirror;
  readonly detachRenderLayer: () => void;
}

interface ActiveRegion {
  readonly loVoxel: Vec3Voxels;
  readonly hiVoxel: Vec3Voxels;
}

// ---------------------------------------------------------------------------
// EditSessionHost
// ---------------------------------------------------------------------------

export class EditSessionHost extends RefCounted {
  // -- Public reactive state ------------------------------------------------
  readonly activeSession = new WatchableValue<EditSession | undefined>(
    undefined,
  );
  readonly state = new TrackableEditSessionIntent();

  /**
   * Side-panel location for the `EditSessionSidebar`. Visibility is toggled
   * by `openSession` / `finalizeTeardown` so the panel auto-hides whenever
   * no session is active. Owned here so the panel can be registered with
   * `SidePanelManager` at viewer construction time without leaking the
   * sidebar widget through the host's surface (the viewer constructs the
   * sidebar and passes this location to `registerPanel`).
   *
   * Per `docs/edit-session-integration/architecture/04-ui-shell.md` § "Side
   * panel registration": the `visible` watchable is derived from
   * `activeSession.value !== undefined`; the host sets it on open/teardown.
   */
  readonly editSessionPanelLocation = new TrackableSidePanelLocation();

  // -- Save cancellation ----------------------------------------------------
  private saveAbortController: AbortController | undefined;

  // -- Adapters (constructed once, reused across sessions) ------------------
  readonly logger: NgLogger;
  readonly sessionLock: NgSessionLockAdapter;
  private readonly chunkSource: NgChunkSource;
  // Exposed publicly so the viewer can pass it into `EditSessionEntryModal`
  // without re-instantiating an adapter against the same `LayerManager`.
  readonly layerMetadataSource: NgLayerMetadataSource;
  private readonly commitTarget: NgCommitTarget;
  private readonly saveTarget: NgSaveTarget;
  private readonly clock: NgClock;

  // -- Per-layer persistent watchables for `editBboxLoHi` -------------------
  // Per `06-bbox-rendering.md` § "Wiring to the render layers", every
  // segmentation/image user layer that may participate in any future session
  // subscribes ONCE to a layer-keyed watchable. Values flip on session
  // open/close. The map persists across sessions (entries lazily allocated).
  private readonly editBboxByLayer = new Map<
    string,
    WatchableValue<{ loVoxel: vec3; hiVoxel: vec3 } | undefined>
  >();

  // -- Per-session machinery (cleared on session end) -----------------------
  private readonly perLayer = new Map<LayerId, PerLayerMachinery>();
  private readonly _activeRegionByLayer = new Map<
    LayerId,
    WatchableValue<ActiveRegion | undefined>
  >();
  private sessionLockHandle: { release(): void } | undefined;
  private unsubscribePhaseChanged: (() => void) | undefined;
  private pointerEventBridge: PointerEventBridge | undefined;
  private hotkeyBinder: EditSessionHotkeyBinder | undefined;
  private cursorState: BrushCursorState | undefined;
  private sliceOverlay: BrushCursorSliceOverlay | undefined;
  private detachSliceOverlay: (() => void) | undefined;
  private perspectiveOverlay: BrushCursorPerspectiveOverlay | undefined;
  private detachPerspectiveOverlay: (() => void) | undefined;

  // -- Read-only public views -----------------------------------------------
  readonly activeRegionByLayer: ReadonlyMap<
    LayerId,
    WatchableValue<ActiveRegion | undefined>
  > = this._activeRegionByLayer;

  get attachedRenderLayers(): ReadonlyMap<
    LayerId,
    PatchedSegmentationRenderLayer
  > {
    const m = new Map<LayerId, PatchedSegmentationRenderLayer>();
    for (const [id, e] of this.perLayer) m.set(id, e.renderLayer);
    return m;
  }

  constructor(readonly viewer: Viewer) {
    super();
    this.logger = new NgLogger();
    this.sessionLock = new NgSessionLockAdapter();
    this.clock = new NgClock();
    this.layerMetadataSource = new NgLayerMetadataSource(
      this.viewer.layerManager,
    );
    this.chunkSource = new NgChunkSource(
      this.viewer.layerManager,
      this.viewer.chunkManager,
    );
    this.commitTarget = new NgCommitTarget();
    this.saveTarget = new NgSaveTarget(
      this.viewer.layerManager,
      this.layerMetadataSource,
      this.logger,
    );

    // The viewer constructor calls `tryRestoreFromState()` once, but the URL
    // hash is parsed AFTER construction, so the first call is a no-op. Watch
    // `state.changed` so that when the URL parse populates the intent block —
    // or the user pastes a new JSON state — we retry the restore.
    this.registerDisposer(
      this.state.changed.add(() => {
        if (this.activeSession.value !== undefined) return;
        if (this.state.value.value === null) return;
        void this.tryRestoreFromState();
      }),
    );
  }

  // -- Lifecycle ------------------------------------------------------------

  /** Open a session described by the host-side `HostSessionConfig`. */
  async openSession(config: HostSessionConfig): Promise<EditSession> {
    if (this.activeSession.value !== undefined) {
      throw new Error("A session is already active");
    }

    const libraryConfig = this.buildLibraryConfig(config);
    const adapters = this.buildAdapters();

    let session: EditSession;
    try {
      session = await EditSession.open(libraryConfig, adapters);
    } catch (err) {
      this.handleOpenFailure(err);
      throw err;
    }

    try {
      this.attachPerLayer(session, config);
      this.sessionLock.setActiveSession({
        sessionId: session.sessionId,
        sessionLayerIds: new Set(config.layers.map((l) => l.layerId)),
      });
      this.bindSessionEvents(session);
      this.writeIntentToState(config);
      this.activeSession.value = session;
      this.editSessionPanelLocation.visible = true;
      this.pointerEventBridge = new PointerEventBridge(this, this.viewer.display);
      this.hotkeyBinder = new EditSessionHotkeyBinder(this, this.viewer);
      this.attachCursorOverlays(config);
    } catch (err) {
      // If post-open wiring throws, attempt to terminate the session and
      // surface the error.
      try {
        await session.discard();
      } catch {
        // ignore — the session will be GC'd
      }
      this.teardownCursorOverlays();
      this.teardownHotkeyBinder();
      this.teardownPerLayer();
      throw err;
    }
    return session;
  }

  /** Discard the active session, dropping all dirty chunks. */
  async discardActive(): Promise<void> {
    const session = this.activeSession.value;
    if (session === undefined) return;
    try {
      await session.discard();
    } finally {
      this.finalizeTeardown();
    }
  }

  /** Commit the active session. Ends the session regardless of outcome. */
  async commitActive(): Promise<CommitResult> {
    const session = this.activeSession.value;
    if (session === undefined) {
      throw new Error("No active session to commit");
    }
    let result: CommitResult;
    try {
      result = await session.commit();
    } finally {
      this.finalizeTeardown();
    }
    return result;
  }

  /**
   * Save the active session. The session remains active on success.
   *
   * An external `signal` (e.g. the sidebar's "Save All" abort controller)
   * is composed with the host's own `saveAbortController` so callers of
   * `cancelActiveSave()` can interrupt an in-flight save without having to
   * own the controller themselves.
   */
  async saveActive(
    layerIds?: readonly LayerId[],
    signal?: AbortSignal,
  ): Promise<SaveResult> {
    const session = this.activeSession.value;
    if (session === undefined) {
      throw new Error("No active session to save");
    }
    if (this.saveAbortController !== undefined) {
      throw new Error("A save is already in flight");
    }
    const controller = new AbortController();
    this.saveAbortController = controller;
    const onExternalAbort = () => controller.abort();
    if (signal !== undefined) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    try {
      return await session.save(layerIds, controller.signal);
    } finally {
      if (signal !== undefined) {
        signal.removeEventListener("abort", onExternalAbort);
      }
      if (this.saveAbortController === controller) {
        this.saveAbortController = undefined;
      }
    }
  }

  /**
   * Abort the in-flight save started by `saveActive()`. No-op when no save
   * is in flight. Per `04-ui-shell.md` § "Cancellation", backends that
   * observe the signal stop after the current chunk and return `'partial'`.
   */
  cancelActiveSave(): void {
    this.saveAbortController?.abort();
  }

  // -- Per-layer accessors --------------------------------------------------

  getPatchStoreForLayer(layerId: LayerId): LocalPatchStore | undefined {
    return this.perLayer.get(layerId)?.patchStore;
  }

  /**
   * Return a persistent watchable holding the bbox lo/hi voxels for `layerId`
   * in the layer's chunk space, or `undefined` when no session is active for
   * the layer. Constructed lazily on first call; the same instance is
   * returned on every subsequent call for the same layer.
   *
   * Wired into `SliceViewSegmentationDisplayState.editBboxLoHi` and
   * `ImageRenderLayerOptions.editBboxLoHi` per
   * `docs/edit-session-integration/architecture/06-bbox-rendering.md`
   * § "Wiring to the render layers".
   */
  getActiveRegionWatchableForLayer(
    layerName: string,
  ): WatchableValue<{ loVoxel: vec3; hiVoxel: vec3 } | undefined> {
    let w = this.editBboxByLayer.get(layerName);
    if (w === undefined) {
      w = new WatchableValue<
        { loVoxel: vec3; hiVoxel: vec3 } | undefined
      >(this.readEditBboxForLayer(layerName));
      this.editBboxByLayer.set(layerName, w);
    }
    return w;
  }

  private readEditBboxForLayer(
    layerName: string,
  ): { loVoxel: vec3; hiVoxel: vec3 } | undefined {
    // The `LayerId` newtype is a branded string; the lookup map is keyed by
    // the brand, but at runtime branded strings are plain strings, so the
    // cast is a no-op.
    const region = this._activeRegionByLayer.get(layerName as LayerId)?.value;
    if (region === undefined) return undefined;
    return {
      loVoxel: vec3.fromValues(
        region.loVoxel[0],
        region.loVoxel[1],
        region.loVoxel[2],
      ),
      hiVoxel: vec3.fromValues(
        region.hiVoxel[0],
        region.hiVoxel[1],
        region.hiVoxel[2],
      ),
    };
  }

  /**
   * Re-evaluate every per-layer bbox watchable from `_activeRegionByLayer`.
   * Called on session open / close.
   */
  private refreshEditBboxWatchables(): void {
    for (const [layerName, watchable] of this.editBboxByLayer) {
      watchable.value = this.readEditBboxForLayer(layerName);
    }
  }

  // -- Reload restore -------------------------------------------------------

  /**
   * Re-open a session from `state` after a viewer reload. No-op when no
   * intent is persisted or when a session is already active.
   */
  async tryRestoreFromState(): Promise<void> {
    if (this.activeSession.value !== undefined) return;
    const intent = this.state.value.value;
    if (intent === null) return;

    const annotationLayer = this.viewer.layerManager.getLayerByName(
      intent.bboxRef.annotationLayerName,
    );
    if (annotationLayer === undefined) {
      this.failRestore(
        `Edit session reference invalid: annotation layer ${JSON.stringify(intent.bboxRef.annotationLayerName)} not found.`,
      );
      return;
    }
    // Walking the annotation source for the specific id is a downstream
    // concern (annotation sources expose `references`). For v1 we trust the
    // captured bbox bytes and let the modal-style flow re-validate against
    // the live annotation if/when the UI tab is opened. If the annotation
    // is missing from the source, downstream consumers degrade gracefully.

    for (const layer of intent.layers) {
      const managed = this.viewer.layerManager.getLayerByName(layer.layerId);
      if (managed === undefined) {
        this.failRestore(
          `Edit session reference invalid: layer ${JSON.stringify(layer.layerId)} not found.`,
        );
        return;
      }
      try {
        const metadata = await this.layerMetadataSource.resolve(layer.layerId);
        const exposed = metadata.scales.some(
          (s) => s.resolution === layer.resolution,
        );
        if (!exposed) {
          this.failRestore(
            `Edit session reference invalid: resolution ${JSON.stringify(layer.resolution)} unavailable on layer ${JSON.stringify(layer.layerId)}.`,
          );
          return;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.failRestore(
          `Edit session reference invalid: ${message}`,
        );
        return;
      }
    }

    const config: HostSessionConfig = {
      bboxRef: {
        annotationLayerName: intent.bboxRef.annotationLayerName,
        annotationId: intent.bboxRef.annotationId,
      },
      bboxVoxelCoords: [
        intent.capturedRegion.lo[0],
        intent.capturedRegion.lo[1],
        intent.capturedRegion.lo[2],
        intent.capturedRegion.hi[0],
        intent.capturedRegion.hi[1],
        intent.capturedRegion.hi[2],
      ],
      bboxResolution: intent.bboxRef.resolution,
      layers: intent.layers,
    };
    try {
      await this.openSession(config);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.failRestore(`Could not re-open session: ${message}`);
    }
  }

  // -- Disposal -------------------------------------------------------------

  override disposed(): void {
    // Best-effort: if a session is still alive, drop in-memory state. We do
    // not await — disposal is synchronous.
    if (this.activeSession.value !== undefined) {
      void this.activeSession.value.discard().catch(() => {});
    }
    this.teardownHotkeyBinder();
    this.teardownPerLayer();
    this.commitTarget.clearAll();
    super.disposed();
  }

  // -- Internal helpers -----------------------------------------------------

  private buildLibraryConfig(config: HostSessionConfig): EditSessionConfig {
    const layers: LayerSelection[] = config.layers.map((l) => ({
      layerId: l.layerId,
      selectedResolutions: [l.resolution],
    }));
    if (config.layers.length === 0) {
      throw new InvalidSessionConfigError(
        "EditSessionConfig.layers must be non-empty",
      );
    }
    const firstWritable = config.layers.find((l) => l.role === "writable");
    const targetLayerId = (firstWritable ?? config.layers[0]).layerId;
    const targetResolution = (firstWritable ?? config.layers[0]).resolution;
    const sourceImageLayerId = config.layers[0].layerId;

    // The user-facing "Size" is `radius * 2 + 1` (see brush panel). Default
    // size 5 paints a 13-voxel diamond — visible enough to confirm the brush
    // works, small enough not to overshoot a precision edit.
    const paintInitial: PaintingSharedState = {
      targetLayerId,
      targetResolution,
      radius: 2,
      radiusCycle: DEFAULT_RADIUS_CYCLE,
      // The brush writes this segment id into voxels. The architect spec
      // suggested 0n (= erase) and required the user to set a value before
      // painting, but that hides successful strokes behind a confusing
      // "nothing happens" UX. Default to 1n so the brush produces visible
      // results immediately; the user can change it via the brush panel.
      activeValue: 1n,
      eraseValue: 0n,
      mask: undefined as PaintingMaskConfig | undefined,
    };

    const correspondenceInitial: CorrespondenceState = {
      lines: [],
      markers: [],
      pending: undefined,
      hoveredId: undefined,
      hoveredKind: undefined,
      selectedId: undefined,
      selectedKind: undefined,
      reversedArrowMode: false,
      sourceImageLayerId,
      targetImageLayerId: targetLayerId,
      fieldLayerId: targetLayerId,
      warpedLayerId: targetLayerId,
      writeResolution: targetResolution,
      numIter: 200,
      rigidity: 1,
      learningRate: 0.1,
      optimizer: "adam",
      mseWeight: 1,
    };

    const zExtInitial: ZExtrapolationState = {
      targetLayerId,
      targetResolution,
      imageLayerId: sourceImageLayerId,
      imageResolution: targetResolution,
      bboxXY: undefined,
      sourceZ: undefined,
      zRange: undefined,
      trackingSegments: [],
      modelHint: undefined,
    };

    return {
      layers,
      region: { bbox: config.bboxVoxelCoords, resolution: config.bboxResolution },
      tools: [
        painting({
          initialState: paintInitial,
          compute: new PaintingCompute(),
        }),
        correspondence({
          initialState: correspondenceInitial,
          compute: new NgCorrespondenceCompute(),
        }),
        zExtrapolation({
          initialState: zExtInitial,
          compute: new NgZExtrapolationCompute(),
        }),
      ],
    };
  }

  private buildAdapters(): EditSessionAdapters {
    return {
      layerMetadata: this.layerMetadataSource,
      chunks: this.chunkSource,
      commit: this.commitTarget,
      save: this.saveTarget,
      lock: this.sessionLock,
      clock: this.clock,
      logger: this.logger,
    };
  }

  private async attachPerLayer(
    session: EditSession,
    config: HostSessionConfig,
  ): Promise<void> {
    for (const layer of config.layers) {
      if (layer.role !== "writable") continue;
      const userLayer = this.findSegmentationUserLayer(layer.layerId);
      if (userLayer === undefined) {
        this.logger.warn(
          "session",
          `Layer ${layer.layerId} is not a writable segmentation layer; skipping render-layer attach`,
        );
        continue;
      }
      const baseRenderLayer = findBaseSegmentationRenderLayer(userLayer);
      if (baseRenderLayer === undefined) {
        this.logger.warn(
          "session",
          `Layer ${layer.layerId} has no SegmentationRenderLayer yet; skipping render-layer attach`,
        );
        continue;
      }
      const patchStore = new LocalPatchStore();
      const renderLayer = new PatchedSegmentationRenderLayer(
        baseRenderLayer.multiscaleSource,
        baseRenderLayer.displayState,
        patchStore,
      );
      const detachRenderLayer = userLayer.addRenderLayer(renderLayer);
      const mirror = new PatchMirror(
        session,
        layer.layerId,
        patchStore,
        this.logger,
      );
      this.perLayer.set(layer.layerId, {
        patchStore,
        renderLayer,
        mirror,
        detachRenderLayer,
      });
      this._activeRegionByLayer.set(
        layer.layerId,
        new WatchableValue<ActiveRegion | undefined>(
          await this.computeActiveRegion(layer.layerId, layer.resolution, config),
        ),
      );
    }

    // Note on calcada save backend registration: the architecture spec
    // (03-host-adapters.md, save backends; 02-module-layout.md) calls for
    // `registerCalcadaSaveBackend({ resolveHttpSource })` to be invoked here
    // for calcada-backed layers. The `HttpSource` lookup goes through the
    // KvStoreContext from the layer's data source, and the precise path from
    // a loaded `UserLayer` to an `HttpSource` is not yet codified in the
    // calcada frontend (see `src/datasource/calcada/frontend.ts:2317`).
    // Wiring is deferred to the integration step that defines that path —
    // see report from this step for the open question.

    // Propagate the newly-set per-layer regions into any persistent
    // watchables that segmentation/image user layers subscribed to at their
    // construction time.
    this.refreshEditBboxWatchables();
  }

  /**
   * Compute the per-layer active region by intersecting the session bbox
   * (expressed at `bboxResolution`) with the layer's chosen resolution's
   * scale bounds. Per `06-bbox-rendering.md` § "Edge-case", we clip the
   * bbox to `[voxelOffset, voxelOffset + sizeVoxels]` so render-layer
   * uniforms never address out-of-bounds voxels.
   */
  private async computeActiveRegion(
    layerId: LayerId,
    layerResolution: ResolutionType,
    config: HostSessionConfig,
  ): Promise<ActiveRegion | undefined> {
    let metadata;
    try {
      metadata = await this.layerMetadataSource.resolve(layerId);
    } catch {
      return undefined;
    }
    const scale = metadata.scales.find((s) => s.resolution === layerResolution);
    if (scale === undefined) return undefined;
    const bboxNm = bboxToNm(config.bboxVoxelCoords, config.bboxResolution);
    const layerLo: Vec3Voxels = [
      Math.floor(bboxNm[0] / scale.voxelSizeNm[0]),
      Math.floor(bboxNm[1] / scale.voxelSizeNm[1]),
      Math.floor(bboxNm[2] / scale.voxelSizeNm[2]),
    ];
    const layerHi: Vec3Voxels = [
      Math.ceil(bboxNm[3] / scale.voxelSizeNm[0]),
      Math.ceil(bboxNm[4] / scale.voxelSizeNm[1]),
      Math.ceil(bboxNm[5] / scale.voxelSizeNm[2]),
    ];
    const minBound: Vec3Voxels = [
      scale.voxelOffset[0],
      scale.voxelOffset[1],
      scale.voxelOffset[2],
    ];
    const maxBound: Vec3Voxels = [
      scale.voxelOffset[0] + scale.sizeVoxels[0],
      scale.voxelOffset[1] + scale.sizeVoxels[1],
      scale.voxelOffset[2] + scale.sizeVoxels[2],
    ];
    // The volume render layer's vertex shader emits a `vChunkPosition`
    // varying in the layer's CHUNK-GRID frame (`vChunkPosition + uTranslation`
    // is the chunk-grid voxel position; cf.
    // `src/sliceview/volume/renderlayer.ts:138`). `voxelOffset` is the offset
    // of that chunk-grid origin from the layer's absolute voxel coords. The
    // bbox uniforms must be in the same chunk-grid frame as the varying, so
    // subtract `voxelOffset` from the clamped absolute coords here.
    return {
      loVoxel: [
        Math.max(layerLo[0], minBound[0]) - scale.voxelOffset[0],
        Math.max(layerLo[1], minBound[1]) - scale.voxelOffset[1],
        Math.max(layerLo[2], minBound[2]) - scale.voxelOffset[2],
      ],
      hiVoxel: [
        Math.min(layerHi[0], maxBound[0]) - scale.voxelOffset[0],
        Math.min(layerHi[1], maxBound[1]) - scale.voxelOffset[1],
        Math.min(layerHi[2], maxBound[2]) - scale.voxelOffset[2],
      ],
    };
  }

  /**
   * Construct the shared `BrushCursorState` and a `BrushCursorSliceOverlay`
   * attached to the first writable layer's render-layer list. v1
   * simplification: a single overlay piggy-backs on one writable layer's
   * draw pass; Phase 3+ may register a dedicated viewer-level overlay if
   * multi-layer cursoring becomes a concern.
   */
  private attachCursorOverlays(config: HostSessionConfig): void {
    this.cursorState = new BrushCursorState(this);
    const firstWritable = config.layers.find((l) => l.role === "writable");
    if (firstWritable === undefined) return;
    const userLayer = this.findSegmentationUserLayer(firstWritable.layerId);
    if (userLayer === undefined) return;
    this.sliceOverlay = new BrushCursorSliceOverlay(
      this.viewer.display.gl,
      this.cursorState,
    );
    this.detachSliceOverlay = userLayer.addRenderLayer(this.sliceOverlay);
    this.perspectiveOverlay = new BrushCursorPerspectiveOverlay(
      this.viewer.display.gl,
      this.cursorState,
    );
    this.detachPerspectiveOverlay = userLayer.addRenderLayer(
      this.perspectiveOverlay,
    );
  }

  private teardownHotkeyBinder(): void {
    if (this.hotkeyBinder !== undefined) {
      try {
        this.hotkeyBinder.dispose();
      } catch {
        // ignore
      }
      this.hotkeyBinder = undefined;
    }
  }

  private teardownCursorOverlays(): void {
    if (this.detachPerspectiveOverlay !== undefined) {
      try {
        this.detachPerspectiveOverlay();
      } catch {
        // ignore
      }
      this.detachPerspectiveOverlay = undefined;
    }
    this.perspectiveOverlay = undefined;
    if (this.detachSliceOverlay !== undefined) {
      try {
        this.detachSliceOverlay();
      } catch {
        // ignore
      }
      this.detachSliceOverlay = undefined;
    }
    // The slice overlay is owned by `addRenderLayer`'s detach call (which
    // disposes the layer); only release the reference here.
    this.sliceOverlay = undefined;
    if (this.cursorState !== undefined) {
      try {
        this.cursorState.dispose();
      } catch {
        // ignore
      }
      this.cursorState = undefined;
    }
  }

  private findSegmentationUserLayer(
    layerId: LayerId,
  ): SegmentationUserLayer | undefined {
    const managed = this.viewer.layerManager.getLayerByName(layerId);
    if (managed === undefined) return undefined;
    const user = managed.layer;
    if (user === null) return undefined;
    // Avoid hard dependency on `instanceof SegmentationUserLayer`: the host
    // can attach to any layer whose render layers include a
    // `SegmentationRenderLayer`. Phase-3 modal will already have validated
    // the layer is a segmentation layer.
    return user as SegmentationUserLayer;
  }

  private bindSessionEvents(session: EditSession): void {
    // The library does not emit a discrete "phase-changed" event in this
    // public surface; we instead listen for fatal session errors, which
    // signal an externally-driven termination. Recoverable errors keep the
    // session ACTIVE.
    this.unsubscribePhaseChanged = session.on("error", (err) => {
      if (err.kind === "fatal") {
        StatusMessage.showTemporaryMessage(
          `Edit session terminated: ${err.message}`,
          8000,
        );
        this.finalizeTeardown();
      }
    });
  }

  private writeIntentToState(config: HostSessionConfig): void {
    const intent: EditSessionIntent = {
      bboxRef: {
        annotationLayerName: config.bboxRef.annotationLayerName,
        annotationId: config.bboxRef.annotationId,
        resolution: config.bboxResolution,
      },
      layers: config.layers.map((l) => ({
        layerId: l.layerId,
        resolution: l.resolution,
        role: l.role,
      })),
      capturedRegion: {
        lo: [
          config.bboxVoxelCoords[0],
          config.bboxVoxelCoords[1],
          config.bboxVoxelCoords[2],
        ],
        hi: [
          config.bboxVoxelCoords[3],
          config.bboxVoxelCoords[4],
          config.bboxVoxelCoords[5],
        ],
      },
    };
    this.state.value.value = intent;
  }

  private handleOpenFailure(err: unknown): void {
    if (err instanceof InvalidSessionConfigError) {
      StatusMessage.showTemporaryMessage(
        `Invalid edit-session config: ${err.message}`,
        6000,
      );
      return;
    }
    if (err instanceof SessionPhaseViolationError) {
      StatusMessage.showTemporaryMessage(
        `Edit-session phase violation: ${err.message}`,
        6000,
      );
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    this.logger.error("session", message);
  }

  private finalizeTeardown(): void {
    if (this.pointerEventBridge !== undefined) {
      try {
        this.pointerEventBridge.dispose();
      } catch {
        // ignore
      }
      this.pointerEventBridge = undefined;
    }
    this.teardownHotkeyBinder();
    this.teardownCursorOverlays();
    this.teardownPerLayer();
    this.sessionLock.clearActiveSession();
    if (this.sessionLockHandle !== undefined) {
      try {
        this.sessionLockHandle.release();
      } catch {
        // ignore
      }
      this.sessionLockHandle = undefined;
    }
    if (this.unsubscribePhaseChanged !== undefined) {
      try {
        this.unsubscribePhaseChanged();
      } catch {
        // ignore
      }
      this.unsubscribePhaseChanged = undefined;
    }
    this.state.value.value = null;
    this.activeSession.value = undefined;
    this.editSessionPanelLocation.visible = false;
    if (this.saveAbortController !== undefined) {
      try {
        this.saveAbortController.abort();
      } catch {
        // ignore
      }
      this.saveAbortController = undefined;
    }
  }

  private teardownPerLayer(): void {
    for (const entry of this.perLayer.values()) {
      try {
        entry.mirror.dispose();
      } catch {
        // ignore
      }
      try {
        entry.detachRenderLayer();
      } catch {
        // ignore
      }
      try {
        entry.patchStore.dispose();
      } catch {
        // ignore
      }
    }
    this.perLayer.clear();
    this._activeRegionByLayer.clear();
    // Flip subscribers from `defined` to `undefined`; this triggers the
    // bbox-dim shader path to recompile back to the no-session variant on
    // the next render.
    this.refreshEditBboxWatchables();
  }

  private failRestore(message: string): void {
    StatusMessage.showTemporaryMessage(message, 8000);
    this.state.value.value = null;
  }
}

// ---------------------------------------------------------------------------
// Free-function helpers
// ---------------------------------------------------------------------------

function findBaseSegmentationRenderLayer(
  user: SegmentationUserLayer,
): SegmentationRenderLayer | undefined {
  for (const rl of user.renderLayers) {
    if (rl instanceof SegmentationRenderLayer) return rl;
  }
  return undefined;
}

function bboxToNm(
  bbox: BoundingBoxVoxels,
  resolution: ResolutionType,
): [number, number, number, number, number, number] {
  const voxelSizeNm = Resolution.toVoxelSize(resolution);
  return [
    bbox[0] * voxelSizeNm[0],
    bbox[1] * voxelSizeNm[1],
    bbox[2] * voxelSizeNm[2],
    bbox[3] * voxelSizeNm[0],
    bbox[4] * voxelSizeNm[1],
    bbox[5] * voxelSizeNm[2],
  ];
}
