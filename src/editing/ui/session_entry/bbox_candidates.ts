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
  Annotation,
  AxisAlignedBoundingBox,
} from "#src/annotation/index.js";
import { AnnotationType } from "#src/annotation/index.js";
import { AnnotationUserLayer } from "#src/layer/annotation/index.js";
import type { LayerManager, ManagedUserLayer } from "#src/layer/index.js";
import { RefCounted } from "#src/util/disposable.js";
import { NullarySignal } from "#src/util/signal.js";

export interface BboxAnnotationSelection {
  readonly annotationLayerName: string;
  readonly annotationId: string;
  readonly voxelBbox: readonly [number, number, number, number, number, number];
  /**
   * Physical size of one voxel of `voxelBbox`, in nanometers, derived from
   * the annotation source's `modelTransform.outputSpace` at selection time.
   * Bound to the bbox so the session's clip region is always in the
   * annotation's own coord system, regardless of which resolutions any
   * other session layer ends up exposing.
   */
  readonly voxelSizeNm: readonly [number, number, number];
}

export interface BboxEntry {
  readonly key: string;
  readonly annotationLayerName: string;
  readonly annotation: AxisAlignedBoundingBox;
  readonly voxelBbox: readonly [number, number, number, number, number, number];
  readonly voxelSizeNm: readonly [number, number, number];
  readonly sizeLabel: string;
}

export class BboxSelectionModel extends RefCounted {
  readonly entriesChanged = new NullarySignal();
  readonly selectionChanged = new NullarySignal();

  private entries_: BboxEntry[] = [];
  private selectedKey_: string | undefined;
  private readonly perLayerDisposers = new Map<ManagedUserLayer, () => void>();

  constructor(private readonly layerManager: LayerManager) {
    super();
    this.registerDisposer(
      layerManager.layersChanged.add(this.refreshSubscriptions),
    );
    this.registerDisposer(() => {
      for (const remove of this.perLayerDisposers.values()) {
        remove();
      }
      this.perLayerDisposers.clear();
    });
    this.refreshSubscriptions();
  }

  get entries(): readonly BboxEntry[] {
    return this.entries_;
  }

  get selectedKey(): string | undefined {
    return this.selectedKey_;
  }

  get selection(): BboxAnnotationSelection | undefined {
    if (this.selectedKey_ === undefined) return undefined;
    const entry = this.entries_.find((e) => e.key === this.selectedKey_);
    if (entry === undefined) return undefined;
    return {
      annotationLayerName: entry.annotationLayerName,
      annotationId: entry.annotation.id,
      voxelBbox: entry.voxelBbox,
      voxelSizeNm: entry.voxelSizeNm,
    };
  }

  select(key: string | undefined): void {
    if (key === this.selectedKey_) return;
    this.selectedKey_ = key;
    this.selectionChanged.dispatch();
  }

  hasBboxAnnotation(): boolean {
    return this.entries_.length > 0;
  }

  private readonly refreshSubscriptions = () => {
    const seen = new Set<ManagedUserLayer>();
    for (const managed of this.layerManager.managedLayers) {
      if (managed.layer instanceof AnnotationUserLayer) {
        seen.add(managed);
        if (!this.perLayerDisposers.has(managed)) {
          const removers: Array<() => void> = [];
          removers.push(managed.layerChanged.add(this.refreshSubscriptions));
          const { localAnnotations } = managed.layer;
          if (localAnnotations !== undefined) {
            removers.push(localAnnotations.changed.add(this.rebuild));
          }
          this.perLayerDisposers.set(managed, () => {
            for (const r of removers) r();
          });
        }
      }
    }
    for (const [managed, remove] of this.perLayerDisposers) {
      if (!seen.has(managed)) {
        remove();
        this.perLayerDisposers.delete(managed);
      }
    }
    this.rebuild();
  };

