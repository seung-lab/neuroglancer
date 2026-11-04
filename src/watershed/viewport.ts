/**
 * @license
 * Copyright 2026 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { ManagedUserLayer } from "#src/layer/index.js";
import { PerspectivePanel } from "#src/perspective_view/panel.js";
import type { SliceView } from "#src/sliceview/frontend.js";
import { SliceViewPanel } from "#src/sliceview/panel.js";
import type { Viewer } from "#src/viewer.js";
import type { PreparedAffinityInput } from "#src/watershed/input.js";

export interface WatershedViewportRegion {
  readonly lowerXYZ: readonly number[];
  readonly shapeXYZ: readonly number[];
}

const axes = ["x", "y", "z"] as const;

type Panel = SliceViewPanel | PerspectivePanel;

function getPanels(viewer: Viewer): Panel[] {
  return Array.from(viewer.display.panels).filter(
    (panel): panel is Panel =>
      panel instanceof SliceViewPanel || panel instanceof PerspectivePanel,
  );
}

function getRegion(
  panels: readonly Panel[],
  input: PreparedAffinityInput,
  outputLayer: ManagedUserLayer,
): WatershedViewportRegion | undefined {
  if (!outputLayer.visible || outputLayer.archived) return undefined;
  input.assertValid();
  // Update all panels first: a slice may be shared by a 2-D and a 3-D panel.
  for (const panel of panels) panel.ensureBoundsUpdated();
  // A shared slice can have two distinct rendered rectangles. Deduplicate
  // within each kind of contributor, but never discard one kind for the other.
  type RectangleKind = "slice" | "perspective";
  const slices = new Map<SliceView, Set<RectangleKind>>();
  function addSlice(slice: SliceView, kind: RectangleKind) {
    let kinds = slices.get(slice);
    if (kinds === undefined) slices.set(slice, (kinds = new Set()));
    kinds.add(kind);
  }
  for (const panel of panels) {
    if (
      !panel.shouldDraw ||
      panel.renderViewport.width <= 0 ||
      panel.renderViewport.height <= 0 ||
      !panel.viewer.layerManager.has(outputLayer)
    ) {
      continue;
    }
    if (panel instanceof SliceViewPanel) {
      addSlice(panel.sliceView, "slice");
    } else {
      for (const [slice, unconditional] of panel.sliceViews) {
        if (unconditional || panel.viewer.showSliceViews.value) {
          addSlice(slice, "perspective");
        }
      }
    }
  }

  const lower = [Infinity, Infinity, Infinity];
  const upper = [-Infinity, -Infinity, -Infinity];
  let haveCorners = false;
  for (const [slice, kinds] of slices) {
    if (!slice.valid || !slice.layerManager.has(outputLayer)) continue;
    const projection = slice.projectionParameters.value;
    if (projection.width <= 0 || projection.height <= 0) continue;
    const info = projection.displayDimensionRenderInfo;
    const space = slice.navigationState.coordinateSpace.value;
    // PreparedAffinityInput requires native output axes named x/y/z. Do not
    // infer an axis permutation from display order, units, or relative scales.
    const globalIndices = axes.map((name) => {
      const index = info.globalDimensionNames.indexOf(name);
      if (index === -1 || space.names[index] !== name) {
        throw new Error(
          `Cannot map watershed viewport axis ${name} to global dimensions`,
        );
      }
      return index;
    });
    const displayIndices = globalIndices.map((index) =>
      Array.from(info.displayDimensionIndices)
        .slice(0, info.displayRank)
        .indexOf(index),
    );
    const factors = globalIndices.map((index, axis) => {
      const scale = space.scales[index] / input.spacingXYZ[axis];
      if (
        space.units[index] !== input.unitsXYZ[axis] ||
        !Number.isFinite(scale) ||
        scale <= 0 ||
        !Number.isFinite(input.originXYZ[axis])
      ) {
        throw new Error(
          `Cannot map watershed viewport units/scale for axis ${axes[axis]}`,
        );
      }
      return scale;
    });
    for (const kind of kinds) {
      const sliceLower = [Infinity, Infinity, Infinity];
      const sliceUpper = [-Infinity, -Infinity, -Infinity];
      // SliceViewPanel draws the clipped clip-space rectangle. In contrast,
      // PerspectivePanel.drawSliceViews centers the visible width/height at
      // invViewMatrix's origin, ignoring the clipped rectangle's offset.
      const inPerspective = kind === "perspective";
      const m = inPerspective
        ? projection.invViewMatrix
        : projection.invViewProjectionMat;
      const halfWidth = inPerspective ? projection.width / 2 : 1;
      const halfHeight = inPerspective ? -projection.height / 2 : 1;
      // z=0 is the slice plane. Render depth is NOT segmentation depth. Both
      // matrices already account for canonical/relative voxel scales.
      for (const x of [-halfWidth, halfWidth]) {
        for (const y of [-halfHeight, halfHeight]) {
          const w = m[3] * x + m[7] * y + m[15];
          const display = [0, 1, 2].map(
            (d) => (m[d] * x + m[4 + d] * y + m[12 + d]) / w,
          );
          for (let axis = 0; axis < 3; ++axis) {
            const d = displayIndices[axis];
            const global =
              d === -1
                ? projection.globalPosition[globalIndices[axis]]
                : display[d];
            // globalVoxel * globalScale = (native + origin) * nativeSpacing.
            const native = global * factors[axis] - input.originXYZ[axis];
            if (!Number.isFinite(native)) {
              throw new Error("Non-finite watershed viewport coordinate");
            }
            sliceLower[axis] = Math.min(sliceLower[axis], native);
            sliceUpper[axis] = Math.max(sliceUpper[axis], native);
          }
        }
      }
      // Expand each plane's degenerate axes BEFORE union. Expanding only the
      // final box would drop the highest integer-positioned parallel plane.
      for (let axis = 0; axis < 3; ++axis) {
        const roundedLower = Math.floor(sliceLower[axis]);
        lower[axis] = Math.min(lower[axis], roundedLower);
        upper[axis] = Math.max(
          upper[axis],
          roundedLower + 1,
          Math.ceil(sliceUpper[axis]),
        );
      }
      haveCorners = true;
    }
  }
  if (!haveCorners) return undefined;
  const shape = [0, 0, 0];
  for (let axis = 0; axis < 3; ++axis) {
    upper[axis] = Math.min(input.upperBoundXYZ[axis], upper[axis]);
    lower[axis] = Math.max(input.lowerBoundXYZ[axis], lower[axis]);
    shape[axis] = upper[axis] - lower[axis];
    if (shape[axis] <= 0) return undefined;
  }
  return { lowerXYZ: lower, shapeXYZ: shape };
}

function regionsEqual(
  a: WatershedViewportRegion | undefined,
  b: WatershedViewportRegion | undefined,
) {
  return (
    a === b ||
    (a !== undefined &&
      b !== undefined &&
      a.lowerXYZ.every((x, i) => x === b.lowerXYZ[i]) &&
      a.shapeXYZ.every((x, i) => x === b.shapeXYZ[i]))
  );
}

/**
 * Watch ONE outward-rounded union box in the selected native input grid.
 * No halo or debounce is applied here. Perspective slices use their slice
 * rectangles, not the perspective camera's volume, occlusion, or depth range.
 * Missing named global axes or incompatible units are errors, never guessed.
 */
