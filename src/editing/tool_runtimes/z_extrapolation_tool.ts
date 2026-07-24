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
 * @file The z-extrapolation edit tool (TM-326).
 *
 * Two roles in one object, mirroring how the painting family pairs a tool with
 * its shared state:
 *  - an {@link EditTool} the session binder activates (binding validation +
 *    working resolution; no pointer interaction — tracked-segment picking is the
 *    segmentation layer's job, and z-extrapolation is exempt from the
 *    selection-suppression that other tools impose);
 *  - a run controller the panel drives: reactive `getState`/`patchState` plus
 *    {@link runNextSlice} / {@link cancel} / {@link resetLastRun}.
 *
 * `runNextSlice` reads the region window from `session.sessionVoxelBoundsFor`
 * (global voxels), the current Z from the viewport (or the locked value), and
 * the tracked IDs from the mask layer's selection, then runs one
 * {@link propagateSlice} inside `EditScope.runOperation` — one native undo entry,
 * which is exactly what Reset undoes.
 */

import type {
  ChunkVoxelBuffer,
  EditSession,
  LayerId,
  LayerMetadata,
  Resolution,
  ScaleMetadata,
  SessionVoxelBounds,
  VoxelBox,
} from "@zettaai/edit-session";
import { ChunkId, scaleFor } from "@zettaai/edit-session";

import { BackendAuthExpiredError } from "#src/editing/backend/backend_endpoint.js";
import { globalToTargetVoxel } from "#src/editing/raster/global_voxel_conversion.js";
import { UnsupportedImageDataTypeError } from "#src/editing/tool_runtimes/image_scalar_to_uint8.js";
import { TooManyTrackedSegmentsError } from "#src/editing/tool_runtimes/mask_label_codec.js";
import type { ReadChunkAt } from "#src/editing/tool_runtimes/painting_tools.js";
import type { MultipartPoster } from "#src/editing/tool_runtimes/propagate_mask_client.js";
import {
  propagateSlice,
  type ImageReadSpec,
  type MaskWriteSpec,
  type PropagateWindow,
} from "#src/editing/tool_runtimes/slice_propagation.js";
import type { InputHandling } from "#src/editing/tool_runtimes/tool_input.js";
import type { EditScope } from "#src/editing/tooling/edit_scope.js";
import type {
  BindingValidation,
  EditTool,
} from "#src/editing/tooling/edit_tool.js";
import type { EditToolActivation } from "#src/editing/tooling/edit_tool_activation.js";
import type { ToolDefinition } from "#src/editing/tooling/tool_registry.js";
import { StatusMessage } from "#src/status.js";
import { NullarySignal } from "#src/util/signal.js";

export const Z_EXTRAPOLATION_TOOL_ID = "z-extrapolation";

export type ZExtrapolationDirection = "forward" | "backward";

/** Reactive state the panel reads and mutates. */
export interface ZExtrapolationRunState {
  readonly imageLayerId: LayerId | undefined;
  readonly maskLayerId: LayerId | undefined;
  readonly direction: ZExtrapolationDirection;
  readonly currentZ: number | undefined;
  readonly isCurrentZLocked: boolean;
  readonly isRunning: boolean;
  /** Whether the last propagation is still the top of the undo stack. */
  readonly hasLastRun: boolean;
}

/** Host-provided collaborators (all the tool needs beyond `EditToolContext`). */
export interface ZExtrapolationDeps {
  readonly session: EditSession;
  readonly scope: EditScope;
  readonly backendClient: MultipartPoster;
  readonly readChunkAt: ReadChunkAt;
  readonly metadataByLayer: ReadonlyMap<LayerId, LayerMetadata>;
  /** The session-pinned resolution of a layer (image or mask). */
  readonly resolutionFor: (layerId: LayerId) => Resolution | undefined;
  /** Physical size (nm) of one viewer global-space unit per axis. */
  readonly globalVoxelSizeNm: () =>
    | readonly [number, number, number]
    | undefined;
  /** The mask layer's currently-selected segment IDs (the tracked set). */
  readonly trackedSegmentsFor: (maskLayerId: LayerId) => readonly bigint[];
  /** Add IDs to the mask layer's selection (auto-detect populates the set). */
  readonly addTrackedSegments: (
    maskLayerId: LayerId,
    ids: readonly bigint[],
  ) => void;
  readonly getViewportPosition: () => Float32Array;
  readonly setViewportPosition: (position: Float32Array) => void;
}

