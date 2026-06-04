/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { LayerManager } from "#src/layer/index.js";

/**
 * Layer-shape descriptor used by `FakeLayerManager`. Only the fields read by
 * `NgSaveTarget.resolveDataSourceKind` need to be supplied.
 */
export interface FakeLayerDescriptor {
  readonly name: string;
  /**
   * URL string returned by the first loaded data source. Used to derive the
   * scheme (`calcada://...`, `precomputed://...`, etc.).
   */
  readonly canonicalUrl?: string;
  readonly specUrl?: string;
  /** If `true`, return a managed layer whose `.layer` is `null` (still loading). */
  readonly nullUserLayer?: boolean;
  /** If `true`, omit `loadState.dataSource.canonicalUrl` so the spec.url fallback fires. */
  readonly useSpecUrlFallback?: boolean;
}

/**
 * Minimal stand-in for `LayerManager` covering only `getLayerByName`. The
 * returned objects mimic the shape inspected by `NgSaveTarget` (see
 * `src/editing/adapters/ng_save_target.ts:137-167`).
 */
export class FakeLayerManager {
  private readonly layers = new Map<string, FakeLayerDescriptor>();

  constructor(layers: readonly FakeLayerDescriptor[]) {
    for (const l of layers) this.layers.set(l.name, l);
  }

  getLayerByName(name: string):
    | { layer: { dataSources: ReadonlyArray<unknown> } | null }
    | undefined {
    const descriptor = this.layers.get(name);
    if (descriptor === undefined) return undefined;
    if (descriptor.nullUserLayer === true) {
      return { layer: null };
    }
    const ds = buildDataSource(descriptor);
    return { layer: { dataSources: [ds] } };
  }

  /** Cast helper so callers can pass this into adapters typed against the
   * real `LayerManager`. The adapters only call `getLayerByName`. */
  asLayerManager(): LayerManager {
    return this as unknown as LayerManager;
  }
}

function buildDataSource(descriptor: FakeLayerDescriptor): unknown {
  const includeCanonical = descriptor.useSpecUrlFallback !== true;
  return {
    spec: descriptor.specUrl !== undefined ? { url: descriptor.specUrl } : undefined,
    loadState: {
      // `loadState.error` absent → the path-pickers treat this as loaded.
      dataSource: includeCanonical
        ? { canonicalUrl: descriptor.canonicalUrl }
        : undefined,
    },
  };
}
