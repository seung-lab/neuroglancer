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
 * Consumer-owned painting tools (TM-315 migration).
 *
 * The library no longer ships tools. This module is the consumer's port of the
 * old `@zettaai/edit-session` `PaintingTools` / `StrokeTool` / `FillTool`,
 * rewritten against the per-operation `Edit` write protocol. Behavior is
 * byte-for-byte preserved:
 *  - the numerical kernels stay in `PaintingCompute` (untouched);
 *  - one stroke (pointer-down → moves → up) is ONE `Edit` → one undo entry;
 *  - one fill click is one `Edit` → one undo entry;
 *  - the eraser is the brush flow with the erase value; it omits the image
 *    mask entirely (TM-297), so the compute no longer needs to suppress it.
 *
 * The tools implement `EditTool` and are selected/activated through the
 * `SessionToolBinder`; they share one `EditScope` (the one-live-edit
 * invariant) and the family `PaintingState` (`getState` / `patchState` /
 * `changed`), which the cursor overlay and tool-settings UI subscribe to.
 */

import type {
  Edit,
  LayerId,
  LayerMetadata,
  ReadonlyChunkVoxelBuffer,
  Resolution,
  WriteTarget,
} from "@zettaai/edit-session";
import { ChunkId, scaleFor } from "@zettaai/edit-session";

import { applyPaintBatch } from "#src/editing/tool_runtimes/paint_batch_apply.js";
import { paintProfiler } from "#src/editing/tool_runtimes/paint_profiler.js";
import { paintScheduler } from "#src/editing/tool_runtimes/paint_scheduler_config.js";
import {
  chunksForStroke,
  PaintStrokePipeline,
} from "#src/editing/tool_runtimes/paint_stroke_pipeline.js";
import type {
  FillMode,
  PaintCompute,
  PaintingMaskConfig,
  PaintWriteBatch,
} from "#src/editing/tool_runtimes/paint_types.js";
import { PaintParamCursor } from "#src/editing/tool_runtimes/param_cursor.js";
import { StrokeGeometry } from "#src/editing/tool_runtimes/stroke_geometry.js";
import type {
  InputHandling,
  ToolInputEvent,
} from "#src/editing/tool_runtimes/tool_input.js";
import type {
  EditScope,
  InteractionHandle,
} from "#src/editing/tooling/edit_scope.js";
import type {
  BindingValidation,
  EditTool,
  InteractionPolicyKind,
} from "#src/editing/tooling/edit_tool.js";
import type { EditToolActivation } from "#src/editing/tooling/edit_tool_activation.js";
import type { ToolDefinition } from "#src/editing/tooling/tool_registry.js";
import { NullarySignal } from "#src/util/signal.js";

export const PAINTING_BRUSH_TOOL_ID = "painting.brush";
export const PAINTING_ERASE_TOOL_ID = "painting.erase";
export const PAINTING_FILL_TOOL_ID = "painting.fill";

export const DEFAULT_RADIUS_CYCLE: readonly number[] = [1, 3, 5, 9, 17, 33];

/** Euclidean distance between two voxel positions (latestWins cap test). */
function dist3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export interface PaintingSharedState {
  readonly targetLayerId: LayerId;
  readonly targetResolution: Resolution;
  readonly radius: number;
  readonly radiusCycle: readonly number[];
  readonly activeValue: number | bigint;
  readonly eraseValue: number | bigint;
  readonly mask: PaintingMaskConfig | undefined;
  /** Fill connectivity mode (TM-269): `"2d"` (seed slice) or `"3d"`. */
  readonly fillMode: FillMode;
  /**
   * Stamp spacing as a fraction of brush diameter for distance-based stroke
   * resampling (TM-318). See `StrokeGeometry`; defaults to
   * `DEFAULT_SPACING_FRACTION`. No UI yet — plumbed so behavior is deterministic
   * and tunable.
   */
  readonly spacingFraction: number;
}

/**
 * Cross-layer baseline reader (e.g. for the mask image layer). Routes through
 * the host's chunk source baseline read, with no per-layer binding — the
 * consumer analogue of the library runtime's old `readChunkAt`.
 */
export type ReadChunkAt = (
  layerId: LayerId,
  resolution: Resolution,
  chunkId: ChunkId,
) => Promise<ReadonlyChunkVoxelBuffer>;

/**
 * Mutable shared paint state with the same surface the old library
 * `PaintingTools` exposed (`getState` / `patchState` / a `changed` signal).
 */
export class PaintingState {
  readonly changed = new NullarySignal();
  private state: PaintingSharedState;

  constructor(initial: PaintingSharedState) {
    this.state = initial;
  }

  getState(): PaintingSharedState {
    return this.state;
  }

  patchState(patch: Partial<PaintingSharedState>): void {
    this.state = { ...this.state, ...patch };
    this.changed.dispatch();
  }
}