const DEFAULT_STATE: ZExtrapolationRunState = {
  imageLayerId: undefined,
  maskLayerId: undefined,
  direction: "forward",
  currentZ: undefined,
  isCurrentZLocked: false,
  isRunning: false,
  hasLastRun: false,
};

interface RunPlan {
  readonly image: ImageReadSpec;
  readonly mask: MaskWriteSpec;
  /** Propagation window in the image grid (the model runs here). */
  readonly imageWindow: PropagateWindow;
  /** Propagation window in the mask grid (read/write happen here). */
  readonly maskWindow: PropagateWindow;
  readonly trackedIds: readonly bigint[];
}

/** Captured before a run so Reset can restore the pre-run viewport + Z. */
interface LastRunSnapshot {
  readonly prevCurrentZ: number | undefined;
  readonly prevLocked: boolean;
  readonly prevViewport: Float32Array;
}

export class ZExtrapolationTool implements EditTool {
  readonly id = Z_EXTRAPOLATION_TOOL_ID;
  readonly description = "Z-extrapolation";
  readonly interactionPolicy = "discrete" as const;

  readonly changed = new NullarySignal();
  private state: ZExtrapolationRunState = DEFAULT_STATE;
  private abortController: AbortController | undefined;
  private lastRun: LastRunSnapshot | undefined;

  constructor(private readonly deps: ZExtrapolationDeps) {}

  // -- Reactive state (panel) ---------------------------------------------

  getState(): ZExtrapolationRunState {
    return this.state;
  }

  patchState(patch: Partial<ZExtrapolationRunState>): void {
    this.state = { ...this.state, ...patch };
    this.changed.dispatch();
  }

  // -- EditTool contract --------------------------------------------------

  workingResolution(): Resolution | undefined {
    const { maskLayerId } = this.state;
    return maskLayerId === undefined
      ? undefined
      : this.deps.resolutionFor(maskLayerId);
  }

  validateBinding(): BindingValidation {
    const { imageLayerId, maskLayerId } = this.state;
    if (
      maskLayerId === undefined ||
      !this.deps.metadataByLayer.has(maskLayerId)
    ) {
      return { ok: false, reason: "Select an editable segmentation layer." };
    }
    if (
      imageLayerId === undefined ||
      !this.deps.metadataByLayer.has(imageLayerId)
    ) {
      return { ok: false, reason: "Select an image layer." };
    }
    return { ok: true };
  }

  handleInput(): InputHandling {
    // No pointer interaction: propagation runs from the panel's Run button, and
    // tracked-segment picking is handled by the segmentation layer.
    return { consumed: false };
  }

  activate(_activation: EditToolActivation): void {
    // Nothing to install — see `handleInput`.
  }

  toJSON(): unknown {
    const { imageLayerId, maskLayerId, direction } = this.state;
    return { imageLayerId, maskLayerId, direction };
  }

  // -- Run controller (panel) --------------------------------------------

  /** Propagate the tracked segments from the current slice to the next one. */
  async runNextSlice(): Promise<void> {
    if (this.state.isRunning) return;
    const plan = this.buildRunPlan();
    if (typeof plan === "string") {
      // The panel disables Run with this reason; surface it too as a fallback
      // (e.g. if invoked while momentarily out of region).
      this.notify(plan);
      return;
    }

    const snapshot: LastRunSnapshot = {
      prevCurrentZ: this.state.currentZ,
      prevLocked: this.state.isCurrentZLocked,
      prevViewport: this.deps.getViewportPosition().slice(),
    };
    const abortController = new AbortController();
    this.abortController = abortController;
    this.patchState({ isRunning: true });

    try {
      await this.deps.scope.runOperation(
        {
          description: "Z-extrapolation",
          tag: Z_EXTRAPOLATION_TOOL_ID,
          redo: { kind: "image" },
        },
        (edit) =>
          propagateSlice({
            edit,
            readChunkAt: this.deps.readChunkAt,
            client: this.deps.backendClient,
            image: plan.image,
            mask: plan.mask,
            imageWindow: plan.imageWindow,
            maskWindow: plan.maskWindow,
            trackedIds: plan.trackedIds,
            signal: abortController.signal,
          }).then(() => undefined),
      );
      if (abortController.signal.aborted) return;
      this.lastRun = snapshot;
      this.advanceAfterRun(plan);
    } catch (error) {
      if (abortController.signal.aborted) return;
      this.notifyError(error);
      this.patchState({ isRunning: false });
    } finally {
      if (this.abortController === abortController) {
        this.abortController = undefined;
      }
    }
  }

