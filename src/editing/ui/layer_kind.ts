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
 * Reference or Editable layers (TM-312, TM-374). Layers backed by these
 * sources may only be Off — this is a product restriction, not a technical
 * fault of the layer, which stays fully usable outside the session.
 */
export type BlockedScheme = "calcada" | "graphene" | "middleauth";

/**
 * URL-prefix test for each blocked scheme. `middleauth` layers carry a
 * `middleauth+<httpScheme>://` URL (the kvstore registers the scheme as
 * `middleauth+https`), so match the `middleauth+` prefix rather than a bare
 * `scheme://`.
 */
const BLOCKED_SCHEME_PREFIXES: ReadonlyArray<readonly [BlockedScheme, string]> =
  [
    ["calcada", "calcada://"],
    ["graphene", "graphene://"],
    ["middleauth", "middleauth+"],
  ];

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
    for (const [scheme, prefix] of BLOCKED_SCHEME_PREFIXES) {
      if (url.startsWith(prefix)) return scheme;
    }
  }
  return undefined;
}