interface StrokePreset {
  readonly toolId: string;
  readonly description: string;
  readonly tag: string;
  /** 'active' writes `activeValue`; 'erase' writes `eraseValue`. */
  readonly source: "active" | "erase";
}

interface PaintingToolDeps {
  /** Owns the Edit lifecycle (one live edit, record/discard, rollback). */
  readonly scope: EditScope;
  readonly state: PaintingState;
  readonly compute: PaintCompute;
  readonly metadataByLayer: ReadonlyMap<LayerId, LayerMetadata>;
  /**
   * Resolutions the host opened (and preloads/pins) per layer. Threaded into
   * every masked stroke as `maskAllowedResolutions` so compute rejects a mask
   * resolution the session never pinned instead of cold-reading a finer scale
   * from the layer's datasource pyramid (TM-350).
   */
  readonly allowedResolutionsByLayer: ReadonlyMap<
    LayerId,
    readonly Resolution[]
  >;
  readonly readChunkAt: ReadChunkAt;
  /**
   * Worker-pool stroke pipeline (TM-322). Used for the unmasked same-z r>=1 fast
   * path when cross-origin isolation makes it available; otherwise strokes fall
   * back to the synchronous main-thread compute path.
   */
  readonly pipeline: PaintStrokePipeline;
  /**
   * Optional sink the host wires to a watchable so UI (the cursor loader) can
   * reflect a running fill (TM-269). Absent in tests / headless contexts.
   */
  readonly fillProgress?: FillProgressSink;
  /**
   * Optional one-off user notification (host wires it to a transient status
   * toast). Used to explain a memory-bounded fill that stopped short (TM-269).
   */
  readonly notify?: (message: string) => void;
}

/**
 * Lifecycle hooks for a running fill, surfaced to the host so it can drive the
 * cursor-attached progress spinner (TM-269). `start`/`end` always bracket a
 * fill (including a canceled or failed one); `update` fires on each progressive
 * flush with the running voxel count.
 */
export interface FillProgressSink {
  start(): void;
  update(voxelsWritten: number): void;
  end(): void;
}

/**
 * Validate the painting family's target binding against the session layers:
 * the target layer must be present and expose the chosen resolution.
 */
function validateTargetBinding(deps: PaintingToolDeps): BindingValidation {
  const shared = deps.state.getState();
  const metadata = deps.metadataByLayer.get(shared.targetLayerId);
  if (metadata === undefined) {
    return {
      ok: false,
      reason: `target layer "${shared.targetLayerId}" is not in the session`,
    };
  }
  if (!metadata.scales.some((s) => s.resolution === shared.targetResolution)) {
    return {
      ok: false,
      reason: `resolution "${shared.targetResolution}" not available on "${shared.targetLayerId}"`,
    };
  }
  return { ok: true };
}

/**
 * Everything needed to deterministically re-apply a stroke for replay-based
 * redo (TM-319). Instead of an after-image, the history entry stores the exact
 * paint operations the stroke performed: the pointer-down stamp plus each
 * painted segment polyline (the `path`s handed to `paintStrokePath`). Because
 * unmasked brush/erase writes are *absolute* (set-value, no read of prior
 * content), replaying these same calls on the post-undo baseline reproduces the
 * stroke byte-for-byte — including the provisional head-stamp residue, which a
 * `canonical()`-only replay would miss. Masked strokes do not use this (their
 * morphology is not decomposable across batches); they keep `image` redo.
 */
interface StrokeReplay {
  /** Brush state snapshot at pointer-down (immutable; `patchState` replaces it). */
  readonly shared: PaintingSharedState;
  readonly metadata: LayerMetadata;
  readonly value: number | bigint;
  /** The pointer-down stamp position (mirrors the live `applyBrush`). */
  readonly initialPoint: readonly [number, number, number];
  /** Each painted segment's polyline, in the order it was applied. */
  readonly segments: (readonly (readonly [number, number, number])[])[];
  /** Spacing passed through to `applyBrushStroke` (no effect on output today). */
  spacingVoxels: number;
}

/**
 * Brush / Erase. Both run the identical stroke flow; only the written value
 * (active vs erase) and the history label/tag differ. One stroke is one
 * `Edit`: pointer-down opens it, each move writes into it, pointer-up records
 * it as a single undo entry, pointer-cancel discards it.
 */
export class StrokeTool implements EditTool {
  readonly id: string;
  readonly description: string;
  readonly interactionPolicy: InteractionPolicyKind = "stroke";
  private handle: InteractionHandle | null = null;
  /**
   * The last point the stroke painted up to — the `from` for the next segment.
   * Under distance resampling (`geometry !== null`) this advances only to
   * canonical stamps, never to the provisional head, so the head segment is
   * re-drawn cleanly each batch.
   */
  private lastVoxel: readonly [number, number, number] | null = null;
  /**
   * Deterministic stroke geometry for the current stroke (TM-318). Non-null for
   * real-radius (`r >= 1`) strokes; null for the 1-voxel brush, which keeps the
   * legacy raw-polyline path.
   */
  private geometry: StrokeGeometry | null = null;
  /**
   * Replay record for the current stroke (TM-319), or null when this stroke
   * uses `image` redo (masked brush, or the 1-voxel brush). Mutated as segments
   * are painted; the `reapply` closure captured at pointer-down holds the same
   * reference, so it sees the finalized record after commit.
   */
  private activeReplay: StrokeReplay | null = null;

