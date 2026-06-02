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
 * @file Pure-state derivations for the brush cursor overlays. Bridges the
 * `@zettaai/edit-session` library events (`active-tool-changed`, painting
 * `changed`) and neuroglancer `mouseState.changed` into flat
 * `WatchableValue`s. Visibility (per `05-tools-and-cursor.md`): session
 * active AND active tool is `painting.brush` or `painting.erase` (fill
 * does NOT show a cursor).
 */

import type {
  EditSession,
  PaintingTools,
  Resolution,
} from "@zettaai/edit-session";
import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { vec3 } from "#src/util/geom.js";
import { WatchableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";

export type ToolKind = "brush" | "eraser" | "fill";

const PAINTING_TOOL_ID = "painting";
const BRUSH_TOOL_ID = "painting.brush";
const ERASER_TOOL_ID = "painting.erase";
const FILL_TOOL_ID = "painting.fill";

function classifyToolKind(toolId: string | undefined): ToolKind | undefined {
  switch (toolId) {
    case BRUSH_TOOL_ID:
      return "brush";
    case ERASER_TOOL_ID:
      return "eraser";
    case FILL_TOOL_ID:
      return "fill";
    default:
      return undefined;
  }
}

/**
 * Cursor state derived from the active edit session and viewer mouse state.
 * Owned by `EditSessionHost`; disposed at session-end.
 */
export class BrushCursorState extends RefCounted {
  readonly visible = new WatchableValue<boolean>(false);
  readonly radiusVoxels = new WatchableValue<number>(0);
  readonly worldCenter = new WatchableValue<vec3 | undefined>(undefined);
  readonly toolKind = new WatchableValue<ToolKind | undefined>(undefined);
  readonly activeToolId = new WatchableValue<string | undefined>(undefined);
  readonly targetResolution = new WatchableValue<Resolution | undefined>(
    undefined,
  );

  /** Per-session subscriptions, replaced whenever the active session changes. */
  private sessionSubscriptions: Array<() => void> = [];

  constructor(private readonly host: EditSessionHost) {
    super();

    // Rewire session-scoped subscriptions whenever the host's active session
    // changes.
    this.registerDisposer(
      host.activeSession.changed.add(() => this.rewireForSession()),
    );

    // The mouse state lives on the viewer (across sessions); subscribe once.
    this.registerDisposer(
      host.viewer.mouseState.changed.add(() => this.refreshWorldCenter()),
    );

    // Initial wiring against whatever session is currently active (typically
    // none at construction, but the host may construct us mid-flight in
    // tests).
    this.rewireForSession();
  }

  override disposed(): void {
    this.teardownSessionSubscriptions();
    super.disposed();
  }

  // -- Derivation ---------------------------------------------------------

  private rewireForSession(): void {
    this.teardownSessionSubscriptions();
    const session = this.host.activeSession.value;
    if (session === undefined) {
      this.activeToolId.value = undefined;
      this.toolKind.value = undefined;
      this.radiusVoxels.value = 0;
      this.targetResolution.value = undefined;
      this.recomputeVisibility();
      this.refreshWorldCenter();
      return;
    }

    // Initial snapshot.
    this.activeToolId.value = session.getActiveToolId();
    this.toolKind.value = classifyToolKind(this.activeToolId.value);
    this.syncPaintingState(session);
    this.recomputeVisibility();
    this.refreshWorldCenter();

    // 1. Active-tool changes.
    const offActive = session.on("active-tool-changed", ({ to }) => {
      this.activeToolId.value = to;
      this.toolKind.value = classifyToolKind(to);
      this.recomputeVisibility();
    });
    this.sessionSubscriptions.push(offActive);

    // 2. Painting tool state (radius / target resolution).
    const painting = safeGetPaintingTools(session);
    if (painting !== undefined) {
      const offPainting = painting.on("changed", () => {
        this.syncPaintingState(session);
      });
      this.sessionSubscriptions.push(offPainting);
    }
  }

  private syncPaintingState(session: EditSession): void {
    const painting = safeGetPaintingTools(session);
    if (painting === undefined) {
      this.radiusVoxels.value = 0;
      this.targetResolution.value = undefined;
      return;
    }
    const state = painting.getState();
    this.radiusVoxels.value = state.radius;
    this.targetResolution.value = state.targetResolution;
  }

  private recomputeVisibility(): void {
    const sessionActive = this.host.activeSession.value !== undefined;
    const kind = this.toolKind.value;
    const shouldShow =
      sessionActive && (kind === "brush" || kind === "eraser");
    if (this.visible.value !== shouldShow) {
      this.visible.value = shouldShow;
    }
  }

  private refreshWorldCenter(): void {
    const mouseState = this.host.viewer.mouseState;
    if (!mouseState.active) {
      if (this.worldCenter.value !== undefined) {
        this.worldCenter.value = undefined;
      }
      return;
    }
    const src = mouseState.unsnappedPosition;
    if (src === undefined || src.length < 3) {
      if (this.worldCenter.value !== undefined) {
        this.worldCenter.value = undefined;
      }
      return;
    }
    const next: vec3 = vec3.fromValues(src[0] ?? 0, src[1] ?? 0, src[2] ?? 0);
    const prev = this.worldCenter.value;
    if (
      prev !== undefined &&
      prev[0] === next[0] &&
      prev[1] === next[1] &&
      prev[2] === next[2]
    ) {
      return;
    }
    this.worldCenter.value = next;
  }

  private teardownSessionSubscriptions(): void {
    for (const off of this.sessionSubscriptions) {
      try {
        off();
      } catch {
        // ignore
      }
    }
    this.sessionSubscriptions = [];
  }
}

/**
 * Safely fetch the `PaintingTools` composite from a session. Returns
 * `undefined` if painting wasn't registered (the library throws
 * `UnknownToolError` rather than returning undefined).
 */
function safeGetPaintingTools(
  session: EditSession,
): PaintingTools | undefined {
  try {
    return session.tools.getTool<PaintingTools>(PAINTING_TOOL_ID);
  } catch {
    // The painting tool group may not be registered (degraded sessions).
    return undefined;
  }
}

// Re-exports used by sibling cursor overlays to avoid string-literal drift.
export const TOOL_IDS = {
  brush: BRUSH_TOOL_ID,
  erase: ERASER_TOOL_ID,
  fill: FILL_TOOL_ID,
} as const;
