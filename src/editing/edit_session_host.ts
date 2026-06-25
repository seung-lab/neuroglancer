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
 * @file Phase-1 host wrapper around the `@zettaai/edit-session` library.
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
  LayerMetadata,
  LayerSelection,
  Resolution as ResolutionType,
  SaveResult,
  SavePayload,
  SaveLayerOutcome,
} from "@zettaai/edit-session";
import {
  ChunkId as ChunkIdFactory,
  EditSession,
  InvalidSessionConfigError,
  OverlayKey,
  Resolution,
  SessionPhaseViolationError,
  layerId as toLayerId,
  sessionId as toSessionId,
} from "@zettaai/edit-session";
import { debounce } from "lodash-es";

import {
  type CoordinateSpace,
  coordinateSpaceFromJson,
  coordinateSpaceToJson,
} from "#src/coordinate_transform.js";
import { createChunkBufferAllocator } from "#src/editing/adapters/ng_chunk_buffer_allocator.js";
import { NgChunkSource } from "#src/editing/adapters/ng_chunk_source.js";
import { NgClock } from "#src/editing/adapters/ng_clock.js";
import { NgCommitTarget } from "#src/editing/adapters/ng_commit_target.js";
import { NgLayerMetadataSource } from "#src/editing/adapters/ng_layer_metadata_source.js";
import { NgLogger } from "#src/editing/adapters/ng_logger.js";
import {
  NgSaveTarget,
  resolveDataSourceUrl,
} from "#src/editing/adapters/ng_save_target.js";
import { NgSessionLockAdapter } from "#src/editing/adapters/ng_session_lock.js";
import type { SaveBackend } from "#src/editing/adapters/save_backend.js";
import {
  hasAnySaveBackend,
  registerDefaultSaveBackend,
  registerSaveBackend,
  saveBackendRegistryChanged,
} from "#src/editing/adapters/save_backend.js";
import { PostMessageSaveBackend } from "#src/editing/adapters/save_backends/post_message_save_backend.js";
import type { ChunkLoadProgressState } from "#src/editing/adapters/session_chunk_preloader.js";
import {
  BRUSH_SIZE_PRESETS,
  nearestPresetSize,
  sizeToRadius,
} from "#src/editing/brush_size_presets.js";
import { BrushCursorPerspectiveOverlay } from "#src/editing/cursor/brush_cursor_perspective_overlay.js";
import { BrushCursorSliceOverlay } from "#src/editing/cursor/brush_cursor_slice_overlay.js";
import { BrushCursorState } from "#src/editing/cursor/brush_cursor_state.js";
import {
  FillCursorProgress,
  type FillProgressState,
} from "#src/editing/cursor/fill_cursor_progress.js";
import { IdleEditHotkeyBinder } from "#src/editing/idle_edit_hotkey_binder.js";
import { LocalPatchStore } from "#src/editing/local_patch_store.js";
// PatchMirror is created by step 9 of Phase 1; this file's runtime import
// resolves once that step lands. Assumed constructor signature:
//   new PatchMirror(session, layerId, store, logger)
// where the mirror subscribes to `session.dirty` chunk events for `layerId`
// and writes the resulting overlay bytes into `store.writeFullChunk(...)`.
import { PatchMirror } from "#src/editing/overlay/patch_mirror.js";
import { PatchTextureCache } from "#src/editing/patch_texture_cache.js";
// Side-effect: attaches `window.__editPaintBench` for the Playwright paint
// benchmark (a dev tool, like `window.__paintProfiler` — only does work when
// invoked). Tree-shake-safe: no value import.
import "#src/editing/benchmarks/edit_paint_bench.js";
import { PointerEventBridge } from "#src/editing/pointer_event_bridge.js";
import { QuickRegionCapture } from "#src/editing/quick_region_capture.js";
import { voxelCenterInBox } from "#src/editing/region/region_geometry.js";
import { EditRegionPerspectiveOverlay } from "#src/editing/region/region_perspective_overlay.js";
import { EditRegionSliceOverlay } from "#src/editing/region/region_slice_overlay.js";
import { EditSessionHotkeyBinder } from "#src/editing/session_hotkey_binder.js";
import type { PatchedMaskProvider } from "#src/editing/shaders/patched_mask_provider.js";
import { voxelDataTypeRange } from "#src/editing/tool_runtimes/mask_coord.js";
import { MorphologyClient } from "#src/editing/tool_runtimes/morphology_client.js";
import { paintProfilerMetrics } from "#src/editing/tool_runtimes/paint_profiler_metrics.js";
import type { PaintingMaskConfig } from "#src/editing/tool_runtimes/paint_types.js";
import { DEFAULT_COVERAGE_THRESHOLD } from "#src/editing/tool_runtimes/paint_types.js";
import { PaintingCompute } from "#src/editing/tool_runtimes/painting_compute.js";
import {
  ConsumerPaintingTools,
  type PaintingSharedState,
  type ReadChunkAt,
} from "#src/editing/tool_runtimes/painting_tools.js";
import { DEFAULT_SPACING_FRACTION } from "#src/editing/tool_runtimes/stroke_geometry.js";
import { TrackableEditPreferences } from "#src/editing/tooling/edit_preferences.js";
import { EditScope } from "#src/editing/tooling/edit_scope.js";
import type { EditToolContext } from "#src/editing/tooling/edit_tool.js";
import { SessionToolBinder } from "#src/editing/tooling/session_tool_binder.js";
import { ToolRegistry } from "#src/editing/tooling/tool_registry.js";
import {
  paintingPatchFromPersist,
  parseTooling,
  serializeTooling,
  type EditKeybindOverrides,
  type ToolingPersistState,
} from "#src/editing/tooling/tooling_persist.js";
import { layerKindOf } from "#src/editing/ui/layer_kind.js";
import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import { SegmentationRenderLayer } from "#src/sliceview/volume/segmentation_renderlayer.js";
import { StatusMessage } from "#src/status.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { WatchableValue } from "#src/trackable_value.js";
import {
  DEFAULT_SIDE_PANEL_LOCATION,
  TrackableSidePanelLocation,
} from "#src/ui/side_panel_location.js";
import { RefCounted } from "#src/util/disposable.js";
import { vec3 } from "#src/util/geom.js";
import { NullarySignal, Signal } from "#src/util/signal.js";
import type { Trackable } from "#src/util/trackable.js";
import type { Viewer } from "#src/viewer.js";

// ---------------------------------------------------------------------------
// Host-side configuration shape (modal-provided)
// ---------------------------------------------------------------------------

export interface HostSessionConfig {
  /** Voxel-space bbox snapshot at modal-submit time. */
  readonly bboxVoxelCoords: BoundingBoxVoxels;
  /**
   * The region's physical frame as a `CoordinateSpace` — the single source of
   * truth for the region's scale/units/names. Captured from the source the
   * bbox was measured in (the annotation's native `inputSpace` scales, with
   * the semantic `outputSpace` names). Persisted via `coordinateSpaceToJson`
   * (byte-identical to every other coordinate space in ngState) and the
   * library `Resolution` tag is derived from it on demand — neither is stored
   * twice (TM-299).
   */
  readonly regionSpace: CoordinateSpace;
  readonly layers: ReadonlyArray<{
    readonly layerId: LayerId;
    /**
     * Resolutions selected at session-entry time. Non-empty. The first entry
     * is the default painting resolution for writable layers; downstream
     * display is restricted to this set on both writable and read-only
     * layers. Every layer in the config is locked in memory for the duration
     * of the session (chunks held in PERMANENT residency).
     */
    readonly resolutions: readonly ResolutionType[];
    readonly writable: boolean;
  }>;
}

// ---------------------------------------------------------------------------
// URL-state shape (per architecture 08-state-ownership.md § URL state)
// ---------------------------------------------------------------------------

type Vec3Voxels = readonly [number, number, number];

/**
 * ngState `CoordinateSpace` JSON for the region's spatial axes:
 * `{ x: [scale, unit], y: [scale, unit], z: [scale, unit] }` — the exact
 * encoding {@link coordinateSpaceToJson} emits (scale in meters, unit `"m"`).
 * Parsed back via {@link coordinateSpaceFromJson}. Carries real physical scale
 * + unit, so the region is self-describing and relabel-stable.
 */
type RegionDimensionsJson = Record<string, readonly [number, string]>;

export interface EditSessionIntent {
  readonly layers: ReadonlyArray<{
    readonly layerId: LayerId;
    /** Non-empty. First entry is the default painting resolution. */
    readonly resolutions: readonly ResolutionType[];
    readonly writable: boolean;
  }>;
  /**
   * The edit region, stored **annotation-independent and layer-agnostic**
   * (TM-299). `lo`/`hi` are voxel coords in the self-describing frame given by
   * `dimensions` — a physical box bound to no layer. Per-layer conversion into
   * each writable layer's voxel grid happens at runtime, so storing the region
   * in any one layer's native frame is deliberately avoided. There is no
   * back-reference to the source annotation: restore depends solely on
   * `lo`/`hi` + `dimensions`.
   */
  readonly region: {
    readonly lo: Vec3Voxels;
    readonly hi: Vec3Voxels;
    readonly dimensions: RegionDimensionsJson;
  };
  /**
   * Persisted consumer tool state (TM-315, decision C): active tool id +
   * painting family config. Absent until the user has tools set up; restored
   * on reopen (validated against the session layers, dropped if stale).
   */
  readonly tooling?: ToolingPersistState;
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
  const rawLayers = obj.layers;
  if (!Array.isArray(rawLayers)) throw new Error("invalid-layers");
  const layers = rawLayers.map((entry): EditSessionIntent["layers"][number] => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("invalid-layer-entry");
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.layerId !== "string" || typeof e.writable !== "boolean") {
      throw new Error("invalid-layer-fields");
    }
    // Accept either the current `resolutions: string[]` shape or the legacy
    // `resolution: string` shape (pre-multi-resolution URL state).
    let resolutions: ResolutionType[];
    if (Array.isArray(e.resolutions)) {
      resolutions = e.resolutions.map((r) => {
        if (typeof r !== "string") throw new Error("invalid-resolution-entry");
        return r as ResolutionType;
      });
    } else if (typeof e.resolution === "string") {
      resolutions = [e.resolution as ResolutionType];
    } else {
      throw new Error("invalid-layer-fields");
    }
    if (resolutions.length === 0) throw new Error("empty-resolutions");
    return {
      layerId: toLayerId(e.layerId),
      resolutions,
      writable: e.writable,
    };
  });
  const tooling = parseTooling(obj.tooling);
  return {
    layers,
    region: parseRegion(obj),
    ...(tooling !== undefined ? { tooling } : {}),
  };
}

/** Parse the persisted region (`region: { lo, hi, dimensions }`). */
function parseRegion(
  obj: Record<string, unknown>,
): EditSessionIntent["region"] {
  const region = obj.region as Record<string, unknown> | undefined;
  if (region === undefined || typeof region !== "object") {
    throw new Error("invalid-region");
  }
  return {
    lo: parseVec3(region.lo, "region.lo"),
    hi: parseVec3(region.hi, "region.hi"),
    dimensions: parseRegionDimensions(region.dimensions),
  };
}

function parseVec3(value: unknown, label: string): Vec3Voxels {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`invalid-${label}`);
  }
  return [Number(value[0]), Number(value[1]), Number(value[2])];
}

/**
 * Validate the persisted `dimensions` block and return it in ngState's
 * canonical `CoordinateSpace` JSON form. Validation and serialization are
 * delegated to the official helpers: {@link coordinateSpaceFromJson} throws on
 * a non-object, invalid dimension names, or uninterpretable units, and
 * {@link coordinateSpaceToJson} re-emits the canonical encoding — so the stored
 * block is always identical to how every other coordinate space in ngState is
 * serialized. Requires the three spatial dimensions.
 */
function parseRegionDimensions(raw: unknown): RegionDimensionsJson {
  const space = coordinateSpaceFromJson(raw);
  if (space.rank < 3) throw new Error("invalid-region-dimensions");
  return coordinateSpaceToJson(space) as RegionDimensionsJson;
}

/**
 * Per-axis voxel size in nm for the region's three spatial dimensions. A
 * `CoordinateSpace` always stores scales in SI metres, so this is a pure m→nm
 * conversion; the rounding strips the float noise that would otherwise make
 * the derived `Resolution` tag miss the layer's exact available resolutions.
 */
function regionVoxelSizeNm(space: CoordinateSpace): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; ++i) {
    const nm = space.scales[i] * 1e9;
    out[i] = Math.round(nm * 1e6) / 1e6;
  }
  return out;
}