  constructor(
    private readonly deps: PaintingToolDeps,
    private readonly preset: StrokePreset,
  ) {
    this.id = preset.toolId;
    this.description = preset.description;
  }

  workingResolution(): Resolution {
    return this.deps.state.getState().targetResolution;
  }

  validateBinding(): BindingValidation {
    return validateTargetBinding(this.deps);
  }

  /** Drop in-flight stroke state when this tool's activation is disposed. */
  activate(activation: EditToolActivation): void {
    activation.registerDisposer(() => this.onDeactivate());
  }

  toJSON(): unknown {
    return { type: this.id };
  }

  onDeactivate(): void {
    // A tool switch mid-stroke abandons the in-flight edit. Roll it back so a
    // half-applied stroke never lingers without a history entry. Supersede any
    // in-flight worker tiles FIRST (TM-322/TM-323) so a late tile cannot
    // commitWrites into the just-discarded edit — this is the real race, since
    // onDeactivate is a direct disposer call, not gated by the bridge.
    if (this.handle !== null) {
      const handle = this.handle;
      this.handle = null;
      this.deps.pipeline.invalidate();
      void handle.cancel();
    }
    this.lastVoxel = null;
    this.geometry = null;
    this.activeReplay = null;
  }

  /**
   * Rasterize a polyline path (≥2 points) into the live edit as one coalesced
   * stroke segment, reusing the compute's capsule/polyline-union kernel. Shared
   * by the move and pointer-up flows. A path with fewer than two points is a
   * no-op (the start was already stamped on pointer-down).
   */
  private async paintStrokePath(
    edit: Edit,
    path: readonly (readonly [number, number, number])[],
    shared: PaintingSharedState,
    metadata: LayerMetadata,
    value: number | bigint,
    maskFields: {
      mask?: PaintingMaskConfig;
      maskMetadata?: LayerMetadata;
      maskAllowedResolutions?: readonly Resolution[];
    },
    readChunkAt: ReadChunkAt,
    stepVoxels: number,
    useWorker: boolean,
  ): Promise<void> {
    if (path.length < 2) return;
    const target: WriteTarget = {
      layerId: shared.targetLayerId,
      resolution: shared.targetResolution,
    };
    const readChunk = (chunkId: ChunkId) =>
      edit.readChunk({ ...target, chunkId });
    const targetScale = scaleFor(metadata, shared.targetResolution);
    const chunkSize = targetScale.chunkDataSize;
    // P1 (TM-317): warm the overlay chunks under the stroke footprint NOW, in
    // parallel, so they are resident by the time the apply (worker OR
    // synchronous) calls `beginWrite` → `materializeForWrite.fetchBaseline`. For
    // a masked stroke the warm overlaps the pyodide compute (~120 ms), so the
    // previously-cold per-chunk baseline IO (spiking to ~150 ms) becomes a
    // resident clone. Best-effort: the real read still happens at write time,
    // and the undo pre-image is still captured there — we only relocate the
    // fetch, never drop it.
    const warm = warmStrokeFootprint(
      edit,
      target,
      path,
      shared.radius,
      chunkSize,
      targetScale.voxelOffset,
    );

    // Worker write path (TM-322 unmasked / TM-317 Phase B masked): single-z,
    // real-radius live strokes apply off the main thread directly into the SAB
    // overlay slots — the unmasked rasterize kernel, or the masked footprint
    // mask stamped where set. This removes `scatter` + `writeRegion` (the
    // measured ~84% of BLOCKS-UI) from the main thread. On ANY worker failure we
    // latch the path off and fall through to the synchronous compute below, so a
    // broken worker degrades gracefully instead of breaking the stroke. The
    // 1-voxel brush (r === 0), z-varying paths, and replay-redo always take the
    // synchronous path.
    const r = Math.floor(shared.radius);
    const z0 = Math.floor(path[0][2]);
    const sameZ = path.every((p) => Math.floor(p[2]) === z0);
    if (useWorker && this.deps.pipeline.available && r >= 1 && sameZ) {
      if (maskFields.mask === undefined) {
        try {
          await this.deps.pipeline.paintSegment(
            edit,
            target,
            metadata,
            path,
            shared.radius,
            value,
          );
          this.deps.pipeline.markSucceeded();
          return;
        } catch (e) {
          this.deps.pipeline.markFailed();
          warnWorkerFallback(e);
        }
      } else if (this.deps.compute.computeMaskedStrokeFootprint !== undefined) {
        try {
          const wvia = path.slice(1, -1);
          const footprint =
            await this.deps.compute.computeMaskedStrokeFootprint({
              targetLayerId: shared.targetLayerId,
              targetResolution: shared.targetResolution,
              metadata,
              from: path[0],
              to: path[path.length - 1],
              ...(wvia.length > 0 ? { via: wvia } : {}),
              stepVoxels,
              radius: shared.radius,
              value,
              ...maskFields,
              readChunk,
              readChunkAt,
            });
          // `null` = not worker-eligible / worker not ready / pyodide failed →
          // take the synchronous path (which re-runs the proven compute).
          if (footprint !== null) {
            await this.deps.pipeline.stampMaskedFootprint(
              edit,
              target,
              metadata,
              footprint,
              value,
            );
            this.deps.pipeline.markSucceeded();
            return;
          }
        } catch (e) {
          this.deps.pipeline.markFailed();
          warnWorkerFallback(e);
        }
      }
    }

    const via = path.slice(1, -1);
    const batch = await this.deps.compute.applyBrushStroke({
      targetLayerId: shared.targetLayerId,
      targetResolution: shared.targetResolution,
      metadata,
      from: path[0],
      to: path[path.length - 1],
      ...(via.length > 0 ? { via } : {}),
      stepVoxels,
      radius: shared.radius,
      value,
      ...maskFields,
      readChunk,
      readChunkAt,
    });
    // Normally already settled (it raced the compute); the recorded cost is the
    // residual wait, which should be ~0 once warming wins the race.
    await paintProfiler.timeAsync("P1.warm(io)", () => warm);
    await paintProfiler.timeAsync("apply.total(cpu)", () =>
      edit.withBatch(() => applyPaintBatch(edit, batch, chunkSize)),
    );
  }

