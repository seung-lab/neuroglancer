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

import { afterEach, describe, expect, it, vi } from "vitest";
import { makeCoordinateSpace } from "#src/coordinate_transform.js";
import { applyRenderViewportToProjectionMatrix } from "#src/display_context.js";
import type { ManagedUserLayer } from "#src/layer/index.js";
import {
  DisplayPose,
  NavigationState,
  OrientationState,
  Position,
  TrackableCrossSectionZoom,
  TrackableDepthRange,
  TrackableDisplayDimensions,
  TrackableRelativeDisplayScales,
  WatchableDisplayDimensionRenderInfo,
} from "#src/navigation_state.js";
import { PerspectivePanel } from "#src/perspective_view/panel.js";
import {
  ProjectionParameters,
  updateProjectionParametersFromInverseViewAndProjection,
} from "#src/projection_parameters.js";
import { DerivedProjectionParameters } from "#src/renderlayer.js";
import type { SliceView } from "#src/sliceview/frontend.js";
import { SliceViewPanel } from "#src/sliceview/panel.js";
import { WatchableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import { mat4 } from "#src/util/geom.js";
import { NullarySignal } from "#src/util/signal.js";
import { WatchableMap } from "#src/util/watchable_map.js";
import type { Viewer } from "#src/viewer.js";
import type { PreparedAffinityInput } from "#src/watershed/input.js";
import { watchWatershedViewport } from "#src/watershed/viewport.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

function fixture(overrides: Partial<PreparedAffinityInput> = {}) {
  const controller = new AbortController();
  const input = {
    lowerBoundXYZ: [-100, -100, -100],
    upperBoundXYZ: [100, 100, 100],
    spacingXYZ: [1, 1, 1],
    originXYZ: [0, 0, 0],
    unitsXYZ: ["m", "m", "m"],
    signal: controller.signal,
    assertValid: vi.fn(),
    ...overrides,
  } as unknown as PreparedAffinityInput;
  const output = Object.assign(new RefCounted(), {
    visible: true,
    archived: false,
    layerChanged: new NullarySignal(),
  });
  const layer = output as unknown as ManagedUserLayer;
  const panels = new Set<SliceViewPanel | PerspectivePanel>();
  const display = {
    panels,
    resizeGeneration: 0,
    updateStarted: new NullarySignal(),
    updateFinished: new NullarySignal(),
  };
  const owner = Object.assign(new RefCounted(), { display });
  const viewer = owner as unknown as Viewer;
  const onRegion = vi.fn();
  const onError = vi.fn();
  function group(present = true) {
    const members = new Set(present ? [layer] : []);
    return {
      members,
      has: (l: ManagedUserLayer) => members.has(l),
      layersChanged: new NullarySignal(),
    };
  }
  const mainGroup = group();

  function slice(
    center = [0, 0, 0],
    u = [2, 0, 0],
    v = [0, 3, 0],
    names = ["x", "y", "z"],
    indices = [0, 1, 2],
    scales = names.map(() => 1),
  ) {
    const p = new ProjectionParameters();
    // Power-of-two dimensions keep these synthetic inverse matrices exact
    // when recovering per-pixel view axes for centered perspective rectangles.
    p.width = p.height = 8;
    p.globalPosition = new Float32Array(names.length);
    const displayedScales = indices.map((i) => (i === -1 ? 1 : scales[i]));
    const canonicalScale = Math.min(
      ...displayedScales.slice(0, indices.filter((i) => i !== -1).length),
    );
    p.displayDimensionRenderInfo = {
      globalRank: names.length,
      globalDimensionNames: names,
      displayDimensionIndices: Int32Array.from(indices),
      displayRank: indices.filter((i) => i !== -1).length,
      displayDimensionUnits: indices.map((i) => (i === -1 ? "" : "m")),
      displayDimensionScales: Float64Array.from(displayedScales),
      voxelPhysicalScales: Float64Array.from(displayedScales),
      canonicalVoxelPhysicalSize: canonicalScale,
      canonicalVoxelFactors: Float64Array.from(displayedScales, (s, i) =>
        indices[i] === -1 ? 1 : s / canonicalScale,
      ),
    };
    // Deliberately enormous render-depth vector: only z=0 may be measured.
    p.invViewProjectionMat = mat4.fromValues(
      ...([...u, 0, ...v, 0, 0, 0, 1000, 0, ...center, 1] as Parameters<
        typeof mat4.fromValues
      >),
    );
    // For an unclipped fixture, centered perspective and 2-D rectangles agree.
    // Match PerspectivePanel's invViewMatrix * diag(width/2, -height/2, 1).
    mat4.scale(p.invViewMatrix, p.invViewProjectionMat, [
      2 / p.width,
      -2 / p.height,
      1,
    ]);
    const space = new WatchableValue(
      makeCoordinateSpace({
        names,
        scales: Float64Array.from(scales),
        units: names.map(() => "m"),
      }),
    );
    const projection = {
      changed: new NullarySignal(),
      get value() {
        return p;
      },
    };
    const readProjection = vi.spyOn(projection, "value", "get");
    const viewChanged = new NullarySignal();
    const state = {
      valid: true,
      layerManager: mainGroup,
      projectionParameters: projection,
      navigationState: { coordinateSpace: space },
      viewChanged,
    };
    const view = state as unknown as SliceView;
    return { view, state, p, space, projection, readProjection, viewChanged };
  }

  function panel(
    sliceView?: SliceView,
    manager = mainGroup,
    controls: {
      visibility?: WatchableValue<boolean>;
      showSliceViews?: WatchableValue<boolean>;
    } = {},
  ) {
    const perspective = sliceView === undefined;
    const visibility = controls.visibility ?? new WatchableValue(true);
    const showSliceViews = controls.showSliceViews ?? new WatchableValue(true);
    const sliceViews = new WatchableMap<SliceView, boolean>(() => {});
    const renderViewport = { width: 100, height: 100 };
    const boundsUpdated = new NullarySignal();
    const ensureBoundsUpdated = vi.fn();
    const value = Object.create(
      perspective ? PerspectivePanel.prototype : SliceViewPanel.prototype,
    );
    Object.defineProperties(value, {
      shouldDraw: { get: () => visibility.value },
      viewer: { value: { layerManager: manager, showSliceViews } },
      visibility: { value: visibility },
      renderViewport: { value: renderViewport },
      boundsUpdated: { value: boundsUpdated },
      ensureBoundsUpdated: { value: ensureBoundsUpdated },
      sliceView: { value: sliceView },
      sliceViews: { value: sliceViews },
    });
    const view = value as SliceViewPanel | PerspectivePanel;
    panels.add(view);
    ++display.resizeGeneration;
    return {
      view,
      visibility,
      showSliceViews,
      sliceViews,
      renderViewport,
      boundsUpdated,
      ensureBoundsUpdated,
    };
  }
  function start() {
    const dispose = watchWatershedViewport(
      viewer,
      input,
      layer,
      onRegion,
      onError,
    );
    cleanup.push(dispose);
    return dispose;
  }
  function frame() {
    display.updateStarted.dispatch();
    display.updateFinished.dispatch();
  }
  return {
    input,
    output,
    owner,
    controller,
    display,
    panels,
    group,
    mainGroup,
    slice,
    panel,
    start,
    frame,
    onRegion,
    onError,
  };
}

function region(lowerXYZ: number[], shapeXYZ: number[]) {
  return { lowerXYZ, shapeXYZ };
}

describe("watershed visible slice union", () => {
  it("returns undefined without visible, nonempty, valid slice rectangles", () => {
    const f = fixture();
    f.start();
    expect(f.onRegion).toHaveBeenCalledExactlyOnceWith(undefined);
    const s = f.slice();
    s.state.valid = false;
    f.panel(s.view);
    f.frame();
    expect(f.onRegion).toHaveBeenCalledOnce();
    s.state.valid = true;
    s.p.width = 0;
    s.projection.changed.dispatch();
    expect(f.onRegion).toHaveBeenCalledOnce();
    s.p.width = 10;
    s.projection.changed.dispatch();
    expect(f.onRegion).toHaveBeenLastCalledWith(region([-2, -3, 0], [4, 6, 1]));
    f.output.archived = true;
    f.output.layerChanged.dispatch();
    expect(f.onRegion).toHaveBeenLastCalledWith(undefined);
  });

  it("encloses all three orthogonal rectangles, not their render z-frusta", () => {
    const f = fixture();
    f.panel(f.slice([10, 20, 30], [4, 0, 0], [0, 5, 0]).view);
    f.panel(f.slice([10, 20, 30], [0, 6, 0], [0, 0, 7]).view);
    f.panel(f.slice([10, 20, 30], [8, 0, 0], [0, 0, 9]).view);
    f.start();
    expect(f.onError).not.toHaveBeenCalled();
    expect(f.onRegion).toHaveBeenCalledExactlyOnceWith(
      region([2, 14, 21], [16, 12, 18]),
    );
  });

  it("rounds oblique corners outward and unions separated slices", () => {
    const f = fixture();
    f.panel(f.slice([5.25, 6.5, 7.75], [2, 1, 3], [-1, 2, 0.5]).view);
    f.panel(f.slice([-10, 0, 1], [1, 0, 0], [0, 1, 0]).view);
    f.start();
    expect(f.onRegion).toHaveBeenLastCalledWith(
      region([-11, -1, 1], [20, 11, 11]),
    );
  });

  it("maps permuted global/display dimensions into coarse native voxels with origins", () => {
    const f = fixture({
      spacingXYZ: [4e-9, 8e-9, 16e-9],
      originXYZ: [10, -2, 4],
    });
    // Global z,t,x,y; displayed y,z,x. The inverse matrix is already in
    // global voxel units, irrespective of canonical/relative display scales.
    const s = f.slice(
      [16, 48, 40],
      [8, 0, 0],
      [0, 8, 8],
      ["z", "t", "x", "y"],
      [3, 0, 2],
      [2e-9, 1, 1e-9, 2e-9],
    );
    f.panel(s.view);
    f.start();
    expect(f.onError).not.toHaveBeenCalled();
    expect(f.onRegion).toHaveBeenLastCalledWith(region([-2, 4, 1], [4, 4, 2]));
  });

  it("uses globalPosition for a native axis absent from the displayed dimensions", () => {
    const f = fixture();
    const s = f.slice(
      [10, 20, 500],
      [2, 0, 100],
      [0, 3, 100],
      ["z", "y", "x"],
      [2, 1, -1],
    );
    s.p.globalPosition[0] = 7;
    f.panel(s.view);
    f.start();
    expect(f.onRegion).toHaveBeenLastCalledWith(region([8, 17, 7], [4, 6, 1]));
  });

  it.each([0, 0.25])(
    "selects at least one voxel for a single plane at z=%s",
    (z) => {
      const f = fixture();
      f.panel(f.slice([0, 0, z]).view);
      f.start();
      expect(f.onRegion).toHaveBeenLastCalledWith(
        region([-2, -3, 0], [4, 6, 1]),
      );
    },
  );

  it("includes the highest integer-positioned parallel plane before union", () => {
    const f = fixture();
    f.panel(f.slice([0, 0, -4]).view);
    f.panel(f.slice([0, 0, -1]).view);
    f.start();
    expect(f.onError).not.toHaveBeenCalled();
    expect(f.onRegion).toHaveBeenCalledExactlyOnceWith(
      region([-2, -3, -4], [4, 6, 4]),
    );
  });

  it("unions distinct clipped 2-D and centered perspective rectangles of a shared slice", () => {
    const f = fixture({ upperBoundXYZ: [200, 100, 100] });
    const s = f.slice();
    Object.assign(s.p, {
      width: 50,
      height: 20,
      logicalWidth: 100,
      logicalHeight: 20,
      visibleLeftFraction: 0.5,
      visibleTopFraction: 0,
      visibleWidthFraction: 0.5,
      visibleHeightFraction: 1,
    });
    mat4.fromTranslation(s.p.invViewMatrix, [100, 0, 0]);
    mat4.ortho(s.p.projectionMat, -50, 50, 10, -10, -1000, 1000);
    applyRenderViewportToProjectionMatrix(s.p, s.p.projectionMat);
    updateProjectionParametersFromInverseViewAndProjection(s.p);
    const p = f.panel(s.view);
    const perspective = f.panel();
    perspective.sliceViews.set(s.view, true);
    f.start();
    expect(f.onError).not.toHaveBeenCalled();
    // 2-D is [100,150]; PerspectivePanel.drawSliceViews centers the visible
    // width=50 at invViewMatrix's center=100, yielding [75,125].
    expect(f.onRegion).toHaveBeenCalledExactlyOnceWith(
      region([75, -10, 0], [75, 20, 1]),
    );
    p.visibility.value = false;
    expect(f.onRegion).toHaveBeenLastCalledWith(
      region([75, -10, 0], [50, 20, 1]),
    );
    p.visibility.value = true;
    perspective.visibility.value = false;
    expect(f.onRegion).toHaveBeenLastCalledWith(
      region([100, -10, 0], [50, 20, 1]),
    );
  });

  it("clamps nonzero bounds, returns empty outside, and treats upper bounds as exclusive", () => {
    const f = fixture({ lowerBoundXYZ: [1, -2, -4], upperBoundXYZ: [4, 2, 5] });
    const s = f.slice([0, 0, 0]);
    f.panel(s.view);
    f.start();
    expect(f.onRegion).toHaveBeenLastCalledWith(region([1, -2, 0], [1, 4, 1]));
    s.p.invViewProjectionMat[12] = 20;
    s.projection.changed.dispatch();
    expect(f.onRegion).toHaveBeenLastCalledWith(undefined);
    s.p.invViewProjectionMat[12] = 2;
    s.p.invViewProjectionMat[14] = 5;
    s.projection.changed.dispatch();
    expect(f.onRegion).toHaveBeenCalledTimes(2);
    s.p.invViewProjectionMat[14] = -4;
    s.projection.changed.dispatch();
    expect(f.onRegion).toHaveBeenLastCalledWith(region([1, -2, -4], [3, 4, 1]));
  });

  it("rejects missing axes and incompatible physical units instead of guessing", () => {
    const f = fixture();
    const s = f.slice([0, 0, 0], [2, 0, 0], [0, 3, 0], ["a", "y", "z"]);
    f.panel(s.view);
    f.start();
    expect(f.onRegion).toHaveBeenLastCalledWith(undefined);
    expect(f.onError.mock.calls[0][0].message).toMatch("axis x");
    s.p.displayDimensionRenderInfo.globalDimensionNames = ["x", "y", "z"];
    s.space.value = makeCoordinateSpace({
      names: ["x", "y", "z"],
      units: ["s", "m", "m"],
      scales: Float64Array.of(1, 1, 1),
    });
    expect(f.onError.mock.lastCall![0].message).toMatch(
      "units/scale for axis x",
    );
  });
});

describe("watershed viewport subscriptions", () => {
  it.each(["viewer", "output", "abort"])(
    "handles an already disposed %s without subscribing",
    (how) => {
      const f = fixture();
      const s = f.slice();
      f.panel(s.view);
      if (how === "viewer") f.owner.dispose();
      else if (how === "output") f.output.dispose();
      else f.controller.abort();
      f.start();
      expect(f.onRegion).toHaveBeenCalledExactlyOnceWith(undefined);
      f.output.layerChanged.dispatch();
      s.projection.changed.dispatch();
      f.frame();
      expect(s.readProjection).not.toHaveBeenCalled();
      expect(f.onRegion).toHaveBeenCalledOnce();
    },
  );

  it("includes shown perspective slices only in relevant groups and deduplicates shared views", () => {
    const f = fixture();
    const a = f.slice();
    const b = f.slice([20, 20, 20]);
    const c = f.slice([80, 80, 80]);
    const p = f.panel(a.view);
    const perspective = f.panel();
    perspective.sliceViews.set(a.view, true);
    perspective.sliceViews.set(b.view, false);
    const foreign = f.panel(undefined, f.group(false));
    foreign.sliceViews.set(c.view, true);
    f.start();
    expect(a.readProjection).toHaveBeenCalledOnce();
    expect(c.readProjection).not.toHaveBeenCalled();
    expect(f.onRegion).toHaveBeenLastCalledWith(
      region([-2, -3, 0], [24, 26, 21]),
    );
    perspective.showSliceViews.value = false;
    expect(f.onRegion).toHaveBeenLastCalledWith(region([-2, -3, 0], [4, 6, 1]));
    perspective.sliceViews.set(b.view, true);
    expect(f.onRegion).toHaveBeenLastCalledWith(
      region([-2, -3, 0], [24, 26, 21]),
    );
    p.visibility.value = false;
    perspective.visibility.value = false;
    expect(f.onRegion).toHaveBeenLastCalledWith(undefined);
    p.visibility.value = true;
    a.state.layerManager = f.group(false);
    p.boundsUpdated.dispatch();
    expect(f.onRegion).toHaveBeenLastCalledWith(undefined);
  });

  it.each(["surviving", "replacement"])(
    "preserves shared viewer visibility subscriptions after 4panel to xy (%s panel)",
    (kind) => {
      const f = fixture();
      const visibility = new WatchableValue(true);
      const old = [
        f.panel(f.slice().view, f.mainGroup, { visibility }),
        f.panel(f.slice().view, f.mainGroup, { visibility }),
        f.panel(f.slice().view, f.mainGroup, { visibility }),
        f.panel(undefined, f.mainGroup, { visibility }),
      ];
      f.start();
      for (const p of old.slice(kind === "surviving" ? 1 : 0))
        f.panels.delete(p.view);
      if (kind === "replacement")
        f.panel(f.slice().view, f.mainGroup, { visibility });
      ++f.display.resizeGeneration;
      f.frame();
      expect(f.onRegion).toHaveBeenLastCalledWith(
        region([-2, -3, 0], [4, 6, 1]),
      );
      visibility.value = false;
      expect(f.onRegion).toHaveBeenLastCalledWith(undefined);
      expect(f.onError).not.toHaveBeenCalled();
    },
  );

  it("preserves shared show-slices subscriptions when a perspective panel is replaced", () => {
    const f = fixture();
    const showSliceViews = new WatchableValue(true);
    const old = f.panel(undefined, f.mainGroup, { showSliceViews });
    old.sliceViews.set(f.slice().view, false);
    f.start();
    f.panels.delete(old.view);
    const replacement = f.panel(undefined, f.mainGroup, { showSliceViews });
    replacement.sliceViews.set(f.slice().view, false);
    ++f.display.resizeGeneration;
    f.frame();
    showSliceViews.value = false;
    expect(f.onRegion).toHaveBeenLastCalledWith(undefined);
    expect(f.onError).not.toHaveBeenCalled();
  });

  it("reacts to projection, bounds, empty panels, membership, hidden output, and layout topology", () => {
    const f = fixture();
    const s = f.slice();
    const p = f.panel(s.view);
    f.start();
    s.p.invViewProjectionMat[12] = 10;
    s.projection.changed.dispatch();
    expect(f.onRegion).toHaveBeenLastCalledWith(region([8, -3, 0], [4, 6, 1]));
    p.renderViewport.width = 0;
    p.boundsUpdated.dispatch();
    expect(f.onRegion).toHaveBeenLastCalledWith(undefined);
    p.renderViewport.width = 50;
    ++f.display.resizeGeneration;
    f.frame();
    expect(f.onRegion).toHaveBeenLastCalledWith(region([8, -3, 0], [4, 6, 1]));
    f.mainGroup.members.clear();
    f.mainGroup.layersChanged.dispatch();
    expect(f.onRegion).toHaveBeenLastCalledWith(undefined);
    f.mainGroup.members.add(f.output as unknown as ManagedUserLayer);
    f.mainGroup.layersChanged.dispatch();
    f.output.visible = false;
    f.output.layerChanged.dispatch();
    expect(f.onRegion).toHaveBeenLastCalledWith(undefined);
    f.output.visible = true;
    f.output.layerChanged.dispatch();
    const other = f.panel(f.slice([30, 30, 30]).view);
    f.frame();
    expect(f.onRegion).toHaveBeenLastCalledWith(
      region([8, -3, 0], [24, 36, 31]),
    );
    f.panels.delete(other.view);
    ++f.display.resizeGeneration;
    f.frame();
    expect(f.onRegion).toHaveBeenLastCalledWith(region([8, -3, 0], [4, 6, 1]));
  });

  it("does no geometry work on chunk arrivals or unchanged frames and suppresses unchanged bounds", () => {
    const f = fixture();
    const s = f.slice();
    const p = f.panel(s.view);
    f.start();
    const reads = s.readProjection.mock.calls.length;
    const bounds = p.ensureBoundsUpdated.mock.calls.length;
    for (let i = 0; i < 20; ++i) {
      s.viewChanged.dispatch();
      f.frame();
    }
    expect(s.readProjection).toHaveBeenCalledTimes(reads);
    expect(p.ensureBoundsUpdated).toHaveBeenCalledTimes(bounds);
    f.output.layerChanged.dispatch(); // Output publication must not feedback.
    s.projection.changed.dispatch();
    p.boundsUpdated.dispatch();
    expect(f.onRegion).toHaveBeenCalledOnce();
  });

  it("does not feedback when publishing a region synchronously changes output layers", () => {
    const f = fixture();
    f.panel(f.slice().view);
    f.onRegion.mockImplementation(() => f.output.layerChanged.dispatch());
    f.start();
    expect(f.onRegion).toHaveBeenCalledExactlyOnceWith(
      region([-2, -3, 0], [4, 6, 1]),
    );
    expect(f.onError).not.toHaveBeenCalled();
  });

  it("handles synchronous bounds/projection flushes and callback visibility changes without recursion", () => {
    const f = fixture();
    const s = f.slice();
    const p = f.panel(s.view);
    p.ensureBoundsUpdated.mockImplementationOnce(() => {
      p.boundsUpdated.dispatch();
      s.projection.changed.dispatch();
    });
    f.onRegion.mockImplementationOnce(() => {
      f.output.visible = false;
      f.output.layerChanged.dispatch();
    });
    f.start();
    expect(f.onRegion.mock.calls.map(([r]) => r)).toEqual([
      region([-2, -3, 0], [4, 6, 1]),
      undefined,
    ]);
  });

  it.each(["manual", "viewer", "output", "abort"])(
    "cleans subscriptions on %s disposal",
    (how) => {
      const f = fixture();
      const s = f.slice();
      const p = f.panel(s.view);
      const dispose = f.start();
      if (how === "viewer") f.owner.dispose();
      else if (how === "output") f.output.dispose();
      else if (how === "abort") f.controller.abort();
      else dispose();
      const count = f.onRegion.mock.calls.length;
      const reads = s.readProjection.mock.calls.length;
      s.projection.changed.dispatch();
      p.visibility.value = false;
      f.mainGroup.layersChanged.dispatch();
      f.output.layerChanged.dispatch();
      ++f.display.resizeGeneration;
      f.frame();
      dispose();
      expect(f.onRegion).toHaveBeenCalledTimes(count);
      expect(s.readProjection).toHaveBeenCalledTimes(reads);
      if (how === "abort")
        expect(f.onRegion).toHaveBeenLastCalledWith(undefined);
    },
  );

  it("detaches removed panels/slices rather than retaining their subscriptions", () => {
    const f = fixture();
    const s = f.slice();
    const p = f.panel(s.view);
    const perspective = f.panel();
    perspective.sliceViews.set(s.view, true);
    f.start();
    f.panels.delete(p.view);
    perspective.sliceViews.delete(s.view);
    ++f.display.resizeGeneration;
    f.frame();
    f.onRegion.mockClear();
    const validations = vi.mocked(f.input.assertValid).mock.calls.length;
    p.visibility.value = false;
    s.projection.changed.dispatch();
    expect(f.input.assertValid).toHaveBeenCalledTimes(validations);
    expect(f.onRegion).not.toHaveBeenCalled();
    expect(f.onError).not.toHaveBeenCalled();
  });
});

it("converts a real navigation projection with anisotropy and relative display scales just once", () => {
  const space = new WatchableValue(
    makeCoordinateSpace({
      names: ["x", "y", "z"],
      scales: Float64Array.of(1, 2, 4),
      units: ["m", "m", "m"],
    }),
  );
  const relative = new TrackableRelativeDisplayScales(space);
  relative.restoreState({ x: 2, y: 1, z: 1 });
  const info = new WatchableDisplayDimensionRenderInfo(
    relative,
    new TrackableDisplayDimensions(space),
  );
  const position = new Position(space);
  position.restoreState([12, 14, 16]);
  const navigation = new NavigationState(
    new DisplayPose(position, info, new OrientationState()),
    new TrackableCrossSectionZoom(info.addRef()),
    new TrackableDepthRange(1000, info),
  );
  navigation.zoomFactor.value = 1;
  const projection = new DerivedProjectionParameters({
    navigationState: navigation,
    update: (out, nav) => {
      nav.toMat4(out.invViewMatrix);
      mat4.ortho(
        out.projectionMat,
        -out.logicalWidth / 2,
        out.logicalWidth / 2,
        out.logicalHeight / 2,
        -out.logicalHeight / 2,
        -nav.relativeDepthRange,
        nav.relativeDepthRange,
      );
      applyRenderViewportToProjectionMatrix(out, out.projectionMat);
      updateProjectionParametersFromInverseViewAndProjection(out);
    },
  });
  projection.setViewport({
    width: 8,
    height: 8,
    logicalWidth: 8,
    logicalHeight: 8,
    visibleLeftFraction: 0,
    visibleTopFraction: 0,
    visibleWidthFraction: 1,
    visibleHeightFraction: 1,
  });
  cleanup.push(
    () => navigation.dispose(),
    () => projection.dispose(),
  );
  const f = fixture({ spacingXYZ: [2, 4, 8], originXYZ: [1, 2, 3] });
  const s = f.slice();
  s.state.projectionParameters = projection as unknown as typeof s.projection;
  s.state.navigationState.coordinateSpace = space;
  f.panel(s.view);
  f.start();
  expect(f.onError).not.toHaveBeenCalled();
  expect(f.onRegion).toHaveBeenLastCalledWith(region([3, 3, 5], [4, 4, 1]));
  position.value = Float32Array.of(16, 14, 16);
  // Production .value flushes pending debounced projection work synchronously.
  void projection.value;
  expect(f.onRegion).toHaveBeenLastCalledWith(region([5, 3, 5], [4, 4, 1]));
  // Clipping away the left half of the logical panel selects only its right
  // rectangle, not the unclipped logical rectangle or any z-depth range.
  projection.setViewport({
    ...projection.value,
    width: 4,
    visibleLeftFraction: 0.5,
    visibleWidthFraction: 0.5,
  });
  void projection.value;
  expect(f.onRegion).toHaveBeenLastCalledWith(region([7, 3, 5], [2, 4, 1]));
});
