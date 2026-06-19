/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { EditSession } from "@zettaai/edit-session";
import { useEffect, useMemo, useState } from "preact/hooks";

import {
  ChunkMemoryStatistics,
  numChunkMemoryStatistics,
} from "#src/chunk_manager/base.js";
import type { ChunkQueueManager } from "#src/chunk_manager/frontend.js";
import type {
  EditSessionHost,
  EditSessionIntent,
} from "#src/editing/edit_session_host.js";
import { useWatchable } from "#src/editing/ui/interop/use_watchable.js";
import { layerKindOf } from "#src/editing/ui/layer_kind.js";
import type { LayerRowState } from "#src/editing/ui/session_entry/layer_row.js";
import { LayerRow } from "#src/editing/ui/session_entry/layer_row.js";
import {
  formatBytes,
  MemoryMeter,
} from "#src/editing/ui/session_entry/memory_estimate.js";
// The summary reuses the entry modal's layer-row, role-control and memory-meter
// markup, so it depends on the same stylesheet for those classes.
import "#src/editing/ui/session_entry/session_entry.css";
import "#src/editing/ui/tool_settings/navigation_summary.css";

/**
 * Read-only recap of the active edit session's configuration (TM-338), shown
 * in the navigation tool's side panel. Its real job is structural: keeping a
 * panel mounted on the left while the navigation tool is active so switching
 * between a paint tool and navigation no longer collapses the left column and
 * jolts the field of view. The content recaps what the user chose in the
 * Enter-Edit-Session modal — region, layers (writable vs locked), per-layer
 * resolution — plus a memory readout against the live GPU/system budget.
 */
export function NavigationSummary({
  host,
}: {
  session: EditSession;
  host: EditSessionHost;
}) {
  useWatchable(host.state.value);
  const intent = host.state.value.value;
  if (intent === null) {
    return (
      <div class="neuroglancer-tool-panel-host-placeholder">
        No active edit session.
      </div>
    );
  }
  return <SummaryBody host={host} intent={intent} />;
}

function SummaryBody({
  host,
  intent,
}: {
  host: EditSessionHost;
  intent: EditSessionIntent;
}) {
  const layerManager = host.viewer.layerManager;

  // Each session layer is locked in memory (reference) or writable (editable);
  // a layer is never "off" inside an open session. Build the read-only row
  // state the modal's `LayerRow` expects.
  const layerStates = useMemo(() => {
    const map = new Map<string, LayerRowState>();
    for (const l of intent.layers) {
      map.set(l.layerId, {
        role: l.writable ? "editable" : "reference",
        resolutions: l.resolutions,
        loadState: "loaded",
        loadError: undefined,
        availableResolutions: l.resolutions,
      });
    }
    return map;
  }, [intent]);

  return (
    <div class="neuroglancer-tool-panel neuroglancer-navigation-summary-panel">
      <RegionSection region={intent.region} />
      <div class="neuroglancer-edit-session-entry-modal-section-title">
        Layers
      </div>
      <div class="neuroglancer-edit-session-entry-modal-layers-list">
        {intent.layers.map((l) => {
          const state = layerStates.get(l.layerId)!;
          const kind = layerKindOf(layerManager.getLayerByName(l.layerId));
          return (
            <LayerRow
              key={l.layerId}
              name={l.layerId}
              layerKind={kind ?? "segmentation"}
              blockedScheme={undefined}
              state={state}
              resolutionModel={undefined}
              onRoleChange={NO_OP}
              readOnly
            />
          );
        })}
      </div>
      <MemorySection host={host} />
    </div>
  );
}

