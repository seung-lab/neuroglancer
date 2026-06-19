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
  ChunkCoord,
  LayerId,
  OverlayCoord,
  Resolution,
} from "@zettaai/edit-session";

import type { VolumeChunkSource } from "#src/sliceview/volume/frontend.js";

/**
 * Pure coordinate / chunk-key helpers shared by `NgChunkSource` and
 * `SessionChunkPreloader`. Kept in their own module so the preloader can reuse
 * them without importing the adapter class (which imports the preloader),
 * avoiding a circular dependency.
 */

export interface CoordGroup {
  readonly layerId: LayerId;
  readonly resolution: Resolution;
  readonly coords: OverlayCoord[];
}

/**
 * Group flat `(layerId, resolution, chunkId)` coords by their `(layerId,
 * resolution)` pair so the volume chunk source is resolved once per group.
 */
export function groupByLayerAndResolution(
  coords: readonly OverlayCoord[],
): CoordGroup[] {
  const groups = new Map<string, CoordGroup>();
  for (const coord of coords) {
    const key = `${coord.layerId}|${coord.resolution}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        layerId: coord.layerId,
        resolution: coord.resolution,
        coords: [],
      };
      groups.set(key, group);
    }
    (group.coords as OverlayCoord[]).push(coord);
  }
  return Array.from(groups.values());
}

export function chunkKeyForSource(
  source: VolumeChunkSource,
  chunkCoord: ChunkCoord,
): string {
  const grid = makeChunkGridPosition(source, chunkCoord);
  return grid.join();
}

export function makeChunkGridPosition(
  source: VolumeChunkSource,
  chunkCoord: ChunkCoord,
): Float32Array {
  const rank = source.spec.rank;
  const grid = new Float32Array(rank);
  grid[0] = chunkCoord.x;
  if (rank > 1) grid[1] = chunkCoord.y;
  if (rank > 2) grid[2] = chunkCoord.z;
  // Any extra dimensions (e.g. channel) stay at 0; the library's ChunkCoord
  // is 3D and assumes per-channel chunks are not addressed separately.
  return grid;
}
