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
import {
  INFERENCE_RECIPE_URL,
  type InferenceRecipe,
} from "#src/inference/recipe.js";
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
import {
  DEFAULT_WATERSHED_HALO,
  DEFAULT_WATERSHED_OPTIONS,
} from "#src/watershed/base.js";
import type { PreparedAffinityInput } from "#src/watershed/input.js";
import { LiveWatershed } from "#src/watershed/live.js";
import {
  parseWatershedRecipe,
  WATERSHED_RECIPE_URL,
  type WatershedRecipe,
} from "#src/watershed/recipe.js";
import { installWatershedRecipeContext } from "#src/watershed/restore.js";
import { computeWatershed } from "#src/watershed/run.js";

vi.mock("#src/watershed/run.js", () => ({ computeWatershed: vi.fn() }));

vi.mock("#src/layer/index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  makeLayer: vi.fn(),
}));

vi.mock("#src/watershed/restore.js", () => ({
  installWatershedRecipeContext: vi.fn(),
}));

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function makeInput(scaleIndex: number, channelCount = 4) {
  const abort = new AbortController();
  let valid = true;
  return {
    lowerBoundXYZ: scaleIndex === 0 ? [10, 20, -30] : [-4, 10, 2],
    upperBoundXYZ: scaleIndex === 0 ? [310, 220, 70] : [60, 90, 42],
    channelCount,
    spacingXYZ: scaleIndex === 0 ? [2e-9, 2e-9, 8e-9] : [4e-9, 4e-9, 16e-9],
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
  const changed = new NullarySignal();
  return {
    info: {
      shapeXYZ: input.upperBoundXYZ.map((x, i) => x - input.lowerBoundXYZ[i]),
      offsetXYZ: input.lowerBoundXYZ.map((x, i) => x + input.originXYZ[i]),
      spacingXYZ: [...input.spacingXYZ],
      unitsXYZ: [...input.unitsXYZ],
      chunkShapeXYZ: [64, 64, 32],
    },
    signal: input.signal,
    changed,
    setRegion: vi.fn<LiveWatershed["setRegion"]>(() => changed.dispatch()),
    assertValid: vi.fn(() => input.assertValid()),
    dispose: vi.fn(disposableOnce(() => input.dispose())),
  };
}

function fixture(channelCount = 4) {
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
  const sourceSpecs = {
    a: { url: "precomputed://https://example.com/affinities" },
    b: {
      url: INFERENCE_RECIPE_URL,
      state: {
        version: 2,
        profile: "ncdhw-centered-v2",
        mode: "live",
        source: {
          name: "raw image",
          source: { url: "precomputed://https://example.com/raw" },
        },
        model: {
          kind: "url",
          name: "affinities.onnx",
          urls: ["https://example.com/affinities.onnx"],
          size: 12345,
          sha256: "ab".repeat(32),
        },
        provider: "cpu",
        inputScaleIndex: 1,
        spacingZYX: [8e-9, 2e-9, 2e-9],
        outputSpacingZYX: [8e-9, 2e-9, 2e-9],
      } satisfies InferenceRecipe,
    },
  };
  const image = (source: unknown) =>
    Object.assign(Object.create(ImageUserLayer.prototype), {
      dataSourcesChanged: new NullarySignal(),
      toJSON: () => ({ type: "image", source }),
    }) as ImageUserLayer;
  const a = managed("affinities", image(sourceSpecs.a));
  // A live ONNX result is just another existing ImageUserLayer to this UI,
  // with the same portable source state returned by a real layer's toJSON.
  const b = managed("affinities", image(sourceSpecs.b));
  layerManager.addManagedLayer(a);
  layerManager.addManagedLayer(b);
  sourceGroup.addManagedLayer(a.addRef());
  otherGroup.addManagedLayer(b.addRef());
  const inputs: ReturnType<typeof makeInput>[] = [];
  const channelCounts = new Map([
    [a.layer!, [channelCount]],
    [b.layer!, [channelCount]],
  ]);
  const prepareInput = vi.fn<WatershedDependencies["prepareInput"]>(
    (layer, scaleIndex = 0) => {
      const counts = channelCounts.get(layer)!;
      const input = makeInput(scaleIndex, counts[scaleIndex] ?? counts[0]);
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
    .mockImplementation((_manager, name, spec) => {
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
          toJSON: () => ({ ...spec }),
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
  const watchers: Array<{
    input: PreparedAffinityInput;
    layer: ManagedUserLayer;
    onRegion: Parameters<WatershedDependencies["watchViewport"]>[3];
    onError: Parameters<WatershedDependencies["watchViewport"]>[4];
    dispose: ReturnType<typeof vi.fn>;
  }> = [];
  const watchViewport = vi.fn<WatershedDependencies["watchViewport"]>(
    (_viewer, input, layer, onRegion, onError) => {
      const dispose = vi.fn();
      watchers.push({ input, layer, onRegion, onError, dispose });
      return dispose;
    },
  );
  const session = owner.registerDisposer(
    new WatershedSession(viewer, {
      prepareInput,
      createLive,
      publish,
      watchViewport,
    }),
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
    sourceSpecs,
    inputs,
    channelCounts,
    prepareInput,
    createLive,
    lives,
    onErrors,
    publish,
    publications,
    resultState,
    resultLayers,
    watchViewport,
    watchers,
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

const probabilityFields = [
  ["High threshold", "highThreshold"],
  ["Low threshold", "lowThreshold"],
  ["Mask threshold", "maskThreshold"],
  ["Agglomeration threshold (agg_threshold)", "aggThreshold"],
] as const;

function selectSource(session: WatershedSession, index: number) {
  const select = session.dialog!.body.querySelector<HTMLSelectElement>(
    '[aria-label="Affinity image source"]',
  )!;
  select.value = String(index);
  select.dispatchEvent(new Event("change"));
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
    const uninstall = vi.fn();
    vi.mocked(installWatershedRecipeContext).mockReturnValueOnce(uninstall);
    const session = bindWatershed(viewer);
    expect(installWatershedRecipeContext).toHaveBeenCalledExactlyOnceWith(
      viewer,
    );
    expect(uninstall).not.toHaveBeenCalled();
    expect(session.dialog).toBeUndefined();
    expect(commandRegistry.get("open-watershed")?.label).toBe("WASM Watershed");
    new ActionCommand("open-watershed", "WASM Watershed").invoke({
      dispatchTarget: element,
    });
    const dialog = session.dialog!;
    expect(dialog.headerTitle.textContent).toBe("WASM Watershed");
    expect(field(session, "Use last channel as mask").disabled).toBe(true);
    expect(field(session, "Mask threshold").disabled).toBe(true);
    owner.dispose();
    expect(dialog.wasDisposed).toBe(true);
    expect(session.wasDisposed).toBe(true);
    expect(uninstall).toHaveBeenCalledOnce();
    expect(commandRegistry.get("open-watershed")).toBeUndefined();
  });

  it("offers one Add operation, defaults/advanced controls, and source identity selection without crop fields", () => {
    const { session, inputs, b } = fixture();
    session.open();
    expect(field(session, "Source scale index").value).toBe("0");
    const halo = field(session, "Halo (voxels)");
    expect(halo.type).toBe("number");
    expect(halo.value).toBe(String(DEFAULT_WATERSHED_HALO));
    expect(halo.min).toBe("0");
    expect(halo.step).toBe("1");
    expect(halo.max).toBe("");
    expect(halo.disabled).toBe(false);
    const channels = field(session, "Channels for −X −Y −Z");
    expect(channels.value).toBe("0, 1, 2");
    expect(channels.type).toBe("text");
    expect(channels.closest("details")).not.toBeNull();
    // Public mask drafts: useLastChannelAsMask is boolean, maskThreshold is text.
    expect(session.useLastChannelAsMask).toBe(false);
    expect(session.maskThreshold).toBe("0.3");
    const useMask = field(session, "Use last channel as mask");
    expect(useMask.type).toBe("checkbox");
    expect(useMask.checked).toBe(false);
    expect(useMask.disabled).toBe(false);
    const maskThreshold = field(session, "Mask threshold");
    expect(maskThreshold.type).toBe("number");
    expect(maskThreshold.value).toBe("0.3");
    expect(maskThreshold.min).toBe("0");
    expect(maskThreshold.max).toBe("1");
    expect(maskThreshold.step).toBe("0.01");
    expect(maskThreshold.disabled).toBe(true);
    expect(maskThreshold.closest("details")).not.toBeNull();
    for (const key of [
      "highThreshold",
      "lowThreshold",
      "sizeThreshold",
      "dustThreshold",
    ] as const)
      expect(session[key]).toBe(String(DEFAULT_WATERSHED_OPTIONS[key]));
    expect(inputs[0].dispose).toHaveBeenCalledOnce();
    const body = session.dialog!.body;
    expect(
      [...body.querySelectorAll("input")].map((input) =>
        input.getAttribute("aria-label"),
      ),
    ).toEqual([
      "Source scale index",
      "Halo (voxels)",
      "Channels for −X −Y −Z",
      "Use last channel as mask",
      "Mask threshold",
      "High threshold",
      "Low threshold",
      "Size threshold",
      "Dust threshold",
      "Agglomerate watershed basins",
      "Agglomeration threshold (agg_threshold)",
    ]);
    expect(body.querySelector("details")!.open).toBe(false);
    expect(
      [...session.dialog!.footer.querySelectorAll("button")].map(
        (x) => x.textContent,
      ),
    ).toEqual(["Add watershed layer", "Close"]);
    expect(addButton(session).disabled).toBe(false);
    for (const explanation of [
      "one shared result",
      "all visible slice views",
      "As you navigate",
      "150 ms debounce",
      "configured halo per face (default 8 native voxels)",
      "Halo and channel mapping are drafts for new layers",
      "add or recreate a layer to change them",
      "not computed per display chunk",
      "labels may change across navigation",
      "not equivalent to whole-volume watershed",
      "2**21 (2,097,152) voxels INCLUDING the halo",
      "zoom in",
      "coarser native scale",
      "never silently split",
      "Hiding the output",
      "UINT64",
      "negative axes",
      "data type maximum",
      "floating-point values are unchanged",
      "Repeated channel indices are allowed and copied literally",
      "Values below threshold are kept; edges touching a masked voxel are zeroed",
      "normalized units in [0, 1]",
      "Non-native transforms",
      "JSON recipe",
      "one current-view union",
      "ALL affinity data for that box",
      "not the whole dataset",
      "no computed labels or local file bytes",
      "source and model URLs",
      "legacy session-local URLs remain nonportable",
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

  it.each(probabilityFields)(
    "steps %s by hundredths with native number-input spinners",
    (label, key) => {
      const { session } = fixture();
      session.open();
      field(session, "Use last channel as mask").click();
      field(session, "Agglomerate watershed basins").click();
      const input = field(session, label);
      expect(input.type).toBe("number");
      expect(input.min).toBe("0");
      expect(input.max).toBe("1");
      fill(session, label, "0.5");
      // Exercise Chrome's native stepping, not just the step attribute.
      input.stepUp();
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(input.value).toBe("0.51");
      expect(session[key]).toBe("0.51");
      input.stepDown();
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(input.value).toBe("0.5");
      expect(session[key]).toBe("0.5");
      for (const bound of ["0", "1"]) {
        fill(session, label, bound);
        if (bound === "0") input.stepDown();
        else input.stepUp();
        input.dispatchEvent(new Event("input", { bubbles: true }));
        expect(input.value).toBe(bound);
        expect(session[key]).toBe(bound);
      }
    },
  );

  it.each([
    ["Source scale index", "scaleIndex"],
    ["Halo (voxels)", "halo"],
    ["Size threshold", "sizeThreshold"],
    ["Dust threshold", "dustThreshold"],
  ] as const)("keeps %s native spinner steps integral", (label, key) => {
    const { session } = fixture();
    session.open();
    const input = field(session, label);
    const initial = input.value;
    expect(input.step).toBe("1");
    input.stepUp();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.valueAsNumber).toBe(Number(initial) + 1);
    expect(session[key]).toBe(String(Number(initial) + 1));
    input.stepDown();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.value).toBe(initial);
    expect(session[key]).toBe(initial);
  });

  it.each(["default", "typed"] as const)(
    "accepts %s probability precision finer than the spinner step without rounding",
    async (kind) => {
      const f = fixture();
      const { session } = f;
      session.open();
      field(session, "Use last channel as mask").click();
      field(session, "Agglomerate watershed basins").click();
      const drafts =
        kind === "default"
          ? {
              highThreshold: String(DEFAULT_WATERSHED_OPTIONS.highThreshold),
              lowThreshold: String(DEFAULT_WATERSHED_OPTIONS.lowThreshold),
              maskThreshold: "0.3",
              aggThreshold: "0.15",
            }
          : {
              highThreshold: "0.87654321",
              lowThreshold: "0.12345678",
              maskThreshold: "0.3456789",
              aggThreshold: "0.23456789",
            };
      for (const [label, key] of probabilityFields) {
        if (kind === "typed") fill(session, label, drafts[key]);
        expect(field(session, label).value).toBe(drafts[key]);
        expect(session[key]).toBe(drafts[key]);
      }
      // Native step validity must not gate application-level validation.
      expect(field(session, "High threshold").validity.stepMismatch).toBe(true);
      expect(field(session, "Low threshold").validity.stepMismatch).toBe(true);
      session.changed.dispatch();
      session.dialog!.close();
      session.open();
      for (const [label, key] of probabilityFields)
        expect(field(session, label).value).toBe(drafts[key]);
      addButton(session).click();
      await vi.waitFor(() =>
        expect(session.status).toContain("Added live layer:"),
      );
      const options = {
        ...DEFAULT_WATERSHED_OPTIONS,
        highThreshold: Number(drafts.highThreshold),
        lowThreshold: Number(drafts.lowThreshold),
        maskThreshold: Number(drafts.maskThreshold),
        aggThreshold: Number(drafts.aggThreshold),
      };
      expect(f.createLive).toHaveBeenCalledExactlyOnceWith(
        f.inputs.at(-1),
        [0, 1, 2],
        options,
        expect.any(Function),
        DEFAULT_WATERSHED_HALO,
      );
      const json = JSON.parse(
        JSON.stringify(f.resultLayers[0].layer!.toJSON()),
      );
      expect(json.source.state.options).toEqual(options);
      expect(parseWatershedRecipe(json.source.state).options).toEqual(options);
      for (const [label, key] of probabilityFields) {
        expect(field(session, label).value).toBe(drafts[key]);
        expect(session[key]).toBe(drafts[key]);
      }
    },
  );

  it.each(["8", "0", "2"])(
    "passes dialog halo %s as the fifth producer argument and preserves channels in saved JSON",
    async (value) => {
      const f = fixture();
      f.session.open();
      expect(field(f.session, "Halo (voxels)").value).toBe("8");
      if (value !== "8") fill(f.session, "Halo (voxels)", value);
      fill(f.session, "Channels for −X −Y −Z", "2, 0, 2");
      addButton(f.session).click();
      await vi.waitFor(() =>
        expect(f.session.status).toContain("Added live layer:"),
      );
      expect(f.createLive).toHaveBeenCalledExactlyOnceWith(
        f.inputs.at(-1),
        [2, 0, 2],
        DEFAULT_WATERSHED_OPTIONS,
        expect.any(Function),
        Number(value),
      );
      const json = JSON.parse(
        JSON.stringify(f.resultLayers[0].layer!.toJSON()),
      );
      expect(json.source.url).toBe(WATERSHED_RECIPE_URL);
      expect(json.source.state.channelsXYZ).toEqual([2, 0, 2]);
      expect(json.source.state.options).not.toHaveProperty("halo");
      if (value === "8") expect(json.source.state).not.toHaveProperty("halo");
      else expect(json.source.state.halo).toBe(Number(value));
      expect(parseWatershedRecipe(json.source.state)).toEqual(
        json.source.state,
      );
      expect(f.inputs.at(-1)!.dispose).not.toHaveBeenCalled();
      deleteLayer(f.resultLayers[0]);
      f.session.reset();
      expect(f.publications[0].dispose).toHaveBeenCalledOnce();
      expect(f.lives[0].dispose).toHaveBeenCalledOnce();
      expect(f.watchers[0].dispose).toHaveBeenCalledOnce();
      for (const input of f.inputs)
        expect(input.dispose).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "",
    "-1",
    "0.5",
    "NaN",
    "Infinity",
    "-Infinity",
    "1e309",
    "9007199254740992",
  ])(
    "rejects invalid dialog halo %s before construction or publication without leaking input",
    async (value) => {
      const f = fixture();
      f.session.open();
      // Number inputs sanitize non-finite text to empty, which must also fail.
      fill(f.session, "Halo (voxels)", value);
      addButton(f.session).click();
      expect(f.session.statusLevel).toBe("error");
      expect(f.session.status).toContain(
        "Watershed halo must be a nonnegative safe integer in native voxels",
      );
      expect(f.createLive).not.toHaveBeenCalled();
      expect(f.publish).not.toHaveBeenCalled();
      expect(makeLayer).not.toHaveBeenCalled();
      expect(f.watchViewport).not.toHaveBeenCalled();
      expect(f.session.busy).toBe(false);
      expect(field(f.session, "Halo (voxels)").disabled).toBe(false);
      for (const input of f.inputs)
        expect(input.dispose).toHaveBeenCalledOnce();
    },
  );

  it("keeps created halo and channel configurations independent of new-layer drafts", async () => {
    const f = fixture();
    f.session.open();
    fill(f.session, "Halo (voxels)", "2");
    fill(f.session, "Channels for −X −Y −Z", "2, 0, 2");
    await f.session.addLayer();
    const saved = JSON.parse(JSON.stringify(f.resultLayers[0].layer!.toJSON()));
    fill(f.session, "Halo (voxels)", "0");
    fill(f.session, "Channels for −X −Y −Z", "0, 0, 0");
    expect(f.createLive).toHaveBeenCalledOnce();
    expect(f.lives[0].setRegion).not.toHaveBeenCalled();
    expect(f.resultLayers[0].layer!.toJSON()).toEqual(saved);
    await f.session.addLayer();
    expect(f.createLive.mock.calls[0][1]).toEqual([2, 0, 2]);
    expect(f.createLive.mock.calls[0][4]).toBe(2);
    expect(f.createLive.mock.calls[1][1]).toEqual([0, 0, 0]);
    expect(f.createLive.mock.calls[1][4]).toBe(0);
    expect(f.resultLayers[1].layer!.toJSON().source.state.halo).toBe(0);
    fill(f.session, "Halo (voxels)", "8");
    await f.session.addLayer();
    expect(f.createLive.mock.calls[2][4]).toBe(DEFAULT_WATERSHED_HALO);
    expect(f.resultLayers[2].layer!.toJSON().source.state).not.toHaveProperty(
      "halo",
    );
    expect(f.resultLayers[0].layer!.toJSON()).toEqual(saved);
    for (const publication of f.publications)
      expect(publication.dispose).not.toHaveBeenCalled();
    f.session.reset();
    for (const publication of f.publications)
      expect(publication.dispose).toHaveBeenCalledOnce();
    for (const live of f.lives) expect(live.dispose).toHaveBeenCalledOnce();
    for (const watcher of f.watchers)
      expect(watcher.dispose).toHaveBeenCalledOnce();
    for (const input of f.inputs) expect(input.dispose).toHaveBeenCalledOnce();
  });

  it("defaults agglomeration off and retains its optional threshold draft across toggles", () => {
    const { session } = fixture(1);
    session.open();
    expect(session.useAgglomeration).toBe(false);
    expect(session.aggThreshold).toBe("0.15");
    const useAgglomeration = field(session, "Agglomerate watershed basins");
    const aggThreshold = field(
      session,
      "Agglomeration threshold (agg_threshold)",
    );
    expect(useAgglomeration.type).toBe("checkbox");
    expect(useAgglomeration.checked).toBe(false);
    expect(useAgglomeration.disabled).toBe(false);
    expect(aggThreshold.type).toBe("number");
    expect(aggThreshold.value).toBe("0.15");
    expect(aggThreshold.min).toBe("0");
    expect(aggThreshold.max).toBe("1");
    expect(aggThreshold.step).toBe("0.01");
    expect(aggThreshold.disabled).toBe(true);
    expect(aggThreshold.closest("details")).toBe(
      useAgglomeration.closest("details"),
    );
    expect(aggThreshold.closest("details")).not.toBeNull();
    useAgglomeration.click();
    expect(session.useAgglomeration).toBe(true);
    fill(session, "Agglomeration threshold (agg_threshold)", "0.35");
    useAgglomeration.click();
    expect(session.useAgglomeration).toBe(false);
    expect(aggThreshold.disabled).toBe(true);
    expect(aggThreshold.value).toBe("0.35");
    useAgglomeration.click();
    expect(aggThreshold.disabled).toBe(false);
    expect(aggThreshold.value).toBe("0.35");
    for (const explanation of [
      "post-watershed agglomeration is off by default",
      "shared-boundary mean affinity is strictly greater than the threshold",
      "summed affinities divided by total contact area",
      "Lower thresholds merge more",
      "0 enables agglomeration, while 1 merges none",
      "Size/dust cleanup runs before agglomeration, not again afterward",
      "background 0 never merges",
      "Final label IDs are not recompacted",
      "Unchecking omits aggThreshold from saved options",
      "a saved value of 0 enables it",
    ])
      expect(session.dialog!.body.textContent).toContain(explanation);
  });

  it.each(["0", "0.15", "1"])(
    "passes enabled agglomeration threshold %s to live construction and roundtrips it in saved JSON",
    async (value) => {
      const f = fixture();
      f.session.open();
      field(f.session, "Agglomerate watershed basins").click();
      fill(f.session, "Agglomeration threshold (agg_threshold)", value);
      addButton(f.session).click();
      await vi.waitFor(() =>
        expect(f.session.status).toContain("Added live layer:"),
      );
      const options = {
        ...DEFAULT_WATERSHED_OPTIONS,
        aggThreshold: Number(value),
      };
      expect(f.createLive).toHaveBeenCalledExactlyOnceWith(
        f.inputs.at(-1),
        [0, 1, 2],
        options,
        expect.any(Function),
        DEFAULT_WATERSHED_HALO,
      );
      const json = JSON.parse(
        JSON.stringify(f.resultLayers[0].layer!.toJSON()),
      );
      expect(json.source.url).toBe(WATERSHED_RECIPE_URL);
      expect(json.source.state.options).toEqual(options);
      expect(parseWatershedRecipe(json.source.state).options).toEqual(options);
    },
  );

  it("ignores an unchecked invalid agglomeration draft without changing an existing masked/agglomerated layer", async () => {
    const f = fixture();
    f.session.open();
    field(f.session, "Use last channel as mask").click();
    fill(f.session, "Mask threshold", "0.4");
    field(f.session, "Agglomerate watershed basins").click();
    fill(f.session, "Agglomeration threshold (agg_threshold)", "0");
    await f.session.addLayer();
    const options = {
      ...DEFAULT_WATERSHED_OPTIONS,
      maskThreshold: 0.4,
      aggThreshold: 0,
    };
    const saved = JSON.parse(JSON.stringify(f.resultLayers[0].layer!.toJSON()));
    expect(f.createLive.mock.calls[0][2]).toEqual(options);
    expect(saved.source.state.options).toEqual(options);
    fill(f.session, "Agglomeration threshold (agg_threshold)", "");
    field(f.session, "Agglomerate watershed basins").click();
    expect(f.session.useAgglomeration).toBe(false);
    expect(f.session.aggThreshold).toBe("");
    expect(
      field(f.session, "Agglomeration threshold (agg_threshold)").disabled,
    ).toBe(true);
    expect(field(f.session, "Use last channel as mask").checked).toBe(true);
    await f.session.addLayer();
    expect(f.session.status).toContain("Added live layer:");
    expect(f.createLive.mock.calls[1][2]).toEqual({
      ...DEFAULT_WATERSHED_OPTIONS,
      maskThreshold: 0.4,
    });
    expect(f.createLive.mock.calls[1][2]).not.toHaveProperty("aggThreshold");
    const unchecked = JSON.parse(
      JSON.stringify(f.resultLayers[1].layer!.toJSON()),
    );
    expect(unchecked.source.state.options).not.toHaveProperty("aggThreshold");
    expect(
      parseWatershedRecipe(unchecked.source.state).options,
    ).not.toHaveProperty("aggThreshold");
    expect(f.createLive.mock.calls[0][2]).toEqual(options);
    expect(f.resultLayers[0].layer!.toJSON()).toEqual(saved);
    expect(f.publications[0].dispose).not.toHaveBeenCalled();
    field(f.session, "Agglomerate watershed basins").click();
    expect(
      field(f.session, "Agglomeration threshold (agg_threshold)").value,
    ).toBe("");
    expect(
      field(f.session, "Agglomeration threshold (agg_threshold)").disabled,
    ).toBe(false);
  });

  it.each([false, true])(
    "disables agglomeration controls during activation and preserves the enabled=%s draft on reopening",
    async (enabled) => {
      const f = fixture();
      f.resultState.ready = false;
      f.session.open();
      if (enabled) {
        field(f.session, "Agglomerate watershed basins").click();
        fill(f.session, "Agglomeration threshold (agg_threshold)", "0.25");
      }
      const value = f.session.aggThreshold;
      const adding = f.session.addLayer();
      expect(f.session.busy).toBe(true);
      expect(field(f.session, "Agglomerate watershed basins").disabled).toBe(
        true,
      );
      expect(
        field(f.session, "Agglomeration threshold (agg_threshold)").disabled,
      ).toBe(true);
      field(f.session, "Agglomerate watershed basins").click();
      expect(f.session.useAgglomeration).toBe(enabled);
      f.session.dialog!.close();
      f.session.open();
      expect(field(f.session, "Agglomerate watershed basins").checked).toBe(
        enabled,
      );
      expect(field(f.session, "Agglomerate watershed basins").disabled).toBe(
        true,
      );
      expect(
        field(f.session, "Agglomeration threshold (agg_threshold)").value,
      ).toBe(value);
      expect(
        field(f.session, "Agglomeration threshold (agg_threshold)").disabled,
      ).toBe(true);
      f.resultState.ready = true;
      f.resultLayers[0].readyStateChanged.dispatch();
      await adding;
      expect(f.session.busy).toBe(false);
      expect(field(f.session, "Agglomerate watershed basins").disabled).toBe(
        false,
      );
      expect(
        field(f.session, "Agglomeration threshold (agg_threshold)").disabled,
      ).toBe(!enabled);
      expect(f.createLive.mock.calls[0][2]).toEqual({
        ...DEFAULT_WATERSHED_OPTIONS,
        ...(enabled ? { aggThreshold: 0.25 } : {}),
      });
    },
  );

  it.each(["", "-0.01", "1.01"])(
    "rejects invalid enabled agglomeration input %s from the dialog",
    async (value) => {
      const f = fixture();
      f.session.open();
      field(f.session, "Agglomerate watershed basins").click();
      fill(f.session, "Agglomeration threshold (agg_threshold)", value);
      addButton(f.session).click();
      expect(f.session.statusLevel).toBe("error");
      expect(f.session.status).toContain(
        "Agglomeration threshold (agg_threshold) must be a number between 0 and 1",
      );
      expect(f.createLive).not.toHaveBeenCalled();
      expect(f.publish).not.toHaveBeenCalled();
      expect(f.session.busy).toBe(false);
      for (const input of f.inputs)
        expect(input.dispose).toHaveBeenCalledOnce();
    },
  );

  it("defaults a single-channel image to literal copies for all three axes", async () => {
    const f = fixture(1);
    f.session.open();
    expect(field(f.session, "Channels for −X −Y −Z").value).toBe("0, 0, 0");
    expect(field(f.session, "Use last channel as mask").disabled).toBe(true);
    addButton(f.session).click();
    await vi.waitFor(() =>
      expect(f.session.status).toContain("Added live layer:"),
    );
    expect(f.createLive).toHaveBeenCalledExactlyOnceWith(
      f.inputs.at(-1),
      [0, 0, 0],
      DEFAULT_WATERSHED_OPTIONS,
      expect.any(Function),
      DEFAULT_WATERSHED_HALO,
    );
    expect(f.inputs.at(-1)!.readRegion).not.toHaveBeenCalled();
  });

  it.each(["0, 0, 0", "2, 2, 2", "2, 0, 2", "3, 3, 3"])(
    "accepts repeated affinity mapping %s with masking off",
    async (mapping) => {
      const f = fixture();
      f.session.open();
      fill(f.session, "Channels for −X −Y −Z", mapping);
      await f.session.addLayer();
      expect(f.createLive).toHaveBeenCalledExactlyOnceWith(
        f.inputs.at(-1),
        mapping.split(", ").map(Number),
        DEFAULT_WATERSHED_OPTIONS,
        expect.any(Function),
        DEFAULT_WATERSHED_HALO,
      );
    },
  );

  it("updates automatic defaults for source/scale changes but preserves an explicit scalar mapping", () => {
    const f = fixture(1);
    f.channelCounts.set(f.b.layer!, [4, 1]);
    f.session.open();
    selectSource(f.session, 1);
    expect(f.session.source).toBe(f.b);
    expect(field(f.session, "Channels for −X −Y −Z").value).toBe("0, 1, 2");
    fill(f.session, "Source scale index", "1");
    expect(field(f.session, "Channels for −X −Y −Z").value).toBe("0, 0, 0");
    fill(f.session, "Source scale index", "0");
    expect(field(f.session, "Channels for −X −Y −Z").value).toBe("0, 1, 2");
    selectSource(f.session, 0);
    expect(field(f.session, "Channels for −X −Y −Z").value).toBe("0, 0, 0");
    fill(f.session, "Channels for −X −Y −Z", "0,0,0");
    selectSource(f.session, 1);
    expect(field(f.session, "Channels for −X −Y −Z").value).toBe("0,0,0");
  });

  it("preserves valid custom mappings across sources/scales and resets only stale out-of-bounds mappings", () => {
    const f = fixture();
    f.channelCounts.set(f.b.layer!, [5, 1]);
    f.session.open();
    fill(f.session, "Channels for −X −Y −Z", "2, 0, 2");
    fill(f.session, "Source scale index", "1");
    expect(field(f.session, "Channels for −X −Y −Z").value).toBe("2, 0, 2");
    selectSource(f.session, 1);
    expect(f.session.scaleIndex).toBe("0");
    expect(field(f.session, "Channels for −X −Y −Z").value).toBe("2, 0, 2");
    fill(f.session, "Channels for −X −Y −Z", "3, 1, 2");
    selectSource(f.session, 0);
    expect(field(f.session, "Channels for −X −Y −Z").value).toBe("3, 1, 2");
    selectSource(f.session, 1);
    fill(f.session, "Source scale index", "1");
    expect(field(f.session, "Channels for −X −Y −Z").value).toBe("0, 0, 0");
    fill(f.session, "Source scale index", "0");
    expect(field(f.session, "Channels for −X −Y −Z").value).toBe("0, 1, 2");
  });

  it.each([1, 2, 3])(
    "disables mask controls for %i source channels and rejects a forced enabled draft",
    async (count) => {
      const f = fixture(count);
      f.session.open();
      const useMask = field(f.session, "Use last channel as mask");
      expect(useMask.disabled).toBe(true);
      useMask.click();
      expect(f.session.useLastChannelAsMask).toBe(false);
      expect(field(f.session, "Mask threshold").disabled).toBe(true);
      f.session.useLastChannelAsMask = true;
      await f.session.addLayer();
      expect(f.session.status).toContain(
        "requires at least four source channels",
      );
      expect(f.createLive).not.toHaveBeenCalled();
      expect(f.publish).not.toHaveBeenCalled();
      for (const input of f.inputs)
        expect(input.dispose).toHaveBeenCalledOnce();
    },
  );

  it.each(["0", "0.3", "1"])(
    "passes mask threshold %s only when enabled",
    async (value) => {
      const f = fixture();
      f.session.open();
      field(f.session, "Use last channel as mask").click();
      expect(f.session.useLastChannelAsMask).toBe(true);
      fill(f.session, "Mask threshold", value);
      await f.session.addLayer();
      expect(f.createLive).toHaveBeenCalledExactlyOnceWith(
        f.inputs.at(-1),
        [0, 1, 2],
        { ...DEFAULT_WATERSHED_OPTIONS, maskThreshold: Number(value) },
        expect.any(Function),
        DEFAULT_WATERSHED_HALO,
      );
    },
  );

  it("reserves only the actual last channel, not always channel 3, when masking", async () => {
    const f = fixture(5);
    f.session.open();
    fill(f.session, "Channels for −X −Y −Z", "3, 3, 3");
    field(f.session, "Use last channel as mask").click();
    await f.session.addLayer();
    expect(f.createLive).toHaveBeenCalledExactlyOnceWith(
      f.inputs.at(-1),
      [3, 3, 3],
      { ...DEFAULT_WATERSHED_OPTIONS, maskThreshold: 0.3 },
      expect.any(Function),
      DEFAULT_WATERSHED_HALO,
    );
  });

  it.each(["source", "scale"] as const)(
    "resets a custom affinity mapping reserved by the mask after a %s channel-count change",
    async (transition) => {
      const f = fixture(5);
      f.channelCounts.set(f.a.layer!, [5, 4]);
      f.channelCounts.set(f.b.layer!, [4]);
      f.session.open();
      fill(f.session, "Channels for −X −Y −Z", "3, 3, 3");
      field(f.session, "Use last channel as mask").click();
      await f.session.addLayer();
      expect(f.createLive).toHaveBeenCalledExactlyOnceWith(
        f.inputs.at(-1),
        [3, 3, 3],
        { ...DEFAULT_WATERSHED_OPTIONS, maskThreshold: 0.3 },
        expect.any(Function),
        DEFAULT_WATERSHED_HALO,
      );

      // Same-count metadata refreshes must leave even unfinished drafts alone.
      fill(f.session, "Channels for −X −Y −Z", "3, ");
      f.a.layer!.dataSourcesChanged.dispatch();
      await Promise.resolve();
      expect(field(f.session, "Channels for −X −Y −Z").value).toBe("3, ");
      fill(f.session, "Channels for −X −Y −Z", "3, 3, 3");

      if (transition === "source") selectSource(f.session, 1);
      else fill(f.session, "Source scale index", "1");
      expect(f.session.metadata?.channelCount).toBe(4);
      expect(field(f.session, "Use last channel as mask").checked).toBe(true);
      expect(field(f.session, "Mask threshold").disabled).toBe(false);
      await f.session.addLayer();
      expect(f.session.status).toContain("Added live layer:");
      expect(field(f.session, "Channels for −X −Y −Z").value).toBe("0, 1, 2");
      expect(f.createLive).toHaveBeenNthCalledWith(
        2,
        f.inputs.at(-1),
        [0, 1, 2],
        { ...DEFAULT_WATERSHED_OPTIONS, maskThreshold: 0.3 },
        expect.any(Function),
        DEFAULT_WATERSHED_HALO,
      );
      expect(f.createLive.mock.calls[0][1]).toEqual([3, 3, 3]);
      expect(f.publications[0].dispose).not.toHaveBeenCalled();
    },
  );

  it.each(["source", "scale"] as const)(
    "preserves an explicit scalar mapping when a %s channel-count change disables masking",
    async (transition) => {
      const f = fixture(5);
      f.channelCounts.set(f.a.layer!, [5, 1]);
      f.channelCounts.set(f.b.layer!, [1]);
      f.session.open();
      fill(f.session, "Channels for −X −Y −Z", "0,0,0");
      field(f.session, "Use last channel as mask").click();
      await f.session.addLayer();
      const maskedInput = f.inputs.at(-1)!;
      if (transition === "source") selectSource(f.session, 1);
      else fill(f.session, "Source scale index", "1");
      expect(field(f.session, "Channels for −X −Y −Z").value).toBe("0,0,0");
      expect(field(f.session, "Use last channel as mask").checked).toBe(false);
      expect(field(f.session, "Use last channel as mask").disabled).toBe(true);
      expect(field(f.session, "Mask threshold").disabled).toBe(true);
      await f.session.addLayer();
      expect(f.createLive).toHaveBeenNthCalledWith(
        2,
        f.inputs.at(-1),
        [0, 0, 0],
        DEFAULT_WATERSHED_OPTIONS,
        expect.any(Function),
        DEFAULT_WATERSHED_HALO,
      );
      expect(f.createLive.mock.calls[0][2]).toEqual({
        ...DEFAULT_WATERSHED_OPTIONS,
        maskThreshold: 0.3,
      });
      expect(f.watchers[0].input).toBe(maskedInput);
      expect(f.watchers[1].input).toBe(f.inputs.at(-1));
      f.watchers[0].onRegion({
        lowerXYZ: [10, 20, -30],
        shapeXYZ: [24, 16, 8],
      });
      expect(f.lives[0].setRegion).toHaveBeenLastCalledWith(
        [10, 20, -30],
        [24, 16, 8],
      );
      expect(f.lives[1].setRegion).not.toHaveBeenCalled();
      expect(f.publications[0].dispose).not.toHaveBeenCalled();
      expect(f.watchers[0].dispose).not.toHaveBeenCalled();
      if (transition === "source") selectSource(f.session, 0);
      else fill(f.session, "Source scale index", "0");
      // Preserve the custom choice, not just the text of an automatic default.
      expect(field(f.session, "Channels for −X −Y −Z").value).toBe("0,0,0");
      expect(field(f.session, "Use last channel as mask").checked).toBe(false);
    },
  );

  it("keeps created configurations independent of mask toggles and source/scale changes", async () => {
    const f = fixture();
    f.channelCounts.set(f.b.layer!, [1, 4]);
    f.session.open();
    await f.session.addLayer();
    const first = f.createLive.mock.calls[0];
    field(f.session, "Use last channel as mask").click();
    fill(f.session, "Mask threshold", "0.4");
    fill(f.session, "Channels for −X −Y −Z", "2, 2, 2");
    await f.session.addLayer();
    const second = f.createLive.mock.calls[1];
    fill(f.session, "Mask threshold", "");
    field(f.session, "Use last channel as mask").click();
    expect(field(f.session, "Mask threshold").disabled).toBe(true);
    // A disabled threshold draft is ignored, even if invalid.
    await f.session.addLayer();
    expect(f.createLive.mock.calls[2][2]).toEqual(DEFAULT_WATERSHED_OPTIONS);
    field(f.session, "Use last channel as mask").click();
    selectSource(f.session, 1);
    expect(f.session.useLastChannelAsMask).toBe(false);
    expect(field(f.session, "Use last channel as mask").checked).toBe(false);
    expect(field(f.session, "Use last channel as mask").disabled).toBe(true);
    expect(field(f.session, "Mask threshold").disabled).toBe(true);
    fill(f.session, "Source scale index", "1");
    expect(field(f.session, "Use last channel as mask").disabled).toBe(false);
    expect(field(f.session, "Use last channel as mask").checked).toBe(false);
    expect(field(f.session, "Mask threshold").disabled).toBe(true);
    expect(first[1]).toEqual([0, 1, 2]);
    expect(first[2]).toEqual(DEFAULT_WATERSHED_OPTIONS);
    expect(first[2]).not.toHaveProperty("maskThreshold");
    expect(second[1]).toEqual([2, 2, 2]);
    expect(second[2]).toEqual({
      ...DEFAULT_WATERSHED_OPTIONS,
      maskThreshold: 0.4,
    });
    for (const publication of f.publications)
      expect(publication.dispose).not.toHaveBeenCalled();
    for (const live of f.lives) expect(live.dispose).not.toHaveBeenCalled();
  });

  it.each([
    [4, "0, 1, 3"],
    [4, "3, 3, 3"],
    [5, "0, 1, 4"],
  ] as const)(
    "rejects affinity mapping for %i channels (%s) that includes the enabled last-channel mask",
    async (count, mapping) => {
      const f = fixture(count);
      f.session.open();
      fill(f.session, "Channels for −X −Y −Z", mapping);
      field(f.session, "Use last channel as mask").click();
      await f.session.addLayer();
      expect(f.session.status).toContain(
        "last source channel is reserved for the mask",
      );
      expect(f.createLive).not.toHaveBeenCalled();
      expect(f.publish).not.toHaveBeenCalled();
      for (const input of f.inputs)
        expect(input.dispose).toHaveBeenCalledOnce();
    },
  );

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
      DEFAULT_WATERSHED_HALO,
    );
    expect(f.publish).toHaveBeenCalledExactlyOnceWith(
      viewer.chunkManager,
      f.lives[0],
    );
    const layer = f.resultLayers[0];
    expect(makeLayer).toHaveBeenCalledWith(root, "affinities watershed", {
      type: "segmentation",
      source: {
        url: WATERSHED_RECIPE_URL,
        state: {
          version: 1,
          profile: "visible-slice-union-v1",
          mode: "live",
          source: { name: "affinities", source: originalSource.source },
          inputScaleIndex: 1,
          channelsXYZ: [3, 1, 2],
          options: {
            highThreshold: 0.8,
            lowThreshold: 0.2,
            sizeThreshold: 12,
            dustThreshold: 3,
          },
          spacingXYZ: [4e-9, 4e-9, 16e-9],
        },
      },
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

  it("saves nested ONNX, mask, scale, channels and thresholds as isolated JSON before live construction", async () => {
    const f = fixture();
    f.session.selectSource(f.b);
    f.session.selectScale("1");
    f.session.channelsXYZ = "2, 0, 2";
    f.session.useLastChannelAsMask = true;
    f.session.maskThreshold = "0.4";
    f.session.highThreshold = "0.8";
    f.session.lowThreshold = "0.2";
    f.session.sizeThreshold = "12";
    f.session.dustThreshold = "3";
    const savedSource = structuredClone(f.sourceSpecs.b);
    const serialize = vi.spyOn(f.b.layer!, "toJSON");
    const create = f.createLive.getMockImplementation()!;
    f.createLive.mockImplementationOnce((...args) => {
      expect(serialize).toHaveBeenCalledOnce();
      // Construction must not be able to change the already validated snapshot.
      f.sourceSpecs.b.state.model.urls[0] = "https://example.com/changed.onnx";
      f.sourceSpecs.b.state.source.source.url = "precomputed://changed/raw";
      f.inputs.at(-1)!.spacingXYZ[0] = 1;
      Object.assign(args[2], { maskThreshold: 0.9 });
      return create(...args);
    });
    await f.session.addLayer();
    const json = JSON.parse(JSON.stringify(f.resultLayers[0].layer!.toJSON()));
    const recipe: WatershedRecipe = {
      version: 1,
      profile: "visible-slice-union-v1",
      mode: "live",
      source: { name: "affinities", source: savedSource },
      inputScaleIndex: 1,
      channelsXYZ: [2, 0, 2],
      options: {
        highThreshold: 0.8,
        lowThreshold: 0.2,
        sizeThreshold: 12,
        dustThreshold: 3,
        maskThreshold: 0.4,
      },
      spacingXYZ: [4e-9, 4e-9, 16e-9],
    };
    expect(json.source).toEqual({ url: WATERSHED_RECIPE_URL, state: recipe });
    expect(parseWatershedRecipe(json.source.state)).toEqual(recipe);
    expect(json).not.toHaveProperty("data");
    expect(JSON.stringify(json)).not.toContain(f.publications[0].url);
    f.session.selectSource(f.a);
    f.session.channelsXYZ = "0, 0, 0";
    f.session.highThreshold = "0.7";
    f.session.maskThreshold = "0.6";
    f.b.name = "renamed ONNX layer";
    expect(f.resultLayers[0].layer!.toJSON().source.state).toEqual(recipe);
    // Later edits to the saved recipe cannot mutate source state or live args.
    const saved = f.resultLayers[0].layer!.toJSON().source
      .state as WatershedRecipe;
    saved.channelsXYZ[0] = 1;
    Object.assign(saved.options, { maskThreshold: 0.5 });
    expect(f.createLive.mock.calls[0][1]).toEqual([2, 0, 2]);
    expect(f.createLive.mock.calls[0][2].maskThreshold).toBe(0.9);
    expect(f.sourceSpecs.b).not.toEqual(savedSource);
    expect(f.watchViewport).toHaveBeenCalledOnce();
    expect(f.inputs.at(-1)!.readRegion).not.toHaveBeenCalled();
  });

  it("rejects an unserializable source before constructing or publishing a live result", async () => {
    const f = fixture();
    vi.spyOn(f.a.layer!, "toJSON").mockReturnValue({
      type: "image",
      source: undefined,
    });
    await f.session.addLayer();
    expect(f.session.statusLevel).toBe("error");
    expect(f.session.status).toContain("recipe");
    expect(f.createLive).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
    expect(makeLayer).not.toHaveBeenCalled();
    for (const input of f.inputs) expect(input.dispose).toHaveBeenCalledOnce();
  });

  it("watches the owned selected-scale input only after activation and group membership, forwarding native boxes unchanged", async () => {
    const f = fixture();
    f.session.selectScale("1");
    f.prepareInput.mockImplementationOnce(() => {
      const input = makeInput(1);
      // Distinguish native coordinates from source-relative or physical ones.
      input.originXYZ = [100, -200, 300];
      f.inputs.push(input);
      return input;
    });
    f.resultState.ready = false;
    const watch = f.watchViewport.getMockImplementation()!;
    f.watchViewport.mockImplementationOnce((...args) => {
      const [viewer, input, layer] = args;
      expect(viewer).toBe(f.viewer);
      expect(input).toBe(f.createLive.mock.calls[0][0]);
      expect(input.dispose).not.toHaveBeenCalled();
      expect(f.layerManager.has(layer)).toBe(true);
      expect(f.sourceGroup.has(layer)).toBe(true);
      expect(f.otherGroup.has(layer)).toBe(false);
      return watch(...args);
    });
    const adding = f.session.addLayer();
    const input = f.inputs.at(-1)!;
    expect(f.watchViewport).not.toHaveBeenCalled();
    f.resultState.ready = true;
    f.resultLayers[0].readyStateChanged.dispatch();
    await adding;
    expect(f.watchViewport).toHaveBeenCalledExactlyOnceWith(
      f.viewer,
      input,
      f.resultLayers[0],
      expect.any(Function),
      expect.any(Function),
    );
    const first = {
      lowerXYZ: Object.freeze([-4, 10, 2]),
      shapeXYZ: Object.freeze([32, 24, 8]),
    };
    const navigated = {
      lowerXYZ: Object.freeze([0, 12, 3]),
      shapeXYZ: Object.freeze([40, 30, 12]),
    };
    f.watchers[0].onRegion(first);
    f.watchers[0].onRegion(navigated);
    expect(f.lives[0].setRegion.mock.calls).toEqual([
      [first.lowerXYZ, first.shapeXYZ],
      [navigated.lowerXYZ, navigated.shapeXYZ],
    ]);
    expect(f.lives[0].setRegion.mock.calls[0][0]).toBe(first.lowerXYZ);
    expect(f.lives[0].setRegion.mock.calls[1][1]).toBe(navigated.shapeXYZ);
    expect(f.createLive).toHaveBeenCalledOnce();
    expect(input.readRegion).not.toHaveBeenCalled();
    expect(input.dispose).not.toHaveBeenCalled();
  });

  it("clears hidden/no-view regions without stopping tracking, resumes on show, and ignores callbacks after reset", async () => {
    const f = fixture();
    await f.session.addLayer();
    const watcher = f.watchers[0];
    const region = { lowerXYZ: [10, 20, -30], shapeXYZ: [32, 24, 8] };
    watcher.onRegion(region);
    watcher.onRegion(undefined);
    expect(f.lives[0].setRegion).toHaveBeenLastCalledWith(undefined, undefined);
    expect(f.publications[0].dispose).not.toHaveBeenCalled();
    expect(watcher.dispose).not.toHaveBeenCalled();
    watcher.onRegion(region);
    expect(f.lives[0].setRegion).toHaveBeenLastCalledWith(
      region.lowerXYZ,
      region.shapeXYZ,
    );
    f.session.reset();
    expect(watcher.dispose).toHaveBeenCalledOnce();
    expect(f.publications[0].dispose).toHaveBeenCalledOnce();
    const status = f.session.status;
    watcher.onRegion(region);
    watcher.onRegion(undefined);
    watcher.onError(new Error("late geometry error"));
    expect(f.lives[0].setRegion).toHaveBeenCalledTimes(3);
    expect(f.session.status).toBe(status);
  });

  it("clears a viewport geometry error and keeps the watcher for a later valid box", async () => {
    const f = fixture();
    await f.session.addLayer();
    f.session.open();
    const watcher = f.watchers[0];
    watcher.onRegion({ lowerXYZ: [10, 20, -30], shapeXYZ: [32, 24, 8] });
    watcher.onError(new Error("Unsupported slice geometry"));
    expect(f.lives[0].setRegion).toHaveBeenLastCalledWith();
    expect(f.session.statusLevel).toBe("error");
    expect(
      f.session.dialog!.body.querySelector('[role="status"]')!.textContent,
    ).toContain("Unsupported slice geometry");
    expect(f.layerManager.has(f.resultLayers[0])).toBe(true);
    expect(watcher.dispose).not.toHaveBeenCalled();
    watcher.onRegion({ lowerXYZ: [12, 22, -24], shapeXYZ: [12, 12, 8] });
    expect(f.lives[0].setRegion).toHaveBeenLastCalledWith(
      [12, 22, -24],
      [12, 12, 8],
    );
    expect(f.publications[0].dispose).not.toHaveBeenCalled();
    expect(f.session.statusLevel).toBe("info");
    expect(
      f.session.dialog!.body.querySelector('[role="status"]')!.textContent,
    ).not.toContain("Unsupported slice geometry");
  });

  it.each(["compute", "geometry"])(
    "keeps an initial recoverable %s error visible instead of replacing it with Add success",
    async (kind) => {
      const f = fixture();
      const message =
        kind === "compute"
          ? "Region exceeds 2**21 voxels including halo"
          : "Unsupported slice geometry";
      const watch = f.watchViewport.getMockImplementation()!;
      f.watchViewport.mockImplementationOnce((...args) => {
        const dispose = watch(...args);
        args[3]({ lowerXYZ: [10, 20, -30], shapeXYZ: [300, 200, 100] });
        if (kind === "compute") f.onErrors[0](new Error(message));
        else args[4](new Error(message));
        return dispose;
      });
      await f.session.addLayer();
      expect(f.session.busy).toBe(false);
      expect(f.session.statusLevel).toBe("error");
      expect(f.session.status).toContain(message);
      expect(f.session.status).not.toContain("Added live layer:");
      expect(f.layerManager.has(f.resultLayers[0])).toBe(true);
      expect(f.watchers[0].dispose).not.toHaveBeenCalled();
      expect(f.publications[0].dispose).not.toHaveBeenCalled();
    },
  );

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

  it("does not limit overall source size or read the whole source at creation", async () => {
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
    fill(f.session, "Halo (voxels)", "2");
    fill(f.session, "Channels for −X −Y −Z", "2, 0, 2");
    field(f.session, "Use last channel as mask").click();
    fill(f.session, "Mask threshold", "0.7");
    const adding = f.session.addLayer();
    const input = f.inputs.at(-1)!;
    f.session.dialog!.close();
    expect(f.session.dialog).toBeUndefined();
    expect(f.session.busy).toBe(true);
    expect(input.signal.aborted).toBe(false);
    f.session.open();
    expect(field(f.session, "High threshold").value).toBe("0.8");
    expect(field(f.session, "High threshold").disabled).toBe(true);
    expect(field(f.session, "Halo (voxels)").value).toBe("2");
    expect(field(f.session, "Halo (voxels)").disabled).toBe(true);
    expect(field(f.session, "Channels for −X −Y −Z").value).toBe("2, 0, 2");
    expect(field(f.session, "Channels for −X −Y −Z").disabled).toBe(true);
    expect(field(f.session, "Use last channel as mask").disabled).toBe(true);
    expect(field(f.session, "Use last channel as mask").checked).toBe(true);
    expect(field(f.session, "Mask threshold").value).toBe("0.7");
    expect(field(f.session, "Mask threshold").disabled).toBe(true);
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
    expect(field(f.session, "Halo (voxels)").value).toBe("2");
    expect(field(f.session, "Halo (voxels)").disabled).toBe(false);
    expect(field(f.session, "Channels for −X −Y −Z").value).toBe("2, 0, 2");
    expect(field(f.session, "Channels for −X −Y −Z").disabled).toBe(false);
    expect(f.createLive.mock.calls[0][4]).toBe(2);
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
    expect(f.watchers[0].dispose).toHaveBeenCalledOnce();
    expect(f.watchers[1].dispose).not.toHaveBeenCalled();
    const secondRegion = { lowerXYZ: [12, 22, -24], shapeXYZ: [12, 12, 8] };
    f.watchers[1].onRegion(secondRegion);
    expect(f.lives[0].setRegion).not.toHaveBeenCalled();
    expect(f.lives[1].setRegion).toHaveBeenLastCalledWith(
      secondRegion.lowerXYZ,
      secondRegion.shapeXYZ,
    );
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
      if (phase === "active")
        expect(f.watchers[0].dispose).toHaveBeenCalledOnce();
      else expect(f.watchViewport).not.toHaveBeenCalled();
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

  it("preserves a valid live layer/publication and unfinished draft on non-semantic metadata notifications", async () => {
    const f = fixture();
    f.session.open();
    fill(f.session, "Channels for −X −Y −Z", "2, 0, 2");
    await f.session.addLayer();
    fill(f.session, "Channels for −X −Y −Z", "2, ");
    const input = f.inputs.at(-1)!;
    const live = f.lives[0];
    expect(() => input.assertValid()).not.toThrow();
    expect(() => live.assertValid()).not.toThrow();
    live.assertValid.mockClear();
    const status = f.session.status;
    // Toggling "Enable default subsource set" can emit this notification
    // without changing the enabled subsources or invalidating the input.
    f.a.layer!.dataSourcesChanged.dispatch();
    f.layerManager.layersChanged.dispatch();
    f.layerManager.readyStateChanged.dispatch();
    await Promise.resolve();
    expect(field(f.session, "Channels for −X −Y −Z").value).toBe("2, ");
    expect(f.createLive.mock.calls[0][1]).toEqual([2, 0, 2]);
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

  it.each(["worker failed", "Region exceeds 2**21 voxels including halo"])(
    "keeps a live layer and watcher after recoverable computation error: %s",
    async (message) => {
      const f = fixture();
      await f.session.addLayer();
      f.session.open();
      f.onErrors[0](new Error(message));
      expect(f.session.statusLevel).toBe("error");
      const status = f.session.dialog!.body.querySelector('[role="status"]')!;
      expect(status.textContent).toContain(message);
      expect(status.textContent).toContain("zoom in");
      expect(status.textContent).toContain("coarser native scale");
      expect(status.getAttribute("data-severity")).toBe("error");
      expect(f.layerManager.has(f.resultLayers[0])).toBe(true);
      expect(f.publications[0].dispose).not.toHaveBeenCalled();
      expect(f.watchers[0].dispose).not.toHaveBeenCalled();
      expect(f.lives[0].signal.aborted).toBe(false);
      // Runtime owns clearing failed results/cache invalidation. The UI must
      // leave tracking active so a smaller box can schedule a fresh computation.
      const region = { lowerXYZ: [12, 24, -20], shapeXYZ: [16, 12, 8] };
      f.watchers[0].onRegion(region);
      expect(f.lives[0].setRegion).toHaveBeenLastCalledWith(
        region.lowerXYZ,
        region.shapeXYZ,
      );
      expect(f.createLive).toHaveBeenCalledOnce();
      expect(f.publish).toHaveBeenCalledOnce();
      deleteLayer(f.resultLayers[0]);
      expect(f.publications[0].dispose).toHaveBeenCalledOnce();
      expect(f.watchers[0].dispose).toHaveBeenCalledOnce();
      const finalStatus = f.session.status;
      f.onErrors[0](new Error("old worker failure"));
      f.watchers[0].onRegion(region);
      expect(f.session.status).toBe(finalStatus);
      expect(f.lives[0].setRegion).toHaveBeenCalledOnce();
    },
  );

  it("recovers the visible status after a real halo-cap retry without viewport navigation", async () => {
    const f = fixture();
    let live: LiveWatershed | undefined;
    f.createLive.mockImplementationOnce(
      (...args) => (live = new LiveWatershed(...args)),
    );
    vi.mocked(computeWatershed).mockImplementationOnce(
      async (input, lower, shape) => ({
        data: new Uint32Array(shape.reduce((n, x) => n * x, 1)).fill(7),
        shapeXYZ: [...shape],
        offsetXYZ: [...lower],
        spacingXYZ: [...input.spacingXYZ],
        unitsXYZ: [...input.unitsXYZ],
      }),
    );
    await f.session.addLayer();
    f.session.open();
    const producer = live!;
    const status = f.session.dialog!.body.querySelector('[role="status"]')!;
    const region = { lowerXYZ: [100, 90, 10], shapeXYZ: [16, 12, 8] };
    f.watchers[0].onRegion(region);
    producer.setParameters([0, 1, 2], DEFAULT_WATERSHED_OPTIONS, 200);
    expect(f.session.statusLevel).toBe("error");
    expect(status.textContent).toContain("2**21 voxel limit");
    const failure = status.textContent;
    expect(vi.mocked(computeWatershed)).not.toHaveBeenCalled();
    // A second invalid retry dispatches changed *before* onError. The new
    // failure must remain visible rather than being mistaken for completion.
    producer.setParameters([0, 1, 2], DEFAULT_WATERSHED_OPTIONS, 201);
    expect(f.session.statusLevel).toBe("error");
    expect(status.getAttribute("data-severity")).toBe("error");
    expect(status.textContent).toContain("2**21 voxel limit");

    producer.setParameters([0, 1, 2], DEFAULT_WATERSHED_OPTIONS, 0);
    expect(f.session.statusLevel).toBe("info");
    expect(status.getAttribute("data-severity")).toBe("info");
    expect(status.textContent).toContain(f.resultLayers[0].name);
    expect(status.textContent).not.toContain("2**21 voxel limit");
    await vi.waitFor(async () => {
      const labels = await producer.readTile(
        [64, 64, 32],
        [64, 64, 32],
        new AbortController().signal,
      );
      expect(labels).toContain(7n);
    });
    expect(vi.mocked(computeWatershed)).toHaveBeenCalledExactlyOnceWith(
      f.inputs.at(-1),
      region.lowerXYZ,
      region.shapeXYZ,
      [0, 1, 2],
      DEFAULT_WATERSHED_OPTIONS,
      expect.any(AbortSignal),
    );
    expect(f.session.statusLevel).toBe("info");
    expect(status.textContent).not.toContain("2**21 voxel limit");
    expect(failure).toContain("Adjust sidebar thresholds");
    expect(failure).toContain(
      "add a layer in WASM Watershed with a smaller halo",
    );
    expect(failure).not.toContain("reduce halo");
    expect(f.createLive).toHaveBeenCalledOnce();
    expect(f.publish).toHaveBeenCalledOnce();
    expect(f.layerManager.has(f.resultLayers[0])).toBe(true);
    expect(f.watchers[0].dispose).not.toHaveBeenCalled();
  });

  it("clears only the current output's recoverable error on live completion", async () => {
    const f = fixture();
    await f.session.addLayer();
    f.session.selectSource(f.b);
    await f.session.addLayer();
    f.session.open();
    const status = f.session.dialog!.body.querySelector('[role="status"]')!;
    const added = f.session.status;
    f.lives[0].changed.dispatch();
    expect(f.session.status).toBe(added);
    f.onErrors[0](new Error("First output failed"));
    f.onErrors[1](new Error("Second output failed"));
    const secondError = f.session.status;
    f.lives[0].changed.dispatch();
    expect(f.session.status).toBe(secondError);
    expect(status.getAttribute("data-severity")).toBe("error");
    f.lives[1].changed.dispatch();
    expect(f.session.statusLevel).toBe("info");
    expect(status.textContent).toContain(f.resultLayers[1].name);
    expect(status.textContent).not.toContain("Second output failed");
    const recovered = f.session.status;
    f.lives[0].changed.dispatch();
    expect(f.session.status).toBe(recovered);
    // Completion must not consume a later failure's ownership.
    f.onErrors[1](new Error("Retry failed again"));
    expect(status.textContent).toContain("Retry failed again");
    expect(status.getAttribute("data-severity")).toBe("error");
    f.lives[1].changed.dispatch();
    expect(f.session.statusLevel).toBe("info");
    expect(status.textContent).not.toContain("Retry failed again");
  });

  it.each(["metadata", "add", "another source stopped"])(
    "does not replace an unrelated %s error when an earlier output recovers",
    async (kind) => {
      const f = fixture();
      await f.session.addLayer();
      f.onErrors[0](new Error("Recoverable compute error"));
      if (kind === "metadata") {
        f.prepareInput.mockImplementationOnce(() => {
          throw new Error("Metadata unavailable");
        });
        f.session.selectScale("1");
      } else if (kind === "add") {
        f.session.channelsXYZ = "0, 1, 99";
        await f.session.addLayer();
      } else {
        f.session.selectSource(f.b);
        await f.session.addLayer();
        f.inputs.at(-1)!.invalidate();
      }
      const unrelated = f.session.status;
      expect(unrelated).not.toContain("Recoverable compute error");
      f.lives[0].changed.dispatch();
      expect(f.session.status).toBe(unrelated);
      expect(f.session.statusLevel).toBe("error");
      expect(f.publications[0].dispose).not.toHaveBeenCalled();
    },
  );

  it("reports fatal source invalidation instead of recovery on live.changed", async () => {
    const f = fixture();
    await f.session.addLayer();
    f.onErrors[0](new Error("Recoverable compute error"));
    const live = f.lives[0];
    const remove = vi.spyOn(live.changed, "remove");
    f.inputs.at(-1)!.invalidate(false);
    live.changed.dispatch();
    expect(f.session.statusLevel).toBe("error");
    expect(f.session.status).toContain("Watershed stopped");
    expect(f.session.status).toContain("Source snapshot changed");
    expect(f.layerManager.has(f.resultLayers[0])).toBe(false);
    expect(f.publications[0].dispose).toHaveBeenCalledOnce();
    expect(f.watchers[0].dispose).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    const stopped = f.session.status;
    live.changed.dispatch();
    f.onErrors[0](new Error("Late worker error"));
    expect(f.session.status).toBe(stopped);
  });

  it.each(["delete", "reset", "dispose"])(
    "removes the recovery listener on %s and ignores late changes",
    async (action) => {
      const f = fixture();
      await f.session.addLayer();
      f.onErrors[0](new Error("Recoverable compute error"));
      const live = f.lives[0];
      const remove = vi.spyOn(live.changed, "remove");
      if (action === "delete") deleteLayer(f.resultLayers[0]);
      else if (action === "reset") f.session.reset();
      else f.owner.dispose();
      expect(remove).toHaveBeenCalledOnce();
      const status = f.session.status;
      const changed = vi.fn();
      const unwatch = f.session.changed.add(changed);
      live.changed.dispatch();
      f.onErrors[0](new Error("Late worker error"));
      unwatch();
      expect(f.session.status).toBe(status);
      expect(changed).not.toHaveBeenCalled();
      expect(f.publications[0].dispose).toHaveBeenCalledOnce();
      expect(f.watchers[0].dispose).toHaveBeenCalledOnce();
    },
  );

  it.each(["initial", "active"])(
    "handles a reentrant reset during %s live error recovery",
    async (phase) => {
      const f = fixture();
      const unwatch = f.session.changed.add(() => {
        if (f.session.status.startsWith("Updating live watershed layer:"))
          f.session.reset();
      });
      if (phase === "initial") {
        const watch = f.watchViewport.getMockImplementation()!;
        f.watchViewport.mockImplementationOnce((...args) => {
          const dispose = watch(...args);
          f.onErrors[0](new Error("Recoverable compute error"));
          f.lives[0].changed.dispatch();
          return dispose;
        });
      }
      await f.session.addLayer();
      if (phase === "active") {
        f.onErrors[0](new Error("Recoverable compute error"));
        f.lives[0].changed.dispatch();
      }
      unwatch();
      expect(f.session.status).toContain("Viewer reset");
      expect(f.session.statusLevel).toBe("info");
      expect(f.session.busy).toBe(false);
      expect(f.layerManager.has(f.resultLayers[0])).toBe(false);
      expect(f.sourceGroup.has(f.resultLayers[0])).toBe(false);
      expect(f.publications[0].dispose).toHaveBeenCalledOnce();
      expect(f.watchers[0].dispose).toHaveBeenCalledOnce();
      const status = f.session.status;
      f.lives[0].changed.dispatch();
      expect(f.session.status).toBe(status);
    },
  );

  it("still removes an invalid source when an error arrives without a lifetime abort", async () => {
    const f = fixture();
    await f.session.addLayer();
    f.inputs.at(-1)!.invalidate(false);
    f.onErrors[0](new Error("Compute noticed an invalid source"));
    expect(f.session.statusLevel).toBe("error");
    expect(f.session.status).toContain("Watershed stopped");
    expect(f.session.status).toContain("Source snapshot changed");
    expect(f.layerManager.has(f.resultLayers[0])).toBe(false);
    expect(f.watchers[0].dispose).toHaveBeenCalledOnce();
    expect(f.publications[0].dispose).toHaveBeenCalledOnce();
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

  it("disposes a watcher returned after reentrant reset in its initial callback", async () => {
    const f = fixture();
    const watch = f.watchViewport.getMockImplementation()!;
    f.watchViewport.mockImplementationOnce((...args) => {
      const dispose = watch(...args);
      f.session.reset();
      args[3]({ lowerXYZ: [10, 20, -30], shapeXYZ: [12, 12, 8] });
      return dispose;
    });
    await f.session.addLayer();
    expect(f.session.statusLevel).toBe("info");
    expect(f.session.status).toContain("Viewer reset");
    expect(f.watchers[0].dispose).toHaveBeenCalledOnce();
    expect(f.publications[0].dispose).toHaveBeenCalledOnce();
    expect(f.lives[0].setRegion).not.toHaveBeenCalled();
    expect(f.layerManager.has(f.resultLayers[0])).toBe(false);
    expect(f.sourceGroup.has(f.resultLayers[0])).toBe(false);
    expect(f.session.busy).toBe(false);
  });

  it("cleans up a fatal watcher startup exception after group activation", async () => {
    const f = fixture();
    f.watchViewport.mockImplementationOnce(() => {
      throw new Error("Watcher startup failed");
    });
    await f.session.addLayer();
    expect(f.session.statusLevel).toBe("error");
    expect(f.session.status).toContain(
      "Watershed failed: Watcher startup failed",
    );
    expect(f.session.busy).toBe(false);
    expect(f.layerManager.has(f.resultLayers[0])).toBe(false);
    expect(f.sourceGroup.has(f.resultLayers[0])).toBe(false);
    expect(f.publications[0].dispose).toHaveBeenCalledOnce();
    expect(f.lives[0].dispose).toHaveBeenCalledOnce();
    expect(f.inputs.at(-1)!.dispose).toHaveBeenCalledOnce();
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
      expect(f.watchViewport).not.toHaveBeenCalled();
      for (const publication of f.publications)
        expect(publication.dispose).toHaveBeenCalledOnce();
      for (const live of f.lives) expect(live.dispose).toHaveBeenCalledOnce();
      for (const input of f.inputs)
        expect(input.dispose).toHaveBeenCalledOnce();
    },
  );

  it.each(["construction", "publication"])(
    "safely handles a synchronous onError callback during %s",
    async (stage) => {
      const f = fixture();
      if (stage === "construction")
        f.createLive.mockImplementationOnce(
          (input, _channels, _options, onError) => {
            const live = makeLive(input);
            f.lives.push(live);
            onError(new Error("startup failed"));
            return live as unknown as LiveWatershed;
          },
        );
      else {
        const publish = f.publish.getMockImplementation()!;
        f.publish.mockImplementationOnce((...args) => {
          const publication = publish(...args);
          f.onErrors[0](new Error("startup failed"));
          return publication;
        });
      }
      await f.session.addLayer();
      expect(f.session.statusLevel).toBe("error");
      expect(f.session.status).toContain("startup failed");
      expect(f.watchViewport).not.toHaveBeenCalled();
      expect(f.root.add).not.toHaveBeenCalled();
      if (stage === "construction") expect(f.publish).not.toHaveBeenCalled();
      else expect(f.publications[0].dispose).toHaveBeenCalledOnce();
      expect(f.lives[0].dispose).toHaveBeenCalledOnce();
      expect(f.inputs.at(-1)!.dispose).toHaveBeenCalledOnce();
    },
  );

  it("cleans up a fatal error while output activation is still pending", async () => {
    const f = fixture();
    f.resultState.ready = false;
    const adding = f.session.addLayer();
    f.onErrors[0](new Error("Output startup failed"));
    await adding;
    expect(f.session.statusLevel).toBe("error");
    expect(f.session.status).toContain("Output startup failed");
    expect(f.session.status).not.toContain("Added live layer:");
    expect(f.watchViewport).not.toHaveBeenCalled();
    expect(f.root.add).not.toHaveBeenCalled();
    expect(f.publications[0].dispose).toHaveBeenCalledOnce();
    expect(f.inputs.at(-1)!.dispose).toHaveBeenCalledOnce();
    expect(f.resultLayers[0].wasDisposed).toBe(true);
  });

  it.each([
    ["scaleIndex", "-1", "Source scale index"],
    ["scaleIndex", "0.5", "Source scale index"],
    ["scaleIndex", "", "Source scale index"],
    ["halo", "", "nonnegative safe integer"],
    ["halo", "-1", "nonnegative safe integer"],
    ["halo", "0.5", "nonnegative safe integer"],
    ["halo", "NaN", "nonnegative safe integer"],
    ["halo", "Infinity", "nonnegative safe integer"],
    ["halo", "-Infinity", "nonnegative safe integer"],
    ["halo", "9007199254740992", "nonnegative safe integer"],
    ["channelsXYZ", "0, 1", "three integers"],
    ["channelsXYZ", "0, 1, 2, 3", "three integers"],
    ["channelsXYZ", "foo, 1, 2", "integer ≥ 0"],
    ["channelsXYZ", "0.5, 1, 2", "integer ≥ 0"],
    ["channelsXYZ", "Infinity, 1, 2", "integer ≥ 0"],
    ["channelsXYZ", "0, 1, 4", "less than 4"],
    ["channelsXYZ", "-1, 1, 2", "integer ≥ 0"],
    ["maskThreshold", "", "Mask threshold must be a number between 0 and 1"],
    ["maskThreshold", "NaN", "Mask threshold must be a number between 0 and 1"],
    [
      "maskThreshold",
      "Infinity",
      "Mask threshold must be a number between 0 and 1",
    ],
    [
      "maskThreshold",
      "-Infinity",
      "Mask threshold must be a number between 0 and 1",
    ],
    [
      "maskThreshold",
      "-0.01",
      "Mask threshold must be a number between 0 and 1",
    ],
    [
      "maskThreshold",
      "1.01",
      "Mask threshold must be a number between 0 and 1",
    ],
    [
      "aggThreshold",
      "",
      "Agglomeration threshold (agg_threshold) must be a number between 0 and 1",
    ],
    [
      "aggThreshold",
      "NaN",
      "Agglomeration threshold (agg_threshold) must be a number between 0 and 1",
    ],
    [
      "aggThreshold",
      "Infinity",
      "Agglomeration threshold (agg_threshold) must be a number between 0 and 1",
    ],
    [
      "aggThreshold",
      "-Infinity",
      "Agglomeration threshold (agg_threshold) must be a number between 0 and 1",
    ],
    [
      "aggThreshold",
      "-0.01",
      "Agglomeration threshold (agg_threshold) must be a number between 0 and 1",
    ],
    [
      "aggThreshold",
      "1.01",
      "Agglomeration threshold (agg_threshold) must be a number between 0 and 1",
    ],
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
      f.session.useLastChannelAsMask = key === "maskThreshold";
      f.session.useAgglomeration = key === "aggThreshold";
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
