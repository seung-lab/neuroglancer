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

/** Session/UI tests without a WebGL viewer, network reads or WASM worker. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageUserLayer } from "#src/layer/image/index.js";
import type {
  ManagedUserLayer,
  TopLevelLayerListSpecification,
} from "#src/layer/index.js";
import { deleteLayer, LayerManager, makeLayer } from "#src/layer/index.js";
import { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import { ActionCommand } from "#src/ui/command.js";
import { CommandRegistry } from "#src/ui/command_registry.js";
import {
  bindWatershed,
  WatershedSession,
  type WatershedDependencies,
} from "#src/ui/watershed.js";
import { disposableOnce, RefCounted } from "#src/util/disposable.js";
import { registerActionListener } from "#src/util/event_action_map.js";
import { NullarySignal } from "#src/util/signal.js";
import type { Viewer } from "#src/viewer.js";
import { DEFAULT_WATERSHED_OPTIONS } from "#src/watershed/base.js";
import type { PreparedAffinityInput } from "#src/watershed/input.js";
import type { LiveWatershed } from "#src/watershed/live.js";

vi.mock("#src/layer/index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  makeLayer: vi.fn(),
}));

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function makeInput(scaleIndex: number) {
  const abort = new AbortController();
  let valid = true;
  return {
    lowerBoundXYZ: scaleIndex === 0 ? [10, 20, -30] : [-4, 10, 2],
    upperBoundXYZ: scaleIndex === 0 ? [310, 220, 70] : [60, 90, 42],
    channelCount: 4,
    spacingXYZ: [2e-9, 2e-9, 8e-9],
    unitsXYZ: ["m", "m", "m"],
    originXYZ: [0, 0, 0],
    signal: abort.signal,
    isValid: vi.fn(() => valid && !abort.signal.aborted),
    assertValid: vi.fn(() => {
      if (!valid || abort.signal.aborted)
        throw new Error("Source snapshot changed");
    }),
    readRegion: vi.fn<PreparedAffinityInput["readRegion"]>(),
    dispose: vi.fn(disposableOnce(() => abort.abort())),
    invalidate: (signal = true) => {
      valid = false;
      if (signal) abort.abort();
    },
  } satisfies PreparedAffinityInput & { invalidate(signal?: boolean): void };
}

function makeLive(input: PreparedAffinityInput) {
  return {
    info: {
      shapeXYZ: input.upperBoundXYZ.map((x, i) => x - input.lowerBoundXYZ[i]),
      offsetXYZ: input.lowerBoundXYZ.map((x, i) => x + input.originXYZ[i]),
      spacingXYZ: [...input.spacingXYZ],
      unitsXYZ: [...input.unitsXYZ],
      chunkShapeXYZ: [64, 64, 32],
    },
    signal: input.signal,
    assertValid: vi.fn(() => input.assertValid()),
    dispose: vi.fn(disposableOnce(() => input.dispose())),
  };
}

function fixture() {
  const owner = new RefCounted();
  disposers.push(() => {
    if (!owner.wasDisposed) owner.dispose();
  });
  const manager = () => {
    const m = owner.registerDisposer(new LayerManager());
    owner.registerDisposer(m.useDirectly());
    return m;
  };
  const layerManager = manager();
  const sourceGroup = manager();
  const otherGroup = manager();
  const group = (layerManager: LayerManager) => ({
    layerManager,
    add: vi.fn((layer: ManagedUserLayer) =>
      layerManager.addManagedLayer(layer),
    ),
  });
  const groups = [group(sourceGroup), group(otherGroup)];
  const root = {
    layerManager,
    rootLayers: layerManager,
    subsets: new Set(groups),
    add: vi.fn((layer: ManagedUserLayer) =>
      layerManager.addManagedLayer(layer),
    ),
  } as unknown as TopLevelLayerListSpecification;
  function managed(
    name: string,
    layer: ImageUserLayer | SegmentationUserLayer,
  ) {
    return Object.assign(new RefCounted(), {
      name,
      layer,
      manager: root,
      containers: new Set<LayerManager>(),
      layerChanged: new NullarySignal(),
      readyStateChanged: new NullarySignal(),
      specificationChanged: new NullarySignal(),
      isReady: () => true,
      visible: true,
    }) as unknown as ManagedUserLayer;
  }
  const image = (url: string) =>
    Object.assign(Object.create(ImageUserLayer.prototype), {
      dataSourcesChanged: new NullarySignal(),
      toJSON: () => ({ type: "image", source: url }),
    }) as ImageUserLayer;
  const a = managed(
    "affinities",
    image("precomputed://https://example.com/affinities"),
  );
  // A live ONNX result is just another existing ImageUserLayer to this UI.
  const b = managed("affinities", image("inference://session/live"));
  layerManager.addManagedLayer(a);
  layerManager.addManagedLayer(b);
  sourceGroup.addManagedLayer(a.addRef());
  otherGroup.addManagedLayer(b.addRef());
  const inputs: ReturnType<typeof makeInput>[] = [];
  const prepareInput = vi.fn<WatershedDependencies["prepareInput"]>(
    (_layer, scaleIndex = 0) => {
      const input = makeInput(scaleIndex);
      inputs.push(input);
      return input;
    },
  );
  const lives: ReturnType<typeof makeLive>[] = [];
  const onErrors: Array<(error: unknown) => void> = [];
  const createLive = vi.fn<WatershedDependencies["createLive"]>(
    (input, _channels, _options, onError) => {
      const live = makeLive(input);
      lives.push(live);
      onErrors.push(onError);
      return live as unknown as LiveWatershed;
    },
  );
  const publications: Array<{
    url: string;
    dispose: ReturnType<typeof vi.fn>;
  }> = [];
  const publish = vi.fn<WatershedDependencies["publish"]>((_manager, live) => {
    const publication = {
      url: `watershed://session/${publications.length}`,
      dispose: vi.fn(disposableOnce(() => live.dispose())),
    };
    publications.push(publication);
    return publication;
  });
  const resultState = {
    ready: true,
    hasVolume: true,
    renderLayerCount: 1,
    error: undefined as unknown,
  };
  const resultLayers: ManagedUserLayer[] = [];
  vi.mocked(makeLayer)
    .mockReset()
    .mockImplementation((_manager, name) => {
      const segmentation = Object.assign(
        Object.create(SegmentationUserLayer.prototype),
        {
          // Successful LoadedLayerDataSource also has an undefined `error` key.
          dataSources: [{ loadState: { error: resultState.error } }],
          dataSourcesChanged: new NullarySignal(),
          displayState: { hasVolume: { value: resultState.hasVolume } },
          renderLayers: Array.from(
            { length: resultState.renderLayerCount },
            () => ({}),
          ),
        },
      ) as SegmentationUserLayer;
      const layer = managed(name, segmentation);
      layer.isReady = () => resultState.ready;
      resultLayers.push(layer);
      return layer;
    });
  const layout = { untouched: true };
  const viewer = {
    layerManager,
    layerSpecification: root,
    chunkManager: {},
    resetInitiated: new NullarySignal(),
    state: { stateReset: new NullarySignal() },
    layout,
  } as unknown as Viewer;
  const session = owner.registerDisposer(
    new WatershedSession(viewer, { prepareInput, createLive, publish }),
  );
  session.selectSource(a);
  return {
    owner,
    session,
    viewer,
    root,
    layerManager,
    sourceGroup,
    otherGroup,
    groups,
    a,
    b,
    inputs,
    prepareInput,
    createLive,
    lives,
    onErrors,
    publish,
    publications,
    resultState,
    resultLayers,
    layout,
  };
}

function field(session: WatershedSession, label: string) {
  return session.dialog!.body.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  )!;
}

function fill(session: WatershedSession, label: string, value: string) {
  const input = field(session, label);
  expect(input.disabled).toBe(false);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function addButton(session: WatershedSession) {
  return [...session.dialog!.footer.querySelectorAll("button")].find(
    (button) => button.textContent === "Add watershed layer",
  )!;
}

describe("WASM watershed UI", () => {
  it("preserves the feature-local palette binding and viewer-owned dialog", () => {
    const { viewer } = fixture();
    const owner = new RefCounted();
    disposers.push(() => {
      if (!owner.wasDisposed) owner.dispose();
    });
    const element = document.createElement("div");
    const commandRegistry = owner.registerDisposer(new CommandRegistry());
    Object.assign(viewer, {
      commandRegistry,
      registerDisposer: owner.registerDisposer.bind(owner),
      bindAction: (id: string, handler: () => void) =>
        owner.registerDisposer(registerActionListener(element, id, handler)),
    });
    const session = bindWatershed(viewer);
    expect(session.dialog).toBeUndefined();
    expect(commandRegistry.get("open-watershed")?.label).toBe("WASM Watershed");
    new ActionCommand("open-watershed", "WASM Watershed").invoke({
      dispatchTarget: element,
    });
    const dialog = session.dialog!;
    expect(dialog.headerTitle.textContent).toBe("WASM Watershed");
    owner.dispose();
    expect(dialog.wasDisposed).toBe(true);
    expect(session.wasDisposed).toBe(true);
    expect(commandRegistry.get("open-watershed")).toBeUndefined();
  });

  it("offers one Add operation, defaults/advanced controls, and source identity selection without crop fields", () => {
    const { session, inputs, b } = fixture();
    session.open();
    expect(field(session, "Source scale index").value).toBe("0");
    expect(field(session, "Channels for −X −Y −Z").value).toBe("0, 1, 2");
    for (const key of [
      "highThreshold",
      "lowThreshold",
      "sizeThreshold",
      "dustThreshold",
    ] as const)
      expect(session[key]).toBe(String(DEFAULT_WATERSHED_OPTIONS[key]));
    expect(inputs[0].dispose).toHaveBeenCalledOnce();
    const body = session.dialog!.body;
    expect(body.querySelector('input[aria-label*="ROI"]')).toBeNull();
    expect(body.querySelector("details")!.open).toBe(false);
    expect(
      [...session.dialog!.footer.querySelectorAll("button")].map(
        (x) => x.textContent,
      ),
    ).toEqual(["Add watershed layer", "Close"]);
    expect(addButton(session).disabled).toBe(false);
    for (const explanation of [
      "current view",
      "as you navigate",
      "64 × 64 × 32",
      "8-voxel halo per face",
      "stable block-local IDs",
      "no global stitching",
      "UINT64",
      "negative axes",
      "data type maximum",
      "floating-point values are unchanged",
      "Non-native transforms",
      "session-local",
      "not shareable",
      "GPL v3+",
    ])
      expect(body.textContent).toContain(explanation);
    expect(
      body.querySelectorAll('a[target="_blank"][rel="noopener"]').length,
    ).toBe(2);
    const select = body.querySelector<HTMLSelectElement>(
      '[aria-label="Affinity image source"]',
    )!;
    expect(select.options.length).toBe(3);
    select.value = "1";
    select.dispatchEvent(new Event("change"));
    expect(session.source).toBe(b);
  });

  it("publishes the selected scale/channels/options without reading data and overlays a standard segmentation", async () => {
    const f = fixture();
    const { session, prepareInput, createLive, viewer, groups, root } = f;
    session.open();
    fill(session, "Source scale index", "1");
    fill(session, "Channels for −X −Y −Z", "3, 1, 2");
    fill(session, "High threshold", "0.8");
    fill(session, "Low threshold", "0.2");
    fill(session, "Size threshold", "12");
    fill(session, "Dust threshold", "3");
    const originalSource = f.a.layer!.toJSON();
    addButton(session).click();
    await vi.waitFor(() =>
      expect(session.status).toContain("Added live layer:"),
    );
    expect(prepareInput).toHaveBeenLastCalledWith(f.a.layer, 1);
    expect(createLive).toHaveBeenCalledExactlyOnceWith(
      f.inputs.at(-1),
      [3, 1, 2],
      {
        highThreshold: 0.8,
        lowThreshold: 0.2,
        sizeThreshold: 12,
        dustThreshold: 3,
      },
      expect.any(Function),
    );
    expect(f.publish).toHaveBeenCalledExactlyOnceWith(
      viewer.chunkManager,
      f.lives[0],
    );
    const layer = f.resultLayers[0];
    expect(makeLayer).toHaveBeenCalledWith(root, "affinities watershed", {
      type: "segmentation",
      source: f.publications[0].url,
      ignoreNullVisibleSet: true,
      selectedAlpha: 0.5,
    });
    expect(root.add).toHaveBeenCalledExactlyOnceWith(layer);
    expect(groups[0].add).toHaveBeenCalledExactlyOnceWith(layer);
    expect(groups[1].add).not.toHaveBeenCalled();
    expect(f.sourceGroup.has(layer)).toBe(true);
    expect(f.otherGroup.has(layer)).toBe(false);
    expect(viewer.layout).toBe(f.layout);
    expect(f.layout).toEqual({ untouched: true });
    expect(f.a.layer!.toJSON()).toEqual(originalSource);
    expect(session.busy).toBe(false);
    expect(f.inputs.at(-1)!.dispose).not.toHaveBeenCalled();
    for (const input of f.inputs)
      expect(input.readRegion).not.toHaveBeenCalled();
    expect(f.publications[0].dispose).not.toHaveBeenCalled();
    deleteLayer(layer);
    expect(f.publications[0].dispose).toHaveBeenCalledOnce();
    expect(f.lives[0].dispose).toHaveBeenCalledOnce();
    expect(f.inputs.at(-1)!.dispose).toHaveBeenCalledOnce();
    session.reset();
    expect(f.publications[0].dispose).toHaveBeenCalledOnce();
  });

  it("uses an existing dynamic ONNX affinity image without changing its source or layout", async () => {
    const f = fixture();
    f.session.selectSource(f.b);
    const originalSource = f.b.layer!.toJSON();
    await f.session.addLayer();
    expect(f.prepareInput).toHaveBeenLastCalledWith(f.b.layer, 0);
    expect(f.groups[0].add).not.toHaveBeenCalled();
    expect(f.groups[1].add).toHaveBeenCalledExactlyOnceWith(f.resultLayers[0]);
    expect(f.b.layer!.toJSON()).toEqual(originalSource);
    expect(f.viewer.layout).toBe(f.layout);
    expect(f.session.status).toContain("Added live layer:");
  });

  it("does not impose an overall voxel limit or read the whole source at creation", async () => {
    const f = fixture();
    f.prepareInput.mockImplementationOnce(() => {
      const input = makeInput(0);
      input.upperBoundXYZ = [10010, 10020, 9970];
      f.inputs.push(input);
      return input;
    });
    await f.session.addLayer();
    expect(f.lives[0].info.shapeXYZ).toEqual([10000, 10000, 10000]);
    expect(f.session.statusLevel).toBe("info");
    expect(f.inputs.at(-1)!.readRegion).not.toHaveBeenCalled();
  });

  it("waits for selected source readiness and releases temporary metadata inputs", () => {
    const f = fixture();
    f.session.selectSource(undefined);
    f.prepareInput.mockImplementationOnce(() => {
      throw new Error("Image is still loading");
    });
    f.session.selectSource(f.b);
    f.session.open();
    expect(f.session.metadata).toBeUndefined();
    expect(f.session.statusLevel).toBe("error");
    expect(addButton(f.session).disabled).toBe(true);
    f.layerManager.readyStateChanged.dispatch();
    expect(f.session.metadata?.lowerBoundXYZ).toEqual([10, 20, -30]);
    expect(f.session.statusLevel).toBe("info");
    expect(addButton(f.session).disabled).toBe(false);
    expect(f.inputs.at(-1)!.dispose).toHaveBeenCalledOnce();
  });

  it("closing/reopening preserves drafts, pending activation, and live layers", async () => {
    const f = fixture();
    f.resultState.ready = false;
    f.session.open();
    fill(f.session, "High threshold", "0.8");
    const adding = f.session.addLayer();
    const input = f.inputs.at(-1)!;
    f.session.dialog!.close();
    expect(f.session.dialog).toBeUndefined();
    expect(f.session.busy).toBe(true);
    expect(input.signal.aborted).toBe(false);
    f.session.open();
    expect(field(f.session, "High threshold").value).toBe("0.8");
    expect(field(f.session, "High threshold").disabled).toBe(true);
    expect(addButton(f.session).disabled).toBe(true);
    await f.session.addLayer();
    expect(f.createLive).toHaveBeenCalledOnce();
    f.session.dialog!.close();
    f.resultState.ready = true;
    f.resultLayers[0].readyStateChanged.dispatch();
    await adding;
    expect(f.root.add).toHaveBeenCalledOnce();
    expect(f.publications[0].dispose).not.toHaveBeenCalled();
    f.session.open();
    expect(
      f.session.dialog!.body.querySelector('[role="status"]')!.textContent,
    ).toContain("Added live layer:");
    f.session.dialog!.close();
    expect(input.dispose).not.toHaveBeenCalled();
  });

  it("gives each output its own lifetime independent of subsequent source, scale, and settings selection", async () => {
    const f = fixture();
    await f.session.addLayer();
    const firstInput = f.inputs.at(-1)!;
    f.session.selectScale("1");
    f.session.selectSource(f.b);
    f.session.highThreshold = "0.8";
    expect(f.publications[0].dispose).not.toHaveBeenCalled();
    await f.session.addLayer();
    expect(f.createLive).toHaveBeenCalledTimes(2);
    expect(f.resultLayers.map((layer) => f.layerManager.has(layer))).toEqual([
      true,
      true,
    ]);
    expect(firstInput.dispose).not.toHaveBeenCalled();
    firstInput.invalidate(false);
    f.a.layer!.dataSourcesChanged.dispatch();
    await Promise.resolve();
    expect(f.publications[0].dispose).toHaveBeenCalledOnce();
    expect(f.publications[1].dispose).not.toHaveBeenCalled();
    expect(f.sourceGroup.has(f.resultLayers[0])).toBe(false);
    expect(f.otherGroup.has(f.resultLayers[1])).toBe(true);
    expect(f.session.source).toBe(f.b);
    expect(f.session.statusLevel).toBe("error");
  });

  it("stops on source deletion even if another owner retains the source object", async () => {
    const f = fixture();
    await f.session.addLayer();
    const retained = f.a.addRef();
    deleteLayer(f.a);
    expect(f.a.wasDisposed).not.toBe(true);
    expect(f.session.source).toBeUndefined();
    expect(f.sourceGroup.has(f.resultLayers[0])).toBe(false);
    expect(f.publications[0].dispose).toHaveBeenCalledOnce();
    expect(f.session.statusLevel).toBe("error");
    retained.dispose();
  });

  it("releases on output deletion even if another owner retains the output object", async () => {
    const f = fixture();
    await f.session.addLayer();
    const retained = f.resultLayers[0].addRef();
    deleteLayer(f.resultLayers[0]);
    expect(f.resultLayers[0].wasDisposed).not.toBe(true);
    expect(f.publications[0].dispose).toHaveBeenCalledOnce();
    retained.dispose();
    expect(f.publications[0].dispose).toHaveBeenCalledOnce();
  });

  for (const phase of ["activating", "active"] as const) {
    it.each([
      "delete",
      "replace",
      "data",
      "transform",
      "silent invalidation",
      "reset",
      "state reset",
      "dispose",
    ])(`cancels and removes an ${phase} layer after %s`, async (action) => {
      const f = fixture();
      f.resultState.ready = phase === "active";
      const adding = f.session.addLayer();
      if (phase === "active") await adding;
      const input = f.inputs.at(-1)!;
      if (action === "delete") deleteLayer(f.a);
      else if (action === "replace") {
        f.a.layer = f.b.layer;
        f.a.layerChanged.dispatch();
      } else if (action === "data") {
        input.invalidate(false);
        f.a.layer!.dataSourcesChanged.dispatch();
      } else if (action === "transform") input.invalidate();
      else if (action === "silent invalidation") {
        input.invalidate(false);
        f.layerManager.readyStateChanged.dispatch();
      } else if (action === "reset") f.viewer.resetInitiated.dispatch();
      else if (action === "state reset") f.viewer.state.stateReset.dispatch();
      else f.owner.dispose();
      await adding;
      expect(input.signal.aborted).toBe(true);
      expect(input.dispose).toHaveBeenCalledOnce();
      expect(f.session.busy).toBe(false);
      expect(f.publications[0].dispose).toHaveBeenCalledOnce();
      expect(f.lives[0].dispose).toHaveBeenCalledOnce();
      expect(f.layerManager.has(f.resultLayers[0])).toBe(false);
      expect(f.sourceGroup.has(f.resultLayers[0])).toBe(false);
      expect(f.resultLayers[0].wasDisposed).toBe(true);
      expect(f.session.status).not.toContain("Added live layer:");
      if (!["reset", "state reset", "dispose"].includes(action))
        expect(f.session.statusLevel).toBe("error");
    });
  }

  it("does not cancel for navigation, shader, visibility, rename, or unrelated readiness changes", async () => {
    const f = fixture();
    await f.session.addLayer();
    f.a.name = "renamed";
    f.a.visible = false;
    f.a.layerChanged.dispatch();
    f.layerManager.readyStateChanged.dispatch();
    f.layerManager.layersChanged.dispatch();
    expect(f.inputs.at(-1)!.signal.aborted).toBe(false);
    expect(f.publications[0].dispose).not.toHaveBeenCalled();
    expect(f.session.source).toBe(f.a);
  });

  it("preserves a valid live layer/publication on non-semantic dataSourcesChanged notifications", async () => {
    const f = fixture();
    await f.session.addLayer();
    const input = f.inputs.at(-1)!;
    const live = f.lives[0];
    expect(() => input.assertValid()).not.toThrow();
    expect(() => live.assertValid()).not.toThrow();
    live.assertValid.mockClear();
    const status = f.session.status;
    // Toggling "Enable default subsource set" can emit this notification
    // without changing the enabled subsources or invalidating the input.
    f.a.layer!.dataSourcesChanged.dispatch();
    await Promise.resolve();
    expect(f.layerManager.has(f.resultLayers[0])).toBe(true);
    expect(f.sourceGroup.has(f.resultLayers[0])).toBe(true);
    expect(live.assertValid).toHaveBeenCalled();
    expect(() => input.assertValid()).not.toThrow();
    expect(() => live.assertValid()).not.toThrow();
    expect(input.dispose).not.toHaveBeenCalled();
    expect(live.dispose).not.toHaveBeenCalled();
    expect(f.publications[0].dispose).not.toHaveBeenCalled();
    expect(f.session.status).toBe(status);
    expect(f.session.statusLevel).toBe("info");
  });

  it("reports live computation errors and removes cached valid-looking output, ignoring late errors", async () => {
    const f = fixture();
    await f.session.addLayer();
    f.session.open();
    f.onErrors[0](new Error("worker failed"));
    expect(f.session.statusLevel).toBe("error");
    expect(
      f.session.dialog!.body.querySelector('[role="status"]')!.textContent,
    ).toContain("worker failed");
    expect(f.layerManager.has(f.resultLayers[0])).toBe(false);
    expect(f.publications[0].dispose).toHaveBeenCalledOnce();
    await f.session.addLayer();
    const status = f.session.status;
    f.onErrors[0](new Error("old worker failure"));
    expect(f.session.status).toBe(status);
    expect(f.publications[1].dispose).not.toHaveBeenCalled();
  });

  it("does not let a successful metadata refresh hide live source invalidation", async () => {
    const f = fixture();
    await f.session.addLayer();
    f.inputs.at(-1)!.invalidate(false);
    f.a.layer!.dataSourcesChanged.dispatch();
    await Promise.resolve();
    expect(f.session.metadata).toBeDefined();
    expect(f.session.statusLevel).toBe("error");
    expect(f.session.status).toContain("Watershed stopped");
    expect(f.session.status).toContain("Source snapshot changed");
    expect(f.layerManager.has(f.resultLayers[0])).toBe(false);
    expect(f.publications[0].dispose).toHaveBeenCalledOnce();
  });

  it("handles reset reentrantly before layer construction", async () => {
    const f = fixture();
    const remove = f.session.changed.add(() => {
      if (f.session.busy) f.session.reset();
    });
    await f.session.addLayer();
    remove();
    expect(makeLayer).not.toHaveBeenCalled();
    expect(f.publications[0].dispose).toHaveBeenCalledOnce();
    expect(f.inputs.at(-1)!.dispose).toHaveBeenCalledOnce();
  });

  it("does not re-add a layer to groups after a reentrant reset during publication", async () => {
    const f = fixture();
    vi.mocked(f.root.add).mockImplementationOnce((layer) => {
      f.layerManager.addManagedLayer(layer);
      f.session.reset();
    });
    await f.session.addLayer();
    expect(f.groups[0].add).not.toHaveBeenCalled();
    expect(f.layerManager.has(f.resultLayers[0])).toBe(false);
    expect(f.publications[0].dispose).toHaveBeenCalledOnce();
  });

  it.each([
    "input",
    "constructor",
    "publish",
    "make layer",
    "load",
    "activation",
  ])(
    "never reports success or leaks ownership on %s failure",
    async (stage) => {
      const f = fixture();
      if (stage === "input")
        f.prepareInput.mockImplementation(() => {
          throw new Error("Non-native transform");
        });
      else if (stage === "constructor")
        f.createLive.mockImplementation(() => {
          throw new Error("Invalid live configuration");
        });
      else if (stage === "publish")
        f.publish.mockImplementation(() => {
          throw new Error("publish failed");
        });
      else if (stage === "make layer")
        vi.mocked(makeLayer).mockImplementation(() => {
          throw new Error("layer failed");
        });
      else if (stage === "load")
        f.resultState.error = new Error("result missing");
      else f.resultState.hasVolume = false;
      await f.session.addLayer();
      expect(f.session.busy).toBe(false);
      expect(f.session.statusLevel).toBe("error");
      expect(f.session.status).toContain("Watershed failed:");
      expect(f.session.status).not.toContain("Added live layer:");
      expect(f.root.add).not.toHaveBeenCalled();
      for (const publication of f.publications)
        expect(publication.dispose).toHaveBeenCalledOnce();
      for (const live of f.lives) expect(live.dispose).toHaveBeenCalledOnce();
      for (const input of f.inputs)
        expect(input.dispose).toHaveBeenCalledOnce();
    },
  );

  it("safely handles a synchronous onError callback during construction", async () => {
    const f = fixture();
    f.createLive.mockImplementationOnce(
      (input, _channels, _options, onError) => {
        const live = makeLive(input);
        f.lives.push(live);
        onError(new Error("startup failed"));
        return live as unknown as LiveWatershed;
      },
    );
    await f.session.addLayer();
    expect(f.session.status).toContain("startup failed");
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.lives[0].dispose).toHaveBeenCalledOnce();
    expect(f.inputs.at(-1)!.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    ["scaleIndex", "-1", "Source scale index"],
    ["scaleIndex", "0.5", "Source scale index"],
    ["scaleIndex", "", "Source scale index"],
    ["channelsXYZ", "0, 1", "three integers"],
    ["channelsXYZ", "foo, 1, 2", "integer ≥ 0"],
    ["channelsXYZ", "0, 1, 4", "less than 4"],
    ["channelsXYZ", "-1, 1, 2", "integer ≥ 0"],
    ["channelsXYZ", "0, 0, 2", "distinct affinity channels"],
    ["highThreshold", "NaN", "between 0 and 1"],
    ["highThreshold", "1.01", "between 0 and 1"],
    ["lowThreshold", "", "between 0 and 1"],
    ["lowThreshold", "0.999999", "low < high"],
    ["lowThreshold", "0.99999", "low < high"],
    ["lowThreshold", "0.9999899999", "float32"],
    ["sizeThreshold", "-1", "integer ≥ 0"],
    ["sizeThreshold", "1.5", "integer ≥ 0"],
    ["sizeThreshold", "4294967296", "uint32"],
    ["dustThreshold", "NaN", "integer ≥ 0"],
  ] as const)(
    "rejects invalid %s = %s before creating a live volume",
    async (key, value, message) => {
      const f = fixture();
      f.session[key] = value;
      await f.session.addLayer();
      expect(f.createLive).not.toHaveBeenCalled();
      expect(f.publish).not.toHaveBeenCalled();
      expect(f.session.statusLevel).toBe("error");
      expect(f.session.status).toContain(message);
      expect(f.session.busy).toBe(false);
      for (const input of f.inputs)
        expect(input.dispose).toHaveBeenCalledOnce();
    },
  );
});