  /**
   * Deterministically re-apply a stroke for replay-based redo (TM-319). The
   * library calls this with a fresh edit on the post-undo baseline; we re-issue
   * the exact same paint operations the stroke performed (the pointer-down stamp
   * then each painted segment). Must NOT call `record()` / `discard()` — the
   * journal owns the stack. Only ever set for unmasked strokes, so no mask
   * config is threaded.
   */
  private async replayStroke(edit: Edit, replay: StrokeReplay): Promise<void> {
    const { shared, metadata, value, initialPoint, segments, spacingVoxels } =
      replay;
    const readChunk = (chunkId: ChunkId) =>
      edit.readChunk({
        layerId: shared.targetLayerId,
        resolution: shared.targetResolution,
        chunkId,
      });
    const batch = await this.deps.compute.applyBrush({
      targetLayerId: shared.targetLayerId,
      targetResolution: shared.targetResolution,
      metadata,
      voxelPosition: initialPoint,
      radius: shared.radius,
      value,
      readChunk,
      readChunkAt: this.deps.readChunkAt,
    });
    const chunkSize = scaleFor(metadata, shared.targetResolution).chunkDataSize;
    await paintProfiler.timeAsync("apply.total(cpu)", () =>
      edit.withBatch(() => applyPaintBatch(edit, batch, chunkSize)),
    );
    for (const path of segments) {
      await this.paintStrokePath(
        edit,
        path,
        shared,
        metadata,
        value,
        {},
        this.deps.readChunkAt,
        spacingVoxels,
        false, // replay-redo stays on the deterministic main-thread path
      );
    }
  }

  /** Record a painted segment for replay-based redo (no-op unless replaying). */
  private recordReplaySegment(
    path: readonly (readonly [number, number, number])[],
  ): void {
    if (this.activeReplay !== null && path.length >= 2) {
      this.activeReplay.segments.push(path);
    }
  }