  /** Abort an in-flight run. */
  cancel(): void {
    this.abortController?.abort();
    this.patchState({ isRunning: false });
  }

  /** Undo the last propagation (native undo) and restore the prior viewport/Z. */
  async resetLastRun(): Promise<void> {
    const snapshot = this.lastRun;
    if (!this.state.hasLastRun || snapshot === undefined) return;
    await this.deps.session.undo();
    this.deps.setViewportPosition(snapshot.prevViewport);
    this.patchState({
      currentZ: snapshot.prevCurrentZ,
      isCurrentZLocked: snapshot.prevLocked,
      hasLastRun: false,
    });
    this.lastRun = undefined;
  }

  // -- Panel bindings -----------------------------------------------------

  /** The tracked segment IDs (the mask layer's current selection). */
  trackedSegments(): readonly bigint[] {
    const { maskLayerId } = this.state;
    return maskLayerId === undefined
      ? []
      : this.deps.trackedSegmentsFor(maskLayerId);
  }

  /**
   * Why Run is currently blocked (missing layers, no tracked segments, current
   * or next slice outside the region, …), or `undefined` when a run would go
   * through. The panel uses this to disable the button and show the reason as a
   * tooltip — so e.g. the next slice being out of region blocks the button
   * instead of erroring on click.
   */
  runDisabledReason(): string | undefined {
    const plan = this.buildRunPlan();
    return typeof plan === "string" ? plan : undefined;
  }

  setImageLayer(layerId: LayerId | undefined): void {
    this.patchState({ imageLayerId: layerId });
  }

  setMaskLayer(layerId: LayerId | undefined): void {
    this.patchState({ maskLayerId: layerId });
  }

  setDirection(direction: ZExtrapolationDirection): void {
    this.patchState({ direction });
  }

  /** Set the current Z explicitly, which locks it (editing pins the slice). */
  setCurrentZ(z: number): void {
    this.patchState({ currentZ: z, isCurrentZLocked: true });
  }

  /** Toggle the Z lock; unlocking re-syncs the current Z to the viewport. */
  toggleLock(): void {
    if (this.state.isCurrentZLocked) {
      this.patchState({ isCurrentZLocked: false });
      this.followViewportZ();
    } else {
      this.patchState({ isCurrentZLocked: true });
    }
  }

  /** When unlocked, refresh the current Z from the viewport's Z position. */
  followViewportZ(): void {
    const { maskLayerId, isCurrentZLocked } = this.state;
    if (isCurrentZLocked || maskLayerId === undefined) return;
    const metadata = this.deps.metadataByLayer.get(maskLayerId);
    const resolution = this.deps.resolutionFor(maskLayerId);
    if (metadata === undefined || resolution === undefined) return;
    const z = this.viewportMaskZ(scaleFor(metadata, resolution));
    if (z !== undefined && z !== this.state.currentZ) {
      this.patchState({ currentZ: z });
    }
  }

  /**
   * Add every distinct non-zero segment ID present in the current slice's region
   * to the tracked set (current-Z only, per TM-326). Reads the mask through the
   * overlay in a throwaway edit so live paint counts.
   */
  async autoDetectTrackedSegments(): Promise<void> {
    const window = this.resolveCurrentWindow();
    if (window === undefined) return; // resolveCurrentWindow surfaced the reason
    const edit = this.deps.session.beginEdit({
      description: "Z-extrapolation auto-detect",
      tag: Z_EXTRAPOLATION_TOOL_ID,
    });
    let ids: bigint[];
    try {
      const region = await edit.readRegion(
        { layerId: window.maskLayerId, resolution: window.maskResolution },
        window.box,
      );
      ids = distinctNonZeroIds(region.data);
    } finally {
      await edit.discard();
    }
    if (ids.length > 0) {
      this.deps.addTrackedSegments(window.maskLayerId, ids);
    }
  }