/** The library `Resolution` tag for a region frame, derived on demand. */
function regionResolution(space: CoordinateSpace): ResolutionType {
  return Resolution.from(regionVoxelSizeNm(space));
}

// ---------------------------------------------------------------------------
// Per-session machinery container
// ---------------------------------------------------------------------------

interface PerLayerMachinery {
  readonly patchStore: LocalPatchStore;
  /**
   * The GPU texture cache. Implements `PatchedMaskProvider` and is
   * published into the layer's `editPatchOverlay` watchable so the base
   * `SegmentationRenderLayer` samples patch values directly — no
   * separate render layer is involved. Persists across commit/discard
   * teardown so committed patches stay visible.
   */
  readonly textureCache: PatchTextureCache;
  /**
   * Reference to the base segmentation render layer for this layer. Used
   * by host-internal helpers that need to walk visible scales (e.g.
   * `chunkDataSizeForLayer`); the cache itself is layer-agnostic.
   */
  readonly baseRenderLayer: SegmentationRenderLayer;
  /**
   * Subscription bridging the active library overlay → `patchStore`. Set
   * while a session is active, replaced on each new `openSession`, and
   * cleared by `commitTeardown` (the backing `DirtyTracker` is gone after
   * commit so the mirror has nothing to listen to). `patchStore` and
   * `textureCache` persist across the gap so committed patches stay visible.
   */
  mirror: PatchMirror | undefined;
}

/**
 * Active region for a layer expressed in the viewer's DISPLAY coordinate
 * space (the same frame as `viewer.position.value` — i.e. voxels at the
 * display dimensions' configured scale). The shader converts each
 * fragment's chunk-grid voxel position to this same frame via
 * `uChunkToGlobal` (bound to `chunkLayout.transform` per source).
 *
 * We use display coords (not nm and not the session's chosen layer
 * resolution) because:
 *   - `chunkLayout.transform`'s output frame IS display coords, so the
 *     shader comparison is one matrix multiply away from a fragment's
 *     chunk-grid position regardless of which scale the viewer chose.
 *   - The user's bbox annotation is itself rendered in display coords by
 *     the annotation render layer — so this matches the visible yellow
 *     rectangle exactly.
 */
export interface ActiveRegion {
  readonly lo: readonly [number, number, number];
  readonly hi: readonly [number, number, number];
}

/**
 * Target on-screen brush diameter, in CSS pixels, used to seed the brush size
 * from the current zoom on first paint-tool activation. Chosen to be clearly
 * visible without dominating the slice; the user adjusts from here with `+`/`-`.
 */
const TARGET_BRUSH_DIAMETER_PX = 28;

// ---------------------------------------------------------------------------
// EditSessionHost
// ---------------------------------------------------------------------------

export class EditSessionHost extends RefCounted {
  // -- Public reactive state ------------------------------------------------
  readonly activeSession = new WatchableValue<EditSession | undefined>(
    undefined,
  );
  /**
   * The active tool id — consumer-owned tool selection (TM-315). Replaces the
   * library's removed `session.getActiveToolId()` / `active-tool-changed`.
   * `undefined` = cursor mode (no tool). The cursor overlay, hotkey binder,
   * pointer bridge, and `activeToolWorkingResolution` all read this.
   */
  readonly activeToolId = new WatchableValue<string | undefined>(undefined);
  /**
   * Per-user edit-hotkey overrides (TM-315 runtime rebind): friendly action
   * name → key identifier(s). Merged by the session hotkey binder OVER the
   * build-time `custom-keybinds.json` defaults, so a rebind takes effect live.
   * Persisted into the `editSession` tooling block and restored on reopen.
   * Empty `{}` means "use the configured defaults". The binder watches this.
   */
  readonly editKeybindOverrides = new WatchableValue<EditKeybindOverrides>({});
  /**
   * Consumer-owned painting tools for the active session (TM-315), constructed
   * after `EditSession.open(...)`. Undefined when no session is active. The
   * pointer bridge dispatches input to it; the cursor overlay / hotkeys / UI
   * read its shared `state`.
   */
  private paintingTools: ConsumerPaintingTools | undefined;
  get painting(): ConsumerPaintingTools | undefined {
    return this.paintingTools;
  }
  /** Per-session tool activation/selection binder (TM-315). */
  private toolBinder: SessionToolBinder | undefined;
  /**
   * Per-session tool registry (TM-315) — the single source of truth for tool
   * identity (cursor kind, panel key, activation hotkey). The cursor overlay
   * and topbar read it instead of hardcoding tool-id lists. Undefined when no
   * session is active.
   */
  private _toolRegistry: ToolRegistry | undefined;
  get toolRegistry(): ToolRegistry | undefined {
    return this._toolRegistry;
  }
  /**
   * Fires when the per-session tool registry / painting tools are (re)built or
   * torn down (TM-315). The registry is constructed asynchronously after
   * `activeSession` is set, so UI that lists the registered tools (e.g. the
   * topbar tool buttons) must re-read `toolRegistry` on this signal rather than
   * only on session-open — otherwise it renders before the registry exists and
   * never picks it up.
   */
  readonly toolingChanged = new NullarySignal();
  /** Disposers for the per-session tooling-persistence subscriptions (TM-315). */
  private toolingSubscriptions: (() => void)[] = [];
  readonly state = new TrackableEditSessionIntent();
  /**
   * Cross-session edit preferences (TM-336): last-used resolution selection +
   * tool state, persisted independently of `state` so they survive an
   * open → close → open flow. Seeds the entry modal + fresh sessions; never
   * trusted as ground truth (always re-validated against fresh metadata).
   */
  readonly editPreferences = new TrackableEditPreferences();

  /**
   * Fired to request that the Enter-Edit-Session modal open. Dispatched by the
   * quick-region capture flow (TM-290) once a box has been drawn; the topbar
   * Edit button subscribes and opens the modal, pre-selecting the optional
   * bbox key (the `BboxSelectionModel` entry key of the just-drawn box).
   */
  readonly requestSessionEntry = new Signal<
    (preselectBboxKey?: string) => void
  >();

  /** Owns the in-flight quick-region capture; lazily constructed. */
  private quickRegionCapture: QuickRegionCapture | undefined;

  /**
   * Per-tool side-panel locations (TM-294 rework). Each tool owns an
   * independent `TrackableSidePanelLocation`; the host's `selectTool()`
   * invariant guarantees at most one is `visible` at any time.
   *
   * The navigation (cursor) tool now has its own panel too (TM-338): a
   * read-only session summary. Selecting cursor / pressing Escape shows it
   * instead of collapsing the left column, so the field of view no longer
   * jumps when switching between a paint tool and navigation.
   *
   * All default to `side: "left"` and the same row/col so they visually
   * replace each other in the same slot.
   */
  readonly navPanelLocation = new TrackableSidePanelLocation({
    ...DEFAULT_SIDE_PANEL_LOCATION,
    side: "left",
  });
  readonly brushPanelLocation = new TrackableSidePanelLocation({
    ...DEFAULT_SIDE_PANEL_LOCATION,
    side: "left",
  });
  readonly eraserPanelLocation = new TrackableSidePanelLocation({
    ...DEFAULT_SIDE_PANEL_LOCATION,
    side: "left",
  });
  readonly fillPanelLocation = new TrackableSidePanelLocation({
    ...DEFAULT_SIDE_PANEL_LOCATION,
    side: "left",
  });
  readonly zExtrapPanelLocation = new TrackableSidePanelLocation({
    ...DEFAULT_SIDE_PANEL_LOCATION,
    side: "left",
  });
  readonly correspondencePanelLocation = new TrackableSidePanelLocation({
    ...DEFAULT_SIDE_PANEL_LOCATION,
    side: "left",
  });

  // -- Save cancellation ----------------------------------------------------
  private saveAbortController: AbortController | undefined;

  /**
   * Reactive flag: whether a save started by `saveActive()` is currently in
   * flight. The topbar's Save button drives its loading state from this, and
   * the Exit-session button disables itself while it is `true` so a save can't
   * be interrupted by leaving the session. Set `true` for the duration of
   * `saveActive()` and reset in its `finally` (covers success, failure, and
   * cancellation alike).
   */
  readonly saveInProgress = new WatchableValue<boolean>(false);

  // -- Adapters (constructed once, reused across sessions) ------------------
  readonly logger: NgLogger;
  readonly sessionLock: NgSessionLockAdapter;
  private readonly chunkSource: NgChunkSource;
  // Exposed publicly so the viewer can pass it into `EditSessionEntryModal`
  // without re-instantiating an adapter against the same `LayerManager`.
  readonly layerMetadataSource: NgLayerMetadataSource;
  // Exposed publicly so the "Pending Changes" panel can subscribe to the
  // `changed` signal and enumerate layers with in-memory committed chunks.
  readonly commitTarget: NgCommitTarget;
  private readonly saveTarget: NgSaveTarget;
  private readonly clock: NgClock;

  /**
   * Pyodide morphology worker (TM-304), shared by every `PaintingCompute` this
   * host builds. Lazily boots pyodide on `warmup()`/first masked stroke and is
   * terminated when the host is disposed.
   */
  private readonly morphologyClient = this.registerDisposer(
    new MorphologyClient(),
  );

  /**
   * Reactive flag: whether any save backend is registered (so persistence is
   * wired up). Mirrors `hasAnySaveBackend()` from the registry. The Save
   * controls subscribe to this and disable themselves while it is `false`.
   */
  readonly saveBackendAvailable = new WatchableValue<boolean>(
    hasAnySaveBackend(),
  );

  /**
   * Background preload progress for the active session's bbox chunks (TM-316),
   * surfaced to the topbar's `ChunkLoadProgress` indicator. Forwards the chunk
   * adapter's stable watchable; resets to `idle` between sessions.
   */
  get chunkLoadProgress(): WatchableValueInterface<ChunkLoadProgressState> {
    return this.chunkSource.chunkLoadProgress;
  }

  /**
   * Progress of the in-flight flood fill (TM-269), driving the cursor-attached
   * spinner. `running` while a fill floods (updated per progressive flush),
   * `idle` otherwise. Session-lifetime; the fill tool's progress sink writes it.
   */
  private readonly fillProgressState = new WatchableValue<FillProgressState>({
    kind: "idle",
  });
  get fillProgress(): WatchableValueInterface<FillProgressState> {
    return this.fillProgressState;
  }
  private fillCursorProgress: FillCursorProgress | undefined;

  /**
   * The NG-provided postMessage save backend, exposed so the embedding host
   * (the portal) can construct and register it from an injected script without
   * importing the NG bundle:
   *
   *   const host = window.viewer.editSessionHost;
   *   host.registerDefaultSaveBackend(
   *     new host.PostMessageSaveBackend({
   *       resolveDataSourceUrl: (id) => host.resolveLayerDataSourceUrl(id),
   *     }),
   *   );
   */
  readonly PostMessageSaveBackend = PostMessageSaveBackend;

  // -- Per-layer persistent watchables for `editBboxLoHi` -------------------
  // Per `06-bbox-rendering.md` § "Wiring to the render layers", every
  // segmentation/image user layer that may participate in any future session
  // subscribes ONCE to a layer-keyed watchable. Values flip on session
  // open/close. The map persists across sessions (entries lazily allocated).
  //
  // Bbox values are stored in the layer's GLOBAL frame (nm), not in
  // chunk-grid voxels. The render-layer shader converts the fragment
  // position to global coords (via `uChunkToGlobal`) and compares in nm —
  // this keeps the bbox comparison resolution-independent so the session's
  // chosen resolution doesn't have to match the actually-rendered scale.
  private readonly editBboxByLayer = new Map<
    string,
    WatchableValue<{ lo: vec3; hi: vec3 } | undefined>
  >();

  // Per-layer persistent watchables for the patched-mask provider hook the
  // base `SegmentationRenderLayer` consumes via `editPatchOverlay`. Same
  // lazy-allocation pattern as `editBboxByLayer`: the segmentation user
  // layer queries on render-layer construction; the host mutates the
  // value when a session opens / closes.
  private readonly patchOverlayByLayer = new Map<
    string,
    WatchableValue<PatchedMaskProvider | undefined>
  >();

  // Per-layer persistent watchables for the resolution-display lock. Same
  // pattern as `editBboxByLayer`: layer-keyed, lazily allocated on first
  // access from segmentation/image user-layer construction. Value holds the
  // set of resolutions the slice-view render layer is allowed to display
  // while a session is active; `undefined` means no session (no lock).
  private readonly allowedResolutionsByLayer = new Map<
    string,
    WatchableValue<ReadonlySet<ResolutionType> | undefined>
  >();

