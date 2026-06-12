/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { ImageUserLayer } from "#src/layer/image/index.js";
import type { ManagedUserLayer } from "#src/layer/index.js";
import { SegmentationUserLayer } from "#src/layer/segmentation/index.js";

export type LayerKind = "image" | "segmentation";

export function layerKindOf(
  managed: ManagedUserLayer | undefined,
): LayerKind | undefined {
  if (managed === undefined) return undefined;
  const userLayer = managed.layer;
  if (userLayer instanceof SegmentationUserLayer) return "segmentation";
  if (userLayer instanceof ImageUserLayer) return "image";
  return undefined;
}

/**
 * Data source schemes that cannot participate in an edit session as
 * Reference or Editable layers (TM-312). Layers backed by these sources
 * may only be Off.
 */
export type BlockedScheme = "calcada" | "graphene";

const BLOCKED_SCHEMES: readonly BlockedScheme[] = ["calcada", "graphene"];

/**
 * Returns the blocked data source scheme backing `managed`, if any. Reads
 * the data source spec URLs, which are available synchronously (no need to
 * wait for the sources to load).
 */
export function blockedSchemeOf(
  managed: ManagedUserLayer | undefined,
): BlockedScheme | undefined {
  const userLayer = managed?.layer;
  if (userLayer == null) return undefined;
  for (const dataSource of userLayer.dataSources) {
    const url = dataSource.spec.url;
    for (const scheme of BLOCKED_SCHEMES) {
      if (url.startsWith(`${scheme}://`)) return scheme;
    }
  }
  return undefined;
}
