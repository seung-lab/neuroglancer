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
 * Edit tool contract (TM-315 tooling redesign).
 *
 * An `EditTool` mirrors neuroglancer's `Tool` shape (`description`, `activate`,
 * `toJSON`) but is session-scoped and driven by our own session binder rather
 * than NG's global palette binder. Each tool declares:
 *  - its `interactionPolicy` — how pointer input is delivered (stroke /
 *    discrete / drag-region);
 *  - its `workingResolution()` — the voxel frame pointer input is interpreted
 *    in (drives `resolveVoxelPosition` rescaling at the input substrate);
 *  - its `validateBinding()` — tool-specific layer-binding rules;
 *  - `activate(activation)` — install its policy + open edits via the scope.
 *
 * Layer/resolution bindings are part of each tool's (or its family's) own
 * typed config — there is no shared "edit target".
 */

import type {
  EditSession,
  LayerId,
  LayerMetadata,
  LayerSelection,
  Resolution,
} from "@zettaai/edit-session";

import type { NgLogger } from "#src/editing/adapters/ng_logger.js";
import type { ReadChunkAt } from "#src/editing/tool_runtimes/painting_tools.js";
import type {
  InputHandling,
  ToolInputEvent,
} from "#src/editing/tool_runtimes/tool_input.js";
import type { EditToolActivation } from "#src/editing/tooling/edit_tool_activation.js";

/** How an active tool's pointer input is delivered (see InteractionPolicy). */
export type InteractionPolicyKind = "stroke" | "discrete" | "drag-region";

/** Shared session-scoped dependencies every edit tool is constructed with. */
export interface EditToolContext {
  readonly session: EditSession;
  readonly metadataByLayer: ReadonlyMap<LayerId, LayerMetadata>;
  /** Cross-layer baseline reader (e.g. for a mask image layer). */
  readonly readChunkAt: ReadChunkAt;
  readonly logger: NgLogger;
  /** Layers selected in the session — for binding validation. */
  readonly sessionLayers: readonly LayerSelection[];
}

export interface BindingValidation {
  readonly ok: boolean;
  /** Human detail when `ok === false`. */
  readonly reason?: string;
}

export interface EditTool {
  /** Stable id, e.g. "painting.brush". */
  readonly id: string;
  /** Human label (NG `Tool.description` parity). */
  readonly description: string;
  /** How the input substrate delivers pointer events to this tool. */
  readonly interactionPolicy: InteractionPolicyKind;

  /** The voxel grid this tool's `voxelPosition` input is interpreted in. */
  workingResolution(): Resolution | undefined;

  /** Validate this tool's layer binding against the session's layers. */
  validateBinding(): BindingValidation;

  /** Handle one normalized input event (called by the interaction policy). */
  handleInput(event: ToolInputEvent): InputHandling | Promise<InputHandling>;

  /**
   * Activate the tool: install its interaction policy and open edits through
   * `activation.editScope`. Everything is torn down when `activation` is
   * disposed (tool switch / session close).
   */
  activate(activation: EditToolActivation): void;

  /** Serializable config for the `editSession` state field. */
  toJSON(): unknown;
}