  async handleInput(ev: ToolInputEvent): Promise<InputHandling> {
    const shared = this.deps.state.getState();
    const metadata = this.deps.metadataByLayer.get(shared.targetLayerId);
    if (
      metadata === undefined ||
      !metadata.scales.some((s) => s.resolution === shared.targetResolution)
    ) {
      return { consumed: false };
    }
    const value =
      this.preset.source === "active" ? shared.activeValue : shared.eraseValue;
    // The eraser deliberately ignores the brush's image mask (TM-297): it omits
    // `mask` entirely rather than relying on the compute to suppress it. Only
    // the brush (source 'active') threads the shared mask config.
    const useMask =
      this.preset.source === "active" && shared.mask !== undefined;
    const maskMetadata = useMask
      ? this.deps.metadataByLayer.get(shared.mask!.imageLayerId)
      : undefined;
    const maskAllowedResolutions = useMask
      ? this.deps.allowedResolutionsByLayer.get(shared.mask!.imageLayerId)
      : undefined;
    const maskFields = useMask
      ? {
          mask: shared.mask,
          ...(maskMetadata !== undefined ? { maskMetadata } : {}),
          ...(maskAllowedResolutions !== undefined
            ? { maskAllowedResolutions }
            : {}),
        }
      : {};
    const readChunkAt = this.deps.readChunkAt;

    if (ev.kind === "pointer-down" && ev.button === "primary") {
      // Benign race guard: a fresh stroke can begin a hair before the previous
      // stroke's async commit has settled. pointer-up finalizes through a
      // separate queue and only clears the live edit AFTER its compute resolves
      // (`handle.commit()` in the pointer-up branch), while pointer-down arrives
      // on the direct dispatch path. If the two overlap, `beginInteraction`
      // below would hit EditScope's "already live" guard and throw — surfacing
      // as an alarming error banner even though the prior stroke committed fine
      // and the user did nothing wrong. Drop this racing down silently instead;
      // the throw already dropped it too, just noisily.
      if (this.deps.scope.hasLiveEdit) {
        console.debug(
          "StrokeTool: pointer-down ignored; previous edit still committing",
        );
        return { consumed: true };
      }
      const pos: readonly [number, number, number] = [
        ev.voxelPosition[0],
        ev.voxelPosition[1],
        ev.voxelPosition[2],
      ];
      // Distance-resampled geometry (TM-318) drives real-radius strokes; the
      // 1-voxel brush keeps the legacy raw-polyline path (geometry === null).
      const r = Math.floor(shared.radius);
      // Replay-based redo (TM-319) for deterministic strokes: unmasked brush /
      // eraser write absolute values, so re-issuing their paint ops reproduces
      // the result with no after-image. Masked strokes (non-decomposable
      // morphology) and the legacy 1-voxel path keep `image` redo.
      const replay: StrokeReplay | null =
        !useMask && r >= 1
          ? {
              shared,
              metadata,
              value,
              initialPoint: pos,
              segments: [],
              spacingVoxels: 0,
            }
          : null;
      const handle = this.deps.scope.beginInteraction({
        description: this.preset.description,
        tag: this.preset.tag,
        redo:
          replay !== null
            ? {
                kind: "replay",
                reapply: (edit) => this.replayStroke(edit, replay),
              }
            : { kind: "image" },
      });
      this.handle = handle;
      this.activeReplay = replay;
      const edit = handle.edit;
      this.lastVoxel = pos;
      this.geometry =
        r >= 1
          ? new StrokeGeometry({
              diameterVoxels: 2 * r + 1,
              spacingFraction: shared.spacingFraction,
            })
          : null;
      this.geometry?.pushSamples([pos]);
      if (replay !== null && this.geometry !== null) {
        replay.spacingVoxels = this.geometry.spacingVoxels;
      }
      const readChunk = (chunkId: ChunkId) =>
        edit.readChunk({
          layerId: shared.targetLayerId,
          resolution: shared.targetResolution,
          chunkId,
        });
      const batch = await this.deps.compute.applyBrush({
        targetLayerId: shared.targetLayerId,
        targetResolution: shared.targetResolution,
        metadata,
        voxelPosition: pos,
        radius: shared.radius,
        value,
        ...maskFields,
        readChunk,
        readChunkAt,
      });
      const chunkSize = scaleFor(
        metadata,
        shared.targetResolution,
      ).chunkDataSize;
      await paintProfiler.timeAsync("apply.total(cpu)", () =>
        edit.withBatch(() => applyPaintBatch(edit, batch, chunkSize)),
      );
      return { consumed: true };
    }

    if (
      ev.kind === "pointer-move" &&
      this.handle !== null &&
      this.lastVoxel !== null
    ) {
      const edit = this.handle.edit;
      const cursor: readonly [number, number, number] = [
        ev.voxelPosition[0],
        ev.voxelPosition[1],
        ev.voxelPosition[2],
      ];
      if (this.geometry !== null) {
        // latestWins scheduling (TM-317): bound the per-call painted span. Once
        // the cursor outran the cap (a fast drag while the worker was busy),
        // DROP the connecting capsule and stamp a single disk at the latest
        // cursor — the old voxel-editor model — then restart the geometry from
        // there so the next capsule is bounded too. This is true drop-to-latest
        // (skip + one disk), NOT serialize-the-backlog. Compute (pyodide /
        // morphology) and commit are reached exactly as for any other segment,
        // just with a bounded footprint.
        if (paintScheduler.mode === "latestWins") {
          const cap = paintScheduler.resolveCap(shared.radius);
          if (dist3(this.lastVoxel, cursor) > cap) {
            this.lastVoxel = cursor;
            this.geometry = new StrokeGeometry({
              diameterVoxels: 2 * Math.floor(shared.radius) + 1,
              spacingFraction: shared.spacingFraction,
            });
            this.geometry.pushSamples([cursor]);
            const diskPath: readonly (readonly [number, number, number])[] = [
              cursor,
              cursor,
            ];
            this.recordReplaySegment(diskPath);
            await this.paintStrokePath(
              edit,
              diskPath,
              shared,
              metadata,
              value,
              maskFields,
              readChunkAt,
              this.geometry.spacingVoxels,
              true,
            );
            return { consumed: true };
          }
        }
        // Feed the raw delivered samples (coalesced waypoints + cursor) to the
        // geometry, then paint tail → canonical stamps → live cursor. The
        // trailing segment to the cursor is the provisional head stamp; it is
        // re-drawn from the last canonical stamp next batch (idempotent under
        // the overlay's overwrite semantics), so it never double-paints.
        const samples = [...(ev.viaVoxelPositions ?? []), cursor];
        this.geometry.pushSamples(samples);
        const stamps = this.geometry.drain();
        const path = [this.lastVoxel, ...stamps, cursor];
        if (stamps.length > 0) {
          this.lastVoxel = stamps[stamps.length - 1];
        }
        this.recordReplaySegment(path);
        await this.paintStrokePath(
          edit,
          path,
          shared,
          metadata,
          value,
          maskFields,
          readChunkAt,
          this.geometry.spacingVoxels,
          true,
        );
      } else {
        // Legacy 1-voxel brush: rasterize the raw delivered polyline as-is.
        const path = [this.lastVoxel, ...(ev.viaVoxelPositions ?? []), cursor];
        this.lastVoxel = cursor;
        await this.paintStrokePath(
          edit,
          path,
          shared,
          metadata,
          value,
          maskFields,
          readChunkAt,
          1,
          true,
        );
      }
      return { consumed: true };
    }

    if (ev.kind === "pointer-up" && this.handle !== null) {
      // Finalize the trailing geometry the head stamp had only provisionally
      // shown, so the committed stroke reaches the exact stroke end.
      if (this.geometry !== null && this.lastVoxel !== null) {
        const stamps = this.geometry.finish();
        if (stamps.length > 0) {
          const path = [this.lastVoxel, ...stamps];
          this.recordReplaySegment(path);
          await this.paintStrokePath(
            this.handle.edit,
            path,
            shared,
            metadata,
            value,
            maskFields,
            readChunkAt,
            this.geometry.spacingVoxels,
            true,
          );
        }
      }
      this.handle.commit();
      this.handle = null;
      this.lastVoxel = null;
      this.geometry = null;
      this.activeReplay = null;
      return { consumed: true };
    }

    if (ev.kind === "pointer-cancel" && this.handle !== null) {
      const handle = this.handle;
      this.handle = null;
      this.lastVoxel = null;
      this.geometry = null;
      this.activeReplay = null;
      // Supersede in-flight worker tiles before discarding (TM-322/TM-323).
      this.deps.pipeline.invalidate();
      await handle.cancel();
      return { consumed: true };
    }

    return { consumed: false };
  }
}