  // Source-of-truth map populated at session-open from
  // `HostSessionConfig.layers[*].resolutions`. Cleared on session end. The
  // public watchables above are derived from this.
  private readonly _allowedResolutionsByLayer = new Map<
    LayerId,
    ReadonlySet<ResolutionType>
  >();

  // Resolutions the session opened per layer, in config order, captured during
  // `instantiatePaintingTools` (which is awaited before `applyRestoredTooling`,
  // unlike the late-populated `_allowedResolutionsByLayer`). Used to repair a
  // stale persisted `mask.imageResolution` on restore (TM-350).
  private _sessionResolutionsByLayer: ReadonlyMap<
    LayerId,
    readonly ResolutionType[]
  > = new Map();

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
  /** Shared brush-cursor state, for the pointer bridge to feed synchronous centers (TM-325). */
  get brushCursor(): BrushCursorState | undefined {
    return this.cursorState;
  }
  private sliceOverlay: BrushCursorSliceOverlay | undefined;
  private detachSliceOverlay: (() => void) | undefined;
  private perspectiveOverlay: BrushCursorPerspectiveOverlay | undefined;
  private detachPerspectiveOverlay: (() => void) | undefined;
  // Session-owned edit-region visuals (TM-302). Unlike the cursor overlays,
  // these are NOT tied to the paint-target layer: neuroglancer only draws a
  // render layer while its host layer is visible, so the outline is re-hosted
  // on whatever session layer is currently visible (`reanchorRegionOverlays`),
  // and only disappears when the user hides every session layer.
  private regionSliceOverlay: EditRegionSliceOverlay | undefined;
  private detachRegionSliceOverlay: (() => void) | undefined;
  private regionPerspectiveOverlay: EditRegionPerspectiveOverlay | undefined;
  private detachRegionPerspectiveOverlay: (() => void) | undefined;
  /**
   * Session layer ids eligible to host the region overlays, captured
   * synchronously at session open (`activeSessionConfig` is populated later,
   * after an `await` in `attachPerLayer`, so it can't be relied on here).
   */
  private regionHostLayerIds: readonly LayerId[] = [];
  /** Layer the region overlays are currently hosted on (avoids redundant re-host). */
  private attachedRegionLayerId: LayerId | undefined;
  /** Disposer for the visibility watch that re-hosts the region overlays. */
  private detachRegionVisibilityWatch: (() => void) | undefined;
  /**
   * Re-entrancy guard for `reanchorRegionOverlays`: attaching/detaching a render
   * layer dispatches `layersChanged`, which is the very signal that drives the
   * re-host — so without this the first `addRenderLayer` would recurse forever.
   */
  private reanchoringRegionOverlays = false;
  /** First writable layer id — fallback anchor when no paint target resolves. */
  private cursorOverlayFallbackLayerId: LayerId | undefined;
  /** Layer the cursor overlays are currently anchored to (avoids redundant re-attach). */
  private attachedCursorLayerId: LayerId | undefined;
  /** Disposer for the paint-target watch that drives overlay re-anchoring. */
  private detachCursorTargetWatch: (() => void) | undefined;
  /**
   * Disposers for the watches that suppress segment hover-highlight while a
   * painting tool (brush/eraser/fill) is active. One tracks active-tool
   * changes; the other re-applies the current suppression to layers that
   * appear mid-session.
   */
  private detachHoverSuppressionToolWatch: (() => void) | undefined;
  private detachHoverSuppressionLayerWatch: (() => void) | undefined;
  /**
   * Set once the brush size has been seeded from the zoom for the active
   * session, so the zoom-adaptive sizing runs only on the first paint-tool
   * activation and never clobbers a size the user has since adjusted. Reset on
   * each `openSession`.
   */
  private brushSizeAutoSized = false;
  /**
   * Disposer for the display-dimensions watch that recomputes the bbox-alpha
   * render region when the viewer's global "dimensions" scale changes
   * mid-session (TM-298). Without it, relabeling global res leaves the region
   * — which is expressed in display coordinates — stale, so the shader masks
   * the actual fragments and chunks visually disappear.
   */
  private detachDisplayDimWatch: (() => void) | undefined;
  /** Config of the active session, retained so regions can be recomputed. */
  private activeSessionConfig: HostSessionConfig | undefined;

  // -- Read-only public views -----------------------------------------------
  readonly activeRegionByLayer: ReadonlyMap<
    LayerId,
    WatchableValue<ActiveRegion | undefined>
  > = this._activeRegionByLayer;