  private resolveCurrentWindow():
    | { maskLayerId: LayerId; maskResolution: Resolution; box: VoxelBox }
    | undefined {
    const { maskLayerId } = this.state;
    if (maskLayerId === undefined) {
      this.notify("Select an editable segmentation layer.");
      return undefined;
    }
    const metadata = this.deps.metadataByLayer.get(maskLayerId);
    const maskResolution = this.deps.resolutionFor(maskLayerId);
    if (metadata === undefined || maskResolution === undefined) {
      this.notify("The segmentation layer is not available in this session.");
      return undefined;
    }
    const maskScale = scaleFor(metadata, maskResolution);
    const bounds = this.deps.session.sessionVoxelBoundsFor({
      layerId: maskLayerId,
      resolution: maskResolution,
      chunkId: ChunkId.fromCoord({ x: 0, y: 0, z: 0 }),
    });
    if (bounds === undefined) {
      this.notify("The segmentation layer is not part of the session region.");
      return undefined;
    }
    const currentZ = this.resolveCurrentZ(maskScale, bounds);
    if (typeof currentZ === "string") {
      this.notify(currentZ);
      return undefined;
    }
    return {
      maskLayerId,
      maskResolution,
      box: {
        origin: [bounds.loX, bounds.loY, currentZ],
        size: [bounds.hiX - bounds.loX, bounds.hiY - bounds.loY, 1],
      },
    };
  }

  // -- Run planning -------------------------------------------------------

  private advanceAfterRun(plan: RunPlan): void {
    this.patchState({
      currentZ: plan.maskWindow.nextZ,
      isCurrentZLocked: true,
      isRunning: false,
      hasLastRun: true,
    });
    this.moveViewportToZ(plan.maskWindow.nextZ, plan.mask.scale);
  }

  /**
   * Build the run plan, or return a human reason it can't run. Pure (no toasts):
   * both `runNextSlice` and the panel's disabled-button tooltip
   * ({@link runDisabledReason}) call it, so the same checks gate the button and
   * the action.
   */
  private buildRunPlan(): RunPlan | string {
    const { imageLayerId, maskLayerId, direction } = this.state;
    if (imageLayerId === undefined || maskLayerId === undefined) {
      return "Select an image layer and an editable segmentation layer.";
    }
    const imageMetadata = this.deps.metadataByLayer.get(imageLayerId);
    const maskMetadata = this.deps.metadataByLayer.get(maskLayerId);
    const imageResolution = this.deps.resolutionFor(imageLayerId);
    const maskResolution = this.deps.resolutionFor(maskLayerId);
    if (
      imageMetadata === undefined ||
      maskMetadata === undefined ||
      imageResolution === undefined ||
      maskResolution === undefined
    ) {
      return "Selected layers are not available in this session.";
    }
    const imageScale = scaleFor(imageMetadata, imageResolution);
    const maskScale = scaleFor(maskMetadata, maskResolution);
    // The model runs at the image grid and only XY is resampled; the two layers
    // must share the Z (section) grid so "adjacent slice" is well-defined.
    if (imageScale.voxelSizeNm[2] !== maskScale.voxelSizeNm[2]) {
      return "Image and segmentation layers must share the Z (section) resolution.";
    }
    const trackedIds = this.deps.trackedSegmentsFor(maskLayerId);
    if (trackedIds.length === 0) {
      return "Double-click segments in the viewer (or Auto-detect) to track them.";
    }
    const windows = this.computeWindows(
      imageLayerId,
      imageResolution,
      maskLayerId,
      maskResolution,
      maskScale,
      direction,
    );
    if (typeof windows === "string") return windows; // a blocking reason
    return {
      image: {
        layerId: imageLayerId,
        resolution: imageResolution,
        scale: imageScale,
        dataType: imageMetadata.voxelDataType,
      },
      mask: {
        layerId: maskLayerId,
        resolution: maskResolution,
        scale: maskScale,
        dataType: maskMetadata.voxelDataType,
      },
      imageWindow: windows.imageWindow,
      maskWindow: windows.maskWindow,
      trackedIds,
    };
  }

  /**
   * Resolve the propagation window in BOTH grids from the session region. The
   * current/next Z are shared integers because the Z resolution matches (checked
   * in `buildRunPlan`), so they are computed once against the mask bounds.
   */
  private computeWindows(
    imageLayerId: LayerId,
    imageResolution: Resolution,
    maskLayerId: LayerId,
    maskResolution: Resolution,
    maskScale: ScaleMetadata,
    direction: ZExtrapolationDirection,
  ): { imageWindow: PropagateWindow; maskWindow: PropagateWindow } | string {
    const maskBounds = this.boundsFor(maskLayerId, maskResolution);
    const imageBounds = this.boundsFor(imageLayerId, imageResolution);
    if (maskBounds === undefined || imageBounds === undefined) {
      return "The selected layers are not part of the session region.";
    }
    const maskWidth = maskBounds.hiX - maskBounds.loX;
    const maskHeight = maskBounds.hiY - maskBounds.loY;
    const imageWidth = imageBounds.hiX - imageBounds.loX;
    const imageHeight = imageBounds.hiY - imageBounds.loY;
    if (
      maskWidth <= 0 ||
      maskHeight <= 0 ||
      imageWidth <= 0 ||
      imageHeight <= 0
    ) {
      return "The session region has no area.";
    }
    const currentZ = this.resolveCurrentZ(maskScale, maskBounds);
    if (typeof currentZ === "string") return currentZ; // a blocking reason
    const nextZ = direction === "forward" ? currentZ + 1 : currentZ - 1;
    if (nextZ < maskBounds.loZ || nextZ >= maskBounds.hiZ) {
      return `Next slice Z=${nextZ} is outside the session region.`;
    }
    return {
      maskWindow: {
        originX: maskBounds.loX,
        originY: maskBounds.loY,
        width: maskWidth,
        height: maskHeight,
        currentZ,
        nextZ,
      },
      imageWindow: {
        originX: imageBounds.loX,
        originY: imageBounds.loY,
        width: imageWidth,
        height: imageHeight,
        currentZ,
        nextZ,
      },
    };
  }