/**
 * Flood fill: a single click is one `Edit` → one undo entry. 2D (seed slice) or
 * 3D per the shared `fillMode` (TM-269). Progressive — the compute flushes
 * partial batches as it floods, so the screen updates and the UI stays
 * responsive — and cancelable mid-fill via Escape or a secondary (right) click.
 */
export class FillTool implements EditTool {
  readonly id = PAINTING_FILL_TOOL_ID;
  readonly description = "Fill";
  // A fill is a single click — each pointer-down is delivered as-is.
  readonly interactionPolicy: InteractionPolicyKind = "discrete";
  /**
   * Controls the in-flight fill (TM-269). Non-null only while a fill runs; the
   * cancel paths (`Escape` / secondary click) abort it. The input bridge
   * dispatches discrete events without serializing on the prior `handleInput`,
   * so a cancel event reaches us while the fill's promise is still pending.
   */
  private activeFill: AbortController | null = null;

  constructor(private readonly deps: PaintingToolDeps) {}

  workingResolution(): Resolution {
    return this.deps.state.getState().targetResolution;
  }

  validateBinding(): BindingValidation {
    return validateTargetBinding(this.deps);
  }

  /** Abort any in-flight fill when the tool is deactivated. */
  activate(_activation: EditToolActivation): void {
    void _activation;
    this.activeFill?.abort();
  }

  toJSON(): unknown {
    return { type: this.id };
  }

