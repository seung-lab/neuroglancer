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
import { RefCounted } from "#src/util/disposable.js";
import { registerActionListener } from "#src/util/event_action_map.js";
import { NullarySignal } from "#src/util/signal.js";
import type { Viewer } from "#src/viewer.js";
import {
  DEFAULT_WATERSHED_OPTIONS,
  type WatershedResult,
} from "#src/watershed/base.js";
import type { PreparedAffinityInput } from "#src/watershed/input.js";

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

const result: WatershedResult = {
  data: Uint32Array.of(0, 1),
  shapeXYZ: [2, 1, 1],
  offsetXYZ: [10, 20, -30],
  spacingXYZ: [2e-9, 2e-9, 8e-9],
  unitsXYZ: ["m", "m", "m"],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((r, e) => {
    resolve = r;
    reject = e;
  });
  return { promise, resolve, reject };
}

function makeInput(scaleIndex: number) {
  const abort = new AbortController();
  let valid = true;
  const input = {
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
    dispose: vi.fn(() => abort.abort()),
    invalidate: (signal = true) => {
      valid = false;
      if (signal) abort.abort();
    },
  } satisfies PreparedAffinityInput & { invalidate(signal?: boolean): void };
  return input;
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
  const compute = vi
    .fn<WatershedDependencies["compute"]>()
    .mockResolvedValue(result);
  const publications: Array<{
    url: string;
    dispose: ReturnType<typeof vi.fn>;
  }> = [];
  const publish = vi.fn<WatershedDependencies["publish"]>(() => {
    const publication = {
      url: `watershed://session/${publications.length}`,
      dispose: vi.fn(),
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
          // Successful LoadedLayerDataSource also has an `error` property,
          // whose value is undefined: testing key presence is not sufficient.
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
    new WatershedSession(viewer, { prepareInput, compute, publish }),
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
    compute,
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

describe("WASM watershed UI", () => {
  it("binds its palette action feature-locally and lets the viewer dispose the dialog", () => {
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

  it("initializes native XYZ bounds and defaults, explains semantics, and selects sources by identity", () => {
    const { session, inputs, b } = fixture();
    session.open();
    expect(field(session, "Source scale index").value).toBe("0");
    expect(field(session, "ROI lower X Y Z").value).toBe("10, 20, -30");
    expect(field(session, "ROI size X Y Z").value).toBe("128, 128, 64");
    expect(field(session, "Channels for −X −Y −Z").value).toBe("0, 1, 2");
    expect(session.highThreshold).toBe(
      String(DEFAULT_WATERSHED_OPTIONS.highThreshold),
    );
    expect(session.lowThreshold).toBe(
      String(DEFAULT_WATERSHED_OPTIONS.lowThreshold),
    );
    expect(session.sizeThreshold).toBe("50");
    expect(session.dustThreshold).toBe("50");
    expect(inputs[0].dispose).toHaveBeenCalledOnce();
    const text = session.dialog!.body.textContent!;
    for (const explanation of [
      "negative axes",
      "data type maximum",
      "floating-point values are unchanged",
      "Non-native transforms are rejected",
      "SINGLE volume",
      "no tiled stitching",
      "padding",
      "2**21",
      "not shareable",
      "restored URL",
      "GPL v3+",
      "worker",
    ])
      expect(text).toContain(explanation);
    const select = session.dialog!.body.querySelector<HTMLSelectElement>(
      '[aria-label="Affinity image source"]',
    )!;
    expect(select.options.length).toBe(3);
    select.value = "1";
    select.dispatchEvent(new Event("change"));
    expect(session.source).toBe(b);
  });

  it("passes the selected scale, XYZ ROI, negative-axis channels and options once and overlays a visible segmentation", async () => {
    const f = fixture();
    const { session, compute, prepareInput, viewer, groups, root } = f;
    session.open();
    fill(session, "Source scale index", "1");
    expect(field(session, "ROI lower X Y Z").value).toBe("-4, 10, 2");
    expect(field(session, "ROI size X Y Z").value).toBe("64, 80, 40");
    fill(session, "ROI lower X Y Z", "-3, 15, 3");
    fill(session, "ROI size X Y Z", "5 6 7");
    fill(session, "Channels for −X −Y −Z", "3, 1, 2");
    fill(session, "High threshold", "0.8");
    fill(session, "Low threshold", "0.2");
    fill(session, "Size threshold", "12");
    fill(session, "Dust threshold", "3");
    const originalSource = f.a.layer!.toJSON();
    await session.run();
    expect(prepareInput).toHaveBeenLastCalledWith(f.a.layer, 1);
    expect(compute).toHaveBeenCalledExactlyOnceWith(
      f.inputs.at(-1),
      [-3, 15, 3],
      [5, 6, 7],
      [3, 1, 2],
      {
        highThreshold: 0.8,
        lowThreshold: 0.2,
        sizeThreshold: 12,
        dustThreshold: 3,
      },
      expect.any(AbortSignal),
    );
    expect(f.publish).toHaveBeenCalledExactlyOnceWith(
      viewer.chunkManager,
      result,
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
    expect(session.status).toContain("Completed:");
    expect(session.busy).toBe(false);
    for (const input of f.inputs) expect(input.dispose).toHaveBeenCalledOnce();
    expect(f.publications[0].dispose).not.toHaveBeenCalled();
    deleteLayer(layer);
    expect(f.publications[0].dispose).toHaveBeenCalledOnce();
    session.reset();
    expect(f.publications[0].dispose).toHaveBeenCalledOnce();
  });

  it("uses an existing dynamic ONNX image exactly like a static affinity image", async () => {
    const f = fixture();
    f.session.selectSource(f.b);
    const originalSource = f.b.layer!.toJSON();
    await f.session.run();
    expect(f.prepareInput).toHaveBeenLastCalledWith(f.b.layer, 0);
    expect(f.groups[0].add).not.toHaveBeenCalled();
    expect(f.groups[1].add).toHaveBeenCalledExactlyOnceWith(f.resultLayers[0]);
    expect(f.b.layer!.toJSON()).toEqual(originalSource);
    expect(f.viewer.layout).toBe(f.layout);
    expect(f.session.status).toContain("Completed:");
  });

  it("accepts exactly 2**21 voxels through the Run button", async () => {
    const f = fixture();
    f.session.open();
    fill(f.session, "ROI size X Y Z", "256, 128, 64");
    const run = [...f.session.dialog!.footer.querySelectorAll("button")].find(
      (button) => button.textContent === "Run watershed",
    )!;
    run.click();
    await vi.waitFor(() => expect(f.session.status).toContain("Completed:"));
    expect(f.compute).toHaveBeenCalledOnce();
    expect(f.compute.mock.calls[0][2]).toEqual([256, 128, 64]);
  });

  it("retries metadata when a selected dynamic image becomes ready", () => {
    const f = fixture();
    f.session.selectSource(undefined);
    f.prepareInput.mockImplementationOnce(() => {
      throw new Error("Image is still loading");
    });
    f.session.selectSource(f.b);
    expect(f.session.metadata).toBeUndefined();
    expect(f.session.statusLevel).toBe("error");
    f.layerManager.readyStateChanged.dispatch();
    expect(f.session.metadata?.lowerBoundXYZ).toEqual([10, 20, -30]);
    expect(f.session.shapeXYZ).toBe("128, 128, 64");
    expect(f.session.statusLevel).toBe("info");
    expect(f.inputs.at(-1)!.dispose).toHaveBeenCalledOnce();
  });

  it("completed snapshots outlive deletion of their source without retaining inputs", async () => {
    const f = fixture();
    await f.session.run();
    deleteLayer(f.a);
    expect(f.a.wasDisposed).toBe(true);
    expect(f.session.source).toBeUndefined();
    expect(f.sourceGroup.has(f.resultLayers[0])).toBe(true);
    expect(f.publications[0].dispose).not.toHaveBeenCalled();
    for (const input of f.inputs) expect(input.dispose).toHaveBeenCalledOnce();
    deleteLayer(f.resultLayers[0]);
    expect(f.publications[0].dispose).toHaveBeenCalledOnce();
  });

  it("closing/reopening the dialog preserves drafts, running work, and completed snapshots", async () => {
    const f = fixture();
    const pending = deferred<WatershedResult>();
    f.compute.mockReturnValue(pending.promise);
    f.session.open();
    fill(f.session, "ROI size X Y Z", "2 1 1");
    const running = f.session.run();
    const signal = f.compute.mock.calls[0][5];
    f.session.dialog!.close();
    expect(f.session.dialog).toBeUndefined();
    expect(f.session.busy).toBe(true);
    expect(signal.aborted).toBe(false);
    f.session.open();
    expect(field(f.session, "ROI size X Y Z").value).toBe("2 1 1");
    expect(field(f.session, "ROI size X Y Z").disabled).toBe(true);
    f.session.dialog!.close();
    pending.resolve(result);
    await running;
    expect(f.root.add).toHaveBeenCalledOnce();
    expect(f.publications[0].dispose).not.toHaveBeenCalled();
    f.session.open();
    expect(
      f.session.dialog!.body.querySelector('[role="status"]')!.textContent,
    ).toContain("Completed:");
    f.session.dialog!.close();
    expect(f.publications[0].dispose).not.toHaveBeenCalled();
  });

  it.each(["reset", "state reset", "dispose"])(
    "releases completed published data on viewer %s",
    async (action) => {
      const f = fixture();
      await f.session.run();
      if (action === "reset") f.viewer.resetInitiated.dispatch();
      else if (action === "state reset") f.viewer.state.stateReset.dispatch();
      else f.owner.dispose();
      expect(f.publications[0].dispose).toHaveBeenCalledOnce();
      deleteLayer(f.resultLayers[0]);
      expect(f.publications[0].dispose).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "cancel",
    "source",
    "delete",
    "replace",
    "data",
    "transform",
    "invalid snapshot",
    "scale",
    "reset",
    "dispose",
  ])("aborts reads and discards late compute after %s", async (action) => {
    const f = fixture();
    const pending = deferred<WatershedResult>();
    f.compute.mockReturnValue(pending.promise);
    const running = f.session.run();
    const input = f.inputs.at(-1)!;
    const signal = f.compute.mock.calls[0][5];
    if (action === "cancel") f.session.cancel();
    else if (action === "source") f.session.selectSource(f.b);
    else if (action === "delete") deleteLayer(f.a);
    else if (action === "replace") {
      f.a.layer = f.b.layer;
      f.a.layerChanged.dispatch();
    } else if (action === "data") f.a.layer!.dataSourcesChanged.dispatch();
    else if (action === "transform") input.invalidate();
    else if (action === "invalid snapshot") {
      input.invalidate(false);
      f.layerManager.readyStateChanged.dispatch();
    } else if (action === "scale") f.session.selectScale("1");
    else if (action === "reset") f.viewer.resetInitiated.dispatch();
    else f.owner.dispose();
    expect(signal.aborted).toBe(true);
    expect(input.dispose).toHaveBeenCalledOnce();
    expect(f.session.busy).toBe(false);
    pending.resolve(result);
    await running;
    expect(f.publish).not.toHaveBeenCalled();
    expect(makeLayer).not.toHaveBeenCalled();
    expect(f.root.add).not.toHaveBeenCalled();
    expect(f.session.status).not.toContain("Completed:");
  });

  it("checks silent snapshot invalidation again immediately before publishing", async () => {
    const f = fixture();
    const pending = deferred<WatershedResult>();
    f.compute.mockReturnValue(pending.promise);
    const running = f.session.run();
    f.inputs.at(-1)!.invalidate(false);
    pending.resolve(result);
    await running;
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.root.add).not.toHaveBeenCalled();
    expect(f.session.status).not.toContain("Completed:");
    expect(f.inputs.at(-1)!.dispose).toHaveBeenCalledOnce();
  });

  it("does not start compute after a reentrant cancellation", async () => {
    const f = fixture();
    const remove = f.session.changed.add(() => {
      if (f.session.busy) f.session.cancel();
    });
    await f.session.run();
    remove();
    expect(f.compute).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.inputs.at(-1)!.dispose).toHaveBeenCalledOnce();
  });

  it("ignores late errors without replacing a newer job's completion", async () => {
    const f = fixture();
    const pending = deferred<WatershedResult>();
    f.compute.mockReturnValueOnce(pending.promise);
    const first = f.session.run();
    f.session.cancel();
    await f.session.run();
    const status = f.session.status;
    expect(status).toContain("Completed:");
    pending.reject(new Error("old worker failure"));
    await first;
    expect(f.session.status).toBe(status);
    expect(f.publish).toHaveBeenCalledOnce();
  });

  it("does not cancel on source navigation, shader, visibility, rename, or unrelated ready changes", async () => {
    const f = fixture();
    const pending = deferred<WatershedResult>();
    f.compute.mockReturnValue(pending.promise);
    const running = f.session.run();
    f.a.name = "renamed";
    f.a.visible = false;
    f.a.layerChanged.dispatch();
    f.layerManager.readyStateChanged.dispatch();
    f.layerManager.layersChanged.dispatch();
    expect(f.compute.mock.calls[0][5].aborted).toBe(false);
    expect(f.session.source).toBe(f.a);
    expect(f.inputs.at(-1)!.dispose).not.toHaveBeenCalled();
    pending.resolve(result);
    await running;
    expect(f.publish).toHaveBeenCalledOnce();
    expect(f.session.status).toContain("Completed: renamed watershed");
  });

  it.each(["cancel", "transform", "reset"])(
    "discards a result still loading after %s, releasing its publication",
    async (action) => {
      const f = fixture();
      f.resultState.ready = false;
      f.session.open();
      const running = f.session.run();
      await vi.waitFor(() => expect(makeLayer).toHaveBeenCalledOnce());
      if (action === "cancel")
        [...f.session.dialog!.footer.querySelectorAll("button")]
          .find((button) => button.textContent === "Cancel")!
          .click();
      else if (action === "transform") f.inputs.at(-1)!.invalidate();
      else f.viewer.resetInitiated.dispatch();
      await running;
      expect(f.root.add).not.toHaveBeenCalled();
      expect(f.publications[0].dispose).toHaveBeenCalledOnce();
      expect(f.resultLayers[0].wasDisposed).toBe(true);
      expect(f.session.status).not.toContain("Completed:");
    },
  );

  it.each(["input", "compute", "publish", "load", "activation"])(
    "never reports completion on %s failure",
    async (stage) => {
      const f = fixture();
      if (stage === "input")
        f.prepareInput.mockImplementation(() => {
          throw new Error("Non-native transform");
        });
      else if (stage === "compute")
        f.compute.mockRejectedValue(new Error("worker failed"));
      else if (stage === "publish")
        f.publish.mockImplementation(() => {
          throw new Error("publish failed");
        });
      else if (stage === "load")
        f.resultState.error = new Error("result missing");
      else f.resultState.hasVolume = false;
      await f.session.run();
      expect(f.session.busy).toBe(false);
      expect(f.session.statusLevel).toBe("error");
      expect(f.session.status).toContain("Watershed failed:");
      expect(f.session.status).not.toContain("Completed:");
      expect(f.root.add).not.toHaveBeenCalled();
      if (f.publications.length)
        expect(f.publications[0].dispose).toHaveBeenCalledOnce();
      for (const input of f.inputs)
        expect(input.dispose).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["scaleIndex", "-1", "Source scale index"],
    ["scaleIndex", "0.5", "Source scale index"],
    ["scaleIndex", "", "Source scale index"],
    ["lowerXYZ", "10, 20", "three integers"],
    ["lowerXYZ", "foo, 20, -30", "integer"],
    ["lowerXYZ", "9, 20, -30", "fully inside"],
    ["shapeXYZ", "0, 1, 1", "integer ≥ 1"],
    ["shapeXYZ", "1.5, 1, 1", "integer ≥ 1"],
    ["shapeXYZ", "129, 129, 129", "2**21 maximum"],
    ["shapeXYZ", "301, 1, 1", "fully inside"],
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
    "rejects invalid %s = %s before compute",
    async (key, value, message) => {
      const f = fixture();
      f.session[key] = value;
      await f.session.run();
      expect(f.compute).not.toHaveBeenCalled();
      expect(f.publish).not.toHaveBeenCalled();
      expect(f.session.statusLevel).toBe("error");
      expect(f.session.status).toContain(message);
      expect(f.session.busy).toBe(false);
      for (const input of f.inputs)
        expect(input.dispose).toHaveBeenCalledOnce();
    },
  );
});
