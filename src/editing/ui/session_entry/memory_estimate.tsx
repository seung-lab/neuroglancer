/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { LayerMetadata, VoxelDataType } from "@zettaai/edit-session";

import type { LayerRowState } from "#src/editing/ui/session_entry/layer_row.js";

/**
 * Region inputs the estimate needs: the voxel bounding box (`[loX, loY, loZ,
 * hiX, hiY, hiZ]`) and the region's per-axis scales in SI metres. Structural
 * so both the entry modal's `BboxAnnotationSelection` and the navigation
 * summary's region (rebuilt from the session intent) satisfy it.
 */
interface MemoryRegion {
  readonly voxelBbox: ArrayLike<number>;
  readonly regionSpace: { readonly scales: ArrayLike<number> };
}

// Amber zone starts at 80% of the GPU budget. Tunable: a single threshold
// keeps the meter behavior predictable and easy to reason about.
const MEMORY_NEAR_FRACTION = 0.8;

// ---------------------------------------------------------------------------
// Memory meter
// ---------------------------------------------------------------------------

export type MemorySignal = "safe" | "near" | "over";

export const MEMORY_SIGNAL_LABEL: Record<MemorySignal, string> = {
  safe: "within limits",
  near: "near GPU budget",
  over: "over budget",
};

export function memorySignalOf(
  usedBytes: number,
  gpuLimit: number,
): MemorySignal {
  if (!Number.isFinite(gpuLimit) || gpuLimit <= 0) return "safe";
  if (usedBytes > gpuLimit) return "over";
  if (usedBytes >= gpuLimit * MEMORY_NEAR_FRACTION) return "near";
  return "safe";
}

/**
 * Single-bar memory meter. The bar fills against the GPU budget and turns
 * amber/red as `usedBytes` nears/exceeds it. `summary` (header) and `detail`
 * (bottom line) are caller-built so the same meter serves the entry modal
 * (estimated footprint) and the navigation summary (actual live usage).
 */
export function MemoryMeter({
  usedBytes,
  gpuLimit,
  summary,
  detail,
}: {
  usedBytes: number;
  gpuLimit: number;
  summary: string;
  detail: string;
}) {
  const signal = memorySignalOf(usedBytes, gpuLimit);
  const fraction =
    Number.isFinite(gpuLimit) && gpuLimit > 0
      ? Math.min(1, usedBytes / gpuLimit)
      : 0;

  const meterClass = [
    "neuroglancer-edit-session-entry-modal-memory-meter",
    `neuroglancer-edit-session-entry-modal-memory-meter-${signal}`,
  ].join(" ");

  return (
    <div class={meterClass}>
      <div class="neuroglancer-edit-session-entry-modal-memory-meter-header">
        <span class="neuroglancer-edit-session-entry-modal-memory-meter-summary">
          {summary}
        </span>
        <span class="neuroglancer-edit-session-entry-modal-memory-meter-label">
          <span
            class="neuroglancer-edit-session-entry-modal-memory-meter-dot"
            aria-hidden="true"
          />
          {MEMORY_SIGNAL_LABEL[signal]}
        </span>
      </div>
      <div class="neuroglancer-edit-session-entry-modal-memory-meter-bar">
        <div
          class="neuroglancer-edit-session-entry-modal-memory-meter-fill"
          style={{ transform: `scaleX(${fraction})` }}
        />
      </div>
      <div class="neuroglancer-edit-session-entry-modal-memory-meter-budgets">
        {detail}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Memory estimate
// ---------------------------------------------------------------------------

export interface MemoryEstimate {
  readonly totalBytes: number;
}

/**
 * Estimate the bytes a session holds resident by locking `bbox` across the
 * selected resolutions of each non-`off` layer. `layerEntries` only needs to
 * carry each layer's `name` (the key into `layerStates`/`metadataByLayer`) —
 * the modal passes its richer `LayerEntry` and the navigation summary passes
 * the session's locked layers; both satisfy the structural `{ name }` shape.
 */
export function estimateLockedMemory({
  layerEntries,
  layerStates,
  metadataByLayer,
  bbox,
}: {
  layerEntries: readonly { readonly name: string }[];
  layerStates: ReadonlyMap<string, LayerRowState>;
  metadataByLayer: ReadonlyMap<string, LayerMetadata>;
  bbox: MemoryRegion | undefined;
}): MemoryEstimate {
  if (bbox === undefined) return { totalBytes: 0 };
  const bboxExtentVoxels: [number, number, number] = [
    bbox.voxelBbox[3] - bbox.voxelBbox[0],
    bbox.voxelBbox[4] - bbox.voxelBbox[1],
    bbox.voxelBbox[5] - bbox.voxelBbox[2],
  ];
  let total = 0;
  for (const entry of layerEntries) {
    const state = layerStates.get(entry.name);
    if (state === undefined) continue;
    // Off layers do NOT count toward the session memory budget — they fall
    // back to base Neuroglancer LRU.
    if (state.role === "off") continue;
    const metadata = metadataByLayer.get(entry.name);
    if (metadata === undefined) continue;
    const bytesPerVoxel = bytesPerVoxelFor(metadata.voxelDataType);
    if (bytesPerVoxel === 0) continue;
    const channels = Math.max(1, metadata.channels);
    for (const resolution of state.resolutions) {
      const scale = metadata.scales.find((s) => s.resolution === resolution);
      if (scale === undefined) continue;
      // `regionSpace.scales` are in SI metres; ×1e9 → nm.
      const extentNm: [number, number, number] = [
        bboxExtentVoxels[0] * bbox.regionSpace.scales[0] * 1e9,
        bboxExtentVoxels[1] * bbox.regionSpace.scales[1] * 1e9,
        bboxExtentVoxels[2] * bbox.regionSpace.scales[2] * 1e9,
      ];
      const extentLayerVoxels: [number, number, number] = [
        extentNm[0] / scale.voxelSizeNm[0],
        extentNm[1] / scale.voxelSizeNm[1],
        extentNm[2] / scale.voxelSizeNm[2],
      ];
      const chunksX = Math.max(
        1,
        Math.ceil(extentLayerVoxels[0] / scale.chunkDataSize[0]),
      );
      const chunksY = Math.max(
        1,
        Math.ceil(extentLayerVoxels[1] / scale.chunkDataSize[1]),
      );
      const chunksZ = Math.max(
        1,
        Math.ceil(extentLayerVoxels[2] / scale.chunkDataSize[2]),
      );
      const chunkVoxels =
        scale.chunkDataSize[0] *
        scale.chunkDataSize[1] *
        scale.chunkDataSize[2];
      total +=
        chunksX * chunksY * chunksZ * chunkVoxels * bytesPerVoxel * channels;
    }
  }
  return { totalBytes: total };
}

function bytesPerVoxelFor(dataType: VoxelDataType): number {
  switch (dataType) {
    case "uint8":
    case "int8":
      return 1;
    case "uint16":
    case "int16":
      return 2;
    case "uint32":
    case "int32":
    case "float32":
      return 4;
    case "uint64":
      return 8;
    default:
      return 0;
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "∞";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}
