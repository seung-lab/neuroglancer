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
  ChunkId,
  Edit,
  LayerId,
  LayerMetadata,
  ReadonlyChunkVoxelBuffer,
  Resolution,
} from "@zettaai/edit-session";
import { scaleFor } from "@zettaai/edit-session";

import { applyPaintBatch } from "#src/editing/tool_runtimes/paint_batch_apply.js";
import type {
  PaintCompute,
  PaintingMaskConfig,
} from "#src/editing/tool_runtimes/paint_types.js";
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

export interface PaintingSharedState {
  readonly targetLayerId: LayerId;
  readonly targetResolution: Resolution;
  readonly radius: number;
  readonly radiusCycle: readonly number[];
  readonly activeValue: number | bigint;
  readonly eraseValue: number | bigint;
  readonly mask: PaintingMaskConfig | undefined;
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
  readonly readChunkAt: ReadChunkAt;
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
    // half-applied stroke never lingers without a history entry.
    if (this.handle !== null) {
      const handle = this.handle;
      this.handle = null;
      void handle.cancel();
    }
    this.lastVoxel = null;
    this.geometry = null;
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
    maskFields: { mask?: PaintingMaskConfig; maskMetadata?: LayerMetadata },
    readChunkAt: ReadChunkAt,
    stepVoxels: number,
  ): Promise<void> {
    if (path.length < 2) return;
    const readChunk = (chunkId: ChunkId) =>
      edit.readChunk({
        layerId: shared.targetLayerId,
        resolution: shared.targetResolution,
        chunkId,
      });
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
    const chunkSize = scaleFor(metadata, shared.targetResolution).chunkDataSize;
    await edit.withBatch(() => applyPaintBatch(edit, batch, chunkSize));
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
    const maskFields = useMask
      ? {
          mask: shared.mask,
          ...(maskMetadata !== undefined ? { maskMetadata } : {}),
        }
      : {};
    const readChunkAt = this.deps.readChunkAt;

    if (ev.kind === "pointer-down" && ev.button === "primary") {
      const handle = this.deps.scope.beginInteraction({
        description: this.preset.description,
        tag: this.preset.tag,
        redo: { kind: "image" },
      });
      this.handle = handle;
      const edit = handle.edit;
      const pos: readonly [number, number, number] = [
        ev.voxelPosition[0],
        ev.voxelPosition[1],
        ev.voxelPosition[2],
      ];
      this.lastVoxel = pos;
      // Distance-resampled geometry (TM-318) drives real-radius strokes; the
      // 1-voxel brush keeps the legacy raw-polyline path (geometry === null).
      const r = Math.floor(shared.radius);
      this.geometry =
        r >= 1
          ? new StrokeGeometry({
              diameterVoxels: 2 * r + 1,
              spacingFraction: shared.spacingFraction,
            })
          : null;
      this.geometry?.pushSamples([pos]);
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
      await edit.withBatch(() => applyPaintBatch(edit, batch, chunkSize));
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
        await this.paintStrokePath(
          edit,
          path,
          shared,
          metadata,
          value,
          maskFields,
          readChunkAt,
          this.geometry.spacingVoxels,
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
          await this.paintStrokePath(
            this.handle.edit,
            [this.lastVoxel, ...stamps],
            shared,
            metadata,
            value,
            maskFields,
            readChunkAt,
            this.geometry.spacingVoxels,
          );
        }
      }
      this.handle.commit();
      this.handle = null;
      this.lastVoxel = null;
      this.geometry = null;
      return { consumed: true };
    }

    if (ev.kind === "pointer-cancel" && this.handle !== null) {
      const handle = this.handle;
      this.handle = null;
      this.lastVoxel = null;
      this.geometry = null;
      await handle.cancel();
      return { consumed: true };
    }

    return { consumed: false };
  }
}

/** 3D flood fill: a single click is one `Edit` → one undo entry. */
export class FillTool implements EditTool {
  readonly id = PAINTING_FILL_TOOL_ID;
  readonly description = "Fill";
  // A fill is a single click — each pointer-down is delivered as-is.
  readonly interactionPolicy: InteractionPolicyKind = "discrete";

  constructor(private readonly deps: PaintingToolDeps) {}

  workingResolution(): Resolution {
    return this.deps.state.getState().targetResolution;
  }

  validateBinding(): BindingValidation {
    return validateTargetBinding(this.deps);
  }

  /** Fill is atomic (one `runOperation`); no per-activation state to reset. */
  activate(_activation: EditToolActivation): void {
    void _activation;
  }

  toJSON(): unknown {
    return { type: this.id };
  }

  async handleInput(ev: ToolInputEvent): Promise<InputHandling> {
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
    await this.deps.scope.runOperation(
      {
        description: "Fill",
        tag: PAINTING_FILL_TOOL_ID,
        redo: { kind: "image" },
      },
      async (edit) => {
        const readChunk = (chunkId: ChunkId) =>
          edit.readChunk({
            layerId: shared.targetLayerId,
            resolution: shared.targetResolution,
            chunkId,
          });
        const batch = await this.deps.compute.fill3d({
          targetLayerId: shared.targetLayerId,
          targetResolution: shared.targetResolution,
          metadata,
          seedVoxelPosition: [
            ev.voxelPosition[0],
            ev.voxelPosition[1],
            ev.voxelPosition[2],
          ],
          value: shared.activeValue,
          readChunk,
        });
        const chunkSize = scaleFor(
          metadata,
          shared.targetResolution,
        ).chunkDataSize;
        await edit.withBatch(() => applyPaintBatch(edit, batch, chunkSize));
      },
    );
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
  readonly brush: StrokeTool;
  readonly erase: StrokeTool;
  readonly fill: FillTool;

  constructor(opts: {
    scope: EditScope;
    compute: PaintCompute;
    metadataByLayer: ReadonlyMap<LayerId, LayerMetadata>;
    readChunkAt: ReadChunkAt;
    initialState: PaintingSharedState;
  }) {
    this.state = new PaintingState(opts.initialState);
    const deps: PaintingToolDeps = {
      scope: opts.scope,
      state: this.state,
      compute: opts.compute,
      metadataByLayer: opts.metadataByLayer,
      readChunkAt: opts.readChunkAt,
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
