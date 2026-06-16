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
import type { CoordinateSpace } from "#src/coordinate_transform.js";
import { makeCoordinateSpace } from "#src/coordinate_transform.js";
import { snapVoxelBbox } from "#src/editing/region/region_geometry.js";
import { AnnotationUserLayer } from "#src/layer/annotation/index.js";
import type { LayerManager, ManagedUserLayer } from "#src/layer/index.js";
import { RefCounted } from "#src/util/disposable.js";
import { NullarySignal } from "#src/util/signal.js";

export interface BboxAnnotationSelection {
  readonly annotationLayerName: string;
  readonly annotationId: string;
  readonly voxelBbox: readonly [number, number, number, number, number, number];
  /**
   * The physical frame `voxelBbox` is expressed in: the annotation source's
   * native `inputSpace` scales/units paired with the semantic `outputSpace`
   * names. The single source of truth for the session region's scale + names —
   * persisted via `coordinateSpaceToJson` and used to derive the runtime
   * `Resolution` (TM-299). Bound to the bbox so the clip region stays in the
   * annotation's own coord system regardless of other layers' resolutions.
   */
  readonly regionSpace: CoordinateSpace;
}

export interface BboxEntry {
  readonly key: string;
  readonly annotationLayerName: string;
  readonly annotation: AxisAlignedBoundingBox;
  readonly voxelBbox: readonly [number, number, number, number, number, number];
  readonly regionSpace: CoordinateSpace;
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
      regionSpace: entry.regionSpace,
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
      const regionSpace = extractAnnotationRegionSpace(userLayer);
      if (regionSpace === undefined) continue;
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
          regionSpace,
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
 * Builds the region's physical frame as a 3-dimensional `CoordinateSpace` from
 * the annotation layer's loaded data-source transform. Returns `undefined` when
 * no data source has loaded yet — caller skips the layer until then.
 *
 * Scales + units come from `inputSpace`, names from `outputSpace`:
 *
 * - **Scales/units — `inputSpace` (TM-298).** An AxisAlignedBoundingBox's
 *   `pointA`/`pointB` are stored in the source's INPUT coordinates, so the
 *   frame that scales `voxelBbox` must be the input grid. `outputSpace` is the
 *   transform's reconciliation with the viewer's global "dimensions": when the
 *   user relabels global (e.g. native 16 nm shown as 256 nm) `outputSpace`
 *   follows to 256 nm while the stored points stay in the 16 nm input grid.
 *   Pairing 16 nm points with a 256 nm frame maps the region 16× off the target
 *   data — it clips to empty and painting is silently dropped. `inputSpace`
 *   stays native regardless of relabeling, keeping the region stable.
 * - **Names — `outputSpace`.** `inputSpace` dimensions are often unnamed
 *   (`"0"/"1"/"2"`); the semantic axis names (`x/y/z`) live in `outputSpace`.
 *   Input dim `i` corresponds to output dim `i` for these axis-aligned sources
 *   (the transform is a diagonal scale, no axis permutation), so they pair by
 *   index.
 *
 * The result is serialized for persistence with `coordinateSpaceToJson`, so the
 * stored region frame is byte-identical to every other coordinate space in
 * ngState (TM-299).
 */
function extractAnnotationRegionSpace(
  userLayer: AnnotationUserLayer,
): CoordinateSpace | undefined {
  for (const layerDataSource of userLayer.dataSources) {
    const loadState = layerDataSource.loadState;
    if (loadState === undefined) continue;
    if ("error" in loadState && loadState.error !== undefined) continue;
    const { inputSpace, outputSpace } = loadState.transform.value;
    if (inputSpace.scales.length < 3 || outputSpace.names.length < 3) continue;
    return makeCoordinateSpace({
      names: [outputSpace.names[0], outputSpace.names[1], outputSpace.names[2]],
      units: [inputSpace.units[0], inputSpace.units[1], inputSpace.units[2]],
      scales: Float64Array.of(
        inputSpace.scales[0],
        inputSpace.scales[1],
        inputSpace.scales[2],
      ),
    });
  }
  return undefined;
}

function computeVoxelBbox(
  bbox: AxisAlignedBoundingBox,
): readonly [number, number, number, number, number, number] {
  const a = bbox.pointA;
  const b = bbox.pointB;
  // Snap to whole voxels: the native bbox tool stores unsnapped mouse positions
  // (plus a `+1` thickness bump on flat axes), so a single-slice box is half a
  // voxel off the grid and straddles two voxels. `snapVoxelBbox` collapses it
  // onto the drawn voxel so the region, its outline, the library clip, and the
  // entry teleport all agree. See `snapVoxelBbox`.
  return snapVoxelBbox([
    Math.min(Number(a[0]) || 0, Number(b[0]) || 0),
    Math.min(Number(a[1]) || 0, Number(b[1]) || 0),
    Math.min(Number(a[2]) || 0, Number(b[2]) || 0),
    Math.max(Number(a[0]) || 0, Number(b[0]) || 0),
    Math.max(Number(a[1]) || 0, Number(b[1]) || 0),
    Math.max(Number(a[2]) || 0, Number(b[2]) || 0),
  ]);
}

function formatSize(
  bbox: readonly [number, number, number, number, number, number],
): string {
  return `${Math.round(bbox[3] - bbox[0])}×${Math.round(bbox[4] - bbox[1])}×${Math.round(bbox[5] - bbox[2])}`;
}