  /**
   * Per-layer patch texture caches that are currently attached. The
   * cache is what implements `PatchedMaskProvider` and feeds the base
   * `SegmentationRenderLayer`'s patch-overlay shader path.
   */
  get attachedPatchTextureCaches(): ReadonlyMap<LayerId, PatchTextureCache> {
    const m = new Map<LayerId, PatchTextureCache>();
    for (const [id, e] of this.perLayer) m.set(id, e.textureCache);
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
    // The chunk source merges in-memory committed chunks into baseline
    // reads so a new session starts on top of a previous session's
    // commits. See NgChunkSource.readBaselineChunk.
    this.chunkSource.commitTarget = this.commitTarget;
    this.saveTarget = new NgSaveTarget(
      this.viewer.layerManager,
      this.layerMetadataSource,
      this.logger,
      // Read-back verification: confirm saved chunks are durable in storage
      // before the session is marked clean (TM-352).
      this.chunkSource,
    );

    // NG does NOT register a save backend itself. NG runs as a same-origin
    // iframe and cannot perform the authenticated write; the embedding host
    // (the portal) installs a backend at viewer-ready via the public
    // registration surface below — typically the NG-provided
    // `PostMessageSaveBackend` (reachable as
    // `window.viewer.editSessionHost.PostMessageSaveBackend`). Until it does,
    // `saveBackendAvailable` is false and the Save controls stay disabled.
    this.registerDisposer(
      saveBackendRegistryChanged.add(() => {
        this.saveBackendAvailable.value = hasAnySaveBackend();
      }),
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

    // Idle (no-session) hotkey layer: Ctrl+E / Cmd+E → quick edit-region
    // capture (TM-290). Installed for the viewer's lifetime; shadowed while a
    // session is active by the session-scoped binder.
    this.registerDisposer(new IdleEditHotkeyBinder(this, this.viewer));
  }

  /**
   * Begin the quick edit-region capture flow (TM-290): draw a 2-corner box,
   * then open the entry modal pre-selected. No-op while a session is active.
   * Also the entry point for a future host-side "Start editing" button.
   */
  beginQuickRegionCapture(): void {
    if (this.activeSession.value !== undefined) return;
    if (this.quickRegionCapture === undefined) {
      this.quickRegionCapture = this.registerDisposer(
        new QuickRegionCapture(this),
      );
    }
    this.quickRegionCapture.start();
  }

  // -- Lifecycle ------------------------------------------------------------

  /** Open a session described by the host-side `HostSessionConfig`. */
  async openSession(config: HostSessionConfig): Promise<EditSession> {
    if (this.activeSession.value !== undefined) {
      throw new Error("A session is already active");
    }

    // Capture any persisted tooling BEFORE `writeIntentToState` overwrites the
    // intent with a fresh config-derived block (TM-315 restore). For a fresh
    // session this is the prior (cleared) intent's tooling — undefined.
    const restoreTooling = this.state.value.value?.tooling;

    // NOTE: previously we tore down all per-layer machinery here so each
    // session started fresh. That broke the cross-session "in-memory
    // commits stay visible and editable" workflow — we now preserve any
    // leftover LocalPatchStore + PatchedSegmentationRenderLayer per layer
    // and just attach a fresh PatchMirror to the new session's overlay in
    // `attachPerLayer`. Layers that aren't in the new config but still
    // have a perLayer entry from a previous commit stay attached and
    // visible until the user explicitly Saves or Resets them via the
    // pending-changes panel.

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
      // Bbox clipping is enforced by the library's paint write path (it
      // clamps every voxel write to the session region), so the host no
      // longer feeds the bbox to the compute out-of-band.
      this.sessionLock.setActiveSession({
        sessionId: session.sessionId,
        sessionLayerIds: new Set(config.layers.map((l) => l.layerId)),
      });
      this.bindSessionEvents(session);
      // Set `activeSession.value` BEFORE persisting the intent. Writing the
      // intent dispatches `state.changed`, which the constructor subscribes
      // to in order to trigger `tryRestoreFromState()` after a URL-state
      // restore. The subscription short-circuits when a session is already
      // active — so we need `activeSession.value` to be set first. Doing it
      // in the other order makes the just-opened session look like a
      // restore-pending intent, leading the subscription to call
      // `openSession` again (which throws "A session is already active"),
      // and the failure handler clears the intent — wiping the URL state
      // we'd just persisted. The user only sees the bug on the next reload.
      this.activeSession.value = session;
      // Fresh session: the brush size will be re-seeded from the zoom on the
      // first paint-tool activation.
      this.brushSizeAutoSized = false;
      // A session is now live — abort any quick-region capture still in flight
      // (e.g. a restore raced an in-progress capture). No-op if idle.
      this.quickRegionCapture?.cancel();
      this.writeIntentToState(config);
      // Memoize the resolution selection (TM-336) so the next entry modal can
      // autofill it. Written from the config — i.e. the modal output, which is
      // the source of truth for the open — not from any prior preference.
      this.rememberResolutions(config);
      // Construct the consumer-owned painting tools (TM-315) before the input
      // bridge — the bridge dispatches pointer input to them.
      await this.instantiatePaintingTools(session, config);
      this.pointerEventBridge = new PointerEventBridge(
        this,
        this.viewer.display,
      );
      this.hotkeyBinder = new EditSessionHotkeyBinder(this, this.viewer);
      this.attachCursorOverlays(config);
      // Restore persisted tool state (TM-315) now that the tools + UI are
      // wired: patches the family config + re-selects the active tool. Patches
      // are validated against the session layers (stale bindings dropped).
      this.applyRestoredTooling(restoreTooling);
      // When no tool was restored, land on navigation: `selectTool(undefined)`
      // shows the read-only session-summary panel so the left column is
      // occupied from the first frame (TM-338).
      if (this.activeToolId.value === undefined) {
        this.selectTool(undefined);
      }
      // Bring the user to the freshly opened session's region; entering a
      // session whose bbox is elsewhere in the volume would otherwise leave
      // them staring at unrelated (now hard-clipped) data.
      this.teleportToActiveRegionCenter();
      // Make a writable target the selected layer (TM-334). Otherwise, if an
      // annotation layer stays selected, its `Ctrl`-based bindings (notably
      // `annotate`, which targets `viewer.selectedLayer.layer`) collide with
      // the session's `Ctrl` painting hotkeys and the session "bugs out".
      this.selectSessionTargetLayer(config);
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

  /**
   * Switch the UI's selected layer to one of the session's writable targets
   * (TM-334). The `annotate` action (`Ctrl+click`) dispatches to
   * `viewer.selectedLayer.layer`'s tool, so leaving an annotation layer
   * selected when a session opens makes its `Ctrl` bindings collide with the
   * session's `Ctrl` painting hotkeys. Picking a writable target keeps the
   * selected layer aligned with what is being edited. No-op when the config
   * has no writable layer or it can't be resolved to a managed layer.
   */
  private selectSessionTargetLayer(config: HostSessionConfig): void {
    const target = config.layers.find((l) => l.writable);
    if (target === undefined) return;
    const managed = this.viewer.layerManager.getLayerByName(target.layerId);
    if (managed === undefined) return;
    this.viewer.selectedLayer.layer = managed;
  }

  /**
   * Discard the active session. The CURRENT session's edits are rolled
   * back, but in-memory committed patches from previous sessions are
   * preserved (the user's "Save" buffer survives this discard — only
   * "Reset" in the pending-changes panel clears that).
   *
   * Rollback procedure: for every chunk dirtied during this session,
   *   - if `commitTarget` has a committed snapshot → re-mirror it into the
   *     per-layer LocalPatchStore (reverting to the committed state),
   *   - else → drop the chunk's patch entry so the base layer renders
   *     through (no leftover patches from in-session edits).
   * Chunks NOT dirtied in this session keep whatever committed state they
   * already had.
   */

  /**
   * Tool selection invariant. The only entry point allowed to flip per-tool
   * panel visibility — every other path (topbar click, hotkey, session
   * teardown) goes through this method so the "≤1 tool panel visible at a
   * time, matching the active tool" invariant always holds.
   *
   * `toolId === undefined` clears the active tool and hides all five panels
   * (used for cursor selection and Escape).
   */
  selectTool(toolId: string | undefined): void {
    const session = this.activeSession.value;
    if (session === undefined) return;
    // Consumer-owned tool selection (TM-315). The binder manages the active
    // tool's activation (disposing the previous one rolls back any in-flight
    // stroke) and writes the stable `activeToolId` watchable.
    this.toolBinder?.select(toolId);
    // The navigation (cursor) tool has no real tool id — it maps to
    // `undefined`. Its panel is the default shown whenever no paint/edit tool
    // panel is active, so the left column stays occupied and the field of view
    // doesn't jump on tool switches (TM-338).
    const target =
      toolId !== undefined
        ? this.toolPanelLocationFor(toolId)
        : this.navPanelLocation;
    for (const loc of this.allToolPanelLocations()) {
      loc.visible = loc === target;
    }
    if (toolId === "painting.brush" || toolId === "painting.erase") {
      this.maybeSeedBrushSizeFromZoom();
    }
  }

  /**
   * On the first paint-tool activation of a session, seed the brush size from
   * the current zoom so its on-screen footprint is a usable, visible size
   * regardless of how far the user is zoomed in/out. A fixed default reads as
   * either a sub-pixel speck (zoomed out) or a screen-filling blob (zoomed in);
   * scaling to a target on-screen diameter avoids both. Runs once per session
   * (`brushSizeAutoSized`) so it never overrides a size the user later picks.
   */
  private maybeSeedBrushSizeFromZoom(): void {
    if (this.brushSizeAutoSized) return;
    // Consumer-owned painting state (TM-315): the library no longer ships a
    // `PaintingTools` reachable via `session.tools`. Seed through the host's
    // own `PaintingState` (`getState`/`patchState`), same as elsewhere.
    const painting = this.paintingTools?.state;
    if (painting === undefined) return; // painting not registered (degraded session)
    const pixelSizeMeters = this.sliceViewPixelSizeMeters();
    if (pixelSizeMeters === undefined) return;
    const voxelSizeNm = Resolution.toVoxelSize(
      painting.getState().targetResolution,
    );
    // The brush stamps in the X/Y plane; size to the finer in-plane axis so an
    // anisotropic grid never yields an oversized footprint.
    const inPlaneNm = Math.min(voxelSizeNm[0], voxelSizeNm[1]);
    if (!Number.isFinite(inPlaneNm) || inPlaneNm <= 0) return;
    // voxels spanned by one screen pixel = (m/px) / (m/voxel).
    const voxelsPerPixel = pixelSizeMeters / (inPlaneNm * 1e-9);
    if (!Number.isFinite(voxelsPerPixel) || voxelsPerPixel <= 0) return;
    const desiredSize = TARGET_BRUSH_DIAMETER_PX * voxelsPerPixel;
    const size = nearestPresetSize(desiredSize);
    painting.patchState({ radius: sizeToRadius(size) });
    this.brushSizeAutoSized = true;
  }

  /**
   * Physical size (meters per screen pixel) of the first laid-out slice view,
   * or `undefined` when none is available yet. Slice panels share the viewer
   * zoom, so any one is representative for sizing the brush.
   */
  private sliceViewPixelSizeMeters(): number | undefined {
    const panels = (
      this.viewer.display as unknown as { panels?: Iterable<unknown> }
    ).panels;
    if (panels === undefined) return undefined;
    for (const panel of panels) {
      const pixelSize = (
        panel as {
          sliceView?: {
            projectionParameters?: { value?: { pixelSize?: number } };
          };
        }
      ).sliceView?.projectionParameters?.value?.pixelSize;
      if (
        pixelSize !== undefined &&
        Number.isFinite(pixelSize) &&
        pixelSize > 0
      ) {
        return pixelSize;
      }
    }
    return undefined;
  }

  /**
   * Toggles only the given tool's panel visibility — does NOT change the
   * active tool. Used by the topbar when the user re-clicks the icon of the
   * currently-active tool.
   */
  toggleToolPanel(toolId: string): void {
    const loc = this.toolPanelLocationFor(toolId);
    if (loc !== undefined) loc.visible = !loc.visible;
  }

  /**
   * Rebind an edit hotkey at runtime (TM-315). `name` is the friendly action
   * name (e.g. `"brush"`, `"undo"`); `keys` are the NG event identifier(s)
   * (e.g. `"control+keyb"`) that should trigger it, replacing the configured
   * default. The session hotkey binder rebuilds its input layer live, and the
   * override is persisted into the `editSession` block so it survives reload.
   * Passing an empty `keys` array reverts `name` to its configured default.
   */
  setEditKeybind(name: string, keys: readonly string[]): void {
    const next: { [n: string]: readonly string[] } = {
      ...this.editKeybindOverrides.value,
    };
    if (keys.length === 0) {
      delete next[name];
    } else {
      next[name] = keys;
    }
    this.editKeybindOverrides.value = next;
  }

  /**
   * The working resolution of the currently-active tool — the voxel grid its
   * `voxelPosition` input is interpreted in. Painting and z-extrapolation use
   * their `targetResolution`; correspondence uses its `writeResolution`. The
   * pointer bridge uses this to convert the viewer's global-space pointer
   * position into the tool's voxel frame (see `globalToTargetVoxel`); without
   * it, strokes are interpreted at whatever resolution the viewer happens to
   * display and fall outside the session bounds when it differs from the
   * tool's resolution. Returns `undefined` when no session/tool is active or
   * the tool state can't be read.
   */
  activeToolWorkingResolution(): ResolutionType | undefined {
    const activeId = this.activeToolId.value;
    if (activeId === undefined) return undefined;
    if (activeId.startsWith("painting")) {
      return this.paintingTools?.state.getState().targetResolution;
    }
    // z-extrapolation / correspondence are not registered yet (TM-310); their
    // working-resolution wiring returns when those ported tools ship (TM-315).
    return undefined;
  }

  /**
   * Physical size, in nanometers, of one unit of the viewer's global
   * coordinate space along each of the first three axes — the frame
   * `mouseState.unsnappedPosition` is reported in. Mirrors the meters→nm
   * convention used when capturing a bbox annotation's `voxelSizeNm`
   * (`bbox_candidates.ts`): a dimension declared in meters is scaled to nm,
   * anything else passes through unchanged. Returns `undefined` when the
   * coordinate space has fewer than three dimensions.
   */
  globalVoxelSizeNm(): readonly [number, number, number] | undefined {
    const space = this.viewer.coordinateSpace.value;
    const { scales, units } = space;
    if (scales.length < 3) return undefined;
    const out: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < 3; ++i) {
      out[i] = units[i] === "m" ? scales[i] * 1e9 : scales[i];
    }
    return out;
  }

  private toolPanelLocationFor(
    toolId: string,
  ): TrackableSidePanelLocation | undefined {
    switch (toolId) {
      case "painting.brush":
        return this.brushPanelLocation;
      case "painting.erase":
        return this.eraserPanelLocation;
      case "painting.fill":
        return this.fillPanelLocation;
      case "z-extrapolation":
        return this.zExtrapPanelLocation;
      case "correspondence":
        return this.correspondencePanelLocation;
    }
    return undefined;
  }

  private allToolPanelLocations(): TrackableSidePanelLocation[] {
    return [
      this.navPanelLocation,
      this.brushPanelLocation,
      this.eraserPanelLocation,
      this.fillPanelLocation,
      this.zExtrapPanelLocation,
      this.correspondencePanelLocation,
    ];
  }

  async discardActive(): Promise<void> {
    const session = this.activeSession.value;
    if (session === undefined) return;
    // Snapshot the dirty set BEFORE discarding — `session.discard()` clears
    // the library's DirtyTracker.
    const dirty = Array.from(session.dirty.getDirtyChunks());
    try {
      await session.discard();
    } finally {
      this.rollbackDirtyChunks(dirty);
      this.commitTeardown();
    }
  }

  private rollbackDirtyChunks(overlayKeys: readonly string[]): void {
    for (const key of overlayKeys) {
      let coord;
      try {
        coord = OverlayKey.toCoord(key);
      } catch {
        continue;
      }
      const entry = this.perLayer.get(coord.layerId);
      if (entry === undefined) continue;
      const committed = this.commitTarget.getChunk(
        coord.layerId,
        coord.resolution,
        coord.chunkId,
      );
      const chunkCoord = ChunkIdFactory.toCoord(coord.chunkId);
      const chunkGridPosition = new Float32Array([
        chunkCoord.x,
        chunkCoord.y,
        chunkCoord.z,
      ]);
      if (committed === undefined) {
        // No committed snapshot — drop the patch entirely so the base
        // layer renders through.
        entry.patchStore.clearChunk(chunkGridPosition);
        continue;
      }
      // Revert to the committed bytes. Mirror the conversion that
      // `PatchMirror` does for live overlay writes.
      const view = committed.bytes.asView();
      const data =
        view instanceof BigUint64Array ? view : widenToBigUint64(view);
      const chunkDataSize = this.chunkDataSizeForLayer(
        coord.layerId,
        coord.resolution,
      );
      if (chunkDataSize === undefined) continue;
      entry.patchStore.writeFullChunk(chunkGridPosition, chunkDataSize, data);
    }
  }

  private chunkDataSizeForLayer(
    layerId: LayerId,
    _resolution: ResolutionType,
  ): readonly [number, number, number] | undefined {
    // The size is layer-resolution-specific. Pull it from the base
    // segmentation render layer's first source (the same source the
    // patch texture cache mirrors voxel-for-voxel).
    const entry = this.perLayer.get(layerId);
    if (entry === undefined) return undefined;
    const sources = entry.baseRenderLayer.visibleSourcesList;
    for (const v of sources) {
      const size = v.source.spec.chunkDataSize;
      if (size.length >= 3) {
        // We don't strictly check resolution match here — chunk sizes are
        // typically consistent across scales for a given layer at editing
        // time and the rollback is best-effort. The library's metadata
        // source is the authoritative answer but it's async; this path
        // runs synchronously inside discard.
        return [size[0], size[1], size[2]];
      }
    }
    return undefined;
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
      // Commit = client-side in-memory persist. Keep the painted patches
      // visible on the canvas (they live in the per-layer LocalPatchStore /
      // PatchedSegmentationRenderLayer) so the user sees their work after
      // committing. Discarding or starting a new session clears them.
      this.commitTeardown();
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
    this.saveInProgress.value = true;
    const onExternalAbort = () => controller.abort();
    if (signal !== undefined) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    try {
      // `NgSaveTarget` read-back-verifies each saved chunk before the library
      // marks it clean, and that verification re-reads from the backend (which
      // also refreshes the base layer to the saved bytes) — so the host no
      // longer invalidates the cache out-of-band here (TM-352).
      return await session.save(layerIds, controller.signal);
    } finally {
      if (signal !== undefined) {
        signal.removeEventListener("abort", onExternalAbort);
      }
      if (this.saveAbortController === controller) {
        this.saveAbortController = undefined;
        this.saveInProgress.value = false;
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

  /**
   * Public host-level registration surface for save backends, reachable via
   * `window.viewer.editSessionHost`. Hosts embedding neuroglancer (e.g. the
   * portal) can register a backend for a specific data-source kind (the URL
   * scheme, e.g. `"calcada"`, `"gs"`); a scheme-specific backend takes
   * precedence over the default. See `src/editing/adapters/save_backend.ts`.
   */
  registerSaveBackend(kind: string, backend: SaveBackend): void {
    registerSaveBackend(kind, backend);
  }

  /**
   * Register the catch-all backend used for any data-source kind without a
   * scheme-specific backend. NG does not install one itself — the embedding
   * host (the portal) calls this at viewer-ready, typically with
   * `new this.PostMessageSaveBackend({ ... })`.
   */
  registerDefaultSaveBackend(backend: SaveBackend): void {
    registerDefaultSaveBackend(backend);
  }

  /**
   * Resolve the canonical data-source URL for a layer (e.g.
   * `gs://bucket/path|precomputed:`). Exposed so an embedder constructing a
   * `PostMessageSaveBackend` can wire its `resolveDataSourceUrl` option without
   * reaching into the viewer's `LayerManager` directly.
   */
  resolveLayerDataSourceUrl(layerId: LayerId): string | undefined {
    return resolveDataSourceUrl(this.viewer.layerManager, layerId);
  }

  // -- Committed-buffer lifecycle (post-commit, no active session) ---------

  /**
   * Drop the in-memory committed patches for `layerId` without persisting
   * them. Clears the corresponding `NgCommitTarget` entries and tears
   * down the layer's `LocalPatchStore` + `PatchedSegmentationRenderLayer`
   * so the base layer renders cleanly again. Safe to call any time.
   */
  resetLayer(layerId: LayerId): void {
    this.commitTarget.clearLayer(layerId);
    const entry = this.perLayer.get(layerId);
    if (entry === undefined) return;
    if (entry.mirror !== undefined) {
      try {
        entry.mirror.dispose();
      } catch {
        // ignore
      }
    }
    // Withdraw the texture cache from the layer's editPatchOverlay
    // watchable BEFORE disposing it. Otherwise the base segmentation
    // shader might still try to bind from a freed texture handle on the
    // next redraw.
    const patchOverlayWatchable = this.patchOverlayByLayer.get(layerId);
    if (patchOverlayWatchable !== undefined) {
      patchOverlayWatchable.value = undefined;
    }
    try {
      entry.textureCache.dispose();
    } catch {
      // ignore
    }
    try {
      entry.patchStore.dispose();
    } catch {
      // ignore
    }
    this.perLayer.delete(layerId);
    this._activeRegionByLayer.delete(layerId);
  }

  /** Drop the committed patches for every layer. */
  resetAllCommitted(): void {
    for (const layerId of [...this.perLayer.keys()]) {
      this.resetLayer(layerId);
    }
    // Make sure NgCommitTarget is fully empty even for layers whose
    // perLayer entry was already gone.
    this.commitTarget.clearAll();
  }

  /**
   * Persist the in-memory committed patches for the given layers (or all
   * layers with pending changes if `layerIds` is omitted) via the host's
   * save backends. On per-layer success the corresponding committed
   * entries are cleared from `NgCommitTarget` and the layer's
   * `LocalPatchStore` + `PatchedSegmentationRenderLayer` are torn down.
   *
   * Distinct from `saveActive()`, which only writes the live session's
   * dirty chunks via the library's pipeline. This path is for committed
   * buffers that survived past session end.
   */
  async saveCommitted(layerIds?: readonly LayerId[]): Promise<SaveResult> {
    const targetLayers =
      layerIds !== undefined && layerIds.length > 0
        ? Array.from(new Set(layerIds))
        : this.commitTarget.pendingLayerIds();
    const outcomes: SaveLayerOutcome[] = [];
    for (const layerId of targetLayers) {
      const chunks = this.commitTarget.layerChunks(layerId);
      if (chunks.length === 0) continue;
      const payload: SavePayload = {
        // No live session; synthesize a marker session id. Backends in
        // v1 do not use this field for routing or auth.
        sessionId: toSessionId("post-commit-save"),
        savedAt: this.clock.now(),
        layerIds: [layerId],
        chunks: chunks.map((c) => ({
          layerId: c.layerId,
          resolution: c.resolution,
          chunkId: c.chunkId,
          chunkCoord: c.chunkCoord,
          contentRef: c.contentRef,
          bytes: c.bytes,
        })),
      };
      let layerResult: SaveResult;
      try {
        layerResult = await this.saveTarget.save(payload);
      } catch (err) {
        outcomes.push({
          status: "failed",
          layerId,
          error: {
            kind: "recoverable",
            code: "save-target-threw",
            message: err instanceof Error ? err.message : String(err),
            at: this.clock.now(),
          },
        });
        continue;
      }
      for (const o of layerResult.outcomes) outcomes.push(o);
      // `NgSaveTarget.save` (used above) read-back-verifies each chunk before
      // reporting `succeeded` (TM-352), so a success here is confirmed durable.
      // Clear the committed buffer + render machinery for any succeeded layer.
      for (const o of layerResult.outcomes) {
        if (o.status === "succeeded") this.resetLayer(o.layerId);
      }
    }
    return { overall: computeOverallOutcome(outcomes), outcomes };
  }

  /**
   * True iff there's at least one committed chunk pending in memory that
   * the user has not yet saved to the backend. Used to drive the
   * `beforeunload` warning.
   */
  hasPendingCommittedChanges(): boolean {
    return this.commitTarget.accepted.size > 0;
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
  ): WatchableValue<{ lo: vec3; hi: vec3 } | undefined> {
    let w = this.editBboxByLayer.get(layerName);
    if (w === undefined) {
      w = new WatchableValue<{ lo: vec3; hi: vec3 } | undefined>(
        this.readEditBboxForLayer(layerName),
      );
      this.editBboxByLayer.set(layerName, w);
    }
    return w;
  }

  /**
   * Move the viewer's global position to the center of the active edit
   * region. Only the display-dimension coordinates change; other global
   * coordinates (e.g. `t`) are left untouched. Returns `false` when no
   * session is active (no region to teleport to).
   *
   * Used by the topbar's "center on edit region" button and called
   * automatically at the end of `openSession`.
   */
  teleportToActiveRegionCenter(): boolean {
    const config = this.activeSessionConfig;
    if (config === undefined) return false;
    const region = this.computeActiveRegionSync(config);
    if (region === undefined) return false;
    const renderInfo = this.viewer.displayDimensionRenderInfo.value;
    // Snap to a covered voxel center rather than the geometric midpoint: a
    // one-voxel-thick region's midpoint can sit on a voxel boundary, which
    // `floor`s to a voxel outside the library's `[floor(lo), floor(hi))` clip
    // range, so every stroke is silently dropped until a manual nudge. See
    // `voxelCenterInBox`.
    this.viewer.position.value = voxelCenterInBox(
      this.viewer.position.value,
      renderInfo.displayDimensionIndices,
      region.lo,
      region.hi,
    );
    return true;
  }

  /**
   * Active edit region in the viewer's global display-voxel frame — the same
   * frame as the position readout — or `undefined` when no session/region is
   * active. Surfaced for the navigation panel's coordinate readout (TM-338).
   */
  activeRegionDisplayBounds(): ActiveRegion | undefined {
    const config = this.activeSessionConfig;
    if (config === undefined) return undefined;
    return this.computeActiveRegionSync(config);
  }

  /**
   * Move the viewer to a corner of the active edit region — the lower
   * (`"lo"`) or upper (`"hi"`) bound. Like {@link teleportToActiveRegionCenter}
   * but targets a corner; only the display-dimension coordinates change.
   * Snaps to the covered voxel center at that corner (a degenerate
   * `[point, point]` box resolves to `floor(point) + 0.5`), so the move lands
   * on the same whole voxel the readout floors to. Returns `false` when no
   * session is active.
   */
  teleportToActiveRegionCorner(corner: "lo" | "hi"): boolean {
    const config = this.activeSessionConfig;
    if (config === undefined) return false;
    const region = this.computeActiveRegionSync(config);
    if (region === undefined) return false;
    const renderInfo = this.viewer.displayDimensionRenderInfo.value;
    const point = corner === "lo" ? region.lo : region.hi;
    this.viewer.position.value = voxelCenterInBox(
      this.viewer.position.value,
      renderInfo.displayDimensionIndices,
      point,
      point,
    );
    return true;
  }

  /**
   * Returns the persistent per-layer watchable for the patched-mask
   * provider hook the base `SegmentationRenderLayer` consumes via
   * `editPatchOverlay`. The watchable's current value is the active
   * session's `PatchedSegmentationRenderLayer` (which implements
   * `PatchedMaskProvider`) for this layer, or `undefined` if no session
   * has attached a provider yet. Lazily allocated — same wiring pattern
   * as `getActiveRegionWatchableForLayer`.
   */
  getPatchOverlayWatchableForLayer(
    layerName: string,
  ): WatchableValue<PatchedMaskProvider | undefined> {
    let w = this.patchOverlayByLayer.get(layerName);
    if (w === undefined) {
      const existing = this.perLayer.get(layerName as LayerId)?.textureCache;
      w = new WatchableValue<PatchedMaskProvider | undefined>(existing);
      this.patchOverlayByLayer.set(layerName, w);
    }
    return w;
  }

  private readEditBboxForLayer(
    layerName: string,
  ): { lo: vec3; hi: vec3 } | undefined {
    // The `LayerId` newtype is a branded string; the lookup map is keyed by
    // the brand, but at runtime branded strings are plain strings, so the
    // cast is a no-op.
    const region = this._activeRegionByLayer.get(layerName as LayerId)?.value;
    if (region === undefined) return undefined;
    return {
      lo: vec3.fromValues(region.lo[0], region.lo[1], region.lo[2]),
      hi: vec3.fromValues(region.hi[0], region.hi[1], region.hi[2]),
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

  /**
   * Return a persistent watchable holding the set of resolutions the layer's
   * slice-view render layers are allowed to display while a session is
   * active, or `undefined` when no session is active for the layer.
   *
   * Used by `SliceViewRenderLayer.getSources` to filter the multiscale
   * source's scales, restricting display to the user-selected resolutions
   * for both writable and locked layers in the session.
   */
  getAllowedResolutionsWatchableForLayer(
    layerName: string,
  ): WatchableValue<ReadonlySet<ResolutionType> | undefined> {
    let w = this.allowedResolutionsByLayer.get(layerName);
    if (w === undefined) {
      w = new WatchableValue<ReadonlySet<ResolutionType> | undefined>(
        this.readAllowedResolutionsForLayer(layerName),
      );
      this.allowedResolutionsByLayer.set(layerName, w);
    }
    return w;
  }

  private readAllowedResolutionsForLayer(
    layerName: string,
  ): ReadonlySet<ResolutionType> | undefined {
    return this._allowedResolutionsByLayer.get(layerName as LayerId);
  }

  private refreshAllowedResolutionsWatchables(): void {
    for (const [layerName, watchable] of this.allowedResolutionsByLayer) {
      watchable.value = this.readAllowedResolutionsForLayer(layerName);
    }
  }

  // -- Reload restore -------------------------------------------------------

  /**
   * Promise of the in-flight restore attempt, if any. Used to coalesce
   * repeated `state.changed` firings during the same restore window
   * (e.g. URL parse → layer add → data-source load each dispatch
   * `state.changed` indirectly).
   */
  private restoreInFlight: Promise<void> | undefined;

  /**
   * Re-open a session from `state` after a viewer reload. No-op when no
   * intent is persisted or when a session is already active.
   *
   * Layers and their data sources load asynchronously after URL parse, so
   * this method awaits per-layer readiness via the metadata source's
   * `waitForVolumetricReady` gate before validating resolutions. Without it,
   * restore would race data-source loading and clear the persisted session on
   * a transient "no-volumetric-data-source" error. Restore is otherwise
   * annotation-independent (TM-299): the region comes from `intent.region`, so
   * a deleted source annotation layer does not break reopening.
   */
  async tryRestoreFromState(): Promise<void> {
    if (this.restoreInFlight !== undefined) return this.restoreInFlight;
    if (this.activeSession.value !== undefined) return;
    if (this.state.value.value === null) return;
    const attempt = this.runRestoreAttempt().finally(() => {
      this.restoreInFlight = undefined;
    });
    this.restoreInFlight = attempt;
    return attempt;
  }

  private async runRestoreAttempt(): Promise<void> {
    // Capture the intent at attempt-start so that if `state` is mutated
    // mid-await (user pastes a new state, or `failRestore` clears it),
    // we abandon this attempt rather than mis-applying stale config.
    const intent = this.state.value.value;
    if (intent === null) return;

    // Restore is annotation-independent (TM-299): the region is reconstructed
    // from `intent.region` (self-describing `lo`/`hi` + `dimensions`), so a
    // deleted source annotation layer no longer breaks reopening the session.

    for (const layer of intent.layers) {
      try {
        await this.layerMetadataSource.waitForVolumetricReady(layer.layerId);
        if (!this.intentIsStillCurrent(intent)) return;
        const metadata = await this.layerMetadataSource.resolve(layer.layerId);
        if (!this.intentIsStillCurrent(intent)) return;
        const availableResolutions = new Set(
          metadata.scales.map((s) => s.resolution),
        );
        for (const resolution of layer.resolutions) {
          if (!availableResolutions.has(resolution)) {
            this.failRestore(
              `Edit session reference invalid: resolution ${JSON.stringify(resolution)} unavailable on layer ${JSON.stringify(layer.layerId)}.`,
            );
            return;
          }
        }
      } catch (err) {
        if (!this.intentIsStillCurrent(intent)) return;
        const message = err instanceof Error ? err.message : String(err);
        this.failRestore(`Edit session reference invalid: ${message}`);
        return;
      }
    }

    // Reconstruct the single region frame from the persisted dimensions; the
    // library `Resolution` tag is derived from it on demand at use sites.
    const config: HostSessionConfig = {
      bboxVoxelCoords: [
        intent.region.lo[0],
        intent.region.lo[1],
        intent.region.lo[2],
        intent.region.hi[0],
        intent.region.hi[1],
        intent.region.hi[2],
      ],
      regionSpace: coordinateSpaceFromJson(intent.region.dimensions),
      layers: intent.layers,
    };
    if (!this.intentIsStillCurrent(intent)) return;
    try {
      await this.openSession(config);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.failRestore(`Could not re-open session: ${message}`);
    }
  }

  private intentIsStillCurrent(intent: EditSessionIntent): boolean {
    if (this.activeSession.value !== undefined) return false;
    return this.state.value.value === intent;
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
    if (config.layers.length === 0) {
      throw new InvalidSessionConfigError(
        "EditSessionConfig.layers must be non-empty",
      );
    }
    // Boot pyodide eagerly as the session opens so the multi-second cold start
    // is hidden before the user's first masked brush stroke (TM-304).
    this.morphologyClient.warmup();
    const layers: LayerSelection[] = config.layers.map((l) => ({
      layerId: l.layerId,
      selectedResolutions: [...l.resolutions],
    }));

    // The library no longer ships tools (TM-315): the config carries only the
    // session region + layers. The host constructs its own painting tools
    // AFTER `EditSession.open(...)` via `instantiatePaintingTools`.
    return {
      layers,
      region: {
        bbox: config.bboxVoxelCoords,
        resolution: regionResolution(config.regionSpace),
      },
    };
  }

  /**
   * Construct the consumer-owned painting tools for a freshly-opened session
   * (TM-315). Resolves per-layer metadata (the library no longer exposes its
   * internal `metadataByLayer`), wires `PaintingCompute` to read the host's
   * active-tool id (so the eraser never inherits the brush's image mask,
   * TM-297), and builds the cross-layer baseline reader the masked brush uses
   * for its image (mask) layer.
   */
  /**
   * Pick the default brush mask for a freshly-opened session: the first
   * session layer that is an image (reference) layer with a thresholdable
   * voxel type. Mirrors the brush panel's reference-layer filtering so the
   * default matches what the user would pick first. Returns `undefined` when
   * the session has no usable image layer (e.g. only segmentation or uint64).
   */
  private defaultBrushMask(
    config: HostSessionConfig,
    metadataByLayer: ReadonlyMap<LayerId, LayerMetadata>,
  ): PaintingMaskConfig | undefined {
    for (const l of config.layers) {
      const managed = this.viewer.layerManager.getLayerByName(l.layerId);
      if (layerKindOf(managed) !== "image") continue;
      const meta = metadataByLayer.get(l.layerId);
      if (meta === undefined) continue;
      const range = voxelDataTypeRange(meta.voxelDataType);
      if (range === null) continue;
      return {
        imageLayerId: l.layerId,
        imageResolution: l.resolutions[0],
        thresholdLow: range.min,
        thresholdHigh: range.max,
        coverageThreshold: DEFAULT_COVERAGE_THRESHOLD,
        minComponentSize: 0,
        binaryClosing: 0,
        filterComponentsFirst: false,
      };
    }
    return undefined;
  }

  private async instantiatePaintingTools(
    session: EditSession,
    config: HostSessionConfig,
  ): Promise<void> {
    const firstWritable = config.layers.find((l) => l.writable);
    const targetLayer = firstWritable ?? config.layers[0];

    // Build the layer-metadata map the compute + tools need (target layer for
    // the stamp, image layer for the mask threshold).
    const metadataByLayer = new Map<LayerId, LayerMetadata>();
    await Promise.all(
      config.layers.map(async (l) => {
        metadataByLayer.set(
          l.layerId,
          await this.layerMetadataSource.resolve(l.layerId),
        );
      }),
    );

    // Resolutions the session actually opened (and the host preloads/pins) per
    // layer. Threaded into the painting tools so a masked stroke can never read
    // an un-pinned scale of the image layer's datasource pyramid (TM-350).
    const allowedResolutionsByLayer = new Map<
      LayerId,
      readonly ResolutionType[]
    >(config.layers.map((l) => [l.layerId, l.resolutions]));
    this._sessionResolutionsByLayer = allowedResolutionsByLayer;

    // The user-facing "Size" is `radius * 2 + 1` (see brush panel). Default
    // size 5 paints a 13-voxel diamond — visible enough to confirm the brush
    // works, small enough not to overshoot a precision edit.
    const initialState: PaintingSharedState = {
      targetLayerId: targetLayer.layerId,
      targetResolution: targetLayer.resolutions[0],
      radius: 2,
      radiusCycle: BRUSH_SIZE_PRESETS.map(sizeToRadius),
      // The brush writes this segment id into voxels. Default to 1n so the
      // brush produces visible results immediately; the user can change it via
      // the brush panel.
      activeValue: 1n,
      eraseValue: 0n,
      // Default the mask to the first usable image (reference) layer so a fresh
      // session can mask straight away (TM-317). The user clears it with the
      // reference picker's × button. A reopened session overrides this default
      // via `applyRestoredTooling` (which always patches `mask`), so a
      // previously-cleared mask stays cleared on reload.
      mask: this.defaultBrushMask(config, metadataByLayer),
      spacingFraction: DEFAULT_SPACING_FRACTION,
      // Fill defaults to 2D per-section (the common case — fill the interior of
      // a shape on one slice); the user switches to a 3D flood across sections
      // from the fill panel (TM-269).
      fillMode: "2d",
    };

    const compute = new PaintingCompute(this.morphologyClient);
    // Cross-layer baseline reader → the chunk-source adapter. Mirrors the
    // library runtime's old `readChunkAt`.
    const readChunkAt: ReadChunkAt = (layerId, resolution, chunkId) =>
      this.chunkSource.readBaselineChunk(
        layerId,
        resolution,
        chunkId,
        ChunkIdFactory.toCoord(chunkId),
      );

    // One Edit lifecycle owner per session, shared by the tools (so they open
    // edits) and the binder's activations (so a tool switch rolls back any
    // in-flight stroke) — the single-live-edit invariant (TM-315).
    const editScope = new EditScope(session);
    this.paintingTools = new ConsumerPaintingTools({
      scope: editScope,
      compute,
      metadataByLayer,
      allowedResolutionsByLayer,
      readChunkAt,
      initialState,
      // Drive the cursor-attached fill spinner (TM-269). `start`/`end` bracket
      // every fill (including canceled / failed); `update` fires per flush.
      fillProgress: {
        start: () => {
          this.fillProgressState.value = { kind: "running", voxelsWritten: 0 };
        },
        update: (voxelsWritten) => {
          this.fillProgressState.value = { kind: "running", voxelsWritten };
        },
        end: () => {
          this.fillProgressState.value = { kind: "idle" };
        },
      },
      // Surface a memory-bounded fill that stopped short (TM-269).
      notify: (message) => StatusMessage.showTemporaryMessage(message, 8000),
    });

    // Registry + session-scoped binder own active-tool selection + the
    // per-tool activation lifecycle. The binder writes the host's stable
    // `activeToolId` watchable so cursor / hotkeys / UI subscriptions survive
    // across sessions.
    const registry = new ToolRegistry();
    for (const def of this.paintingTools.toolDefinitions()) {
      registry.register(def);
    }
    this._toolRegistry = registry;
    const toolContext: EditToolContext = {
      session,
      metadataByLayer,
      readChunkAt,
      logger: this.logger,
      sessionLayers: session.config.layers,
    };
    this.toolBinder = new SessionToolBinder(
      this.viewer,
      registry,
      toolContext,
      this.activeToolId,
      editScope,
    );

    // Persist tool state into the `editSession` block on change (TM-315,
    // decision C). Debounced so a brush-size drag doesn't rewrite the URL per
    // tick. Disposed on session teardown.
    const persist = debounce(() => this.persistTooling(), 300);
    this.toolingSubscriptions.push(
      this.paintingTools.state.changed.add(() => persist()),
      this.activeToolId.changed.add(() => persist()),
      this.editKeybindOverrides.changed.add(() => persist()),
      () => persist.cancel(),
    );

    // The registry is now populated — notify UI (e.g. the topbar tool buttons)
    // that rendered against an empty registry when `activeSession` was first set.
    this.toolingChanged.dispatch();
  }

  /** Rebuild the persisted tooling block from the live tool state (TM-315). */
  private persistTooling(): void {
    const painting = this.paintingTools?.state.getState();
    if (painting === undefined) return;
    const tooling = serializeTooling(
      this.activeToolId.value,
      painting,
      this.editKeybindOverrides.value,
    );
    const intent = this.state.value.value;
    if (intent !== null) {
      this.state.value.value = { ...intent, tooling };
    }
    // Mirror into the cross-session preferences (TM-336) so the tool setup
    // survives session teardown and seeds the next fresh open.
    const prefs = this.editPreferences.value.value ?? {};
    this.editPreferences.value.value = { ...prefs, tooling };
  }

  /**
   * Apply persisted tool state after a session reopens (TM-315): patch the
   * painting family config (validated against the session layers; stale
   * bindings dropped) and re-select the active tool.
   *
   * `restoreTooling` is the per-session block from `editSession.tooling`,
   * present only when reloading an already-open session — it wins when set. For
   * a fresh open → close → open it is `undefined`, and we fall back to the
   * cross-session `editPreferences.tooling` (TM-336) to seed brush / tool /
   * keybind defaults. Either way the painting patch is re-validated against the
   * session layers, so a stale binding is dropped back to the hardcoded
   * defaults.
   */
  private applyRestoredTooling(
    restoreTooling: ToolingPersistState | undefined,
  ): void {
    const session = this.activeSession.value;
    if (session === undefined) return;
    const tooling = restoreTooling ?? this.editPreferences.value.value?.tooling;
    // Restore per-user keybind overrides (or clear any left over from a prior
    // session). Done before the early-return so a fresh session always starts
    // from the configured defaults. The binder watches this and rebuilds.
    this.editKeybindOverrides.value = tooling?.keybinds ?? {};
    if (tooling === undefined) return;
    if (this.paintingTools !== undefined && tooling.painting !== undefined) {
      // A stale persisted `mask.imageResolution` (e.g. a finer scale from the
      // image layer's datasource pyramid the session never pinned) is repaired
      // to a resident resolution instead of driving cold full-res EM reads
      // (TM-350). `_sessionResolutionsByLayer` holds the opened resolutions per
      // layer, captured in the awaited `instantiatePaintingTools`.
      const patch = paintingPatchFromPersist(
        tooling.painting,
        this._sessionResolutionsByLayer,
      );
      if (patch !== undefined) {
        this.paintingTools.state.patchState(patch);
      }
    }
    if (
      tooling.activeToolId !== null &&
      this.toolRegistry?.has(tooling.activeToolId)
    ) {
      this.selectTool(tooling.activeToolId);
    }
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
      // Routes the library's apply-path timings into the paint profiler (no-op
      // unless profiling is enabled). See `paintProfilerMetrics`.
      metrics: paintProfilerMetrics,
      // Back overlay working buffers with SharedArrayBuffer so the brush worker
      // pool can read/write them zero-copy (TM-322 / TM-317 Phase B); falls back
      // to ArrayBuffer when not cross-origin isolated (the worker path then
      // stays off — see `PaintStrokePipeline.available`).
      chunkBufferAllocator: createChunkBufferAllocator(),
    };
  }

  private async attachPerLayer(
    session: EditSession,
    config: HostSessionConfig,
  ): Promise<void> {
    // Step 1: populate `_activeRegionByLayer` for EVERY layer in the
    // session config (writable AND locked). Both kinds participate in
    // bbox-scoped rendering — per
    // `docs/edit-session-integration/architecture/06-bbox-rendering.md`
    // § "Behaviorally important details", the dim alpha applies to all
    // layers in `EditSessionConfig.layers`. Without this, locked image
    // layers stay fully bright outside the bbox (bug seen in v1).
    for (const layer of config.layers) {
      this._activeRegionByLayer.set(
        layer.layerId,
        new WatchableValue<ActiveRegion | undefined>(
          await this.computeActiveRegion(
            layer.layerId,
            layer.resolutions[0],
            config,
          ),
        ),
      );
      this._allowedResolutionsByLayer.set(
        layer.layerId,
        new Set(layer.resolutions),
      );
    }
    // Step 2: attach per-layer paint machinery for WRITABLE layers only.
    for (const layer of config.layers) {
      if (!layer.writable) continue;
      const userLayer = this.findSegmentationUserLayer(layer.layerId);
      if (userLayer === undefined) {
        this.logger.warn(
          "session",
          `Layer ${layer.layerId} is not a writable segmentation layer; skipping render-layer attach`,
        );
        continue;
      }
      // Reuse the existing per-layer entry when a previous commit left
      // one behind — its `LocalPatchStore` + `PatchTextureCache` are the
      // user's in-memory commits and must stay visible/editable.
      let entry = this.perLayer.get(layer.layerId);
      if (entry === undefined) {
        const baseRenderLayer = findBaseSegmentationRenderLayer(userLayer);
        if (baseRenderLayer === undefined) {
          this.logger.warn(
            "session",
            `Layer ${layer.layerId} has no SegmentationRenderLayer yet; skipping patch-overlay attach`,
          );
          continue;
        }
        const patchStore = new LocalPatchStore();
        const textureCache = new PatchTextureCache(patchStore);
        entry = {
          patchStore,
          textureCache,
          baseRenderLayer,
          mirror: undefined,
        };
        this.perLayer.set(layer.layerId, entry);
        // Publish the texture cache as the layer's PatchedMaskProvider so
        // the base `SegmentationRenderLayer`'s `getUint64DataValue` starts
        // sampling patched values uniformly with baseline values. The base
        // shader recompiles to the editPatchOverlayActive variant on this
        // watchable's first non-undefined dispatch.
        this.getPatchOverlayWatchableForLayer(layer.layerId).value =
          textureCache;
      }
      entry.mirror = new PatchMirror(
        session,
        layer.layerId,
        entry.patchStore,
        this.logger,
        (coord) =>
          this.chunkSource.readBaselineChunk(
            coord.layerId,
            coord.resolution,
            coord.chunkId,
            ChunkIdFactory.toCoord(coord.chunkId),
          ),
      );
    }

    // Save backend: persistence routes through whatever backend the embedding
    // host (the portal) registers via `registerDefaultSaveBackend` — typically
    // the protocol-agnostic `PostMessageSaveBackend`, which ships dirty chunks
    // to the portal over postMessage to be written there (TM-289, Option A).
    // NG registers none itself. The earlier calcada `/edit_write` HttpSource
    // path is retired, so no per-layer `HttpSource` resolution is needed.

    // Propagate the newly-set per-layer regions into any persistent
    // watchables that segmentation/image user layers subscribed to at their
    // construction time.
    this.refreshEditBboxWatchables();
    this.refreshAllowedResolutionsWatchables();

    // Keep the bbox-alpha render region in sync if the user relabels the
    // global "dimensions" while the session is open. The region is expressed
    // in display coordinates (a function of `voxelPhysicalScales`), so it must
    // be recomputed when those change — otherwise chunks visually disappear
    // (TM-298).
    this.activeSessionConfig = config;
    if (this.detachDisplayDimWatch === undefined) {
      this.detachDisplayDimWatch =
        this.viewer.displayDimensionRenderInfo.changed.add(() =>
          this.recomputeActiveRegions(),
        );
    }
  }

  /**
   * Compute the per-layer active region in the viewer's DISPLAY coordinate
   * space (the same frame as `viewer.position.value`). The conversion is:
   *
   *   bbox_displayVoxel[i] =
   *     bboxVoxels[i] × regionVoxelSizeNm[i] × 1e-9 /
   *     voxelPhysicalScales[i]
   *
   * where `voxelPhysicalScales[i]` is the display dimension's voxel size in
   * meters (from `viewer.displayDimensionRenderInfo.value`), and the `1e-9`
   * converts the annotation's nm voxel size to meters.
   *
   * The shader compares this with `(uChunkToGlobal *
   * vec4(vChunkPosition + uTranslation, 1.0)).xyz`, which is the
   * fragment's position in the same display-coord frame. So the
   * comparison is resolution-independent — works regardless of which
   * scale (16 nm vs 32 nm vs ...) the viewer actually rendered.
   *
   * `layerId` and `layerResolution` are retained for API symmetry; the
   * current bbox is layer-agnostic in display coords.
   */

  private async computeActiveRegion(
    _layerId: LayerId,
    _layerResolution: ResolutionType,
    config: HostSessionConfig,
  ): Promise<ActiveRegion | undefined> {
    return this.computeActiveRegionSync(config);
  }

  /**
   * Synchronous core of `computeActiveRegion`. The region is layer-agnostic in
   * display coordinates, so a single value applies to every session layer. It
   * depends on `displayDimensionRenderInfo.voxelPhysicalScales`, which changes
   * when the user relabels the global "dimensions" — see
   * `recomputeActiveRegions`, which re-runs this on that signal.
   */
  private computeActiveRegionSync(
    config: HostSessionConfig,
  ): ActiveRegion | undefined {
    const renderInfo = this.viewer.displayDimensionRenderInfo.value;
    const scales = renderInfo.voxelPhysicalScales;
    const bboxVoxelSizeNm = regionVoxelSizeNm(config.regionSpace);
    const display = (axis: number, voxelCoord: number): number => {
      const scale = scales[axis];
      if (!Number.isFinite(scale) || scale === 0) {
        return voxelCoord;
      }
      // Form the ratio in rounded nm on both sides so matching region/display
      // resolutions yield exactly 1.0. Dividing rounded-nm by the raw-metres
      // scale leaves IEEE-754 noise (e.g. 45nm / 4.5000000000000006e-8 m =
      // 0.9999999999999999), which floors a 3000 boundary to 2999 and drops
      // teleport-to-center and the corner readout a whole voxel.
      const displayVoxelSizeNm = Math.round(scale * 1e9 * 1e6) / 1e6;
      if (displayVoxelSizeNm === 0) return voxelCoord;
      return (voxelCoord * bboxVoxelSizeNm[axis]) / displayVoxelSizeNm;
    };
    return {
      lo: [
        display(0, config.bboxVoxelCoords[0]),
        display(1, config.bboxVoxelCoords[1]),
        display(2, config.bboxVoxelCoords[2]),
      ],
      hi: [
        display(0, config.bboxVoxelCoords[3]),
        display(1, config.bboxVoxelCoords[4]),
        display(2, config.bboxVoxelCoords[5]),
      ],
    };
  }

  /**
   * Recompute every layer's bbox-alpha render region from the current
   * display-dimension scales and republish to the `editBboxLoHi` watchables.
   * Triggered whenever `displayDimensionRenderInfo` changes (e.g. the user
   * relabels the global resolution mid-session) so the dim region tracks the
   * new display frame instead of masking the wrong area (TM-298). Painting is
   * unaffected — it converts pointer/region through the live scale and stable
   * target voxels — so this only keeps rendering consistent.
   */
  private recomputeActiveRegions(): void {
    const config = this.activeSessionConfig;
    if (config === undefined) return;
    const region = this.computeActiveRegionSync(config);
    for (const watchable of this._activeRegionByLayer.values()) {
      watchable.value = region;
    }
    this.refreshEditBboxWatchables();
  }

  /**
   * Construct the shared `BrushCursorState` and anchor the brush-cursor
   * overlays to the layer painting currently targets — re-anchoring whenever
   * the user switches the paint target layer. Anchoring to the *target* layer
   * (rather than always the first writable one) keeps the cursor visible
   * whenever the painted layer is visible: hiding an unrelated writable layer
   * no longer makes the cursor disappear. The overlay's draw pass still rides
   * the target layer's render-layer list, so the cursor follows that layer's
   * visibility — which is what the user controls when they hide it.
   */
  private attachCursorOverlays(config: HostSessionConfig): void {
    this.cursorState = new BrushCursorState(this);
    // Cursor-attached spinner for the in-flight fill (TM-269). DOM overlay, no
    // layer anchoring — independent of the paint target re-host below.
    this.fillCursorProgress = new FillCursorProgress(this.fillProgressState);
    this.attachHoverHighlightSuppression();
    const firstWritable = config.layers.find((l) => l.writable);
    if (firstWritable === undefined) return;
    this.cursorOverlayFallbackLayerId = firstWritable.layerId;

    this.reattachCursorOverlaysToTarget();
    this.detachCursorTargetWatch = this.cursorState.targetLayerId.changed.add(
      () => this.reattachCursorOverlaysToTarget(),
    );

    // Region overlays are hosted independently of the paint target: re-host
    // on any visible session layer whenever layer visibility changes, so the
    // outline persists when the user hides individual layers.
    this.regionHostLayerIds = config.layers.map((l) => l.layerId);
    this.reanchorRegionOverlays();
    this.detachRegionVisibilityWatch =
      this.viewer.layerManager.layersChanged.add(() =>
        this.reanchorRegionOverlays(),
      );
  }

  /**
   * Suppress segment hover-highlight on every segmentation layer while a
   * painting tool (brush/eraser/fill) is active, restoring it for navigate.
   * `BrushCursorState.toolKind` is exactly the paint-like classification
   * (`undefined` for navigate / non-paint tools), so it is the single signal we
   * watch. A second watch on `layersChanged` re-applies the current suppression
   * to layers that appear mid-session.
   */
  private attachHoverHighlightSuppression(): void {
    const apply = () => this.applyHoverHighlightSuppression();
    this.detachHoverSuppressionToolWatch =
      this.cursorState?.toolKind.changed.add(apply);
    this.detachHoverSuppressionLayerWatch =
      this.viewer.layerManager.layersChanged.add(apply);
    apply();
  }

  private applyHoverHighlightSuppression(): void {
    const suppress = this.cursorState?.toolKind.value !== undefined;
    this.setHoverHighlightSuppressedOnAllSegmentationLayers(suppress);
  }

  /**
   * Duck-typed sweep over all managed layers: any layer whose display state
   * carries a `hoverHighlightSuppressed` watchable is a segmentation layer (see
   * `findSegmentationUserLayer` for why we avoid a hard `instanceof`).
   */
  private setHoverHighlightSuppressedOnAllSegmentationLayers(
    suppress: boolean,
  ): void {
    for (const managed of this.viewer.layerManager.managedLayers) {
      const displayState = (managed.layer as SegmentationUserLayer | null)
        ?.displayState;
      const flag = displayState?.hoverHighlightSuppressed;
      if (flag !== undefined && flag.value !== suppress) {
        flag.value = suppress;
      }
    }
  }

  /**
   * (Re)anchor the cursor overlays to the current paint-target layer, falling
   * back to the first writable layer when no target resolves yet. Render-layer
   * detach disposes the overlay instance (see `removeRenderLayer`), so each
   * re-anchor creates fresh overlays bound to the shared `cursorState`.
   */
  private reattachCursorOverlaysToTarget(): void {
    const cursorState = this.cursorState;
    if (cursorState === undefined) return;

    const targetLayerId = cursorState.targetLayerId.value;
    let resolvedLayerId = targetLayerId;
    let userLayer =
      targetLayerId !== undefined
        ? this.findSegmentationUserLayer(targetLayerId)
        : undefined;
    if (
      userLayer === undefined &&
      this.cursorOverlayFallbackLayerId !== undefined
    ) {
      resolvedLayerId = this.cursorOverlayFallbackLayerId;
      userLayer = this.findSegmentationUserLayer(resolvedLayerId);
    }
    if (userLayer === undefined || resolvedLayerId === undefined) return;
    if (
      this.attachedCursorLayerId === resolvedLayerId &&
      this.sliceOverlay !== undefined
    ) {
      return; // Already anchored here.
    }

    this.detachCursorOverlayRenderLayers();
    this.sliceOverlay = new BrushCursorSliceOverlay(
      this.viewer.display.gl,
      cursorState,
    );
    this.detachSliceOverlay = userLayer.addRenderLayer(this.sliceOverlay);
    this.perspectiveOverlay = new BrushCursorPerspectiveOverlay(
      this.viewer.display.gl,
      cursorState,
    );
    this.detachPerspectiveOverlay = userLayer.addRenderLayer(
      this.perspectiveOverlay,
    );
    this.attachedCursorLayerId = resolvedLayerId;
  }

  /**
   * (Re)host the region overlays on a currently-visible session layer. The
   * outline must persist while the session is active regardless of which layers
   * the user hides, but neuroglancer only draws a render layer while its host
   * layer is visible (`LayerManager.readyRenderLayers`). So we host on whatever
   * session layer is visible — preferring the current host to avoid churn — and
   * draw nothing only when every session layer is hidden.
   *
   * TODO(Option D): replace with a panel-level session overlay that does not
   * depend on any layer's visibility.
   */
  private reanchorRegionOverlays(): void {
    // Attaching/detaching render layers below dispatches `layersChanged`, which
    // re-enters this method; ignore those nested calls.
    if (this.reanchoringRegionOverlays) return;
    this.reanchoringRegionOverlays = true;
    try {
      this.reanchorRegionOverlaysImpl();
    } finally {
      this.reanchoringRegionOverlays = false;
    }
  }

  private reanchorRegionOverlaysImpl(): void {
    if (this.regionHostLayerIds.length === 0) {
      this.detachRegionOverlayRenderLayers();
      return;
    }
    const layerManager = this.viewer.layerManager;
    const visibleManaged = (layerId: LayerId) => {
      const managed = layerManager.getLayerByName(layerId);
      if (managed === undefined || !managed.visible || managed.layer === null) {
        return undefined;
      }
      return managed;
    };

    // Keep the current host if it is still visible; otherwise take the first
    // visible session layer (the image layer counts — it is rarely hidden).
    let host =
      this.attachedRegionLayerId !== undefined
        ? visibleManaged(this.attachedRegionLayerId)
        : undefined;
    let hostId = host !== undefined ? this.attachedRegionLayerId : undefined;
    if (host === undefined) {
      for (const layerId of this.regionHostLayerIds) {
        const managed = visibleManaged(layerId);
        if (managed !== undefined) {
          host = managed;
          hostId = layerId;
          break;
        }
      }
    }
    if (host === undefined || hostId === undefined) {
      this.detachRegionOverlayRenderLayers();
      return;
    }
    if (
      this.attachedRegionLayerId === hostId &&
      this.regionSliceOverlay !== undefined
    ) {
      return; // Already hosted on a still-visible layer.
    }

    this.detachRegionOverlayRenderLayers();
    // `visibleManaged` guarantees `host.layer` is non-null.
    const userLayer = host.layer!;
    const regionWatchable = this.getActiveRegionWatchableForLayer(hostId);
    this.regionSliceOverlay = new EditRegionSliceOverlay(
      this.viewer.display.gl,
      regionWatchable,
    );
    this.detachRegionSliceOverlay = userLayer.addRenderLayer(
      this.regionSliceOverlay,
    );
    this.regionPerspectiveOverlay = new EditRegionPerspectiveOverlay(
      this.viewer.display.gl,
      regionWatchable,
    );
    this.detachRegionPerspectiveOverlay = userLayer.addRenderLayer(
      this.regionPerspectiveOverlay,
    );
    this.attachedRegionLayerId = hostId;
  }

  /** Detach (and thereby dispose) the current region render-layer instances. */
  private detachRegionOverlayRenderLayers(): void {
    if (this.detachRegionPerspectiveOverlay !== undefined) {
      try {
        this.detachRegionPerspectiveOverlay();
      } catch {
        // ignore
      }
      this.detachRegionPerspectiveOverlay = undefined;
    }
    this.regionPerspectiveOverlay = undefined;
    if (this.detachRegionSliceOverlay !== undefined) {
      try {
        this.detachRegionSliceOverlay();
      } catch {
        // ignore
      }
      this.detachRegionSliceOverlay = undefined;
    }
    this.regionSliceOverlay = undefined;
    this.attachedRegionLayerId = undefined;
  }

  /**
   * Detach (and thereby dispose) the current cursor render-layer instances.
   */
  private detachCursorOverlayRenderLayers(): void {
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
    this.sliceOverlay = undefined;
    this.attachedCursorLayerId = undefined;
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
    if (this.detachCursorTargetWatch !== undefined) {
      try {
        this.detachCursorTargetWatch();
      } catch {
        // ignore
      }
      this.detachCursorTargetWatch = undefined;
    }
    if (this.detachRegionVisibilityWatch !== undefined) {
      try {
        this.detachRegionVisibilityWatch();
      } catch {
        // ignore
      }
      this.detachRegionVisibilityWatch = undefined;
    }
    this.regionHostLayerIds = [];
    this.detachRegionOverlayRenderLayers();
    // Stop watching for tool/layer changes and lift suppression so navigate
    // (and the next session) sees the user's hover-highlight preference again.
    if (this.detachHoverSuppressionToolWatch !== undefined) {
      try {
        this.detachHoverSuppressionToolWatch();
      } catch {
        // ignore
      }
      this.detachHoverSuppressionToolWatch = undefined;
    }
    if (this.detachHoverSuppressionLayerWatch !== undefined) {
      try {
        this.detachHoverSuppressionLayerWatch();
      } catch {
        // ignore
      }
      this.detachHoverSuppressionLayerWatch = undefined;
    }
    this.setHoverHighlightSuppressedOnAllSegmentationLayers(false);
    // Detaching each render layer disposes it (see `removeRenderLayer`); this
    // also clears `attachedCursorLayerId`.
    this.detachCursorOverlayRenderLayers();
    this.cursorOverlayFallbackLayerId = undefined;
    if (this.fillCursorProgress !== undefined) {
      try {
        this.fillCursorProgress.dispose();
      } catch {
        // ignore
      }
      this.fillCursorProgress = undefined;
    }
    this.fillProgressState.value = { kind: "idle" };
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
      layers: config.layers.map((l) => ({
        layerId: l.layerId,
        resolutions: [...l.resolutions],
        writable: l.writable,
      })),
      region: {
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
        // Serialize the single region frame with the official encoder — same
        // `CoordinateSpace` JSON as the rest of ngState (TM-299).
        dimensions: coordinateSpaceToJson(config.regionSpace),
      },
    };
    this.state.value.value = intent;
  }

  /**
   * Persist the session's per-layer resolution selection into the cross-session
   * `editPreferences` block (TM-336), keyed by `layerId`. The entry modal reads
   * this to autofill the resolution picker on the next open; the value is
   * re-validated against fresh metadata there, so a now-stale resolution is
   * silently dropped.
   */
  private rememberResolutions(config: HostSessionConfig): void {
    const resolutions: { [layerId: string]: readonly ResolutionType[] } = {};
    for (const l of config.layers) {
      resolutions[l.layerId] = [...l.resolutions];
    }
    const prev = this.editPreferences.value.value ?? {};
    this.editPreferences.value.value = { ...prev, resolutions };
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

  /**
   * Full teardown. Used by `discardActive` and the disposed path:
   *   - tools (pointer bridge, hotkey binder, cursor),
   *   - per-layer rendering (LocalPatchStore, PatchedSegmentationRenderLayer,
   *     PatchMirror),
   *   - session lock + state.
   */
  private finalizeTeardown(): void {
    this.tearDownSessionTools();
    this.teardownPerLayer();
    this.tearDownSessionState();
  }

  /**
   * Partial teardown for `commitActive` and `discardActive`. The library's
   * commit pipeline has already stashed the dirty chunks in
   * `NgCommitTarget` (the host-side in-memory committed buffer). We need
   * the painted result to stay VISIBLE on the canvas — it's the user's
   * client-side persistence — so keep the per-layer `LocalPatchStore` +
   * `PatchedSegmentationRenderLayer` alive. Everything else (session
   * tools, library lock, sidebar state, the per-layer active region) is
   * torn down so the editing UI exits cleanly and the bbox-clip shader
   * path deactivates on every render layer.
   *
   * Clearing `_activeRegionByLayer` is what flips `editBboxLoHi` back to
   * `undefined` on the per-layer watchables, which turns OFF the
   * `editBboxActive` shader gate. Without this, render layers stay stuck
   * in "clip outside the last-known bbox" mode even after the session
   * ends — which means the canvas continues to discard everything outside
   * the prior bbox.
   *
   * The `PatchMirror` instances are disposed (their backing session is
   * gone, no more `DirtyTracker` events will arrive) but the patch bytes
   * already mirrored into the GPU stores stay put.
   *
   * URL state is cleared because in-memory commits do not survive a
   * reload — they're per-client. A reload should start with a clean slate.
   */
  private commitTeardown(): void {
    this.tearDownSessionTools();
    for (const entry of this.perLayer.values()) {
      if (entry.mirror !== undefined) {
        try {
          entry.mirror.dispose();
        } catch {
          // ignore
        }
        entry.mirror = undefined;
      }
    }
    this._activeRegionByLayer.clear();
    this._allowedResolutionsByLayer.clear();
    this._sessionResolutionsByLayer = new Map();
    this.refreshEditBboxWatchables();
    this.refreshAllowedResolutionsWatchables();
    this.tearDownSessionState();
  }

  private tearDownSessionTools(): void {
    if (this.pointerEventBridge !== undefined) {
      try {
        this.pointerEventBridge.dispose();
      } catch {
        // ignore
      }
      this.pointerEventBridge = undefined;
    }
    // Stop persisting tool state, then dispose the binder (deactivates the
    // active tool → rolls back any in-flight stroke and clears `activeToolId`)
    // and release the consumer painting tools (TM-315) before the session is
    // cleared.
    for (const dispose of this.toolingSubscriptions) {
      try {
        dispose();
      } catch {
        // best-effort
      }
    }
    this.toolingSubscriptions = [];
    if (this.toolBinder !== undefined) {
      try {
        this.toolBinder.dispose();
      } catch {
        // ignore
      }
      this.toolBinder = undefined;
    }
    this._toolRegistry = undefined;
    this.paintingTools = undefined;
    this.teardownHotkeyBinder();
    this.teardownCursorOverlays();
    // The registry is gone — let any live UI drop the tool buttons.
    this.toolingChanged.dispatch();
  }

  private tearDownSessionState(): void {
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
    for (const loc of this.allToolPanelLocations()) {
      loc.visible = false;
    }
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
    // Withdraw every texture cache from its editPatchOverlay watchable
    // BEFORE disposing the cache. Otherwise the base segmentation shader
    // could try to bind from a freed texture handle on the next redraw.
    // Recompiling the shader back to the no-hook variant happens on the
    // next render naturally because `editPatchOverlayActive` derives
    // from `editPatchOverlay.value !== undefined`.
    for (const watchable of this.patchOverlayByLayer.values()) {
      watchable.value = undefined;
    }
    for (const entry of this.perLayer.values()) {
      if (entry.mirror !== undefined) {
        try {
          entry.mirror.dispose();
        } catch {
          // ignore
        }
      }
      try {
        entry.textureCache.dispose();
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
    this._allowedResolutionsByLayer.clear();
    this._sessionResolutionsByLayer = new Map();
    // Stop tracking global-dimension changes — the session is ending.
    if (this.detachDisplayDimWatch !== undefined) {
      try {
        this.detachDisplayDimWatch();
      } catch {
        // ignore
      }
      this.detachDisplayDimWatch = undefined;
    }
    this.activeSessionConfig = undefined;
    // Flip subscribers from `defined` to `undefined`; this triggers the
    // bbox-dim shader path to recompile back to the no-session variant on
    // the next render and re-enables full resolution range on slice views.
    this.refreshEditBboxWatchables();
    this.refreshAllowedResolutionsWatchables();
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

/**
 * Widen a narrower typed-array voxel buffer into a `BigUint64Array` with
 * one BigUint64 per voxel (matching `LocalPatchStore`'s storage format).
 * Mirrors the conversion logic in `PatchMirror.toBigUint64Array` so that
 * discard-rollback writes are byte-compatible with live mirror writes.
 */
function computeOverallOutcome(
  outcomes: readonly SaveLayerOutcome[],
): SaveResult["overall"] {
  if (outcomes.length === 0) return "all-succeeded";
  let anySucceeded = false;
  let anyFailed = false;
  for (const o of outcomes) {
    if (o.status === "succeeded") anySucceeded = true;
    else anyFailed = true;
  }
  if (anySucceeded && !anyFailed) return "all-succeeded";
  if (anyFailed && !anySucceeded) return "all-failed";
  return "partial";
}

function widenToBigUint64(view: ArrayBufferView): BigUint64Array {
  const len = (view as unknown as { length: number }).length;
  const out = new BigUint64Array(len);
  if (
    view instanceof Uint8Array ||
    view instanceof Uint16Array ||
    view instanceof Uint32Array
  ) {
    for (let i = 0; i < len; ++i) out[i] = BigInt(view[i]);
    return out;
  }
  if (
    view instanceof Int8Array ||
    view instanceof Int16Array ||
    view instanceof Int32Array
  ) {
    for (let i = 0; i < len; ++i) out[i] = BigInt(view[i] >>> 0);
    return out;
  }
  // Unknown / unsupported types fall through as all-zero — safer than
  // misreading bytes.
  return out;
}
