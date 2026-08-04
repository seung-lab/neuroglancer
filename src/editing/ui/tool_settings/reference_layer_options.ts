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
 * @file Enumerates the image layers the brush's reference mask can sample and
 * resolves them into picker entries. A stroke may mask against the session's
 * own image ("reference") layers AND any other loaded image layer the user left
 * "off" on entry — the chunk-read path (`readChunkAt` → `resolveVolumeChunkSource`)
 * resolves any layer by name, so this only decides what the picker offers. Pure
 * (no Preact) so the enumeration and the uint64-disabled rule can be unit tested.
 */

import type { LayerId, LayerMetadata, Resolution } from "@zettaai/edit-session";
import {
  availableResolutions,
  layerId as toLayerId,
} from "@zettaai/edit-session";

import { blockedSchemeOf, layerKindOf } from "#src/editing/ui/layer_kind.js";
import type { LayerManager } from "#src/layer/index.js";

/** Shared copy for the one reason a reference layer is shown-but-unpickable. */
export const UINT64_REFERENCE_DISABLED =
  "uint64 layers can't be used as a reference image.";

/**
 * An image layer that could back the mask, before its metadata resolves.
 * Session layers ("reference" role) carry the resolutions the session pinned;
 * external ones (loaded image layers left "off" on entry) derive their
 * resolutions from metadata once it loads.
 */
export interface ReferenceCandidate {
  readonly layerId: LayerId;
  readonly origin: "session" | "external";
  readonly sessionResolutions?: readonly Resolution[];
}

/** A resolved picker entry. `disabledReason` set => shown but unpickable. */
export interface ReferenceLayerEntry {
  readonly layerId: LayerId;
  readonly origin: "session" | "external";
  readonly resolutions: readonly Resolution[];
  readonly disabledReason?: string;
}

/**
 * Image layers eligible to mask a stroke: the session's own image layers plus
 * every other loaded, non-archived image layer whose data source is usable in a
 * session (blocked schemes and non-image layers excluded). External layers are
 * read on demand — they are not preloaded by the session (TM-317 follow-up).
 */
export function collectReferenceCandidates(
  sessionLayers: readonly {
    readonly layerId: LayerId;
    readonly resolutions: readonly Resolution[];
  }[],
  layerManager: LayerManager,
): ReferenceCandidate[] {
  const candidates: ReferenceCandidate[] = [];
  const sessionIds = new Set<string>();
  for (const layer of sessionLayers) {
    if (layerKindOf(layerManager.getLayerByName(layer.layerId)) !== "image") {
      continue;
    }
    sessionIds.add(layer.layerId);
    candidates.push({
      layerId: layer.layerId,
      origin: "session",
      sessionResolutions: layer.resolutions,
    });
  }
  for (const managed of layerManager.managedLayers) {
    if (managed.archived) continue;
    if (layerKindOf(managed) !== "image") continue;
    if (sessionIds.has(managed.name)) continue;
    if (blockedSchemeOf(managed) !== undefined) continue;
    candidates.push({ layerId: toLayerId(managed.name), origin: "external" });
  }
  return candidates;
}

/**
 * Resolve candidates into picker entries. External layers appear only once
 * their metadata loads (that is where their resolution list comes from); a
 * uint64 layer stays visible but is flagged unpickable rather than hidden.
 */
export function buildReferenceEntries(
  candidates: readonly ReferenceCandidate[],
  metadataByLayer: ReadonlyMap<string, LayerMetadata>,
): ReferenceLayerEntry[] {
  const entries: ReferenceLayerEntry[] = [];
  for (const candidate of candidates) {
    const metadata = metadataByLayer.get(candidate.layerId);
    let resolutions: readonly Resolution[];
    if (candidate.origin === "session") {
      resolutions = candidate.sessionResolutions ?? [];
    } else if (metadata !== undefined) {
      resolutions = availableResolutions(metadata);
    } else {
      continue;
    }
    const disabledReason =
      metadata?.voxelDataType === "uint64"
        ? UINT64_REFERENCE_DISABLED
        : undefined;
    entries.push({
      layerId: candidate.layerId,
      origin: candidate.origin,
      resolutions,
      disabledReason,
    });
  }
  return entries;
}

/**
 * The resolution to pin when a reference layer is first selected. Mask at the
 * editing resolution when the layer offers it — external layers expose their
 * full pyramid, so prefer the target's scale over the finest to avoid a cold
 * full-resolution read per stamp (TM-350). Falls back to the first listed.
 */
export function defaultReferenceResolution(
  entry: ReferenceLayerEntry,
  targetResolution: Resolution,
): Resolution {
  if (
    entry.origin === "external" &&
    entry.resolutions.includes(targetResolution)
  ) {
    return targetResolution;
  }
  return entry.resolutions[0];
}