  private boundsFor(
    layerId: LayerId,
    resolution: Resolution,
  ): SessionVoxelBounds | undefined {
    return this.deps.session.sessionVoxelBoundsFor({
      layerId,
      resolution,
      chunkId: ChunkId.fromCoord({ x: 0, y: 0, z: 0 }),
    });
  }

  private resolveCurrentZ(
    maskScale: ScaleMetadata,
    bounds: SessionVoxelBounds,
  ): number | string {
    const z =
      this.state.isCurrentZLocked && this.state.currentZ !== undefined
        ? this.state.currentZ
        : this.viewportMaskZ(maskScale);
    if (z === undefined) {
      return "Current Z is not set.";
    }
    if (z < bounds.loZ || z >= bounds.hiZ) {
      return `Current Z=${z} is outside the session region.`;
    }
    return z;
  }

  /** The viewport's current Z, in the mask layer's voxel grid. */
  private viewportMaskZ(maskScale: ScaleMetadata): number | undefined {
    const globalNm = this.deps.globalVoxelSizeNm();
    if (globalNm === undefined) return undefined;
    const position = this.deps.getViewportPosition();
    const voxel = globalToTargetVoxel(
      [position[0], position[1], position[2]],
      globalNm,
      maskScale.voxelSizeNm,
    );
    return Math.floor(voxel[2]);
  }

  /** Move the viewport to the center of mask-voxel slice `z`. */
  private moveViewportToZ(z: number, maskScale: ScaleMetadata): void {
    const globalNm = this.deps.globalVoxelSizeNm();
    if (globalNm === undefined || globalNm[2] === 0) return;
    const position = this.deps.getViewportPosition().slice();
    // Inverse of globalToTargetVoxel on Z: global = voxel * voxelNm / globalNm.
    position[2] = ((z + 0.5) * maskScale.voxelSizeNm[2]) / globalNm[2];
    this.deps.setViewportPosition(position);
  }

  private notify(message: string): void {
    StatusMessage.showTemporaryMessage(message, 5000);
  }

  private notifyError(error: unknown): void {
    let message: string;
    if (error instanceof TooManyTrackedSegmentsError) {
      message = error.message;
    } else if (error instanceof UnsupportedImageDataTypeError) {
      message = error.message;
    } else if (error instanceof BackendAuthExpiredError) {
      message = "Session expired — sign in again and retry.";
    } else {
      message = error instanceof Error ? error.message : "Unknown error";
    }
    StatusMessage.showTemporaryMessage(
      `Z-extrapolation failed: ${message}`,
      8000,
    );
  }
}

/** Distinct non-zero segment IDs in a dense mask block (widening numeric → bigint). */
function distinctNonZeroIds(data: ChunkVoxelBuffer): bigint[] {
  const found = new Set<bigint>();
  for (let i = 0; i < data.length; i++) {
    const raw = data[i];
    const id = typeof raw === "bigint" ? raw : BigInt(raw);
    if (id !== 0n) found.add(id);
  }
  return [...found];
}

/** The registry definition for the z-extrapolation tool (hotkey Ctrl+X). */
export function zExtrapolationToolDefinition(
  tool: ZExtrapolationTool,
): ToolDefinition {
  return {
    id: Z_EXTRAPOLATION_TOOL_ID,
    interactionPolicy: "discrete",
    cursorKind: undefined,
    activationHotkey: "control+keyx",
    panelKey: Z_EXTRAPOLATION_TOOL_ID,
    createTool: () => tool,
  };
}