function RegionSection({ region }: { region: EditSessionIntent["region"] }) {
  const extent: [number, number, number] = [
    Math.round(region.hi[0] - region.lo[0]),
    Math.round(region.hi[1] - region.lo[1]),
    Math.round(region.hi[2] - region.lo[2]),
  ];
  // `dimensions` is insertion-ordered x/y/z, each `[scaleMetres, unit]`.
  const scales = Object.values(region.dimensions).map(([s]) => s);
  const physical =
    scales.length >= 3
      ? `${formatLength(extent[0] * scales[0])} × ` +
        `${formatLength(extent[1] * scales[1])} × ` +
        `${formatLength(extent[2] * scales[2])}`
      : undefined;

  return (
    <>
      <div class="neuroglancer-edit-session-entry-modal-section-title">
        Edit region
      </div>
      <div class="neuroglancer-navigation-summary-region">
        <div class="neuroglancer-navigation-summary-region-voxels">
          {extent[0]} × {extent[1]} × {extent[2]} voxels
        </div>
        {physical !== undefined && (
          <div class="neuroglancer-navigation-summary-region-physical">
            {physical}
          </div>
        )}
      </div>
    </>
  );
}

function MemorySection({ host }: { host: EditSessionHost }) {
  const queueManager = host.viewer.chunkManager.chunkQueueManager;
  const capacities = queueManager.capacities;
  // Live GPU/system budgets — the limits are watchable, so the meter reacts if
  // they change.
  const gpuLimit = useWatchable(capacities.gpuMemory.sizeLimit);
  const systemLimit = useWatchable(capacities.systemMemory.sizeLimit);
  // Actual resident bytes, polled from the worker's per-chunk statistics.
  const usage = useChunkMemoryUsage(queueManager);

  const gpuUsed = usage?.gpu ?? 0;
  const detail =
    usage === null
      ? "measuring…"
      : `${formatBytes(gpuUsed)} / ${formatBytes(gpuLimit)} GPU · ` +
        `${formatBytes(usage.system)} / ${formatBytes(systemLimit)} system`;

  return (
    <MemoryMeter
      usedBytes={gpuUsed}
      gpuLimit={gpuLimit}
      summary="Memory in use"
      detail={detail}
    />
  );
}

interface ChunkMemoryUsage {
  readonly gpu: number;
  readonly system: number;
}

// Statistics are a worker round-trip; the built-in statistics panel polls at
// the same cadence.
const USAGE_POLL_INTERVAL_MS = 1000;

/**
 * Poll the chunk queue's actual resident memory (GPU + system bytes), summed
 * across every chunk source and state, while the panel is mounted. Returns
 * `null` until the first sample lands. This is the real consumed memory the
 * worker reports — the same statistics the built-in statistics panel reads —
 * not an estimate.
 */
function useChunkMemoryUsage(
  queueManager: ChunkQueueManager,
): ChunkMemoryUsage | null {
  const [usage, setUsage] = useState<ChunkMemoryUsage | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const poll = () => {
      void queueManager
        .getStatistics()
        .then((data) => {
          if (cancelled) return;
          let gpu = 0;
          let system = 0;
          for (const stats of data.values()) {
            for (
              let base = 0;
              base + numChunkMemoryStatistics <= stats.length;
              base += numChunkMemoryStatistics
            ) {
              system += stats[base + ChunkMemoryStatistics.systemMemoryBytes];
              gpu += stats[base + ChunkMemoryStatistics.gpuMemoryBytes];
            }
          }
          setUsage({ gpu, system });
        })
        .catch(() => {
          // Ignore a failed sample; the next tick retries.
        })
        .finally(() => {
          if (!cancelled)
            timer = window.setTimeout(poll, USAGE_POLL_INTERVAL_MS);
        });
    };
    poll();
    return () => {
      cancelled = true;
      if (timer !== 0) window.clearTimeout(timer);
    };
  }, [queueManager]);
  return usage;
}

const NO_OP = () => {};

/** Format a length in metres into nm / µm / mm / m with a compact precision. */
function formatLength(metres: number): string {
  if (!Number.isFinite(metres)) return "—";
  const nm = metres * 1e9;
  if (nm < 1000) return `${round(nm)} nm`;
  const um = nm / 1000;
  if (um < 1000) return `${round(um)} µm`;
  const mm = um / 1000;
  if (mm < 1000) return `${round(mm)} mm`;
  return `${round(mm / 1000)} m`;
}

function round(value: number): string {
  return value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2);
}
