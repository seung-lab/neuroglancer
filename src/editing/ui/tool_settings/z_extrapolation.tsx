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
 * @file Z-extrapolation tool settings panel (TM-326).
 *
 * Presentational: all logic lives on `host.zExtrapolation` (the tool + run
 * controller). The panel reads its reactive state, offers layer/direction/Z
 * controls, lists the tracked segments (the mask layer's selection), and drives
 * Auto-detect / Run / Reset. Run is gated on the backend being reachable.
 */

import type { EditSession, LayerId } from "@zettaai/edit-session";
import { useCallback, useEffect } from "preact/hooks";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import type { ZExtrapolationTool } from "#src/editing/tool_runtimes/z_extrapolation_tool.js";
import { useEvent } from "#src/editing/ui/interop/use_event.js";
import { useWatchable } from "#src/editing/ui/interop/use_watchable.js";
import { layerKindOf } from "#src/editing/ui/layer_kind.js";
import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import "#src/editing/ui/tool_settings/z_extrapolation.css";

type Props = { session: EditSession; host: EditSessionHost };

export function ZExtrapolation({ host }: Props) {
  // The tools are (re)built asynchronously after `openSession`; re-read on the
  // signal so the panel picks up `host.zExtrapolation` once it exists.
  useEvent(useCallback((h: () => void) => host.toolingChanged.add(h), [host]));
  const tool = host.zExtrapolation;
  if (tool === undefined) {
    return (
      <div class="neuroglancer-tool-panel neuroglancer-z-extrapolation-panel">
        <p class="neuroglancer-tool-panel-placeholder">Preparing…</p>
      </div>
    );
  }
  return <ZExtrapolationBody tool={tool} host={host} />;
}

function ZExtrapolationBody({
  tool,
  host,
}: {
  tool: ZExtrapolationTool;
  host: EditSessionHost;
}) {
  useEvent(useCallback((h: () => void) => tool.changed.add(h), [tool]));
  useWatchable(host.state.value);
  const backendAvailable = useWatchable(host.backendAvailable);
  const backendAuthExpired = useWatchable(host.backendAuthExpired);

  const layerManager = host.viewer.layerManager;
  const intent = host.state.value.value;
  const state = tool.getState();

  const imageLayers: LayerId[] =
    intent === null
      ? []
      : intent.layers
          .filter(
            (l) =>
              layerKindOf(layerManager.getLayerByName(l.layerId)) === "image",
          )
          .map((l) => l.layerId);
  const maskLayers: LayerId[] =
    intent === null
      ? []
      : intent.layers
          .filter(
            (l) =>
              l.writable &&
              layerKindOf(layerManager.getLayerByName(l.layerId)) ===
                "segmentation",
          )
          .map((l) => l.layerId);

  // Default the pickers to the first candidate of each kind (idempotent).
  const firstImage = imageLayers[0];
  const firstMask = maskLayers[0];
  useEffect(() => {
    if (state.maskLayerId === undefined && firstMask !== undefined) {
      tool.setMaskLayer(firstMask);
    }
    if (state.imageLayerId === undefined && firstImage !== undefined) {
      tool.setImageLayer(firstImage);
    }
  }, [tool, state.maskLayerId, state.imageLayerId, firstMask, firstImage]);

  // Follow the viewport Z while unlocked.
  useEffect(() => {
    const position = host.viewer.position;
    tool.followViewportZ();
    return position.changed.add(() => tool.followViewportZ());
  }, [tool, host]);

  // Re-render when the mask layer's selection (the tracked set) changes.
  const maskLayerId = state.maskLayerId;
  useEvent(
    useCallback(
      (h: () => void) => {
        if (maskLayerId === undefined) return () => {};
        const layer = layerManager.getLayerByName(maskLayerId)?.layer as
          | SegmentationUserLayer
          | null
          | undefined;
        const selected =
          layer?.displayState.segmentationGroupState.value.selectedSegments;
        return selected ? selected.changed.add(() => h()) : () => {};
      },
      [maskLayerId, layerManager],
    ),
  );
  const trackedIds = tool.trackedSegments();

  // Backend reachability is host-level; every domain reason (layers, tracked
  // segments, current/next slice in region) comes from the tool so the button
  // and the action share one source of truth — a next slice outside the region
  // disables Run rather than erroring on click.
  const disabledReason = !backendAvailable
    ? "Backend is not available."
    : backendAuthExpired
      ? "Session expired — sign in again."
      : tool.runDisabledReason();
  const canRun = disabledReason === undefined && !state.isRunning;

  const onSelectChange = (set: (id: LayerId) => void) => (event: Event) => {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (value !== "") set(value as LayerId);
  };
  const onCurrentZInput = (event: Event) => {
    const value = (event.currentTarget as HTMLInputElement).value;
    if (value === "") return;
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) tool.setCurrentZ(Math.floor(n));
  };

  return (
    <div class="neuroglancer-tool-panel neuroglancer-z-extrapolation-panel">
      <div class="neuroglancer-tool-panel-row">
        <label>Segmentation</label>
        <select
          value={state.maskLayerId ?? ""}
          onChange={onSelectChange((id) => tool.setMaskLayer(id))}
        >
          <option value="">— Select —</option>
          {maskLayers.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </div>
      <div class="neuroglancer-tool-panel-row">
        <label>Image</label>
        <select
          value={state.imageLayerId ?? ""}
          onChange={onSelectChange((id) => tool.setImageLayer(id))}
        >
          <option value="">— Select —</option>
          {imageLayers.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </div>

      <div class="neuroglancer-tool-panel-row">
        <label>Direction</label>
        <select
          value={state.direction}
          onChange={(e) =>
            tool.setDirection(
              (e.currentTarget as HTMLSelectElement).value === "backward"
                ? "backward"
                : "forward",
            )
          }
        >
          <option value="forward">Forward (+Z)</option>
          <option value="backward">Backward (−Z)</option>
        </select>
      </div>

      <div class="neuroglancer-tool-panel-row">
        <label>Current Z</label>
        <input
          type="number"
          min={0}
          step={1}
          value={state.currentZ ?? ""}
          onChange={onCurrentZInput}
        />
        <button
          type="button"
          class="neuroglancer-z-extrapolation-lock"
          aria-pressed={state.isCurrentZLocked ? "true" : "false"}
          data-tooltip={
            state.isCurrentZLocked
              ? "Locked — click to follow the viewport"
              : "Following viewport — click to lock"
          }
          onClick={() => tool.toggleLock()}
        >
          {state.isCurrentZLocked ? "Locked" : "Follow"}
        </button>
      </div>

      <div class="neuroglancer-z-extrapolation-tracked">
        <div class="neuroglancer-z-extrapolation-tracked-head">
          <span>Tracking {trackedIds.length}</span>
          <button
            type="button"
            disabled={state.maskLayerId === undefined}
            onClick={() => void tool.autoDetectTrackedSegments()}
          >
            Auto-detect (Z)
          </button>
        </div>
        {trackedIds.length === 0 ? (
          <div class="neuroglancer-z-extrapolation-tracked-empty">
            No segments tracked yet.
          </div>
        ) : (
          <ul class="neuroglancer-z-extrapolation-tracked-list">
            {trackedIds.map((id) => (
              <li key={String(id)}>{String(id)}</li>
            ))}
          </ul>
        )}
      </div>

      <button
        type="button"
        class="neuroglancer-z-extrapolation-run"
        disabled={!canRun}
        data-tooltip={disabledReason}
        onClick={() => void tool.runNextSlice()}
      >
        {state.isRunning ? "Running…" : "Run next slice"}
      </button>
      {state.isRunning && (
        <button type="button" onClick={() => tool.cancel()}>
          Cancel
        </button>
      )}
      <button
        type="button"
        class="neuroglancer-z-extrapolation-reset"
        disabled={!state.hasLastRun || state.isRunning}
        data-tooltip="Undo the last propagation and return to the previous slice"
        onClick={() => void tool.resetLastRun()}
      >
        Reset
      </button>
    </div>
  );
}