  private readonly rebuild = () => {
    const next: BboxEntry[] = [];
    for (const managed of this.layerManager.managedLayers) {
      const userLayer = managed.layer;
      if (!(userLayer instanceof AnnotationUserLayer)) continue;
      const source = userLayer.localAnnotations;
      if (source === undefined) continue;
      const voxelSizeNm = extractAnnotationVoxelSizeNm(userLayer);
      if (voxelSizeNm === undefined) continue;
      for (const annotation of source as Iterable<Annotation>) {
        if (annotation.type !== AnnotationType.AXIS_ALIGNED_BOUNDING_BOX) {
          continue;
        }
        const bbox = annotation as AxisAlignedBoundingBox;
        const voxelBbox = computeVoxelBbox(bbox);
        next.push({
          key: `${managed.name} ${bbox.id}`,
          annotationLayerName: managed.name,
          annotation: bbox,
          voxelBbox,
          voxelSizeNm,
          sizeLabel: formatSize(voxelBbox),
        });
      }
    }

    const prevSelection = this.selectedKey_;
    this.entries_ = next;
    this.entriesChanged.dispatch();

    if (next.length === 0) {
      if (this.selectedKey_ !== undefined) {
        this.selectedKey_ = undefined;
        this.selectionChanged.dispatch();
      }
      return;
    }

    let nextKey: string;
    if (
      prevSelection !== undefined &&
      next.some((e) => e.key === prevSelection)
    ) {
      nextKey = prevSelection;
    } else {
      nextKey = next[next.length - 1].key;
    }
    if (nextKey !== this.selectedKey_) {
      this.selectedKey_ = nextKey;
      this.selectionChanged.dispatch();
    }
  };
}

/**
 * Pulls the first 3 INPUT-space scales of the annotation layer's loaded data
 * source and converts them to nm. The scales are stored in meters (the
 * standard neuroglancer convention); anything else falls through unchanged.
 * Returns `undefined` when no data source has loaded yet — caller skips the
 * layer until the load completes.
 *
 * TM-298: this reads `inputSpace` (the annotation source's own/native grid),
 * NOT `outputSpace`. An AxisAlignedBoundingBox's `pointA`/`pointB` are stored
 * in the source's input coordinates, so `voxelBbox` and the resolution that
 * scales it must come from the SAME space. `outputSpace` is the transform's
 * reconciliation with the viewer's global "dimensions": when the user relabels
 * global (e.g. native 16 nm shown as 256 nm) `outputSpace` follows to 256 nm
 * while the stored points stay in the 16 nm input grid. Pairing 16 nm points
 * with a 256 nm resolution makes the library map the session region 16× off
 * the target data — it clips to empty, so no chunks load and painting is
 * silently dropped. `inputSpace` stays at the native scale regardless of
 * global relabeling, keeping `voxelBbox × resolution` a stable physical region.
 */
function extractAnnotationVoxelSizeNm(
  userLayer: AnnotationUserLayer,
): readonly [number, number, number] | undefined {
  for (const layerDataSource of userLayer.dataSources) {
    const loadState = layerDataSource.loadState;
    if (loadState === undefined) continue;
    if ("error" in loadState && loadState.error !== undefined) continue;
    const inputSpace = loadState.transform.value.inputSpace;
    const { scales, units } = inputSpace;
    if (scales.length < 3) continue;
    const out: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < 3; ++i) {
      const scale = scales[i];
      const unit = units[i];
      out[i] = unit === "m" ? scale * 1e9 : scale;
    }
    return out;
  }
  return undefined;
}

function computeVoxelBbox(
  bbox: AxisAlignedBoundingBox,
): readonly [number, number, number, number, number, number] {
  const a = bbox.pointA;
  const b = bbox.pointB;
  return [
    Math.min(Number(a[0]) || 0, Number(b[0]) || 0),
    Math.min(Number(a[1]) || 0, Number(b[1]) || 0),
    Math.min(Number(a[2]) || 0, Number(b[2]) || 0),
    Math.max(Number(a[0]) || 0, Number(b[0]) || 0),
    Math.max(Number(a[1]) || 0, Number(b[1]) || 0),
    Math.max(Number(a[2]) || 0, Number(b[2]) || 0),
  ];
}

function formatSize(
  bbox: readonly [number, number, number, number, number, number],
): string {
  return `${Math.round(bbox[3] - bbox[0])}×${Math.round(bbox[4] - bbox[1])}×${Math.round(bbox[5] - bbox[2])}`;
}
