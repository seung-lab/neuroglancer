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
 *  - the eraser is the brush flow with the erase value; its mask is suppressed
 *    inside `PaintingCompute` (keyed on the active tool id) exactly as before.
 *
 * The shared paint state (radius, radiusCycle, activeValue, eraseValue, mask,
 * target layer/resolution) keeps the `getState()` / `patchState()` /
 * `changed` surface of the old library `PaintingTools`, so the cursor overlay
 * and tool-settings UI only need to swap WHERE they obtain it.
 */

import type {
  ChunkId,
  Edit,
  EditSession,
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
import type {
  InputHandling,
  Tool,
  ToolInputEvent,
} from "#src/editing/tool_runtimes/tool_input.js";
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
  readonly session: EditSession;
  readonly state: PaintingState;
  readonly compute: PaintCompute;
  readonly metadataByLayer: ReadonlyMap<LayerId, LayerMetadata>;
  readonly readChunkAt: ReadChunkAt;
}

/**
 * Brush / Erase. Both run the identical stroke flow; only the written value
 * (active vs erase) and the history label/tag differ. One stroke is one
 * `Edit`: pointer-down opens it, each move writes into it, pointer-up records
 * it as a single undo entry, pointer-cancel discards it.
 */
export class StrokeTool implements Tool {
  readonly id: string;
  private edit: Edit | null = null;
  private lastVoxel: readonly [number, number, number] | null = null;

  constructor(
    private readonly deps: PaintingToolDeps,
    private readonly preset: StrokePreset,
  ) {
    this.id = preset.toolId;
  }

  onDeactivate(): void {
    // A tool switch mid-stroke abandons the in-flight edit. Roll it back so a
    // half-applied stroke never lingers without a history entry.
    if (this.edit !== null) {
      void this.edit.discard();
      this.edit = null;
    }
    this.lastVoxel = null;
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
    const maskMetadata =
      shared.mask !== undefined
        ? this.deps.metadataByLayer.get(shared.mask.imageLayerId)
        : undefined;
    const maskFields =
      shared.mask !== undefined
        ? {
            mask: shared.mask,
            ...(maskMetadata !== undefined ? { maskMetadata } : {}),
          }
        : {};
    const readChunkAt = this.deps.readChunkAt;

    if (ev.kind === "pointer-down" && ev.button === "primary") {
      const edit = this.deps.session.beginEdit({
        description: this.preset.description,
        tag: this.preset.tag,
        redo: { kind: "image" },
      });
      this.edit = edit;
      const pos: readonly [number, number, number] = [
        ev.voxelPosition[0],
        ev.voxelPosition[1],
        ev.voxelPosition[2],
      ];
      this.lastVoxel = pos;
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
      this.edit !== null &&
      this.lastVoxel !== null
    ) {
      const edit = this.edit;
      const from = this.lastVoxel;
      const to: readonly [number, number, number] = [
        ev.voxelPosition[0],
        ev.voxelPosition[1],
        ev.voxelPosition[2],
      ];
      this.lastVoxel = to;
      const via = ev.viaVoxelPositions;
      const readChunk = (chunkId: ChunkId) =>
        edit.readChunk({
          layerId: shared.targetLayerId,
          resolution: shared.targetResolution,
          chunkId,
        });
      const batch = await this.deps.compute.applyBrushStroke({
        targetLayerId: shared.targetLayerId,
        targetResolution: shared.targetResolution,
        metadata,
        from,
        to,
        ...(via !== undefined && via.length > 0 ? { via } : {}),
        stepVoxels: 1,
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

    if (ev.kind === "pointer-up" && this.edit !== null) {
      this.edit.record();
      this.edit = null;
      this.lastVoxel = null;
      return { consumed: true };
    }

    if (ev.kind === "pointer-cancel" && this.edit !== null) {
      const edit = this.edit;
      this.edit = null;
      this.lastVoxel = null;
      await edit.discard();
      return { consumed: true };
    }

    return { consumed: false };
  }
}

/** 3D flood fill: a single click is one `Edit` → one undo entry. */
export class FillTool implements Tool {
  readonly id = PAINTING_FILL_TOOL_ID;

  constructor(private readonly deps: PaintingToolDeps) {}

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
    const edit = this.deps.session.beginEdit({
      description: "Fill",
      tag: PAINTING_FILL_TOOL_ID,
      redo: { kind: "image" },
    });
    try {
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
      edit.record();
    } catch (err) {
      await edit.discard();
      throw err;
    }
    return { consumed: true };
  }
}

/**
 * Owns the three painting tools and the shared paint state. Constructed by the
 * host AFTER `EditSession.open(...)`. `dispatch` routes one input event to the
 * currently-active painting tool (the host owns active-tool selection state).
 */
export class ConsumerPaintingTools {
  readonly state: PaintingState;
  readonly brush: StrokeTool;
  readonly erase: StrokeTool;
  readonly fill: FillTool;

  constructor(opts: {
    session: EditSession;
    compute: PaintCompute;
    metadataByLayer: ReadonlyMap<LayerId, LayerMetadata>;
    readChunkAt: ReadChunkAt;
    initialState: PaintingSharedState;
  }) {
    this.state = new PaintingState(opts.initialState);
    const deps: PaintingToolDeps = {
      session: opts.session,
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
  getTool(toolId: string | undefined): Tool | undefined {
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

  /** Drop in-flight stroke state for the active tool (tool switch / teardown). */
  deactivate(toolId: string | undefined): void {
    this.getTool(toolId)?.onDeactivate?.();
  }
}