  async handleInput(ev: ToolInputEvent): Promise<InputHandling> {
    // While a fill runs, route the cancel gestures to its abort controller and
    // swallow any other input (a second primary click would only conflict with
    // the live edit).
    if (this.activeFill !== null) {
      const isEscape =
        ev.kind === "key" && ev.phase === "down" && ev.key === "Escape";
      const isSecondaryDown =
        ev.kind === "pointer-down" && ev.button === "secondary";
      if (isEscape || isSecondaryDown) {
        this.activeFill.abort();
        return { consumed: true };
      }
      return ev.kind === "pointer-down"
        ? { consumed: true }
        : { consumed: false };
    }

    if (ev.kind !== "pointer-down" || ev.button !== "primary") {
      return { consumed: false };
    }
    const shared = this.deps.state.getState();
    const metadata = this.deps.metadataByLayer.get(shared.targetLayerId);
    if (
      metadata === undefined ||
      !metadata.scales.some((s) => s.resolution === shared.targetResolution)
    ) {
      return { consumed: false };
    }
    const seedVoxelPosition: readonly [number, number, number] = [
      ev.voxelPosition[0],
      ev.voxelPosition[1],
      ev.voxelPosition[2],
    ];
    const controller = new AbortController();
    this.activeFill = controller;
    this.deps.fillProgress?.start();
    let truncation: PaintWriteBatch["truncated"];
    try {
      await this.deps.scope.runOperation(
        {
          description: "Fill",
          tag: PAINTING_FILL_TOOL_ID,
          redo: { kind: "image" },
        },
        async (edit) => {
          const target = {
            layerId: shared.targetLayerId,
            resolution: shared.targetResolution,
          };
          // Session region bounds at the fill resolution — the wall the flood
          // must not cross (so an open 2D region terminates, no runaway fill).
          const bounds = edit.sessionVoxelBoundsFor({
            ...target,
            chunkId: ChunkId.fromCoord({ x: 0, y: 0, z: 0 }),
          });
          if (bounds === undefined) return;
          const chunkSize = scaleFor(
            metadata,
            shared.targetResolution,
          ).chunkDataSize;
          const applyBatch = (batch: PaintWriteBatch) =>
            paintProfiler.timeAsync("apply.total(cpu)", () =>
              edit.withBatch(() => applyPaintBatch(edit, batch, chunkSize)),
            );
          const finalBatch = await this.deps.compute.fill({
            targetLayerId: shared.targetLayerId,
            targetResolution: shared.targetResolution,
            metadata,
            seedVoxelPosition,
            value: shared.activeValue,
            mode: shared.fillMode,
            bounds,
            readChunk: (chunkId: ChunkId) =>
              edit.readChunk({ ...target, chunkId }),
            onFlush: applyBatch,
            onProgress: (p) => this.deps.fillProgress?.update(p.voxelsWritten),
            signal: controller.signal,
          });
          await applyBatch(finalBatch);
          truncation = finalBatch.truncated;
        },
      );
    } catch (err) {
      // A cancel rejects the operation (which already discarded the edit, so no
      // undo entry is recorded). Any other error is a real failure — rethrow.
      if (!controller.signal.aborted) throw err;
    } finally {
      this.activeFill = null;
      this.deps.fillProgress?.end();
    }
    // A memory-bounded fill keeps what it painted (the op was recorded), but
    // tell the user it stopped short so the partial result isn't a surprise.
    if (truncation?.reason === "out-of-memory") {
      this.deps.notify?.(
        `Fill stopped — the region is too large to fill in available memory. ` +
          `Painted ${truncation.voxelsWritten.toLocaleString()} voxels; ` +
          `try a 2D fill or a smaller region.`,
      );
    }
    return { consumed: true };
  }
}

/**
 * Owns the three painting tools and the shared family state. Constructed by
 * the host AFTER `EditSession.open(...)`. The tools share one `EditScope` (the
 * one-live-edit invariant) supplied by the host so the `SessionToolBinder`'s
 * activations roll back the same edits. Selection / dispatch is owned by the
 * binder + input bridge; this only holds the instances + their definitions.
 */
export class ConsumerPaintingTools {
  readonly state: PaintingState;
  /**
   * Keyboard parameter cursor for the Ctrl+Arrow scheme (TM-337). The active
   * paint tool's settings panel publishes its enabled parameters here in render
   * order; the session hotkey binder selects + nudges them. Session-lifetime,
   * like {@link state}.
   */
  readonly paramCursor = new PaintParamCursor();
  readonly brush: StrokeTool;
  readonly erase: StrokeTool;
  readonly fill: FillTool;

  constructor(opts: {
    scope: EditScope;
    compute: PaintCompute;
    metadataByLayer: ReadonlyMap<LayerId, LayerMetadata>;
    allowedResolutionsByLayer: ReadonlyMap<LayerId, readonly Resolution[]>;
    readChunkAt: ReadChunkAt;
    initialState: PaintingSharedState;
    /** Host sink for fill progress → cursor loader UI (TM-269). */
    fillProgress?: FillProgressSink;
    /** Host transient-notification sink (TM-269). */
    notify?: (message: string) => void;
  }) {
    this.state = new PaintingState(opts.initialState);
    const deps: PaintingToolDeps = {
      scope: opts.scope,
      state: this.state,
      compute: opts.compute,
      metadataByLayer: opts.metadataByLayer,
      allowedResolutionsByLayer: opts.allowedResolutionsByLayer,
      readChunkAt: opts.readChunkAt,
      pipeline: new PaintStrokePipeline(),
      fillProgress: opts.fillProgress,
      notify: opts.notify,
    };
    this.brush = new StrokeTool(deps, {
      toolId: PAINTING_BRUSH_TOOL_ID,
      description: "Brush stroke",
      tag: PAINTING_BRUSH_TOOL_ID,
      source: "active",
    });
    this.erase = new StrokeTool(deps, {
      toolId: PAINTING_ERASE_TOOL_ID,
      description: "Erase stroke",
      tag: PAINTING_ERASE_TOOL_ID,
      source: "erase",
    });
    this.fill = new FillTool(deps);
  }

