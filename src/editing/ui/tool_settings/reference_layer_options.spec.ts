/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { LayerMetadata, Resolution } from "@zettaai/edit-session";
import { Resolution as ResolutionValue, layerId } from "@zettaai/edit-session";
import { describe, expect, it, vi } from "vitest";

// Replace the real layer-kind helpers (which reach into heavy NG layer modules
// via `instanceof`) with field reads on our plain fake managed layers.
vi.mock("#src/editing/ui/layer_kind.js", () => ({
  layerKindOf: (managed: FakeManaged | undefined) => managed?.kind,
  blockedSchemeOf: (managed: FakeManaged | undefined) => managed?.blockedScheme,
}));

import {
  buildReferenceEntries,
  collectReferenceCandidates,
  defaultReferenceResolution,
  UINT64_REFERENCE_DISABLED,
  type ReferenceLayerEntry,
} from "#src/editing/ui/tool_settings/reference_layer_options.js";
import type { LayerManager } from "#src/layer/index.js";

interface FakeManaged {
  readonly name: string;
  readonly kind: "image" | "segmentation" | undefined;
  readonly archived: boolean;
  readonly blockedScheme?: string;
}

function managed(
  name: string,
  kind: FakeManaged["kind"],
  opts: { archived?: boolean; blockedScheme?: string } = {},
): FakeManaged {
  return {
    name,
    kind,
    archived: opts.archived ?? false,
    blockedScheme: opts.blockedScheme,
  };
}

function fakeLayerManager(managedLayers: FakeManaged[]): LayerManager {
  const byName = new Map(managedLayers.map((m) => [m.name, m]));
  return {
    managedLayers,
    getLayerByName: (name: string) => byName.get(name),
  } as unknown as LayerManager;
}

const RES_8 = ResolutionValue.from([8, 8, 40]);
const RES_16 = ResolutionValue.from([16, 16, 40]);

function metadata(
  voxelDataType: LayerMetadata["voxelDataType"],
  resolutions: readonly Resolution[],
): LayerMetadata {
  return {
    voxelDataType,
    scales: resolutions.map((resolution) => ({ resolution })),
  } as unknown as LayerMetadata;
}

describe("collectReferenceCandidates", () => {
  it("includes session image layers and skips session segmentation layers", () => {
    const lm = fakeLayerManager([
      managed("img", "image"),
      managed("seg", "segmentation"),
    ]);
    const candidates = collectReferenceCandidates(
      [
        { layerId: layerId("img"), resolutions: [RES_8] },
        { layerId: layerId("seg"), resolutions: [RES_8] },
      ],
      lm,
    );
    expect(candidates).toEqual([
      {
        layerId: layerId("img"),
        origin: "session",
        sessionResolutions: [RES_8],
      },
    ]);
  });

  it("adds loaded non-session image layers as external, deduped by name", () => {
    const lm = fakeLayerManager([
      managed("sessionImg", "image"),
      managed("offImg", "image"),
      managed("seg", "segmentation"),
    ]);
    const candidates = collectReferenceCandidates(
      [{ layerId: layerId("sessionImg"), resolutions: [RES_8] }],
      lm,
    );
    expect(candidates).toEqual([
      {
        layerId: layerId("sessionImg"),
        origin: "session",
        sessionResolutions: [RES_8],
      },
      { layerId: layerId("offImg"), origin: "external" },
    ]);
  });

  it("excludes archived, blocked-scheme, and non-image external layers", () => {
    const lm = fakeLayerManager([
      managed("archived", "image", { archived: true }),
      managed("graphene", "image", { blockedScheme: "graphene" }),
      managed("seg", "segmentation"),
      managed("ok", "image"),
    ]);
    const candidates = collectReferenceCandidates([], lm);
    expect(candidates).toEqual([
      { layerId: layerId("ok"), origin: "external" },
    ]);
  });
});

describe("buildReferenceEntries", () => {
  it("uses session-pinned resolutions and does not wait on metadata", () => {
    const entries = buildReferenceEntries(
      [
        {
          layerId: layerId("img"),
          origin: "session",
          sessionResolutions: [RES_8, RES_16],
        },
      ],
      new Map(),
    );
    expect(entries).toEqual([
      {
        layerId: layerId("img"),
        origin: "session",
        resolutions: [RES_8, RES_16],
        disabledReason: undefined,
      },
    ]);
  });

  it("skips external layers until their metadata resolves", () => {
    const entries = buildReferenceEntries(
      [{ layerId: layerId("off"), origin: "external" }],
      new Map(),
    );
    expect(entries).toEqual([]);
  });

  it("derives external resolutions from metadata scales", () => {
    const entries = buildReferenceEntries(
      [{ layerId: layerId("off"), origin: "external" }],
      new Map([[layerId("off"), metadata("uint8", [RES_8, RES_16])]]),
    );
    expect(entries[0].resolutions).toEqual([RES_8, RES_16]);
    expect(entries[0].disabledReason).toBeUndefined();
  });

  it("shows uint64 layers but flags them unpickable (session or external)", () => {
    const entries = buildReferenceEntries(
      [
        {
          layerId: layerId("s"),
          origin: "session",
          sessionResolutions: [RES_8],
        },
        { layerId: layerId("e"), origin: "external" },
      ],
      new Map([
        [layerId("s"), metadata("uint64", [RES_8])],
        [layerId("e"), metadata("uint64", [RES_8])],
      ]),
    );
    expect(entries.map((e) => e.disabledReason)).toEqual([
      UINT64_REFERENCE_DISABLED,
      UINT64_REFERENCE_DISABLED,
    ]);
  });
});

describe("defaultReferenceResolution", () => {
  const external = (
    resolutions: readonly Resolution[],
  ): ReferenceLayerEntry => ({
    layerId: layerId("e"),
    origin: "external",
    resolutions,
  });
  const session = (
    resolutions: readonly Resolution[],
  ): ReferenceLayerEntry => ({
    layerId: layerId("s"),
    origin: "session",
    resolutions,
  });

  it("prefers the editing resolution for an external layer that offers it", () => {
    expect(defaultReferenceResolution(external([RES_8, RES_16]), RES_16)).toBe(
      RES_16,
    );
  });

  it("falls back to the first scale when the external layer lacks the target", () => {
    expect(defaultReferenceResolution(external([RES_8]), RES_16)).toBe(RES_8);
  });

  it("always uses the first pinned scale for a session layer", () => {
    expect(defaultReferenceResolution(session([RES_8, RES_16]), RES_16)).toBe(
      RES_8,
    );
  });
});
