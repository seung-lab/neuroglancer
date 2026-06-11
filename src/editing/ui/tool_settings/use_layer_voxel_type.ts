/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { LayerId, VoxelDataType } from "@zettaai/edit-session";
import { useEffect, useState } from "preact/hooks";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";

/**
 * Resolve a layer's voxel data type via the host's metadata source.
 *
 * Returns `undefined` while the (async) lookup is pending or if it fails, so
 * callers can fall back to a type-agnostic default until the real type is
 * known. Re-resolves whenever `layerId` changes.
 */
export function useLayerVoxelType(
  host: EditSessionHost,
  layerId: LayerId,
): VoxelDataType | undefined {
  const [voxelDataType, setVoxelDataType] = useState<VoxelDataType | undefined>(
    undefined,
  );

  useEffect(() => {
    let cancelled = false;
    setVoxelDataType(undefined);
    void host.layerMetadataSource
      .resolve(layerId)
      .then((meta) => {
        if (!cancelled) setVoxelDataType(meta.voxelDataType);
      })
      .catch(() => {
        if (!cancelled) setVoxelDataType(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [host, layerId]);

  return voxelDataType;
}