  /** The painting tool for `toolId`, or undefined if it isn't a painting tool. */
  getTool(toolId: string | undefined): EditTool | undefined {
    switch (toolId) {
      case PAINTING_BRUSH_TOOL_ID:
        return this.brush;
      case PAINTING_ERASE_TOOL_ID:
        return this.erase;
      case PAINTING_FILL_TOOL_ID:
        return this.fill;
      default:
        return undefined;
    }
  }

  /**
   * Registry definitions for the three painting tools. `createTool` returns the
   * persistent instance (they hold the shared family state), so activations
   * reuse the same tool rather than re-constructing it.
   */
  toolDefinitions(): readonly ToolDefinition[] {
    return [
      {
        id: PAINTING_BRUSH_TOOL_ID,
        interactionPolicy: "stroke",
        cursorKind: "brush",
        activationHotkey: "control+keyb",
        panelKey: PAINTING_BRUSH_TOOL_ID,
        createTool: () => this.brush,
      },
      {
        id: PAINTING_ERASE_TOOL_ID,
        interactionPolicy: "stroke",
        cursorKind: "eraser",
        activationHotkey: "control+keye",
        panelKey: PAINTING_ERASE_TOOL_ID,
        createTool: () => this.erase,
      },
      {
        id: PAINTING_FILL_TOOL_ID,
        interactionPolicy: "discrete",
        cursorKind: "fill",
        activationHotkey: "control+keyf",
        panelKey: PAINTING_FILL_TOOL_ID,
        createTool: () => this.fill,
      },
    ];
  }
}

/**
 * Warm (make resident) the overlay chunks the stroke footprint will write into,
 * so the subsequent `writeRegion` → `beginWrite` → `materializeForWrite`
 * baseline fetch is a resident clone instead of a cold IO await (P1, TM-317).
 *
 * The footprint chunks are derived from the swept-capsule / polyline-union
 * geometry (`chunksForStroke`, clipped to the session bounds) — the exact
 * superset of chunks `applyPaintBatch` touches. Issuing `edit.readChunk` for
 * each routes through the same `EditOverlayStore.read` → `fetchBaseline` →
 * `NgChunkSource.readBaselineChunk` path the write later hits, priming
 * neuroglancer's chunk cache; concurrent duplicate reads dedup via the chunk
 * pipeline and the overlay's `readInFlight`, so warming costs no extra IO.
 *
 * Only the well-defined single-z, radius ≥ 1 case is warmed — that is the
 * expensive masked footprint whose cold baseline IO this targets; the rare
 * z-varying / 1-voxel fallback paints tiny dabs and is left to the write path.
 * Best-effort: per-chunk read errors are swallowed (the real read in
 * `writeRegion` surfaces any genuine failure), and warming NEVER mutates or
 * captures the undo pre-image — that still happens at `beginWrite`.
 */
let workerFallbackWarned = false;
/**
 * Warn once per session when the brush worker path fails and we fall back to the
 * synchronous main-thread apply. The stroke still paints correctly (the
 * synchronous path is the byte-identical reference) — this just makes it visible
 * that the off-thread acceleration is not in effect.
 */
function warnWorkerFallback(e: unknown): void {
  if (workerFallbackWarned) return;
  workerFallbackWarned = true;
  console.warn(
    "[painting] brush worker write path failed — falling back to the " +
      "synchronous main-thread apply for the rest of this session. Painting " +
      "stays correct but is not accelerated off-thread. First failure:",
    e,
  );
}

function warmStrokeFootprint(
  edit: Edit,
  target: WriteTarget,
  path: readonly (readonly [number, number, number])[],
  radius: number,
  chunkSize: readonly [number, number, number],
  voxelOffset: readonly [number, number, number],
): Promise<void> {
  if (path.length === 0) return Promise.resolve();
  const r = Math.floor(radius);
  const z0 = Math.floor(path[0][2]);
  if (r < 1 || !path.every((p) => Math.floor(p[2]) === z0)) {
    return Promise.resolve();
  }
  const bounds = edit.sessionVoxelBoundsFor({
    ...target,
    chunkId: ChunkId.fromCoord({ x: 0, y: 0, z: 0 }),
  });
  const tiles = chunksForStroke(path, r, chunkSize, bounds, voxelOffset);
  if (tiles.length === 0) return Promise.resolve();
  return Promise.all(
    tiles.map((tile) =>
      edit
        .readChunk({ ...target, chunkId: ChunkId.fromCoord(tile.coord) })
        .then(
          () => undefined,
          () => undefined,
        ),
    ),
  ).then(() => undefined);
}
