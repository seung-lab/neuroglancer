/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type {
  EditSession,
  LayerId,
  PaintingTools,
  Resolution,
} from "@zettaai/edit-session";
import { layerId as toLayerId } from "@zettaai/edit-session";
import { useCallback } from "preact/hooks";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { useEvent } from "#src/editing/ui/interop/use_event.js";
import { useWatchable } from "#src/editing/ui/interop/use_watchable.js";

/**
 * In-session control letting the user switch the painting target layer and
 * the painting resolution. Sources its options from the host's session
 * intent (writable layers + their selected resolutions); on submit, calls
 * `painting.patchState`. When the user picks a layer whose resolution set
 * doesn't include the current `targetResolution`, the picker auto-snaps
 * to the new layer's first allowed resolution.
 */
export function PaintingTargetPicker({
  session,
  host,
}: {
  session: EditSession;
  host: EditSessionHost;
}) {
  useWatchable(host.state.value);
  const painting = session.tools.getTool<PaintingTools>("painting");
  const subscribe = useCallback(
    (h: () => void) => painting.on("changed", h),
    [painting],
  );
  useEvent(subscribe);

  const intent = host.state.value.value;
  const writable = intent === null
    ? []
    : intent.layers.filter((l) => l.writable);

  if (writable.length === 0) {
    return null;
  }

  const state = painting.getState();
  const currentLayer =
    writable.find((l) => l.layerId === state.targetLayerId) ?? writable[0];
  const layerResolutions = currentLayer.resolutions;
  const currentResolution = layerResolutions.includes(state.targetResolution)
    ? state.targetResolution
    : layerResolutions[0];

  const onLayerChange = (e: Event) => {
    const value = (e.currentTarget as HTMLSelectElement).value;
    const next = writable.find((l) => l.layerId === value);
    if (next === undefined) return;
    const nextResolution = next.resolutions.includes(state.targetResolution)
      ? state.targetResolution
      : next.resolutions[0];
    painting.patchState({
      targetLayerId: toLayerId(next.layerId),
      targetResolution: nextResolution,
    });
  };

  const onResolutionChange = (e: Event) => {
    const value = (e.currentTarget as HTMLSelectElement).value as Resolution;
    if (!layerResolutions.includes(value)) return;
    painting.patchState({ targetResolution: value });
  };

  return (
    <>
      <div class="neuroglancer-tool-panel-row">
        <label>Target layer</label>
        <select value={currentLayer.layerId} onChange={onLayerChange}>
          {writable.map((l: { layerId: LayerId }) => (
            <option key={l.layerId} value={l.layerId}>
              {l.layerId}
            </option>
          ))}
        </select>
      </div>
      <div class="neuroglancer-tool-panel-row">
        <label>Target resolution</label>
        {layerResolutions.length <= 1 ? (
          /* Static text for single-resolution layers (TM-294): a disabled
             dropdown reads as interactive-but-broken; a plain readout is
             clearer. */
          <span class="neuroglancer-tool-panel-resolution-static">
            {currentResolution}
          </span>
        ) : (
          <select value={currentResolution} onChange={onResolutionChange}>
            {layerResolutions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        )}
      </div>
    </>
  );
}
