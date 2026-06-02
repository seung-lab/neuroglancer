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