export function watchWatershedViewport(
  viewer: Viewer,
  input: PreparedAffinityInput,
  outputLayer: ManagedUserLayer,
  onRegion: (region: WatershedViewportRegion | undefined) => void,
  onError: (error: unknown) => void,
): () => void {
  if (viewer.wasDisposed || outputLayer.wasDisposed) {
    onRegion(undefined);
    return () => {};
  }
  const subscriptions = new Map<object, (() => void)[]>();
  const disposers: (() => void)[] = [];
  let disposed = false;
  let updating = false;
  let pending = false;
  let initialized = false;
  let previous: WatershedViewportRegion | undefined;
  let resizeGeneration = -1;

  function publish(region: WatershedViewportRegion | undefined) {
    if (disposed || (initialized && regionsEqual(previous, region))) return;
    initialized = true;
    previous = region;
    onRegion(region);
  }

  function synchronize(panels: readonly Panel[]) {
    const wanted = new Set<object>();
    function watch(
      key: object,
      subscribe: (notify: () => void) => (() => void)[],
    ) {
      wanted.add(key);
      // Signal stores handlers in a Set. Distinct owners need distinct wrappers
      // even when they share a visibility, show-slices, or coordinate signal:
      // removing an old owner must not unregister a surviving/new owner.
      if (!subscriptions.has(key))
        subscriptions.set(
          key,
          subscribe(() => update()),
        );
    }
    function watchSlice(slice: SliceView) {
      watch(slice, (notify) => [
        slice.projectionParameters.changed.add(notify),
        // Non-displayed axes also need their current global physical scales.
        slice.navigationState.coordinateSpace.changed.add(notify),
      ]);
      watch(slice.layerManager, (notify) => [
        slice.layerManager.layersChanged.add(notify),
      ]);
    }
    for (const panel of panels) {
      watch(panel, (notify) => {
        const removers = [
          panel.boundsUpdated.add(notify),
          panel.visibility.changed.add(notify),
        ];
        if (panel instanceof PerspectivePanel) {
          removers.push(
            panel.sliceViews.changed.add(notify),
            panel.viewer.showSliceViews.changed.add(notify),
          );
        }
        return removers;
      });
      watch(panel.viewer.layerManager, (notify) => [
        panel.viewer.layerManager.layersChanged.add(notify),
      ]);
      if (panel instanceof SliceViewPanel) watchSlice(panel.sliceView);
      else for (const slice of panel.sliceViews.keys()) watchSlice(slice);
    }
    for (const [key, removers] of subscriptions) {
      if (wanted.has(key)) continue;
      subscriptions.delete(key);
      for (const remove of removers) remove();
    }
  }

  function update() {
    if (disposed) return;
    pending = true;
    // .value flushes pending projection updates, and ensureBoundsUpdated may
    // dispatch boundsUpdated. Also permit callbacks to change layer visibility.
    if (updating) return;
    updating = true;
    try {
      do {
        pending = false;
        let region: WatershedViewportRegion | undefined;
        let error: unknown;
        let failed = false;
        try {
          const panels = getPanels(viewer);
          synchronize(panels);
          resizeGeneration = viewer.display.resizeGeneration;
          region = getRegion(panels, input, outputLayer);
        } catch (e) {
          failed = true;
          error = e;
        }
        publish(region);
        if (failed && !disposed) onError(error);
      } while (pending && !disposed);
    } finally {
      updating = false;
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const remove of disposers) remove();
    for (const removers of subscriptions.values()) {
      for (const remove of removers) remove();
    }
    subscriptions.clear();
    viewer.unregisterDisposer(dispose);
    outputLayer.unregisterDisposer(dispose);
  }

  function abort() {
    try {
      publish(undefined);
    } finally {
      dispose();
    }
  }

  // DisplayContext has no panel-topology signal. Its generation changes for
  // panel add/remove and layout/resize/scroll. Chunk-only frames leave it alone.
  const checkDisplay = () => {
    if (viewer.display.resizeGeneration !== resizeGeneration) update();
  };
  disposers.push(
    viewer.display.updateStarted.add(checkDisplay),
    viewer.display.updateFinished.add(checkDisplay),
    outputLayer.layerChanged.add(update),
  );
  input.signal.addEventListener("abort", abort, { once: true });
  disposers.push(() => input.signal.removeEventListener("abort", abort));
  viewer.registerDisposer(dispose);
  outputLayer.registerDisposer(dispose);
  if (input.signal.aborted) abort();
  else update();
  return dispose;
}
