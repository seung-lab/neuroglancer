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
 * @file Bridge between the host's per-layer "allowed resolutions" watchable
 * (set during an edit session) and the SliceView render layer's
 * `allowedSourcePredicate` option.
 *
 * The host stores the user-selected resolution set as `Resolution` branded
 * strings (the same identity emitted by `NgLayerMetadataSource`). The
 * SliceView render layer however filters by a per-source predicate — it has
 * no awareness of the edit-session library. This helper converts one to the
 * other by deriving each scale source's voxel size in nm and comparing to
 * the canonicalized `Resolution.from(voxelSizeNm)` of every allowed entry.
 */

import type { Resolution } from "@zetta-ai/edit-session";
import { Resolution as ResolutionFactory } from "@zetta-ai/edit-session";

import type { TopLevelLayerListSpecification } from "#src/layer/index.js";
import type { LoadedLayerDataSource } from "#src/layer/layer_data_source.js";
import type {
  SliceViewChunkSource,
  SliceViewSingleResolutionSource,
} from "#src/sliceview/frontend.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { makeCachedDerivedWatchableValue } from "#src/trackable_value.js";

type AllowedPredicate =
  | ((source: SliceViewSingleResolutionSource<SliceViewChunkSource>) => boolean)
  | undefined;

interface AllowedHost {
  getAllowedResolutionsWatchableForLayer(
    layerName: string,
  ): WatchableValueInterface<ReadonlySet<Resolution> | undefined>;
}

/**
 * Returns an optional watchable that holds an "allowed source" predicate.
 *
 * Lifetimes: the returned watchable is owned by the caller; the underlying
 * host watchable persists across sessions. Pass the result into
 * `SliceViewRenderLayerOptions.allowedSourcePredicate`.
 *
 * Returns `undefined` when no `editSessionHost` is wired on the layer
 * manager (test viewers, alternative embeddings). The SliceView base then
 * compiles down to no filtering.
 */
export function getAllowedSourcePredicateForLayer(
  root: TopLevelLayerListSpecification,
  layerName: string,
  loadedDataSource: LoadedLayerDataSource,
): WatchableValueInterface<AllowedPredicate> | undefined {
  const host = (root as { editSessionHost?: AllowedHost }).editSessionHost;
  if (host === undefined) return undefined;
  const watchable = host.getAllowedResolutionsWatchableForLayer(layerName);
  const modelResolutionNm = extractModelResolutionNm(loadedDataSource);
  return makeCachedDerivedWatchableValue(
    (allowed) => {
      if (allowed === undefined) return undefined;
      return (source) =>
        allowed.has(resolutionForSource(source, modelResolutionNm));
    },
    [watchable],
  );
}

function resolutionForSource(
  source: SliceViewSingleResolutionSource<SliceViewChunkSource>,
  modelResolutionNm: readonly [number, number, number],
): Resolution {
  const transform = source.chunkToMultiscaleTransform;
  const rank = source.chunkSource.spec.rank;
  const stride = rank + 1;
  const voxelSizeNm: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; ++i) {
    const relativeScale = transform[stride * i + i] || 1;
    voxelSizeNm[i] = modelResolutionNm[i] * relativeScale;
  }
  return ResolutionFactory.from(voxelSizeNm);
}

function extractModelResolutionNm(
  loadState: LoadedLayerDataSource,
): readonly [number, number, number] {
  const { scales, units } =
    loadState.dataSource.modelTransform.outputSpace;
  const result: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3 && i < scales.length; ++i) {
    const scale = scales[i];
    const unit = units[i];
    result[i] = unit === "m" ? scale * 1e9 : scale;
  }
  return result;
}
