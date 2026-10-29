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

import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isChannelDimension } from "#src/coordinate_transform.js";
import { makeInferenceRecipeSource } from "#src/datasource/inference/frontend.js";
import type { PreparedInferenceInput } from "#src/inference/input.js";
import type { InferenceResult, ModelMetadata } from "#src/inference/model.js";
import { MAX_MODEL_BYTES } from "#src/inference/model.js";
import { ImageUserLayer } from "#src/layer/image/index.js";
import type { ManagedUserLayer } from "#src/layer/index.js";
import { LayerGroupViewer } from "#src/layer_group_viewer.js";
import type { LayoutComponentContainer } from "#src/layer_groups_layout.js";
import {
  SingletonLayerGroupViewer,
  StackLayoutComponent,
} from "#src/layer_groups_layout.js";
import { ChunkFormat } from "#src/sliceview/uncompressed_chunk_format.js";
import { defineChunkDataShaderAccess } from "#src/sliceview/volume/frontend.js";
import { defineImageLayerShader } from "#src/sliceview/volume/image_renderlayer.js";
import { statusMessages } from "#src/status.js";
import { ActionCommand } from "#src/ui/command.js";
import { CommandRegistry } from "#src/ui/command_registry.js";
import {
  INFERENCE_RESULT_SHADER,
  getInferenceResultShader,
  OnnxInferenceSession,
  bindOnnxInference,
  planAdjacentInferenceView,
  waitForInferenceLayer,
} from "#src/ui/onnx_inference.js";
import { DataType } from "#src/util/data_type.js";
import { RefCounted } from "#src/util/disposable.js";
import { registerActionListener } from "#src/util/event_action_map.js";
import { NullarySignal } from "#src/util/signal.js";
import type { Viewer } from "#src/viewer.js";
import { fragmentShaderTest } from "#src/webgl/shader_testing.js";
import {
  getFallbackBuilderState,
  parseShaderUiControls,
} from "#src/webgl/shader_ui_controls.js";

vi.mock("#src/datasource/inference/frontend.js", { spy: true });

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
  vi.restoreAllMocks();
});

const LEGACY_JSEP_PADDING_HELP =
  "Padding workarounds for the older JavaScript WebGPU backend. Not required for the default model on the tested native runtime.";

const metadata: ModelMetadata = {
  inputNames: ["input"],
  outputNames: ["output"],
  inputShape: [1, 1, 20, 80, 80],
  outputShape: [1, 4, 20, 80, 80],
  initMs: 0,
  threads: 1,
  requestedProvider: "auto",
  actualProvider: "wasm",
  fallbackReason: "WebGPU unavailable in test",
};
const result: InferenceResult = {
  data: new Float32Array(4),
  shapeZYX: [1, 1, 1],
  originZYX: [2, 10, 10],
  spacingZYX: [4, 2, 2],
  axisNamesZYX: ["z", "y", "x"],
  unitsZYX: ["m", "m", "m"],
  channels: 4,
  provenance: {},
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((r, e) => {
    resolve = r;
    reject = e;
  });
  return { promise, resolve, reject };
}
function fakeSource(name: string): ManagedUserLayer {
  const image = Object.assign(Object.create(ImageUserLayer.prototype), {
    dataSourcesChanged: new NullarySignal(),
    toJSON: () => ({ source: "precomputed://https://example.com/volume" }),
  });
  return {
    name,
    layer: image,
    layerChanged: new NullarySignal(),
  } as unknown as ManagedUserLayer;
}
function fixture(bundledModel?: typeof bundledTestModel) {
  const a = fakeSource("image"),
    b = fakeSource("image");
  const layerManager = {
    managedLayers: [a, b],
    layersChanged: new NullarySignal(),
    readyStateChanged: new NullarySignal(),
  };
  const viewer = {
    layerManager,
    resetInitiated: new NullarySignal(),
    state: { stateReset: new NullarySignal() },
    chunkManager: {},
    layerSpecification: { coordinateSpace: {} },
    layout: {
      container: container(
        group([a], { type: "viewer", layers: [a.name], layout: "xy" }),
      ),
    },
  } as unknown as Viewer;
  const input: PreparedInferenceInput = {
    shapeZYX: [100, 200, 300],
    originZYX: [0, 0, 0],
    spacingZYX: [4, 2, 2],
    axisNamesZYX: ["z", "y", "x"],
    unitsZYX: ["m", "m", "m"],
    validitySnapshot: {
      chunkDimensionsZYX: [2, 1, 0],
      lowerBoundChunk: [0, 0, 0],
      upperBoundChunk: [300, 200, 100],
      baseVoxelOffset: [0, 0, 0],
      chunkToMultiscaleTransform: [
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
      ],
      modelOriginZYX: [0, 0, 0],
    },
    isValid: () => true,
    assertValid: () => {},
    readPatch: vi.fn(),
    dispose: vi.fn(),
  };
  const run = vi.fn().mockResolvedValue(result);
  const controller = {
    loadModel: vi.fn().mockResolvedValue(metadata),
    onMetadata: (_metadata: ModelMetadata) => {},
    run,
    cancel: vi.fn(),
    dispose: vi.fn(),
  };
  const publishLive = vi.fn().mockResolvedValue({
    url: "inference://test/live",
    dispose: vi.fn(),
  });
  const fetchModel = vi.fn<typeof fetch>();
  const session = new OnnxInferenceSession(viewer, {
    createController: () => controller,
    prepareInput: () => input,
    publishLive,
    fetchModel,
    bundledModel,
  });
  disposers.push(() => session.dispose());
  session.selectSource(a);
  session.metadata = metadata;
  session.modelReference = { kind: "local", name: "model.onnx", size: 5 };
  session.outputSpacing = "2 2 4";
  session.confirmed = true;
  return {
    session,
    controller,
    publishLive,
    fetchModel,
    a,
    b,
    layerManager,
    input,
    viewer,
  };
}

function inputScaleField(session: OnnxInferenceSession) {
  return session.dialog!.body.querySelector<HTMLSelectElement>(
    '[aria-label="Input scale X Y Z"]',
  )!;
}

function outputSpacingField(session: OnnxInferenceSession) {
  return Array.from(session.dialog!.body.querySelectorAll("label"))
    .find((label) => label.textContent!.startsWith("Output voxel size"))!
    .querySelector("input")!;
}

function confirmationField(session: OnnxInferenceSession) {
  return session.dialog!.body.querySelector<HTMLInputElement>(
    'input[name="confirm-inference-settings"]',
  )!;
}

function chooseInputScale(session: OnnxInferenceSession, index: number) {
  const select = inputScaleField(session);
  expect(select.disabled).toBe(false);
  select.value = String(index);
  select.dispatchEvent(new Event("change"));
}

function multiscaleFixture(modelMetadata = metadata) {
  const f = fixture();
  const { session } = f;
  session.selectSource(undefined);
  session.metadata = modelMetadata;
  const scales = [
    {
      scaleIndex: 0,
      spacingZYX: [45e-9, 16e-9, 12e-9],
      axisNamesZYX: ["z", "y", "x"],
      unitsZYX: ["m", "m", "m"],
    },
    {
      scaleIndex: 1,
      spacingZYX: [90e-9, 48e-9, 24e-9],
      axisNamesZYX: ["z", "y", "x"],
      unitsZYX: ["m", "m", "m"],
    },
  ];
  const data = [Float32Array.of(1, 2), Float32Array.of(10, 20)];
  const listInputScales = (session.dependencies.listInputScales = vi.fn(
    () => scales,
  ));
  const prepared: PreparedInferenceInput[] = [];
  const prepare = vi
    .spyOn(session.dependencies, "prepareInput")
    .mockImplementation((_layer, scaleIndex = 0) => {
      const scale = scales.find((scale) => scale.scaleIndex === scaleIndex);
      if (scale === undefined) throw new Error("Unavailable test scale");
      const input = {
        ...f.input,
        ...scale,
        shapeZYX: scaleIndex === 0 ? [100, 200, 300] : [64, 160, 192],
        readPatch: vi
          .fn<PreparedInferenceInput["readPatch"]>()
          .mockResolvedValue(data[scaleIndex]),
        dispose: vi.fn(),
      };
      prepared.push(input);
      return input;
    });
  session.selectSource(f.a);
  return { ...f, scales, data, prepared, prepare, listInputScales };
}

function signalBackedInputs(
  session: OnnxInferenceSession,
  template: PreparedInferenceInput,
) {
  const snapshots: Array<{
    input: PreparedInferenceInput;
    invalidate(): void;
  }> = [];
  const prepare = vi
    .spyOn(session.dependencies, "prepareInput")
    .mockImplementation((layer) => {
      let valid = true;
      const invalidate = () => {
        valid = false;
      };
      // Real NullarySignal deliberately includes handlers added during dispatch.
      const remove = layer.dataSourcesChanged.add(invalidate);
      const input = {
        ...template,
        isValid: () => valid,
        assertValid: () => {
          if (!valid) throw new Error("stale input");
        },
        dispose: vi.fn(() => {
          remove();
          invalidate();
        }),
      };
      snapshots.push({ input, invalidate });
      return input;
    });
  return { prepare, snapshots };
}

// These small structural doubles exercise the exported insertion helper without
// creating a WebGL viewer; instanceof still follows the real layout classes.
function group(layers: ManagedUserLayer[], spec: object) {
  return Object.assign(Object.create(LayerGroupViewer.prototype), {
    layerSpecification: {
      layerManager: { has: (x: ManagedUserLayer) => layers.includes(x) },
    },
    toJSON: () => structuredClone(spec),
  });
}
function container(component: object, parent?: StackLayoutComponent) {
  return {
    component,
    parent,
    flex: { value: 3 },
    toJSON: vi.fn(() => ({ type: "old" })),
    setSpecification: vi.fn(),
  } as unknown as LayoutComponentContainer;
}
function stack(
  children: LayoutComponentContainer[],
  direction: "row" | "column",
) {
  const value = Object.create(StackLayoutComponent.prototype);
  Object.defineProperty(value, "length", { get: () => children.length });
  Object.assign(value, {
    direction,
    get: (i: number) => children[i],
    [Symbol.iterator]: () => children[Symbol.iterator](),
    insertChild: vi.fn(),
  });
  for (const child of children) child.parent = value;
  return value as StackLayoutComponent;
}

describe("inference result layout planning", () => {
  it("uses singleton.layerGroupViewer state, snapshotted before root result insertion", () => {
    const source = fakeSource("source");
    const spec = {
      type: "viewer",
      layers: ["source", "overlay"],
      layout: "xy",
      position: { link: "relative", value: [1, 2, 3] },
    };
    const singleton = Object.assign(
      Object.create(SingletonLayerGroupViewer.prototype),
      {
        layerGroupViewer: group([source], spec),
        toJSON: () => "xy",
      },
    );
    const target = container(singleton);
    const insert = planAdjacentInferenceView(target, source);
    spec.layers.push("result"); // Simulate root add after planning.
    insert("result");
    expect(target.setSpecification).toHaveBeenCalledWith({
      type: "row",
      flex: 3,
      children: [
        { ...spec, layers: ["source", "overlay"] },
        {
          type: "viewer",
          layers: ["result"],
          layout: "xy",
          position: spec.position,
        },
      ],
    });
  });

  it("inserts adjacent in an existing row without replacing other groups or navigation", () => {
    const source = fakeSource("source");
    const first = container(
      group([source], {
        type: "viewer",
        layers: ["source"],
        layout: "4panel",
        position: { link: "relative", value: [1, 2, 3] },
      }),
    );
    const next = container(
      group([], { type: "viewer", layers: ["other"], layout: "xz" }),
    );
    const row = stack([first, next], "row");
    const root = container(row);
    planAdjacentInferenceView(root, source)("result");
    expect(row.insertChild).toHaveBeenCalledWith(
      {
        type: "viewer",
        layers: ["result"],
        layout: "4panel",
        position: { link: "relative", value: [1, 2, 3] },
      },
      next,
    );
    expect(root.setSpecification).not.toHaveBeenCalled();
    expect(first.setSpecification).not.toHaveBeenCalled();
    expect(next.setSpecification).not.toHaveBeenCalled();
  });

  it("retains relative/root links without changing source groups", () => {
    const source = fakeSource("source");
    const navigation = {
      position: { link: "relative", value: [101, 202, 303] },
      crossSectionScale: { link: "relative", value: 2 },
      crossSectionOrientation: { link: "relative", value: [0, 0, 1, 0] },
      crossSectionDepth: { link: "relative", value: 3 },
      projectionScale: { link: "relative", value: 2 },
      projectionOrientation: { link: "relative", value: [0, 1, 0, 0] },
      projectionDepth: { link: "relative", value: 4 },
    };
    const target = container(
      group([source], {
        type: "viewer",
        layers: ["source"],
        layout: "4panel",
        ...navigation,
      }),
    );
    const row = stack([target], "row");
    planAdjacentInferenceView(container(row), source)("result");
    expect(row.insertChild).toHaveBeenCalledWith(
      { type: "viewer", layers: ["result"], layout: "4panel", ...navigation },
      undefined,
    );
    expect(target.setSpecification).not.toHaveBeenCalled();
  });

  it.each([
    "position",
    "velocity",
    "crossSectionScale",
    "crossSectionOrientation",
    "crossSectionDepth",
    "projectionScale",
    "projectionOrientation",
    "projectionDepth",
    "displayDimensions",
    "dimensionRenderScales",
  ])("rejects unlinked %s without changing layout", (key) => {
    const source = fakeSource("source");
    const target = container(
      group([source], {
        type: "viewer",
        layers: ["source"],
        layout: "xy",
        [key]: { link: "unlinked", value: [1, 2, 3] },
      }),
    );
    expect(() => planAdjacentInferenceView(target, source)).toThrow(
      "Link source navigation first",
    );
    expect(target.setSpecification).not.toHaveBeenCalled();
  });

  it("wraps only the source group within a column and synchronously rolls back insertion failure", () => {
    const source = fakeSource("source");
    const target = container(
      group([source], { type: "viewer", layers: ["source"], layout: "yz" }),
    );
    const unrelated = container(group([], {}));
    const root = container(stack([unrelated, target], "column"));
    vi.mocked(target.setSpecification).mockImplementationOnce(() => {
      throw new Error("construction failed");
    });
    expect(() => planAdjacentInferenceView(root, source)("result")).toThrow(
      "construction failed",
    );
    expect(target.setSpecification).toHaveBeenLastCalledWith({ type: "old" });
    expect(root.setSpecification).not.toHaveBeenCalled();
    expect(unrelated.setSpecification).not.toHaveBeenCalled();
  });

  it("does not make an empty view when the source is no longer displayed", () => {
    const root = container(group([], {}));
    expect(() => planAdjacentInferenceView(root, fakeSource("gone"))).toThrow(
      "Source is not displayed",
    );
    expect(root.setSpecification).not.toHaveBeenCalled();
  });
});

describe("output voxel size defaults and overrides", () => {
  const supersampled: ModelMetadata = {
    ...metadata,
    inputNames: ["image"],
    outputNames: ["prediction"],
    inputShape: [1, 1, 16, 128, 128],
    outputShape: [1, 1, 48, 128, 128],
  };
  const outputField = (session: OnnxInferenceSession) =>
    Array.from(session.dialog!.body.querySelectorAll("label"))
      .find((label) => label.textContent!.startsWith("Output voxel size"))!
      .querySelector("input")!;

  it("defaults 16→48 Z output spacing to 15nm when the source arrives after the model", async () => {
    const { session, controller, input, a } = fixture();
    Object.assign(input, { spacingZYX: [45e-9, 16e-9, 16e-9] });
    session.selectSource(undefined);
    controller.loadModel.mockResolvedValue(supersampled);
    await session.loadModel(new File(["model"], "custom.onnx"));
    session.selectSource(a);
    session.open();
    expect(session.metadata?.outputShape).toEqual([1, 1, 48, 128, 128]);
    expect(session.outputSpacing).toBe("1.6e-8, 1.6e-8, 1.5e-8");
    expect(outputField(session).value).toBe(session.outputSpacing);
    expect(
      session.dialog!.body.querySelector('[aria-label="Model geometry"]')!
        .textContent,
    ).toContain("crop 6, 16, 16 per face retains 36×96×96");
    expect(session.confirmed).toBe(false);
  });

  it.each([
    {
      name: "16→48 Z supersampling",
      modelMetadata: supersampled,
      outputXYZ: "1.6e-8, 1.6e-8, 1.5e-8",
    },
    {
      name: "equal spatial shapes",
      modelMetadata: metadata,
      outputXYZ: "1.6e-8, 1.6e-8, 4.5e-8",
    },
    {
      name: "asymmetric ratios on all three axes",
      modelMetadata: { ...supersampled, outputShape: [1, 4, 48, 64, 256] },
      outputXYZ: "8e-9, 3.2e-8, 1.5e-8",
    },
  ])(
    "recomputes $name output defaults when metadata arrives after the source",
    async ({ modelMetadata, outputXYZ }) => {
      const { session, controller, input, a } = fixture();
      session.selectSource(undefined);
      session.metadata = undefined;
      Object.assign(input, { spacingZYX: [45e-9, 16e-9, 16e-9] });
      session.selectSource(a);
      session.open();
      expect(outputField(session).value).toBe("1.6e-8, 1.6e-8, 4.5e-8");
      const pending = deferred<ModelMetadata>();
      controller.loadModel.mockReturnValueOnce(pending.promise);
      const loading = session.loadModel(new File(["model"], "custom.onnx"));
      expect(session.metadata).toBeUndefined();
      controller.onMetadata(modelMetadata);
      expect(session.outputSpacing).toBe(outputXYZ);
      expect(outputField(session).value).toBe(outputXYZ);
      pending.resolve(modelMetadata);
      await loading;
      expect(outputField(session).value).toBe(outputXYZ);
      expect(session.outputSpacingEdited).toBe(false);
      expect(session.confirmed).toBe(false);
    },
  );

  it("converts anisotropic source and typed output XYZ voxel sizes to ZYX geometry and serialized recipe", async () => {
    const { session, controller, input, a, publishLive } = fixture();
    Object.assign(input, { spacingZYX: [45, 16, 12] });
    session.selectSource(undefined);
    controller.loadModel.mockResolvedValue(supersampled);
    await session.loadModel(new File(["model"], "anisotropic.onnx"));
    session.selectSource(a);
    session.open();
    expect(inputScaleField(session).value).toBe("0");
    expect(outputField(session).value).toBe("12, 16, 15");
    expect(
      session.dialog!.body.querySelector(
        '[aria-label="Current input voxel size X Y Z"]',
      )!.textContent,
    ).toBe("Current input voxel size X Y Z: 12 m, 16 m, 45 m; axes: x, y, z.");
    outputField(session).value = "12 16 5";
    outputField(session).dispatchEvent(new Event("input"));
    const profile = session.dialog!.body.querySelector(
      '[aria-label="Model geometry"]',
    )!.textContent!;
    expect(profile).toContain("Model geometry ZYX: input 16×128×128");
    expect(profile).toContain("output voxel size 5, 16, 12");
    session
      .dialog!.body.querySelector<HTMLInputElement>(
        'input[name="confirm-inference-settings"]',
      )!
      .click();
    const pending = deferred<{ url: string; dispose(): void }>();
    publishLive.mockReturnValue(pending.promise);
    vi.mocked(makeInferenceRecipeSource).mockClear();
    const running = session.run();
    expect(publishLive, session.status).toHaveBeenCalledOnce();
    const live = publishLive.mock.calls[0][1];
    await live.readTile([0, 0, 0], new AbortController().signal);
    expect(controller.run).toHaveBeenCalledOnce();
    expect(controller.run.mock.calls[0][1].geometry).toMatchObject({
      inputSpacing: [45, 16, 12],
      outputSpacing: [5, 16, 12],
      inputShape: [16, 128, 128],
      rawOutputShape: [48, 128, 128],
    });
    expect(JSON.parse(live.info.provenanceJson).geometry).toMatchObject({
      inputSpacing: [45, 16, 12],
      outputSpacing: [5, 16, 12],
    });
    pending.resolve({ url: "inference://test/live", dispose: vi.fn() });
    await running;
    expect(makeInferenceRecipeSource).toHaveBeenCalledOnce();
    const recipe = JSON.parse(
      JSON.stringify(vi.mocked(makeInferenceRecipeSource).mock.lastCall![1]),
    );
    expect(recipe).toMatchObject({
      inputScaleIndex: 0,
      spacingZYX: [45, 16, 12],
      outputSpacingZYX: [5, 16, 12],
    });
  });

  it.each(["2 2 3", "", "invalid"])(
    "preserves output voxel draft %j across notifications, reopen and provider reload",
    async (edited) => {
      const { session, controller, a } = multiscaleFixture();
      const file = new File(["model"], "custom.onnx");
      await session.loadModel(file);
      session.open();
      const field = outputField(session);
      field.value = edited;
      field.dispatchEvent(new Event("input"));
      expect(session.confirmed).toBe(false);
      session.refreshSources();
      expect(outputField(session).value).toBe(edited);
      controller.onMetadata(supersampled);
      expect(session.outputSpacing).toBe(edited);
      expect(outputField(session).value).toBe(edited);
      const previous = session.input!;
      a.layer!.dataSourcesChanged.dispatch();
      await Promise.resolve();
      expect(previous.dispose).toHaveBeenCalledOnce();
      expect(session.input).not.toBe(previous);
      expect(outputField(session).value).toBe(edited);
      session.dialog!.close();
      session.open();
      expect(outputField(session).value).toBe(edited);
      const pending = deferred<ModelMetadata>();
      controller.loadModel.mockReturnValueOnce(pending.promise);
      const loading = session.loadModel(file);
      expect(session.metadata).toBeUndefined();
      expect(outputField(session).value).toBe(edited);
      controller.onMetadata(supersampled);
      expect(outputField(session).value).toBe(edited);
      pending.resolve(supersampled);
      await loading;
      expect(outputField(session).value).toBe(edited);
      await session.selectProvider("cpu");
      expect(outputField(session).value).toBe(edited);
      expect(session.outputSpacingEdited).toBe(true);
    },
  );

  it.each(["", "0 2 2", "NaN 2 2", "1 2"])(
    "rejects invalid output voxel size %j before running",
    async (value) => {
      const { session, controller } = fixture();
      session.outputSpacing = value;
      await session.run();
      expect(controller.run).not.toHaveBeenCalled();
      expect(session.status).toContain(
        "Output voxel size must contain three positive numbers",
      );
    },
  );

  it("passes model-derived single-channel geometry and user voxel size to live inference", async () => {
    const { session, controller, input, a, publishLive } = fixture();
    Object.assign(input, { spacingZYX: [45e-9, 16e-9, 16e-9] });
    session.selectSource(undefined);
    controller.loadModel.mockResolvedValue(supersampled);
    await session.loadModel(new File(["model"], "custom.onnx"));
    session.selectSource(a);
    session.outputSpacing = "1.6e-8 1.6e-8 1.5e-8";
    session.confirmed = true;
    const pending = deferred<{ url: string; dispose(): void }>();
    publishLive.mockReturnValue(pending.promise);
    const running = session.run();
    expect(controller.run).not.toHaveBeenCalled();
    const live = publishLive.mock.calls[0][1];
    await live.readTile([0, 0, 0], new AbortController().signal);
    expect(controller.run).toHaveBeenCalledOnce();
    const geometry = controller.run.mock.calls[0][1].geometry!;
    expect(geometry.inputShape).toEqual([16, 128, 128]);
    expect(geometry.rawOutputShape).toEqual([48, 128, 128]);
    expect(geometry.cropBefore).toEqual([6, 16, 16]);
    expect(geometry.cropAfter).toEqual([6, 16, 16]);
    expect(geometry.outputChannels).toBe(1);
    expect(geometry.outputSpacing).toEqual([15e-9, 16e-9, 16e-9]);
    expect(geometry.rawOutputOrigin[0]).toBeCloseTo(-15e-9, 16);
    session.cancel();
    pending.resolve({ url: "inference://test/live", dispose: vi.fn() });
    await running;
  });
});

describe("inference input scale selection", () => {
  const supersampled: ModelMetadata = {
    ...metadata,
    inputShape: [1, 1, 16, 128, 128],
    outputShape: [1, 1, 48, 128, 128],
  };

  it("lists XYZ scale sizes and prepares the chosen scale, disposing the old input and requiring confirmation", async () => {
    const {
      session,
      a,
      scales,
      prepared,
      prepare,
      listInputScales,
      publishLive,
    } = multiscaleFixture(supersampled);
    session.confirmed = true;
    session.open();
    expect(listInputScales).toHaveBeenCalledExactlyOnceWith(a.layer);
    expect(prepare).toHaveBeenCalledExactlyOnceWith(a.layer, 0);
    expect(listInputScales.mock.invocationCallOrder[0]).toBeLessThan(
      prepare.mock.invocationCallOrder[0],
    );
    expect(session.inputScales).toEqual(scales);
    expect(inputScaleField(session).value).toBe("0");
    expect(
      Array.from(inputScaleField(session).options, (option) => ({
        value: option.value,
        text: option.text,
      })),
    ).toEqual([
      { value: "0", text: "Scale 0: 12nm × 16nm × 45nm" },
      { value: "1", text: "Scale 1: 24nm × 48nm × 90nm" },
    ]);
    expect(outputSpacingField(session).value).toBe("1.2e-8, 1.6e-8, 1.5e-8");
    const previous = session.input!;
    chooseInputScale(session, 1);
    expect(previous.dispose).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenLastCalledWith(a.layer, 1);
    expect(session.input).toBe(prepared[1]);
    expect(session.input!.spacingZYX).toEqual([90e-9, 48e-9, 24e-9]);
    expect(session.inputScaleIndex).toBe(1);
    expect(inputScaleField(session).value).toBe("1");
    expect(
      session.dialog!.body.querySelector(
        '[aria-label="Current input voxel size X Y Z"]',
      )!.textContent,
    ).toBe(
      "Current input voxel size X Y Z: 2.4e-8 m, 4.8e-8 m, 9e-8 m; axes: x, y, z.",
    );
    expect(outputSpacingField(session).value).toBe("2.4e-8, 4.8e-8, 3e-8");
    expect(outputSpacingField(session).disabled).toBe(false);
    expect(session.confirmed).toBe(false);
    expect(confirmationField(session).checked).toBe(false);
    expect(session.metadata).toEqual(supersampled);
    await session.run();
    expect(publishLive).not.toHaveBeenCalled();
    expect(session.status).toContain("Confirm");
    const current = session.input!;
    chooseInputScale(session, 1);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(current.dispose).not.toHaveBeenCalled();
  });

  it("uses input spacing before metadata and recomputes for the selected scale when the model loads", async () => {
    const { session, a, controller } = multiscaleFixture();
    session.selectSource(undefined);
    session.metadata = undefined;
    session.modelReference = undefined;
    session.selectSource(a);
    session.open();
    expect(session.metadata).toBeUndefined();
    expect(outputSpacingField(session).value).toBe("1.2e-8, 1.6e-8, 4.5e-8");
    expect(outputSpacingField(session).disabled).toBe(false);
    chooseInputScale(session, 1);
    expect(session.metadata).toBeUndefined();
    expect(session.outputSpacing).toBe("2.4e-8, 4.8e-8, 9e-8");
    expect(outputSpacingField(session).value).toBe(session.outputSpacing);
    expect(session.outputSpacingEdited).toBe(false);
    expect(session.confirmed).toBe(false);
    controller.loadModel.mockResolvedValueOnce(supersampled);
    await session.loadModel(new File(["model"], "supersampled.onnx"));
    expect(session.metadata).toEqual(supersampled);
    expect(outputSpacingField(session).value).toBe("2.4e-8, 4.8e-8, 3e-8");
    expect(outputSpacingField(session).disabled).toBe(false);
  });

  it("replaces a manual output voxel draft with model-derived spacing for the chosen scale and leaves it editable", () => {
    const { session } = multiscaleFixture(supersampled);
    session.open();
    outputSpacingField(session).value = "1 2 3";
    outputSpacingField(session).dispatchEvent(new Event("input"));
    expect(session.outputSpacingEdited).toBe(true);
    chooseInputScale(session, 1);
    expect(session.outputSpacingEdited).toBe(false);
    expect(outputSpacingField(session).value).toBe("2.4e-8, 4.8e-8, 3e-8");
    expect(outputSpacingField(session).disabled).toBe(false);
    outputSpacingField(session).value = "2.4e-8 4.8e-8 6e-8";
    outputSpacingField(session).dispatchEvent(new Event("input"));
    expect(session.outputSpacing).toBe("2.4e-8 4.8e-8 6e-8");
    expect(session.outputSpacingEdited).toBe(true);
    chooseInputScale(session, 0);
    expect(session.outputSpacingEdited).toBe(false);
    expect(outputSpacingField(session).value).toBe("1.2e-8, 1.6e-8, 1.5e-8");
  });

  it("preserves the chosen scale across source refresh, model reload and reopen, but resets it for another source", async () => {
    const { session, a, b, prepare, controller } = multiscaleFixture();
    session.open();
    chooseInputScale(session, 1);
    const previous = session.input!;
    a.layer!.dataSourcesChanged.dispatch();
    await Promise.resolve();
    expect(previous.dispose).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenLastCalledWith(a.layer, 1);
    session.refreshSources();
    controller.onMetadata(metadata);
    await session.loadModel(new File(["model"], "model.onnx"));
    const selected = session.input;
    const attempts = prepare.mock.calls.length;
    session.dialog!.close();
    session.open();
    expect(session.input).toBe(selected);
    expect(prepare).toHaveBeenCalledTimes(attempts);
    expect(session.inputScaleIndex).toBe(1);
    expect(inputScaleField(session).value).toBe("1");
    expect(session.confirmed).toBe(false);
    const source = session.dialog!.body.querySelector("select")!;
    source.value = "1";
    source.dispatchEvent(new Event("change"));
    expect(session.source).toBe(b);
    expect(session.inputScaleIndex).toBe(0);
    expect(inputScaleField(session).value).toBe("0");
    expect(prepare).toHaveBeenLastCalledWith(b.layer, 0);
  });

  it("uses the selected scale's data and geometry for live inference and emits its index in the saved recipe", async () => {
    const { session, controller, publishLive, data, prepared } =
      multiscaleFixture(supersampled);
    session.open();
    chooseInputScale(session, 1);
    confirmationField(session).click();
    expect(session.confirmed).toBe(true);
    const pending = deferred<{ url: string; dispose(): void }>();
    publishLive.mockReturnValueOnce(pending.promise);
    controller.run.mockImplementationOnce(
      async (input: PreparedInferenceInput) => {
        expect(
          await input.readPatch(
            [0, 0, 0],
            [1, 1, 2],
            new AbortController().signal,
          ),
        ).toEqual(data[1]);
        return result;
      },
    );
    vi.mocked(makeInferenceRecipeSource).mockClear();
    const running = session.run();
    expect(inputScaleField(session).disabled).toBe(true);
    const live = publishLive.mock.calls[0][1];
    await live.readTile([0, 0, 0], new AbortController().signal);
    expect(controller.run).toHaveBeenCalledOnce();
    expect(controller.run.mock.calls[0][0]).toBe(prepared[1]);
    expect(prepared[0].readPatch).not.toHaveBeenCalled();
    expect(prepared[1].readPatch).toHaveBeenCalledOnce();
    expect(controller.run.mock.calls[0][1].geometry).toMatchObject({
      inputSpacing: [90e-9, 48e-9, 24e-9],
      outputSpacing: [30e-9, 48e-9, 24e-9],
      inputShape: [16, 128, 128],
      rawOutputShape: [48, 128, 128],
    });
    expect(session.liveActive).toBe(true);
    expect(inputScaleField(session).disabled).toBe(true);
    pending.resolve({ url: "inference://test/scale1", dispose: vi.fn() });
    await running;
    expect(makeInferenceRecipeSource).toHaveBeenCalledOnce();
    expect(
      JSON.parse(
        JSON.stringify(vi.mocked(makeInferenceRecipeSource).mock.lastCall![1]),
      ),
    ).toMatchObject({
      inputScaleIndex: 1,
      spacingZYX: [90e-9, 48e-9, 24e-9],
      outputSpacingZYX: [30e-9, 48e-9, 24e-9],
    });
    session.cancel();
    expect(inputScaleField(session).disabled).toBe(false);
  });

  it("invalidates pending live results when the selected scale changes and releases late publication", async () => {
    const { session, prepared, publishLive, viewer } = multiscaleFixture();
    const add = vi.fn();
    Object.assign(viewer.layerSpecification, { add });
    session.open();
    confirmationField(session).click();
    const pending = deferred<{ url: string; dispose(): void }>();
    publishLive.mockReturnValueOnce(pending.promise);
    const running = session.run();
    const live = publishLive.mock.calls[0][1];
    expect(session.liveActive).toBe(true);
    expect(inputScaleField(session).disabled).toBe(true);
    // The UI blocks edits while live; programmatic selection still invalidates it.
    session.selectInputScale(1);
    expect(session.liveActive).toBe(false);
    expect(session.confirmed).toBe(false);
    expect(confirmationField(session).checked).toBe(false);
    expect(prepared[0].dispose).toHaveBeenCalledOnce();
    expect(session.input).toBe(prepared[1]);
    expect(inputScaleField(session).value).toBe("1");
    expect(inputScaleField(session).disabled).toBe(false);
    await expect(
      live.readTile([0, 0, 0], new AbortController().signal),
    ).rejects.toThrow("stopped");
    const dispose = vi.fn();
    pending.resolve({ url: "inference://test/old-scale", dispose });
    await running;
    expect(dispose).toHaveBeenCalledOnce();
    expect(add).not.toHaveBeenCalled();
    expect(session.inputScaleIndex).toBe(1);
    expect(session.confirmed).toBe(false);
  });

  it("disables scale selection while loading a model and reenables it afterward", async () => {
    const { session, controller } = multiscaleFixture();
    session.open();
    const pending = deferred<ModelMetadata>();
    controller.loadModel.mockReturnValueOnce(pending.promise);
    const loading = session.loadModel(new File(["model"], "model.onnx"));
    expect(session.busy).toBe(true);
    expect(inputScaleField(session).disabled).toBe(true);
    pending.resolve(metadata);
    await loading;
    expect(inputScaleField(session).disabled).toBe(false);
    chooseInputScale(session, 1);
    expect(session.inputScaleIndex).toBe(1);
  });
});

describe("optional output overlap and blending", () => {
  it("defaults to no overlap, identifies Chunkflow blending, and retains an enabled choice across dialog reopen", () => {
    const { session, controller } = fixture();
    session.open();
    const toggle = () =>
      session.dialog!.body.querySelector<HTMLInputElement>(
        '[aria-label="Overlap and blend output patches"]',
      )!;
    const profile = () =>
      session.dialog!.body.querySelector('[aria-label="Model geometry"]')!
        .textContent;
    expect(session.overlap).toBe(false);
    expect(toggle().checked).toBe(false);
    expect(toggle().labels?.[0].textContent?.trim()).toBe(
      "Overlap and blend output patches (chunkflow)",
    );
    expect(profile()).toContain("input stride 16, 60, 60");
    expect(profile()).toContain("output stride 16, 60, 60");
    expect(profile()).toContain("no overlap or blending");
    const cancels = controller.cancel.mock.calls.length;
    toggle().click();
    expect(session.overlap).toBe(true);
    expect(session.confirmed).toBe(false);
    expect(session.metadata).toEqual(metadata);
    expect(controller.cancel).toHaveBeenCalledTimes(cancels);
    expect(profile()).toContain("input stride 10, 40, 40");
    expect(profile()).not.toContain("no overlap or blending");
    session.dialog!.close();
    session.open();
    expect(toggle().checked).toBe(true);
  });

  it("publishes numeric no-overlap geometry and provenance without changing the new-session default", async () => {
    const { session, controller, publishLive } = fixture();
    expect(session.overlap).toBe(false);
    await session.run();
    const live = publishLive.mock.calls[0][1];
    expect(live.info.originZYX).toEqual([2, 10, 10]);
    expect(live.info.shapeZYX).toEqual([96, 180, 240]);
    expect(JSON.parse(live.info.provenanceJson)).toMatchObject({
      boundary:
        "Cropped nonoverlapping outputs from contexts fully inside the source; live publishes full output chunks only; no padding",
      blending: {
        method: "none",
        inputStrideZYX: [16, 60, 60],
        retainedOutputShapeZYX: [16, 60, 60],
      },
      geometry: {
        inputShape: [20, 80, 80],
        inputSpacing: [4, 2, 2],
        rawOutputShape: [20, 80, 80],
        outputSpacing: [4, 2, 2],
        cropBefore: [2, 10, 10],
        cropAfter: [2, 10, 10],
      },
    });
    expect(vi.mocked(makeInferenceRecipeSource).mock.lastCall![1].overlap).toBe(
      false,
    );
    expect(controller.run).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "passes overlap=%s to live inference and outgoing shared state",
    async (overlap) => {
      const { session, controller, publishLive } = fixture();
      session.overlap = overlap;
      await session.run();
      expect(publishLive).toHaveBeenCalledOnce();
      expect(controller.run).not.toHaveBeenCalled();
      const live = publishLive.mock.calls[0][1];
      expect(JSON.parse(live.info.provenanceJson).blending.method).toBe(
        overlap ? "wu" : "none",
      );
      const recipe = vi.mocked(makeInferenceRecipeSource).mock.lastCall![1];
      expect(JSON.parse(JSON.stringify(recipe)).overlap).toBe(overlap);
    },
  );

  it("rejects a nonintegral no-overlap input stride before inference", async () => {
    const { session, controller, publishLive } = fixture();
    session.overlap = false;
    session.outputSpacing = "2 2 3.1";
    await session.run();
    expect(session.status).toContain("Fractional input alignment");
    expect(controller.run).not.toHaveBeenCalled();
    expect(publishLive).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "passes overlap=%s through live inference without changing display chunks",
    async (overlap) => {
      const { session, controller } = fixture();
      const pending = deferred<{ url: string; dispose(): void }>();
      const publishLive = (session.dependencies.publishLive = vi
        .fn<NonNullable<typeof session.dependencies.publishLive>>()
        .mockReturnValue(pending.promise));
      session.overlap = overlap;
      session.open();
      const running = session.run();
      const live = publishLive.mock.calls[0][1];
      expect(JSON.parse(live.info.provenanceJson).blending.method).toBe(
        overlap ? "wu" : "none",
      );
      expect(
        session.dialog!.body.querySelector<HTMLInputElement>(
          '[aria-label="Overlap and blend output patches"]',
        )!.disabled,
      ).toBe(true);
      await live.readTile([0, 0, 0], new AbortController().signal);
      expect(controller.run.mock.calls[0][1].overlap).toBe(overlap);
      expect(controller.run.mock.calls[0][1].shapeZYX).toEqual([16, 60, 60]);
      session.cancel();
      const dispose = vi.fn();
      pending.resolve({ url: "inference://test/live", dispose });
      await running;
      expect(dispose).toHaveBeenCalledOnce();
    },
  );
});

describe("model-channel result shader", () => {
  it.each([1, 4, 7])(
    "renders all %i raw channels without normalization",
    (channels) => {
      const channelRank = ["x", "y", "z", "c^"].filter(
        isChannelDimension,
      ).length;
      const shaderSource = getInferenceResultShader(channels);
      if (channels === 4) expect(shaderSource).toBe(INFERENCE_RESULT_SHADER);
      const parsed = parseShaderUiControls(shaderSource, {
        imageData: { dataType: DataType.FLOAT32, channelRank },
      });
      expect(parsed.errors).toEqual([]);
      if (channels === 1) expect(parsed.controls.has("channel")).toBe(false);
      else
        expect(parsed.controls.get("channel")).toMatchObject({
          type: "slider",
          valueType: "int",
          min: 0,
          max: channels - 1,
          default: 0,
        });
      fragmentShaderTest({}, { outputValue: "float" }, (tester) => {
        const { gl, builder } = tester;
        const format = tester.registerDisposer(
          ChunkFormat.get(gl, DataType.FLOAT32, 3),
        );
        const layout = tester.registerDisposer(
          format.getTextureLayout(gl, Uint32Array.of(1, 1, 1, channels)),
        );
        builder.addUniform("highp vec3", "vChunkPosition");
        builder.addUniform("vec3", "uChunkDataSize");
        builder.addUniform("float", "uOpacity");
        defineChunkDataShaderAccess(
          builder,
          format,
          channelRank,
          "vChunkPosition",
        );
        builder.addFragmentCode(
          "void emit(vec4 value) { outputValue = value.r; }",
        );
        defineImageLayerShader(builder, getFallbackBuilderState(parsed));
        tester.build();
        const { shader } = tester;
        const texture = gl.createTexture();
        tester.registerDisposer(() => gl.deleteTexture(texture));
        const values = Float32Array.from(
          { length: channels },
          (_, channel) => channel * 1.75 - 2,
        );
        format.beginDrawing(gl, shader);
        gl.bindTexture(gl.TEXTURE_3D, texture);
        format.setTextureData(gl, layout, values);
        format.setupTextureLayout(
          gl,
          shader,
          layout,
          Uint32Array.of(0, 0, 0, 0),
          [0, 1, 2],
          [3],
        );
        gl.uniform3fv(shader.uniform("uChunkDataSize"), [1, 1, 1]);
        gl.uniform3fv(shader.uniform("vChunkPosition"), [0, 0, 0]);
        for (let channel = 0; channel < channels; ++channel) {
          if (channels > 1)
            gl.uniform1i(shader.uniform("u_shaderControl_channel"), channel);
          tester.execute();
          expect(tester.values.outputValue).toBe(values[channel]);
        }
        format.endDrawing(gl, shader);
      });
    },
  );
});

describe("result layer readiness", () => {
  it("rejects finished-but-failed image loading instead of publishing an empty panel", async () => {
    const layer = fakeSource("failed");
    Object.assign(layer, {
      readyStateChanged: new NullarySignal(),
      isReady: () => true,
    });
    Object.assign(layer.layer!, {
      dataSources: [{ loadState: { error: new Error("result missing") } }],
      dataType: { value: undefined },
      renderLayers: [],
    });
    await expect(
      waitForInferenceLayer(layer, new AbortController().signal),
    ).rejects.toThrow("result missing");
  });

  it("aborts a pending result layer wait", async () => {
    const layer = fakeSource("pending");
    Object.assign(layer, {
      readyStateChanged: new NullarySignal(),
      isReady: () => false,
    });
    Object.assign(layer.layer!, { dataSources: [] });
    const abort = new AbortController();
    const pending = waitForInferenceLayer(layer, abort.signal);
    abort.abort();
    await expect(pending).rejects.toThrow("Cancelled");
  });
});

const bundledTestModel = {
  name: "nooverseg.onnx",
  urls: ["/models/test.part0.bin", "/models/test.part1.bin"],
  size: 5,
  sha256: "9372c470eeadd5ecd9c3c74c2b3cb633f8e2f2fad799250a0f70d652b6b825e4",
};

function bundledFixture(bundledModel = bundledTestModel) {
  const f = fixture(bundledModel);
  f.session.metadata = undefined;
  f.session.confirmed = false;
  return f;
}

function modelUrlInput(session: OnnxInferenceSession) {
  return session.dialog!.body.querySelector<HTMLTextAreaElement>(
    '[aria-label="Model URL (.onnx)"]',
  )!;
}

function precisionToggle(session: OnnxInferenceSession) {
  return session.dialog!.body.querySelector<HTMLInputElement>(
    '[aria-label="Experimental FP16 GPU inference"]',
  )!;
}

function compatibilityToggle(session: OnnxInferenceSession) {
  return page
    .elementLocator(session.dialog!.body)
    .getByRole("checkbox", {
      name: "Apply legacy JSEP padding fixes",
      exact: true,
    })
    .element() as HTMLInputElement;
}

function precisionStatus(session: OnnxInferenceSession) {
  return session.dialog!.body.querySelector(
    '[aria-label="Inference precision status"]',
  )!.textContent;
}

function loadUrlButton(session: OnnxInferenceSession) {
  return Array.from(session.dialog!.body.querySelectorAll("button")).find(
    (button) => button.textContent === "Load model URL",
  )!;
}

function enterModelUrl(session: OnnxInferenceSession, url: string) {
  const input = modelUrlInput(session);
  input.value = url;
  input.dispatchEvent(new Event("input"));
  loadUrlButton(session).click();
}

// A deliberately non-cooperative reader exercises results arriving after abort.
function pendingBody() {
  const body = deferred<ReadableStreamReadResult<Uint8Array>>();
  const reader = {
    read: vi.fn().mockReturnValueOnce(body.promise),
    cancel: vi.fn().mockResolvedValue(undefined),
    releaseLock: vi.fn(),
  };
  const response = new Response();
  Object.defineProperty(response, "body", {
    value: { getReader: () => reader },
  });
  return { body, reader, response };
}

describe("experimental GPU inference precision", () => {
  const fp16: ModelMetadata = {
    ...metadata,
    actualProvider: "webgpu",
    fallbackReason: undefined,
    requestedPrecision: "float16",
    actualPrecision: "float16",
  };
  const fallback: ModelMetadata = {
    ...fp16,
    actualPrecision: "float32",
    precisionFallbackReason: "WebGPU adapter does not support shader-f16",
  };

  it("defaults off, reloads the original file on toggle, and retains precision across reopen and provider changes", async () => {
    const { session, controller, fetchModel } = fixture();
    const file = new File(["original model bytes"], "original.onnx");
    session.compatibilityFixes = true;
    await session.loadModel(file);
    const reference = session.modelReference;
    session.confirmed = true;
    session.open();
    expect(session.precision).toBe("float32");
    expect(precisionToggle(session).checked).toBe(false);
    expect(precisionStatus(session)).toContain("Requested precision: FP32");
    expect(precisionStatus(session)).toContain(
      "last initialized precision: FP32",
    );
    expect(controller.loadModel).toHaveBeenLastCalledWith(
      file,
      "auto",
      true,
      "float32",
    );
    const loading = deferred<ModelMetadata>();
    controller.loadModel.mockReturnValueOnce(loading.promise);
    const cancels = controller.cancel.mock.calls.length;
    precisionToggle(session).click();
    expect(session.precision).toBe("float16");
    expect(session.confirmed).toBe(false);
    expect(session.metadata).toBeUndefined();
    expect(controller.cancel.mock.calls.length).toBeGreaterThan(cancels);
    expect(controller.loadModel).toHaveBeenLastCalledWith(
      file,
      "auto",
      true,
      "float16",
    );
    expect(session.busy).toBe(true);
    expect(precisionToggle(session).checked).toBe(true);
    expect(precisionToggle(session).disabled).toBe(true);
    expect(precisionStatus(session)).toContain("Requested precision: FP16");
    expect(precisionStatus(session)).toContain("Runtime not initialized");
    loading.resolve(fp16);
    await vi.waitFor(() => expect(session.busy).toBe(false));
    expect(precisionToggle(session).disabled).toBe(false);
    expect(precisionStatus(session)).toContain(
      "last initialized precision: FP16",
    );
    const loads = controller.loadModel.mock.calls.length;
    const idleCancels = controller.cancel.mock.calls.length;
    await session.selectPrecision("float16");
    session.dialog!.close();
    session.open();
    expect(precisionToggle(session).checked).toBe(true);
    expect(controller.loadModel).toHaveBeenCalledTimes(loads);
    expect(controller.cancel).toHaveBeenCalledTimes(idleCancels);
    controller.loadModel.mockResolvedValueOnce({
      ...metadata,
      requestedProvider: "cpu",
      requestedPrecision: "float16",
      actualPrecision: "float32",
      precisionFallbackReason: "FP16 requires WebGPU",
    });
    await session.selectProvider("cpu");
    expect(controller.loadModel).toHaveBeenLastCalledWith(
      file,
      "cpu",
      true,
      "float16",
    );
    expect(session.modelReference).toBe(reference);
    expect(session.precision).toBe("float16");
    expect(precisionToggle(session).checked).toBe(true);
    await session.selectPrecision("float32");
    expect(controller.loadModel).toHaveBeenLastCalledWith(
      file,
      "cpu",
      true,
      "float32",
    );
    expect(precisionToggle(session).checked).toBe(false);
    expect(fetchModel).not.toHaveBeenCalled();
  });

  it("shows shader-f16 fallback without unchecking the request and refreshes actual precision from worker metadata", async () => {
    const { session, controller } = fixture();
    await session.selectPrecision("float16");
    controller.loadModel.mockResolvedValueOnce(fallback);
    await session.loadModel(new File(["model"], "model.onnx"));
    session.open();
    expect(precisionToggle(session).checked).toBe(true);
    expect(precisionStatus(session)).toContain("Requested precision: FP16");
    expect(precisionStatus(session)).toContain(
      "last initialized precision: FP32",
    );
    expect(precisionStatus(session)).toContain(
      `FP32 fallback: ${fallback.precisionFallbackReason}`,
    );
    controller.onMetadata(fp16);
    expect(precisionStatus(session)).toContain(
      "last initialized precision: FP16",
    );
    expect(precisionStatus(session)).not.toContain("FP32 fallback:");
    session.dialog!.close();
    controller.onMetadata(fallback);
    session.open();
    expect(precisionToggle(session).checked).toBe(true);
    expect(precisionStatus(session)).toContain("shader-f16");
    expect(precisionStatus(session)).toContain(
      "last initialized precision: FP32",
    );
  });

  it.each(["initialization", "download"])(
    "clears stale FP16 metadata during %s failure and a later FP32 reload",
    async (failure) => {
      const { session, controller, fetchModel } = fixture();
      await session.selectPrecision("float16");
      controller.loadModel.mockResolvedValueOnce(
        failure === "initialization" ? fp16 : fallback,
      );
      const file = new File(["model"], "model.onnx");
      await session.loadModel(file);
      session.open();
      expect(precisionStatus(session)).toContain(
        failure === "initialization"
          ? "last initialized precision: FP16"
          : "shader-f16",
      );
      const pending = deferred<ModelMetadata>();
      const download = deferred<Response>();
      let changing: Promise<void>;
      if (failure === "initialization") {
        controller.loadModel.mockReturnValueOnce(pending.promise);
        changing = session.selectPrecision("float32");
      } else {
        fetchModel.mockReturnValueOnce(download.promise);
        changing = session.loadModelUrl("https://example.org/new.onnx");
      }
      expect(session.metadata).toBeUndefined();
      expect(precisionStatus(session)).toContain("Runtime not initialized");
      expect(precisionStatus(session)).not.toContain(
        "last initialized precision:",
      );
      expect(precisionStatus(session)).not.toContain("shader-f16");
      if (failure === "initialization")
        pending.reject(new Error("FP32 load failed"));
      else download.reject(new Error("Model download failed"));
      await changing;
      expect(session.status).toContain("failed");
      expect(session.metadata).toBeUndefined();
      expect(precisionStatus(session)).not.toContain("FP32 fallback:");
      expect(precisionToggle(session).disabled).toBe(false);
      session.dialog!.close();
      session.open();
      expect(precisionStatus(session)).toContain("Runtime not initialized");
      await session.selectPrecision("float32");
      await session.loadModel(file);
      expect(precisionToggle(session).checked).toBe(false);
      expect(precisionStatus(session)).toContain("Requested precision: FP32");
      expect(precisionStatus(session)).toContain(
        "last initialized precision: FP32",
      );
      expect(precisionStatus(session)).not.toContain("shader-f16");
    },
  );
});

describe("default ONNX model selection", () => {
  it("prefills the dependency URL without loading on open or reopen and has only the URL load control", async () => {
    const url = "https://models.example.org/dependency-default.onnx";
    const { session, controller, fetchModel } = bundledFixture({
      ...bundledTestModel,
      urls: [url],
    });
    expect(session.modelUrl).toBe(url);
    session.open();
    expect(modelUrlInput(session)).toBeInstanceOf(HTMLTextAreaElement);
    expect(modelUrlInput(session).value).toBe(url);
    const buttons = Array.from(session.dialog!.body.querySelectorAll("button"));
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Load model URL",
    ]);
    session.dialog!.close();
    session.open();
    expect(modelUrlInput(session).value).toBe(url);
    await Promise.resolve();
    expect(fetchModel).not.toHaveBeenCalled();
    expect(controller.loadModel).not.toHaveBeenCalled();
    expect(session.metadata).toBeUndefined();
    expect(session.busy).toBe(false);
  });

  it("keeps URL edits and setting changes idle until the first explicit load", async () => {
    const { session, controller, fetchModel } = bundledFixture();
    const url = "https://models.example.org/edited.onnx";
    const assertIdle = async () => {
      await Promise.resolve();
      expect(fetchModel).not.toHaveBeenCalled();
      expect(controller.loadModel).not.toHaveBeenCalled();
      expect(session.metadata).toBeUndefined();
      expect(session.busy).toBe(false);
      expect(session.downloadingModel).toBe(false);
    };
    session.open();
    await assertIdle();
    const provider = session.dialog!.body.querySelector<HTMLSelectElement>(
      '[aria-label="Execution provider"]',
    )!;
    provider.value = "cpu";
    provider.dispatchEvent(new Event("change"));
    await assertIdle();
    precisionToggle(session).click();
    await assertIdle();
    compatibilityToggle(session).click();
    await assertIdle();
    session
      .dialog!.body.querySelector<HTMLInputElement>(
        '[aria-label="Overlap and blend output patches"]',
      )!
      .click();
    await assertIdle();
    modelUrlInput(session).value = url;
    modelUrlInput(session).dispatchEvent(new Event("input"));
    await assertIdle();
    session.dialog!.close();
    session.open();
    expect(modelUrlInput(session).value).toBe(url);
    expect(session.provider).toBe("cpu");
    expect(precisionToggle(session).checked).toBe(true);
    expect(session.compatibilityFixes).toBe(true);
    expect(session.overlap).toBe(true);
    await assertIdle();
    fetchModel.mockResolvedValueOnce(new Response("model"));
    loadUrlButton(session).click();
    await vi.waitFor(() => expect(session.metadata).toEqual(metadata));
    expect(fetchModel).toHaveBeenCalledExactlyOnceWith(url, {
      signal: expect.any(AbortSignal),
      mode: "cors",
      credentials: "omit",
    });
    expect(controller.loadModel).toHaveBeenCalledExactlyOnceWith(
      expect.any(File),
      "cpu",
      true,
      "float16",
    );
  });

  it("uses an empty URL draft when no dependency default exists", () => {
    const { session } = fixture();
    expect(session.modelUrl).toBe("");
    session.open();
    expect(modelUrlInput(session).value).toBe("");
  });

  it("downloads a single external model anonymously through CORS before loading verified bytes", async () => {
    const url = "https://models.example.org/model300000.onnx";
    const { session, controller, fetchModel } = bundledFixture({
      ...bundledTestModel,
      name: "model300000.onnx",
      urls: [url],
    });
    fetchModel.mockResolvedValueOnce(new Response("model"));
    session.open();
    expect(fetchModel).not.toHaveBeenCalled();
    expect(controller.loadModel).not.toHaveBeenCalled();
    loadUrlButton(session).click();
    await vi.waitFor(() => expect(session.metadata).toEqual(metadata));
    expect(fetchModel).toHaveBeenCalledExactlyOnceWith(url, {
      signal: expect.any(AbortSignal),
      mode: "cors",
      credentials: "omit",
    });
    const [file, provider] = controller.loadModel.mock.calls[0];
    expect(file.name).toBe("model300000.onnx");
    expect(session.modelReference).toEqual({
      kind: "url",
      name: "model300000.onnx",
      urls: [url],
      size: bundledTestModel.size,
      sha256: bundledTestModel.sha256,
    });
    expect(await file.text()).toBe("model");
    expect(provider).toBe("auto");
    session.dialog!.close();
    session.open();
    expect(fetchModel).toHaveBeenCalledOnce();
    expect(controller.loadModel).toHaveBeenCalledOnce();
  });

  it("downloads the prefilled default only on click, verifies and reassembles it once, and retains bytes and runtime across reopen", async () => {
    const { session, controller, fetchModel } = bundledFixture();
    const download = deferred<Response>();
    const loading = deferred<ModelMetadata>();
    fetchModel.mockReturnValueOnce(download.promise);
    fetchModel.mockResolvedValueOnce(new Response("del"));
    controller.loadModel.mockReturnValueOnce(loading.promise);
    expect(fetchModel).not.toHaveBeenCalled();
    expect(controller.loadModel).not.toHaveBeenCalled();
    expect(controller.run).not.toHaveBeenCalled();
    session.open();
    expect(fetchModel).not.toHaveBeenCalled();
    expect(controller.loadModel).not.toHaveBeenCalled();
    expect(modelUrlInput(session).value).toBe(bundledTestModel.urls[0]);
    loadUrlButton(session).click();
    expect(session.status).toContain(
      "Downloading default model nooverseg.onnx (part 1/2)",
    );
    expect(
      session.dialog!.content.querySelector('[role="status"]')!.textContent,
    ).toBe(session.status);
    expect(session.busy).toBe(true);
    expect(session.downloadingModel).toBe(true);
    expect(session.dialog!.body.querySelector("select")!.disabled).toBe(true);
    expect(modelUrlInput(session).disabled).toBe(false);
    expect(
      session.dialog!.body.querySelector<HTMLSelectElement>(
        '[aria-label="Execution provider"]',
      )!.disabled,
    ).toBe(false);
    expect(loadUrlButton(session).disabled).toBe(false);
    session.dialog!.close();
    session.open();
    expect(fetchModel).toHaveBeenCalledOnce();
    download.resolve(new Response("mo"));
    await vi.waitFor(() => expect(controller.loadModel).toHaveBeenCalledOnce());
    expect(fetchModel.mock.calls.map(([url]) => url)).toEqual(
      bundledTestModel.urls,
    );
    const signal = fetchModel.mock.calls[0][1]!.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(fetchModel.mock.calls[1][1]).toEqual({
      signal,
      mode: "cors",
      credentials: "omit",
    });
    expect(signal!.aborted).toBe(false);
    const [file, provider] = controller.loadModel.mock.calls[0];
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("nooverseg.onnx");
    expect(await file.text()).toBe("model");
    expect(provider).toBe("auto");
    expect(session.status).toContain("Loading model");
    expect(session.downloadingModel).toBe(false);
    expect(session.busy).toBe(true);
    expect(session.dialog!.body.querySelector("select")!.disabled).toBe(true);
    loading.resolve(metadata);
    await vi.waitFor(() => expect(session.metadata).toEqual(metadata));
    expect(session.status).toContain("Model ready");
    expect(session.busy).toBe(false);
    expect(session.dialog!.body.querySelector("select")!.disabled).toBe(false);
    session.dialog!.close();
    session.open();
    expect(fetchModel).toHaveBeenCalledTimes(2);
    expect(controller.loadModel).toHaveBeenCalledOnce();
    // The prefilled URL reuses verified multipart bytes, not a custom download.
    expect(modelUrlInput(session).value).toBe(bundledTestModel.urls[0]);
    loadUrlButton(session).click();
    await vi.waitFor(() =>
      expect(controller.loadModel).toHaveBeenCalledTimes(2),
    );
    expect(fetchModel).toHaveBeenCalledTimes(2);
    await session.selectProvider("cpu");
    expect(controller.loadModel).toHaveBeenLastCalledWith(
      file,
      "cpu",
      false,
      "float32",
    );
    expect(session.modelReference).toEqual({
      kind: "url",
      ...bundledTestModel,
    });
    expect(fetchModel).toHaveBeenCalledTimes(2);
    expect(controller.run).not.toHaveBeenCalled();
  });

  it("preserves a manual model selected before first open", async () => {
    const { session, controller, fetchModel } = bundledFixture();
    const file = new File(["local"], "override.onnx");
    await session.loadModel(file);
    session.open();
    session.dialog!.close();
    session.open();
    expect(fetchModel).not.toHaveBeenCalled();
    expect(controller.loadModel).toHaveBeenCalledExactlyOnceWith(
      file,
      "auto",
      false,
      "float32",
    );
    expect(session.modelReference).toEqual({
      kind: "local",
      name: "override.onnx",
      size: file.size,
    });
    await session.selectProvider("cpu");
    expect(session.modelReference?.kind).toBe("local");
  });

  it("allows the URL UI to override a download, rejects its late response, and restores the default", async () => {
    const { session, controller, fetchModel } = bundledFixture();
    const download = deferred<Response>();
    fetchModel.mockReturnValueOnce(download.promise);
    session.open();
    loadUrlButton(session).click();
    const signal = fetchModel.mock.calls[0][1]!.signal!;
    const url = "https://example.org/override.onnx";
    fetchModel.mockResolvedValueOnce(new Response("model"));
    enterModelUrl(session, url);
    expect(signal.aborted).toBe(true);
    await vi.waitFor(() => expect(session.metadata).toEqual(metadata));
    download.resolve(new Response("obsolete"));
    await Promise.resolve();
    expect(fetchModel).toHaveBeenCalledTimes(2);
    expect(controller.loadModel).toHaveBeenCalledOnce();
    expect(session.modelReference).toEqual({
      kind: "url",
      name: "override.onnx",
      urls: [url],
      size: 5,
      sha256: bundledTestModel.sha256,
    });
    expect(session.modelName).toBe("override.onnx");
    session.dialog!.close();
    session.open();
    expect(modelUrlInput(session).value).toBe(url);
    expect(fetchModel).toHaveBeenCalledTimes(2);
    fetchModel.mockResolvedValueOnce(new Response("mo"));
    fetchModel.mockResolvedValueOnce(new Response("del"));
    enterModelUrl(session, bundledTestModel.urls[0]);
    await vi.waitFor(() => expect(session.modelName).toBe("nooverseg.onnx"));
    await vi.waitFor(() =>
      expect(controller.loadModel).toHaveBeenCalledTimes(2),
    );
    expect(modelUrlInput(session).value).toBe(bundledTestModel.urls[0]);
    expect(session.modelReference).toEqual({
      kind: "url",
      ...bundledTestModel,
    });
    // Once verified, restoring the default never downloads it again.
    fetchModel.mockResolvedValueOnce(new Response("custom"));
    await session.loadModelUrl(url);
    enterModelUrl(session, bundledTestModel.urls[0]);
    await vi.waitFor(() => expect(session.busy).toBe(false));
    expect(fetchModel).toHaveBeenCalledTimes(5);
    expect(session.modelReference).toEqual({
      kind: "url",
      ...bundledTestModel,
    });
  });

  it.each(["response", "body", "hash", "initialization"])(
    "restoring the default URL supersedes custom %s work before reusing verified multipart bytes",
    async (stage) => {
      const { session, controller, fetchModel } = bundledFixture();
      fetchModel.mockResolvedValueOnce(new Response("mo"));
      fetchModel.mockResolvedValueOnce(new Response("del"));
      session.open();
      loadUrlButton(session).click();
      await vi.waitFor(() => expect(session.metadata).toEqual(metadata));
      const defaultFile = controller.loadModel.mock.calls[0][0];
      const response = deferred<Response>();
      const stream = pendingBody();
      const hash = deferred<ArrayBuffer>();
      const initialization = deferred<ModelMetadata>();
      if (stage === "hash")
        vi.spyOn(crypto.subtle, "digest").mockReturnValueOnce(hash.promise);
      if (stage === "initialization")
        controller.loadModel.mockReturnValueOnce(initialization.promise);
      fetchModel.mockReturnValueOnce(
        stage === "response"
          ? response.promise
          : Promise.resolve(
              stage === "body" ? stream.response : new Response("custom"),
            ),
      );
      const customLoading = session.loadModelUrl(
        "https://example.org/custom.onnx",
      );
      if (stage === "body")
        await vi.waitFor(() =>
          expect(stream.reader.read).toHaveBeenCalledOnce(),
        );
      else if (stage === "hash")
        await vi.waitFor(() =>
          expect(crypto.subtle.digest).toHaveBeenCalledOnce(),
        );
      else if (stage === "initialization")
        await vi.waitFor(() =>
          expect(controller.loadModel).toHaveBeenCalledTimes(2),
        );
      const oldSignal = fetchModel.mock.calls[2][1]!.signal!;
      // Whitespace is accepted without treating the multipart default as a
      // single custom URL or dropping its verified-byte cache.
      const cancels = controller.cancel.mock.calls.length;
      if (stage === "initialization") {
        // Initialization disables the UI; exercise programmatic replacement
        // without pretending a disabled Load model URL button can be clicked.
        expect(loadUrlButton(session).disabled).toBe(true);
        await session.loadModelUrl(`  ${bundledTestModel.urls[0]}  `);
      } else {
        enterModelUrl(session, `  ${bundledTestModel.urls[0]}  `);
        expect(oldSignal.aborted).toBe(true);
      }
      expect(controller.cancel.mock.calls.length).toBeGreaterThan(cancels);
      await vi.waitFor(() => expect(session.busy).toBe(false));
      expect(controller.loadModel).toHaveBeenLastCalledWith(
        defaultFile,
        "auto",
        false,
        "float32",
      );
      const status = session.status;
      if (stage === "response") response.resolve(new Response("obsolete"));
      else if (stage === "body") {
        expect(stream.reader.cancel).toHaveBeenCalled();
        stream.body.resolve({
          done: false,
          value: new TextEncoder().encode("obsolete"),
        });
      } else if (stage === "hash") hash.resolve(new ArrayBuffer(32));
      else initialization.resolve({ ...metadata, actualProvider: "webgpu" });
      await customLoading;
      expect(fetchModel).toHaveBeenCalledTimes(3);
      expect(session.status).toBe(status);
      expect(session.metadata).toEqual(metadata);
      expect(session.modelReference).toEqual({
        kind: "url",
        ...bundledTestModel,
      });
    },
  );

  it("shows HTTP failures without retrying on reopen, and retries explicitly", async () => {
    const { session, controller, fetchModel } = bundledFixture();
    fetchModel.mockResolvedValueOnce(new Response("mo"));
    fetchModel.mockResolvedValueOnce(
      new Response("missing", { status: 404, statusText: "Not Found" }),
    );
    session.open();
    loadUrlButton(session).click();
    await vi.waitFor(() => expect(session.busy).toBe(false));
    expect(session.status).toContain(
      "Default model download failed: HTTP 404 Not Found",
    );
    expect(
      session.dialog!.content.querySelector('[role="status"]')!.textContent,
    ).toBe(session.status);
    expect(session.metadata).toBeUndefined();
    expect(controller.loadModel).not.toHaveBeenCalled();
    expect(fetchModel.mock.calls[0][1]!.signal!.aborted).toBe(true);
    session.dialog!.close();
    session.open();
    expect(fetchModel).toHaveBeenCalledTimes(2);
    fetchModel.mockResolvedValueOnce(new Response("mo"));
    fetchModel.mockResolvedValueOnce(new Response("del"));
    expect(modelUrlInput(session).value).toBe(bundledTestModel.urls[0]);
    expect(loadUrlButton(session).disabled).toBe(false);
    loadUrlButton(session).click();
    await vi.waitFor(() => expect(session.metadata).toEqual(metadata));
    expect(fetchModel).toHaveBeenCalledTimes(4);
    expect(controller.loadModel).toHaveBeenCalledOnce();
  });

  it.each(["network", "size", "hash"])(
    "surfaces %s failure without initializing the model",
    async (failure) => {
      const { session, controller, fetchModel } = bundledFixture();
      if (failure === "network")
        fetchModel.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      else {
        fetchModel.mockResolvedValueOnce(new Response("mo"));
        fetchModel.mockResolvedValueOnce(
          new Response(failure === "size" ? "" : "bad"),
        );
      }
      session.open();
      loadUrlButton(session).click();
      await vi.waitFor(() => expect(session.busy).toBe(false));
      expect(session.status).toContain(
        failure === "network"
          ? "Failed to fetch"
          : failure === "size"
            ? "Expected 5 model bytes, received 2"
            : "Model SHA-256 mismatch",
      );
      expect(controller.loadModel).not.toHaveBeenCalled();
      session.dialog!.close();
      session.open();
      expect(fetchModel).toHaveBeenCalledTimes(failure === "network" ? 1 : 2);
    },
  );

  it.each(["cancel", "reset", "dispose", "source"])(
    "aborts a download on %s and ignores stale completion without automatic retry",
    async (change) => {
      const { session, controller, fetchModel, viewer, b } = bundledFixture();
      const download = deferred<Response>();
      fetchModel.mockReturnValueOnce(download.promise);
      session.open();
      loadUrlButton(session).click();
      const signal = fetchModel.mock.calls[0][1]!.signal!;
      if (change === "cancel") session.cancel();
      else if (change === "reset") viewer.resetInitiated.dispatch();
      else if (change === "source") session.selectSource(b);
      else {
        disposers.pop();
        session.dispose();
      }
      expect(signal.aborted).toBe(true);
      expect(session.busy).toBe(false);
      expect(session.downloadingModel).toBe(false);
      const status = session.status;
      download.resolve(new Response("mo"));
      await Promise.resolve();
      expect(controller.loadModel).not.toHaveBeenCalled();
      expect(session.metadata).toBeUndefined();
      expect(session.status).toBe(status);
      if (change !== "dispose") {
        session.dialog!.close();
        session.open();
      }
      expect(fetchModel).toHaveBeenCalledOnce();
    },
  );

  it.each(
    ["response", "failure"].flatMap((completion) =>
      ["provider", "precision"].map((setting) => ({ completion, setting })),
    ),
  )(
    "restarts bundled downloading on explicit $setting change and ignores the old $completion",
    async ({ completion, setting }) => {
      const { session, controller, fetchModel } = bundledFixture();
      const oldDownload = deferred<Response>();
      const replacement = deferred<Response>();
      fetchModel.mockReturnValueOnce(oldDownload.promise);
      fetchModel.mockReturnValueOnce(replacement.promise);
      fetchModel.mockResolvedValueOnce(new Response("del"));
      session.open();
      loadUrlButton(session).click();
      const oldSignal = fetchModel.mock.calls[0][1]!.signal!;
      const provider = session.dialog!.body.querySelector<HTMLSelectElement>(
        '[aria-label="Execution provider"]',
      )!;
      if (setting === "provider") {
        expect(provider.disabled).toBe(false);
        provider.value = "cpu";
        provider.dispatchEvent(new Event("change"));
      } else {
        expect(precisionToggle(session).disabled).toBe(false);
        precisionToggle(session).click();
      }
      expect(oldSignal.aborted).toBe(true);
      expect(fetchModel).toHaveBeenCalledTimes(2);
      const newSignal = fetchModel.mock.calls[1][1]!.signal!;
      expect(newSignal).not.toBe(oldSignal);
      expect(newSignal.aborted).toBe(false);
      expect(session.provider).toBe(setting === "provider" ? "cpu" : "auto");
      expect(session.precision).toBe(
        setting === "precision" ? "float16" : "float32",
      );
      expect(session.confirmed).toBe(false);
      const status = session.status;
      if (completion === "response")
        oldDownload.resolve(new Response("obsolete"));
      else oldDownload.reject(new Error("Old download failed"));
      await Promise.resolve();
      expect(session.busy).toBe(true);
      expect(session.downloadingModel).toBe(true);
      expect(session.metadata).toBeUndefined();
      expect(session.status).toBe(status);
      expect(controller.loadModel).not.toHaveBeenCalled();
      expect(session.dialog!.body.querySelector("select")!.disabled).toBe(true);
      session.dialog!.close();
      session.open();
      expect(fetchModel).toHaveBeenCalledTimes(2);
      replacement.resolve(new Response("mo"));
      await vi.waitFor(() => expect(session.metadata).toEqual(metadata));
      expect(controller.loadModel).toHaveBeenCalledOnce();
      const [file, requestedProvider] = controller.loadModel.mock.calls[0];
      expect(await file.text()).toBe("model");
      expect(requestedProvider).toBe(setting === "provider" ? "cpu" : "auto");
      expect(controller.loadModel.mock.calls[0][3]).toBe(
        setting === "precision" ? "float16" : "float32",
      );
      const reference = session.modelReference;
      if (setting === "precision") {
        await session.selectPrecision("float32");
        expect(controller.loadModel).toHaveBeenLastCalledWith(
          file,
          "auto",
          false,
          "float32",
        );
        expect(session.modelReference).toBe(reference);
        expect(fetchModel).toHaveBeenCalledTimes(3);
      }
      expect(fetchModel.mock.calls.map(([url]) => url)).toEqual([
        bundledTestModel.urls[0],
        ...bundledTestModel.urls,
      ]);
      expect(fetchModel.mock.calls[2][1]!.signal).toBe(newSignal);
      expect(newSignal.aborted).toBe(false);
      expect(session.busy).toBe(false);
      expect(session.dialog!.body.querySelector("select")!.disabled).toBe(
        false,
      );
    },
  );

  it("aborts during body download and ignores a stale body even after a new attempt starts", async () => {
    const { session, controller, fetchModel } = bundledFixture();
    const { body, reader, response } = pendingBody();
    fetchModel.mockResolvedValueOnce(response);
    session.open();
    loadUrlButton(session).click();
    await vi.waitFor(() => expect(reader.read).toHaveBeenCalledOnce());
    const signal = fetchModel.mock.calls[0][1]!.signal!;
    session.cancel();
    expect(signal.aborted).toBe(true);
    fetchModel.mockResolvedValueOnce(new Response("mo"));
    fetchModel.mockResolvedValueOnce(new Response("del"));
    loadUrlButton(session).click();
    await vi.waitFor(() => expect(session.busy).toBe(false));
    expect(reader.cancel).toHaveBeenCalledOnce();
    body.resolve({ done: false, value: new TextEncoder().encode("obsolete") });
    await Promise.resolve();
    expect(fetchModel).toHaveBeenCalledTimes(3);
    expect(controller.loadModel).toHaveBeenCalledOnce();
    expect(session.status).toContain("Model ready");
  });

  it("shows model initialization failure and retries verified bytes only on request", async () => {
    const { session, controller, fetchModel } = bundledFixture();
    controller.loadModel.mockRejectedValueOnce(new Error("Unsupported model"));
    fetchModel.mockResolvedValueOnce(new Response("mo"));
    fetchModel.mockResolvedValueOnce(new Response("del"));
    session.open();
    loadUrlButton(session).click();
    await vi.waitFor(() => expect(session.busy).toBe(false));
    expect(session.status).toBe("Model load failed: Unsupported model");
    expect(session.metadata).toBeUndefined();
    session.dialog!.close();
    session.open();
    expect(controller.loadModel).toHaveBeenCalledOnce();
    expect(modelUrlInput(session).value).toBe(bundledTestModel.urls[0]);
    loadUrlButton(session).click();
    await vi.waitFor(() => expect(session.metadata).toEqual(metadata));
    expect(fetchModel).toHaveBeenCalledTimes(2);
    expect(controller.loadModel).toHaveBeenCalledTimes(2);
  });

  it.each(["success", "failure"])(
    "rejects a stale controller load %s after cancellation and reuses verified bytes on retry",
    async (completion) => {
      const { session, controller, fetchModel } = bundledFixture();
      const loading = deferred<ModelMetadata>();
      controller.loadModel.mockReturnValueOnce(loading.promise);
      fetchModel.mockResolvedValueOnce(new Response("mo"));
      fetchModel.mockResolvedValueOnce(new Response("del"));
      session.open();
      loadUrlButton(session).click();
      await vi.waitFor(() =>
        expect(controller.loadModel).toHaveBeenCalledOnce(),
      );
      session.cancel();
      const status = session.status;
      const statusElement =
        session.dialog!.content.querySelector<HTMLElement>('[role="status"]')!;
      expect(session.statusLevel).toBe("info");
      expect(statusElement.dataset.severity).toBe("info");
      expect(getComputedStyle(statusElement)).toMatchObject({
        fontWeight: "700",
        color: "rgb(27, 94, 32)",
      });
      if (completion === "success") loading.resolve(metadata);
      else loading.reject(new Error("Superseded model load failed"));
      await Promise.resolve();
      expect(session.metadata).toBeUndefined();
      expect(session.status).toBe(status);
      expect(session.statusLevel).toBe("info");
      expect(statusElement.textContent).toBe(status);
      expect(statusElement.dataset.severity).toBe("info");
      expect(getComputedStyle(statusElement)).toMatchObject({
        fontWeight: "700",
        color: "rgb(27, 94, 32)",
      });
      session.dialog!.close();
      session.open();
      expect(
        session.dialog!.content.querySelector<HTMLElement>('[role="status"]')!
          .dataset.severity,
      ).toBe("info");
      expect(fetchModel).toHaveBeenCalledTimes(2);
      expect(controller.loadModel).toHaveBeenCalledOnce();
      loadUrlButton(session).click();
      await vi.waitFor(() => expect(session.metadata).toEqual(metadata));
      expect(fetchModel).toHaveBeenCalledTimes(2);
      expect(controller.loadModel).toHaveBeenCalledTimes(2);
      expect(session.metadata).toEqual(metadata);
      const readyStatus =
        session.dialog!.content.querySelector<HTMLElement>('[role="status"]')!;
      expect(session.statusLevel).toBe("info");
      expect(readyStatus.textContent).toContain("Model ready");
      expect(readyStatus.dataset.severity).toBe("info");
      expect(getComputedStyle(readyStatus)).toMatchObject({
        fontWeight: "700",
        color: "rgb(27, 94, 32)",
      });
    },
  );
});

describe("custom ONNX model URLs", () => {
  const url = "https://models.example.org/custom.onnx?revision=1";

  it.each(["float32", "float16"] as const)(
    "loads anonymously and preserves the original URL digest and precision=%s through provider reload and recipe JSON",
    async (precision) => {
      const { session, controller, fetchModel } = fixture();
      await session.selectPrecision(precision);
      session.open();
      expect(
        session.dialog!.body.querySelector('input[type="file"]'),
      ).toBeNull();
      expect(session.dialog!.body.textContent).not.toContain("local file");
      expect(modelUrlInput(session).labels?.[0].textContent).toContain(
        "Model URL (.onnx)",
      );
      fetchModel.mockResolvedValueOnce(new Response("model"));
      enterModelUrl(session, url);
      await vi.waitFor(() => expect(session.busy).toBe(false));
      expect(fetchModel).toHaveBeenCalledExactlyOnceWith(url, {
        signal: expect.any(AbortSignal),
        mode: "cors",
        credentials: "omit",
      });
      const reference = {
        kind: "url",
        name: "custom.onnx",
        urls: [url],
        size: 5,
        sha256: bundledTestModel.sha256,
      };
      expect(session.modelReference).toEqual(reference);
      const file = controller.loadModel.mock.calls[0][0];
      expect(await file.text()).toBe("model");
      await session.selectProvider("cpu");
      expect(controller.loadModel).toHaveBeenLastCalledWith(
        file,
        "cpu",
        false,
        precision,
      );
      expect(fetchModel).toHaveBeenCalledOnce();
      expect(session.modelReference).toEqual(reference);
      // Observe the actual serialized source constructed by run(), before the
      // structural viewer double rejects real layer construction.
      session.confirmed = true;
      vi.mocked(makeInferenceRecipeSource).mockClear();
      await session.run();
      expect(makeInferenceRecipeSource).toHaveBeenCalledOnce();
      const recipe = vi.mocked(makeInferenceRecipeSource).mock.lastCall![1];
      expect(recipe.model).toEqual(reference);
      expect(recipe.provider).toBe("cpu");
      expect(recipe.precision).toBe(precision);
      const restored = JSON.parse(JSON.stringify(recipe));
      expect(restored.model).toEqual(reference);
      expect(restored.precision).toBe(precision);
      expect(restored.mode).toBe("live");
      expect(restored).not.toHaveProperty("preprocessing");
      expect(restored).not.toHaveProperty("roi");
      expect(session.precision).toBe(precision);
    },
  );

  it("wraps and auto-sizes the complete long URL initially, after edits, on reopen, and when its width changes", async () => {
    const resizeErrors: string[] = [];
    const onError = (event: ErrorEvent) => {
      if (event.message.includes("ResizeObserver"))
        resizeErrors.push(event.message);
    };
    window.addEventListener("error", onError);
    disposers.push(() => window.removeEventListener("error", onError));
    const initial = `https://models.example.org/${"a".repeat(900)}.onnx?revision=1`;
    const { session, controller, fetchModel } = bundledFixture({
      ...bundledTestModel,
      urls: [initial],
    });
    session.metadata = metadata;
    session.open();
    session.dialog!.body.style.width = "540px";
    const expectFullyVisible = async (value: string) => {
      // Let ResizeObserver finish a layout cycle before comparing heights;
      // an oversized textarea can already contain all text at its new width.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => window.setTimeout(resolve, 0)),
        ),
      );
      await vi.waitFor(() => {
        const input = modelUrlInput(session);
        expect(input.value).toBe(value);
        expect(input.checkVisibility()).toBe(true);
        expect(input.clientWidth).toBeGreaterThan(100);
        expect(input.scrollWidth).toBeLessThanOrEqual(input.clientWidth);
        expect(input.scrollHeight).toBeLessThanOrEqual(input.clientHeight + 1);
        // More than two lines must actually be laid out, not clipped or scrolled.
        expect(input.clientHeight).toBeGreaterThan(
          3 * Number.parseFloat(getComputedStyle(input).fontSize),
        );
        expect(input.getBoundingClientRect().width).toBeCloseTo(
          input.labels![0].getBoundingClientRect().width,
          0,
        );
      });
    };
    await expectFullyVisible(initial);
    const initialHeight = modelUrlInput(session).clientHeight;
    const edited = `https://models.example.org/${"b".repeat(1800)}.onnx?revision=2`;
    modelUrlInput(session).value = edited;
    modelUrlInput(session).dispatchEvent(new Event("input"));
    await expectFullyVisible(edited);
    expect(modelUrlInput(session).clientHeight).toBeGreaterThan(initialHeight);
    controller.onMetadata(metadata);
    session.dialog!.close();
    session.open();
    session.dialog!.body.style.width = "540px";
    await expectFullyVisible(edited);
    const wideWidth = modelUrlInput(session).clientWidth;
    const wideHeight = modelUrlInput(session).clientHeight;
    session.dialog!.body.style.width = "260px";
    await expectFullyVisible(edited);
    await vi.waitFor(() => {
      expect(modelUrlInput(session).clientWidth).toBeLessThan(wideWidth);
      expect(modelUrlInput(session).clientHeight).toBeGreaterThan(wideHeight);
    });
    session.dialog!.body.style.width = "540px";
    await expectFullyVisible(edited);
    await vi.waitFor(() =>
      expect(modelUrlInput(session).clientHeight).toBe(wideHeight),
    );
    expect(resizeErrors).toEqual([]);
    expect(fetchModel).not.toHaveBeenCalled();
  });

  it("preserves an unfinished URL draft across metadata, notifications and reopen", () => {
    const { session, controller } = fixture();
    session.open();
    const draft = "https://models.example.org/still-typing";
    modelUrlInput(session).value = draft;
    modelUrlInput(session).dispatchEvent(new Event("input"));
    controller.onMetadata(metadata);
    session.refreshSources();
    expect(modelUrlInput(session).value).toBe(draft);
    session.dialog!.close();
    session.open();
    expect(modelUrlInput(session).value).toBe(draft);
  });

  it.each([
    "",
    "/model.onnx",
    "file:///model.onnx",
    "data:application/onnx,test",
    "http://example.org/model.onnx",
    "http://localhost.example.org/a",
    "https://user:secret@example.org/model.onnx",
    "https://user@example.org/a",
  ])("shows invalid URL errors without fetching: %s", async (value) => {
    const { session, fetchModel, controller } = fixture();
    session.open();
    enterModelUrl(session, value);
    await vi.waitFor(() =>
      expect(session.status).toContain("Model URL load failed"),
    );
    expect(
      session.dialog!.content.querySelector('[role="status"]')!.textContent,
    ).toBe(session.status);
    expect(fetchModel).not.toHaveBeenCalled();
    expect(controller.loadModel).not.toHaveBeenCalled();
    expect(session.metadata).toBeUndefined();
    expect(session.modelReference).toBeUndefined();
  });

  it.each([
    "http://localhost:8000/a.onnx",
    "http://127.0.0.1/a.onnx",
    "http://[::1]/a.onnx",
  ])("accepts HTTP loopback URL %s", async (value) => {
    const { session, fetchModel } = fixture();
    fetchModel.mockResolvedValueOnce(new Response("model"));
    await session.loadModelUrl(value);
    expect(session.modelReference).toMatchObject({
      kind: "url",
      urls: [value],
    });
    expect(session.metadata).toEqual(metadata);
  });

  it.each(["network", "HTTP", "empty", "oversized", "hash"])(
    "shows %s failures without loading a model",
    async (failure) => {
      const { session, controller, fetchModel } = fixture();
      session.open();
      if (failure === "network")
        fetchModel.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      else if (failure === "HTTP")
        fetchModel.mockResolvedValueOnce(
          new Response("missing", { status: 404, statusText: "Not Found" }),
        );
      else if (failure === "empty")
        fetchModel.mockResolvedValueOnce(new Response(""));
      else if (failure === "oversized")
        fetchModel.mockResolvedValueOnce(
          new Response("small", {
            headers: { "Content-Length": String(MAX_MODEL_BYTES + 1) },
          }),
        );
      else {
        fetchModel.mockResolvedValueOnce(new Response("model"));
        vi.spyOn(crypto.subtle, "digest").mockRejectedValueOnce(
          new Error("Hash unavailable"),
        );
      }
      enterModelUrl(session, url);
      await vi.waitFor(() => expect(session.busy).toBe(false));
      const message = {
        network: "Failed to fetch",
        HTTP: "HTTP 404 Not Found",
        empty: "Model download is empty",
        oversized: "Model exceeds maximum size",
        hash: "Hash unavailable",
      }[failure];
      expect(session.status).toContain(message);
      expect(
        session.dialog!.content.querySelector('[role="status"]')!.textContent,
      ).toBe(session.status);
      expect(controller.loadModel).not.toHaveBeenCalled();
      session.dialog!.close();
      session.open();
      expect(fetchModel).toHaveBeenCalledOnce();
    },
  );

  it("rejects oversized streamed chunks before retaining them and cancels the reader", async () => {
    const { session, controller, fetchModel } = fixture();
    const { response, reader, body } = pendingBody();
    fetchModel.mockResolvedValueOnce(response);
    const loading = session.loadModelUrl(url);
    await vi.waitFor(() => expect(reader.read).toHaveBeenCalledOnce());
    // No multi-GB allocation: only byteLength is inspected before rejection.
    body.resolve({
      done: false,
      value: { byteLength: MAX_MODEL_BYTES + 1 } as Uint8Array,
    });
    await loading;
    expect(session.status).toContain("Model exceeds maximum size");
    expect(reader.cancel).toHaveBeenCalled();
    expect(controller.loadModel).not.toHaveBeenCalled();
  });

  it.each(["cancel", "reset", "source", "dispose", "new URL"])(
    "aborts pending fetch on %s and ignores late success",
    async (change) => {
      const { session, controller, fetchModel, b } = fixture();
      const pending = deferred<Response>();
      fetchModel.mockReturnValueOnce(pending.promise);
      const loading = session.loadModelUrl(url);
      const signal = fetchModel.mock.calls[0][1]!.signal!;
      if (change === "cancel") session.cancel();
      else if (change === "reset") session.reset();
      else if (change === "source") session.selectSource(b);
      else if (change === "dispose") {
        disposers.pop();
        session.dispose();
      } else {
        fetchModel.mockResolvedValueOnce(new Response("model"));
        await session.loadModelUrl("https://example.org/new.onnx");
      }
      expect(signal.aborted).toBe(true);
      const status = session.status;
      pending.resolve(new Response("obsolete"));
      await loading;
      expect(session.status).toBe(status);
      expect(controller.loadModel).toHaveBeenCalledTimes(
        change === "new URL" ? 1 : 0,
      );
      if (change === "new URL")
        expect(session.modelReference).toMatchObject({
          urls: ["https://example.org/new.onnx"],
        });
    },
  );

  it.each(["cancel", "reset", "source"])(
    "ignores a pending SHA-256 result after %s",
    async (change) => {
      const { session, controller, fetchModel, b } = fixture();
      const hash = deferred<ArrayBuffer>();
      vi.spyOn(crypto.subtle, "digest").mockReturnValueOnce(hash.promise);
      fetchModel.mockResolvedValueOnce(new Response("model"));
      const loading = session.loadModelUrl(url);
      await vi.waitFor(() =>
        expect(crypto.subtle.digest).toHaveBeenCalledOnce(),
      );
      const signal = fetchModel.mock.calls[0][1]!.signal!;
      if (change === "cancel") session.cancel();
      else if (change === "reset") session.reset();
      else session.selectSource(b);
      const status = session.status;
      expect(signal.aborted).toBe(true);
      hash.resolve(new ArrayBuffer(32));
      await loading;
      expect(controller.loadModel).not.toHaveBeenCalled();
      expect(session.status).toBe(status);
      expect(session.metadata).toBeUndefined();
      expect(session.busy).toBe(false);
    },
  );

  it("uses decoded streamed bytes, not an encoded Content-Length, for the URL reference", async () => {
    const { session, fetchModel } = fixture();
    fetchModel.mockResolvedValueOnce(
      new Response("model", {
        headers: {
          "Content-Length": String(MAX_MODEL_BYTES + 1),
          "Content-Encoding": "gzip",
        },
      }),
    );
    await session.loadModelUrl(url);
    expect(session.modelReference).toMatchObject({
      size: 5,
      sha256: bundledTestModel.sha256,
    });
    expect(session.metadata).toEqual(metadata);
  });

  it.each(["body", "hash"])(
    "ignores stale %s results after a new URL starts",
    async (stage) => {
      const { session, controller, fetchModel } = fixture();
      const hash = deferred<ArrayBuffer>();
      const { response, reader, body } = pendingBody();
      fetchModel.mockResolvedValueOnce(
        stage === "body" ? response : new Response("old"),
      );
      const digest =
        stage === "hash"
          ? vi.spyOn(crypto.subtle, "digest").mockReturnValueOnce(hash.promise)
          : undefined;
      const loading = session.loadModelUrl(url);
      await vi.waitFor(() =>
        expect(stage === "body" ? reader.read : digest).toHaveBeenCalledOnce(),
      );
      const oldSignal = fetchModel.mock.calls[0][1]!.signal!;
      fetchModel.mockResolvedValueOnce(new Response("model"));
      await session.loadModelUrl("https://example.org/new.onnx");
      expect(oldSignal.aborted).toBe(true);
      if (stage === "body") {
        expect(reader.cancel).toHaveBeenCalled();
        body.resolve({ done: false, value: new TextEncoder().encode("old") });
      } else hash.resolve(new ArrayBuffer(32));
      await loading;
      expect(controller.loadModel).toHaveBeenCalledOnce();
      expect(session.modelReference).toMatchObject({
        urls: ["https://example.org/new.onnx"],
        sha256: bundledTestModel.sha256,
      });
      expect(session.status).toContain("Model ready");
    },
  );

  it.each(
    ["response", "failure", "body", "hash"].flatMap((stage) =>
      ["provider", "precision"].map((setting) => ({ stage, setting })),
    ),
  )(
    "restarts the same custom URL on $setting change, ignoring old $stage",
    async ({ stage, setting }) => {
      const { session, controller, fetchModel } = bundledFixture();
      session.open();
      expect(fetchModel).not.toHaveBeenCalled();
      const pending = deferred<Response>();
      const { response, reader, body } = pendingBody();
      const hash = deferred<ArrayBuffer>();
      if (stage === "hash")
        vi.spyOn(crypto.subtle, "digest").mockReturnValueOnce(hash.promise);
      fetchModel.mockReturnValueOnce(
        stage === "body"
          ? Promise.resolve(response)
          : stage === "hash"
            ? Promise.resolve(new Response("old"))
            : pending.promise,
      );
      enterModelUrl(session, url);
      if (stage === "body")
        await vi.waitFor(() => expect(reader.read).toHaveBeenCalledOnce());
      if (stage === "hash")
        await vi.waitFor(() =>
          expect(crypto.subtle.digest).toHaveBeenCalledOnce(),
        );
      const oldSignal = fetchModel.mock.calls[0][1]!.signal!;
      const replacement = deferred<Response>();
      fetchModel.mockReturnValueOnce(replacement.promise);
      const provider = session.dialog!.body.querySelector<HTMLSelectElement>(
        '[aria-label="Execution provider"]',
      )!;
      if (setting === "provider") {
        expect(provider.disabled).toBe(false);
        provider.value = "cpu";
        provider.dispatchEvent(new Event("change"));
      } else {
        expect(precisionToggle(session).disabled).toBe(false);
        precisionToggle(session).click();
      }
      expect(oldSignal.aborted).toBe(true);
      expect(fetchModel.mock.calls.map(([value]) => value)).toEqual([url, url]);
      if (stage === "response") pending.resolve(new Response("old"));
      else if (stage === "failure")
        pending.reject(new Error("obsolete failure"));
      else if (stage === "hash") hash.resolve(new ArrayBuffer(32));
      else
        body.resolve({ done: false, value: new TextEncoder().encode("old") });
      await Promise.resolve();
      expect(session.downloadingModel).toBe(true);
      expect(controller.loadModel).not.toHaveBeenCalled();
      replacement.resolve(new Response("model"));
      await vi.waitFor(() => expect(session.metadata).toEqual(metadata));
      expect(controller.loadModel).toHaveBeenCalledOnce();
      expect(controller.loadModel.mock.calls[0][1]).toBe(
        setting === "provider" ? "cpu" : "auto",
      );
      expect(controller.loadModel.mock.calls[0][3]).toBe(
        setting === "precision" ? "float16" : "float32",
      );
      expect(session.modelReference).toMatchObject({
        kind: "url",
        urls: [url],
      });
      expect(modelUrlInput(session).value).toBe(url);
    },
  );
});

describe("ONNX main status visibility and severity", () => {
  const expectStatus = (
    session: OnnxInferenceSession,
    severity: "info" | "warning" | "error",
  ) => {
    const status =
      session.dialog!.content.querySelector<HTMLElement>('[role="status"]')!;
    expect(status.textContent).toBe(session.status);
    expect(session.statusLevel).toBe(severity);
    expect.soft(status.dataset.severity).toBe(severity);
    const style = getComputedStyle(status);
    expect.soft(style.fontWeight).toBe("700");
    expect.soft(style.color).toBe(
      {
        info: "rgb(27, 94, 32)",
        warning: "rgb(138, 87, 0)",
        error: "rgb(183, 28, 28)",
      }[severity],
    );
    return status;
  };

  it("keeps the main status below the title and stationary above a genuinely scrolling form", async () => {
    const { session } = fixture();
    session.open();
    const { content, header, body, footer } = session.dialog!;
    content.style.maxHeight = "360px";
    for (const details of body.querySelectorAll("details")) details.open = true;
    expect(body.querySelectorAll("details[open]")).toHaveLength(5);
    const status = content.querySelector<HTMLElement>('[role="status"]')!;
    await vi.waitFor(() => {
      expect(body.clientHeight).toBeGreaterThan(0);
      expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
      expect(content.getBoundingClientRect().height).toBeLessThanOrEqual(361);
    });
    const before = status.getBoundingClientRect();
    body.scrollTop = body.scrollHeight;
    await vi.waitFor(() => expect(body.scrollTop).toBeGreaterThan(0));
    const after = status.getBoundingClientRect();
    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.bottom - before.bottom)).toBeLessThanOrEqual(1);
    const assertStatusVisible = () => {
      const bounds = status.getBoundingClientRect();
      const contentBounds = content.getBoundingClientRect();
      expect(bounds.height).toBeGreaterThan(0);
      expect(bounds.top).toBeGreaterThanOrEqual(
        header.getBoundingClientRect().bottom - 1,
      );
      expect(bounds.bottom).toBeLessThanOrEqual(
        body.getBoundingClientRect().top + 1,
      );
      expect(bounds.left).toBeGreaterThanOrEqual(contentBounds.left - 1);
      expect(bounds.right).toBeLessThanOrEqual(contentBounds.right + 1);
      expect(bounds.bottom).toBeLessThanOrEqual(contentBounds.bottom + 1);
      expect(contentBounds.height).toBeLessThanOrEqual(361);
      expect(header.getBoundingClientRect().height).toBeGreaterThan(0);
      expect(footer.getBoundingClientRect().height).toBeGreaterThan(0);
      expect(footer.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        contentBounds.bottom + 1,
      );
      expect(status.checkVisibility()).toBe(true);
    };
    assertStatusVisible();
    expect(status.parentElement).toBe(content);
    expect(header.nextElementSibling).toBe(status);
    expect(status.nextElementSibling).toBe(body);
    expect(body.querySelector('[role="status"]')).toBeNull();

    const previousText = status.textContent;
    session.reset();
    expect(status.textContent).not.toBe(previousText);
    expect(status.textContent).toBe(
      "Viewer reset; select a source and confirm settings.",
    );
    expect(body.scrollTop).toBeGreaterThan(0);
    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
    expectStatus(session, "info");
    assertStatusVisible();
    session.dialog!.close();
    session.selectOverlap(true);
    session.open();
    const reopenedStatus = expectStatus(session, "warning");
    expect(reopenedStatus).not.toBe(status);
    expect(reopenedStatus.textContent).toBe(
      "Overlap/blending changed; confirm settings before running.",
    );
    expect(session.dialog!.header.nextElementSibling).toBe(reopenedStatus);
    expect(reopenedStatus.nextElementSibling).toBe(session.dialog!.body);
  });

  it("bounds a long download status without hiding the form or footer", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(320, 560);
    const { session, fetchModel } = fixture();
    const download = deferred<Response>();
    fetchModel.mockReturnValueOnce(download.promise);
    session.open();
    const { content, body, footer } = session.dialog!;
    for (const details of body.querySelectorAll("details")) details.open = true;
    const loading = session.loadModelUrl(
      `https://models.example.org/${"x".repeat(900)}.onnx`,
    );
    try {
      const status = expectStatus(session, "info");
      expect(status.textContent).toContain("x".repeat(900));
      await vi.waitFor(() => {
        expect(body.clientHeight).toBeGreaterThan(0);
        expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
      });
      const bounds = content.getBoundingClientRect();
      expect(status.scrollHeight).toBeGreaterThan(status.clientHeight);
      expect(status.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        body.getBoundingClientRect().top + 1,
      );
      expect(footer.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        bounds.bottom + 1,
      );
      expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
    } finally {
      download.resolve(new Response("model"));
      await loading;
      await page.viewport(viewport.width, viewport.height);
    }
  });

  it("renders reset, overlap, model failure and recovery with distinct bold severity colors across reopen", async () => {
    const { session, controller } = fixture();
    session.open();
    session.reset();
    expectStatus(session, "info");
    session.selectOverlap(true);
    expect(session.status).toBe(
      "Overlap/blending changed; confirm settings before running.",
    );
    expectStatus(session, "warning");

    const file = new File(["model"], "model.onnx");
    controller.loadModel.mockRejectedValueOnce(
      new Error("Unsupported test operator"),
    );
    await session.loadModel(file);
    expect(session.status).toBe("Model load failed: Unsupported test operator");
    expectStatus(session, "error");
    session.dialog!.close();
    session.open();
    expectStatus(session, "error");

    const pending = deferred<ModelMetadata>();
    controller.loadModel.mockReturnValueOnce(pending.promise);
    const loading = session.loadModel(file);
    expect(session.busy).toBe(true);
    expect(session.status).toBe(
      "Loading model and analyzing WebGPU compatibility in background…",
    );
    expectStatus(session, "info");
    pending.resolve(metadata);
    await loading;
    expect(session.busy).toBe(false);
    expect(session.status).toBe(
      "Model ready. Verify input/output voxel size and model geometry.",
    );
    expectStatus(session, "info");
    session.dialog!.close();
    session.open();
    expectStatus(session, "info");
  });

  it("clears a prior error severity during deferred downloading, verification and model loading", async () => {
    const { session, controller, fetchModel } = fixture();
    session.open();
    controller.loadModel.mockRejectedValueOnce(new Error("Retry this model"));
    await session.loadModel(new File(["model"], "model.onnx"));
    expect(session.status).toBe("Model load failed: Retry this model");
    expectStatus(session, "error");

    const download = deferred<Response>();
    const pending = deferred<ModelMetadata>();
    fetchModel.mockReturnValueOnce(download.promise);
    controller.loadModel.mockReturnValueOnce(pending.promise);
    const verification: Array<{
      severity: string | undefined;
      fontWeight: string;
      color: string;
      busy: boolean;
    }> = [];
    disposers.push(
      session.changed.add(() => {
        if (session.status !== "Verifying model retry.onnx…") return;
        const status =
          session.dialog!.content.querySelector<HTMLElement>(
            '[role="status"]',
          )!;
        const style = getComputedStyle(status);
        verification.push({
          severity: status.dataset.severity,
          fontWeight: style.fontWeight,
          color: style.color,
          busy: session.busy,
        });
      }),
    );
    const loading = session.loadModelUrl(
      "https://models.example.org/retry.onnx",
    );
    expect(session.busy).toBe(true);
    expect(session.downloadingModel).toBe(true);
    expect(session.status).toBe("Downloading model retry.onnx…");
    expectStatus(session, "info");
    session.dialog!.close();
    session.open();
    expect(session.status).toBe("Downloading model retry.onnx…");
    expectStatus(session, "info");

    download.resolve(new Response("model"));
    await vi.waitFor(() =>
      expect(controller.loadModel).toHaveBeenCalledTimes(2),
    );
    expect(verification).toEqual([
      {
        severity: "info",
        fontWeight: "700",
        color: "rgb(27, 94, 32)",
        busy: true,
      },
    ]);
    expect(session.busy).toBe(true);
    expect(session.downloadingModel).toBe(false);
    expect(session.status).toBe(
      "Loading model and analyzing WebGPU compatibility in background…",
    );
    expectStatus(session, "info");
    pending.resolve(metadata);
    await loading;
    expect(session.busy).toBe(false);
    expect(session.status).toBe(
      "Model ready. Verify input/output voxel size and model geometry.",
    );
    expectStatus(session, "info");
  });
});

describe("ONNX configuration disclosure sections", () => {
  const sections = [
    {
      title: "Model download and sharing details",
      paragraphs: [
        "The default model is downloaded from Google Cloud Storage. A model URL overrides it and cancels any pending download. Use HTTPS (or HTTP on loopback) with anonymous CORS access. Inference runs locally in your browser. The model URL, verified size/hash, and inference settings are saved in URL state; shared pages download the model and recompute predictions.",
      ],
    },
    {
      title: "Experimental FP16 details",
      paragraphs: [
        "Experimental FP16 changes model arithmetic and can affect predictions. Enabling this attempts conversion for any model, including unverified exports; public input/output stay FP32. Unsupported models may still fail conversion or execution. Requires the browser's shader-f16 feature. This option cannot enable Chrome startup flags. Missing support or a first-execution failure retries FP32 with a visible reason; inaccurate finite outputs cannot be detected automatically. CPU always uses FP32.",
      ],
    },
    {
      title: "Legacy JSEP padding details",
      paragraphs: [
        `${LEGACY_JSEP_PADDING_HELP} Model compatibility analysis: load a model to check for verified legacy JSEP padding fixes.`,
      ],
    },
    {
      title: "Model geometry details",
      paragraphs: [
        "Input/output names, shapes and channel count come from the model (float32, batch-one NCDHW, scalar input). Crop 12.5% from each output face, rounded down to whole voxels. With overlap enabled, input stride is 50% of the input patch and blending uses Chunkflow's wu mask, normalized by available weights per voxel/channel. With overlap disabled, output stride equals the retained cropped output patch; patches are copied directly without blending, and the corresponding input stride must align to whole input voxels. Centered input/output fields of view. Native input only: no resampling or padding. Output voxel size is editable and must match the model's training geometry. Live inference follows visible slices with fixed displayed XYZ chunks 60×60×16, independent of model patch size; only full output chunks are published.",
      ],
    },
    {
      title: "Navigation and raw input details",
      paragraphs: [
        "Result navigation stays linked to the source. Link any unlinked source-group navigation first; existing groups are never relinked automatically.",
        "Source raw float values are passed to the model unchanged, without normalization. Verify that the source values and voxel sizes match the model's training requirements.",
      ],
    },
  ];
  const visible = (element: Element) =>
    element.checkVisibility({
      contentVisibilityAuto: true,
      visibilityProperty: true,
      opacityProperty: true,
    });
  const detailsFor = (session: OnnxInferenceSession, title: string) => {
    const details = Array.from(
      session.dialog!.body.querySelectorAll("details"),
    ).find(
      (element) =>
        element.querySelector(":scope > summary")?.textContent === title,
    );
    expect(details, title).toBeDefined();
    return details!;
  };

  it.each(sections)(
    "keeps $title closed by default and reveals preserved text on summary click",
    async ({ title, paragraphs }) => {
      const { session } = fixture();
      session.open();
      expect(session.dialog!.body.querySelectorAll("details")).toHaveLength(5);
      const details = detailsFor(session, title);
      const summary = details.querySelector("summary")!;
      const contents = paragraphs.map((text) => {
        const paragraph = Array.from(details.querySelectorAll("p, div")).find(
          (element) => element.textContent?.includes(text),
        );
        expect(paragraph, text).toBeDefined();
        return paragraph!;
      });
      expect(details.open).toBe(false);
      expect(visible(summary)).toBe(true);
      for (const content of contents) expect(visible(content)).toBe(false);
      summary.click();
      await vi.waitFor(() => {
        expect(details.open).toBe(true);
        for (const content of contents) expect(visible(content)).toBe(true);
      });
      summary.click();
      await vi.waitFor(() => {
        expect(details.open).toBe(false);
        for (const content of contents) expect(visible(content)).toBe(false);
      });
    },
  );

  it("keeps controls and runtime statuses visible outside collapsed details, including while live inference starts", async () => {
    const { session, publishLive } = fixture();
    session.dependencies.bundledModel = bundledTestModel;
    session.open();
    const { content, body, footer } = session.dialog!;
    const assertVisibleControlsAndStatuses = () => {
      for (const { title } of sections)
        expect(detailsFor(session, title).open).toBe(false);
      const controls = [
        ...body.querySelectorAll("input, textarea, select, button"),
        ...footer.querySelectorAll("button"),
      ];
      expect(controls).not.toHaveLength(0);
      for (const control of controls) {
        expect(control.closest("details")).toBeNull();
        expect(visible(control)).toBe(true);
      }
      for (const selector of [
        '[aria-label="Execution provider status"]',
        '[aria-label="Inference precision status"]',
        '[aria-label="Current input voxel size X Y Z"]',
        '[aria-label="Model geometry"]',
        '[role="status"]',
      ]) {
        const status = content.querySelector(selector)!;
        expect(status.closest("details"), selector).toBeNull();
        expect(visible(status), selector).toBe(true);
      }
      expect(content.querySelector('[role="status"]')!.textContent).toBe(
        session.status,
      );
    };
    assertVisibleControlsAndStatuses();
    const pending = deferred<{ url: string; dispose(): void }>();
    publishLive.mockReturnValueOnce(pending.promise);
    const running = session.run();
    expect(session.liveActive).toBe(true);
    expect(session.status).not.toBe("");
    assertVisibleControlsAndStatuses();
    session.cancel();
    pending.resolve({ url: "inference://test/live", dispose: vi.fn() });
    await running;
    assertVisibleControlsAndStatuses();
  });

  it("updates compatibility analysis while closed and shows the latest metadata on expansion", async () => {
    const { session, controller } = fixture();
    session.open();
    const details = detailsFor(session, "Legacy JSEP padding details");
    const analysis = session.dialog!.body.querySelector(
      '[aria-label="Model compatibility analysis"]',
    )!;
    expect(analysis.closest("details")).toBe(details);
    expect(visible(analysis)).toBe(false);
    controller.onMetadata({
      ...metadata,
      compatibilityAnalysis: {
        status: "available",
        model: "model6280000",
        fixes: ["Conv SAME_UPPER padding"],
        message: "Verified model6280000 export: WebGPU fixes available.",
      },
    });
    expect(analysis.textContent).toBe(
      `${LEGACY_JSEP_PADDING_HELP} Verified model6280000 export: WebGPU fixes available. Fixes: Conv SAME_UPPER padding. Legacy JSEP padding fixes are disabled.`,
    );
    expect(details.open).toBe(false);
    expect(visible(analysis)).toBe(false);
    controller.onMetadata({
      ...metadata,
      compatibilityAnalysis: {
        status: "unverified",
        fixes: [],
        message: "Latest model export is unverified.",
      },
    });
    expect(analysis.textContent).toBe(
      `${LEGACY_JSEP_PADDING_HELP} Latest model export is unverified.`,
    );
    expect(details.open).toBe(false);
    expect(visible(analysis)).toBe(false);
    details.querySelector("summary")!.click();
    await vi.waitFor(() => {
      expect(details.open).toBe(true);
      expect(visible(analysis)).toBe(true);
      expect(analysis.textContent).toBe(
        `${LEGACY_JSEP_PADDING_HELP} Latest model export is unverified.`,
      );
    });
  });
});

describe("viewer-owned ONNX UI state", () => {
  it("bolds every associated label's text, but not its controls or help text", () => {
    const { session, controller } = fixture();
    const assertLabelStyles = () => {
      const { body } = session.dialog!;
      const controls = body.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >("input, select, textarea");
      expect(controls).toHaveLength(9);
      for (const control of controls) {
        expect(control.labels).toHaveLength(1);
        const label = control.labels![0];
        const strong = label.querySelector(":scope > strong")!;
        expect(strong, control.outerHTML).not.toBeNull();
        expect(strong.textContent!.trim()).not.toBe("");
        expect(strong.childElementCount).toBe(0);
        expect(label.firstChild).toBe(strong);
        expect(strong.nextSibling!.textContent).toBe(" ");
        expect(strong.nextSibling!.nextSibling).toBe(control);
        expect(control.closest("strong, b")).toBeNull();
        expect(
          Number(getComputedStyle(strong).fontWeight),
        ).toBeGreaterThanOrEqual(600);
        expect(Number(getComputedStyle(control).fontWeight)).toBeLessThan(600);
        expect(Number(getComputedStyle(label).fontWeight)).toBeLessThan(600);
      }
      for (const help of body.querySelectorAll("details")) {
        help.open = true;
        expect(help.querySelector("strong, b")).toBeNull();
        for (const text of help.querySelectorAll("summary, div, p")) {
          expect(text.checkVisibility()).toBe(true);
          expect(Number(getComputedStyle(text).fontWeight)).toBeLessThan(600);
        }
      }
    };
    session.open();
    assertLabelStyles();
    controller.onMetadata(metadata);
    assertLabelStyles();
    session.dialog!.close();
    session.open();
    assertLabelStyles();
  });

  it("offers live inference only with unchanged raw floats and no ROI or preprocessing controls", () => {
    const { session } = fixture();
    session.open();
    const { body, footer } = session.dialog!;
    const fields = Array.from(
      body.querySelectorAll<HTMLInputElement>('input[type="text"]'),
    );
    expect(fields.map((field) => field.labels![0].textContent)).toEqual([
      "Output voxel size X Y Z (native units shown above) ",
    ]);
    expect(
      Array.from(body.querySelectorAll("select")).map(
        (select) => select.labels![0].querySelector("strong")!.textContent,
      ),
    ).toEqual(["Image source", "Execution provider", "Input scale X Y Z"]);
    expect(body.textContent).not.toMatch(
      /Explicit.*ROI|Output ROI|Preprocessing|scale\/offset/,
    );
    expect(body.textContent).toContain(
      "Source raw float values are passed to the model unchanged, without normalization.",
    );
    expect(body.querySelector("progress")).toBeNull();
    expect(
      Array.from(footer.querySelectorAll("button")).map(
        (button) => button.textContent,
      ),
    ).toContain("Start live");
  });

  it("selects the source's default scale without confirming it", () => {
    const { session, a, b, input } = fixture();
    session.selectSource(undefined);
    session.open();
    expect(inputScaleField(session).disabled).toBe(true);
    const prepare = vi
      .spyOn(session.dependencies, "prepareInput")
      .mockImplementation((layer) =>
        layer === a.layer
          ? input
          : { ...input, spacingZYX: [45e-9, 16e-9, 16e-9] },
      );
    const select = session.dialog!.body.querySelector("select")!;
    select.value = "0";
    select.dispatchEvent(new Event("change"));
    expect(prepare).toHaveBeenCalledWith(a.layer, 0);
    expect(session.inputScaleIndex).toBe(0);
    expect(inputScaleField(session).value).toBe("0");
    expect(inputScaleField(session).disabled).toBe(false);
    expect(session.confirmed).toBe(false);
    expect(confirmationField(session).checked).toBe(false);
    const run = Array.from(
      session.dialog!.footer.querySelectorAll("button"),
    ).find((button) => button.textContent === "Start live")!;
    expect(run.disabled).toBe(true);
    confirmationField(session).click();
    expect(session.confirmed).toBe(true);
    expect(run.disabled).toBe(false);
    select.value = "1";
    select.dispatchEvent(new Event("change"));
    expect(session.source).toBe(b);
    expect(session.inputScaleIndex).toBe(0);
    expect(session.sourceMetadata?.spacingZYX).toEqual([45e-9, 16e-9, 16e-9]);
    expect(inputScaleField(session).value).toBe("0");
    expect(session.confirmed).toBe(false);
    select.value = "-1";
    select.dispatchEvent(new Event("change"));
    expect(session.inputScales).toEqual([]);
    expect(inputScaleField(session).disabled).toBe(true);
  });

  it("selects the default scale when a selected source becomes ready and requires reconfirmation", async () => {
    const { session, a, input, layerManager } = fixture();
    session.selectSource(undefined);
    let ready = false;
    vi.spyOn(session.dependencies, "prepareInput").mockImplementation(() => {
      if (!ready) throw new Error("Source not ready");
      return input;
    });
    session.open();
    session.selectSource(a);
    expect(inputScaleField(session).disabled).toBe(true);
    ready = true;
    layerManager.readyStateChanged.dispatch();
    await Promise.resolve();
    expect(session.input).toBe(input);
    expect(inputScaleField(session).value).toBe("0");
    expect(inputScaleField(session).disabled).toBe(false);
    expect(session.confirmed).toBe(false);
  });

  it.each(
    ["Source not ready", "Unsupported input transform"].flatMap((sourceError) =>
      ["HTTP", "initialization"].map((failure) => ({ sourceError, failure })),
    ),
  )(
    "keeps $failure model errors visible with input error '$sourceError'",
    async ({ sourceError, failure }) => {
      const { session, a, input, fetchModel, controller, layerManager } =
        fixture();
      session.selectSource(undefined);
      let ready = false;
      const prepare = vi
        .spyOn(session.dependencies, "prepareInput")
        .mockImplementation(() => {
          if (!ready) throw new Error(sourceError);
          return input;
        });
      session.open();
      session.selectSource(a);
      // Drain the open/selection preparation before starting the model attempt.
      await Promise.resolve();
      expect(session.input).toBeUndefined();
      expect(session.status).toBe(sourceError);
      const attempts = prepare.mock.calls.length;
      if (failure === "HTTP") {
        fetchModel.mockResolvedValueOnce(
          new Response("missing", { status: 404, statusText: "Not Found" }),
        );
      } else {
        fetchModel.mockResolvedValueOnce(new Response("model"));
        controller.loadModel.mockRejectedValueOnce(
          new Error("Unsupported model"),
        );
      }
      await session.loadModelUrl("https://example.org/failing.onnx");
      // A queued prepareSource must not replace the completed model failure.
      await Promise.resolve();
      const error =
        failure === "HTTP"
          ? "Model URL load failed: HTTP 404 Not Found"
          : "Model load failed: Unsupported model";
      expect(session.status).toContain(error);
      expect(
        session.dialog!.content.querySelector('[role="status"]')!.textContent,
      ).toContain(error);
      expect(prepare).toHaveBeenCalledTimes(attempts);
      expect(session.metadata).toBeUndefined();
      expect(session.busy).toBe(false);

      // Independent readiness signals must still prepare input and native spacing.
      ready = true;
      layerManager.readyStateChanged.dispatch();
      await Promise.resolve();
      expect(session.input).toBe(input);
      expect(inputScaleField(session).value).toBe("0");
      expect(session.confirmed).toBe(false);
      expect(session.status).toContain(error);
    },
  );

  it("prefills readiness deferred until model loading completes", async () => {
    const { session, a, input, layerManager, controller } = fixture();
    session.selectSource(undefined);
    let ready = false;
    vi.spyOn(session.dependencies, "prepareInput").mockImplementation(() => {
      if (!ready) throw new Error("Source not ready");
      return input;
    });
    session.open();
    session.selectSource(a);
    const pending = deferred<ModelMetadata>();
    controller.loadModel.mockReturnValueOnce(pending.promise);
    const loading = session.loadModel(new File(["model"], "model.onnx"));
    ready = true;
    layerManager.readyStateChanged.dispatch();
    await Promise.resolve();
    expect(session.input).toBeUndefined();
    pending.resolve(metadata);
    await loading;
    expect(session.input).toBe(input);
    expect(inputScaleField(session).value).toBe("0");
    expect(session.confirmed).toBe(false);
  });

  it("aligns XYZ native spacing, units and axis names without changing confirmation", () => {
    const { session, input } = fixture();
    Object.assign(input, {
      spacingZYX: [9, 6, 3],
      unitsZYX: ["nm", "µm", "mm"],
      axisNamesZYX: ["depth", "row", "column"],
    });
    session.open();
    const body = session.dialog!.body;
    const current = body.querySelector(
      '[aria-label="Current input voxel size X Y Z"]',
    )!;
    expect(current.textContent).toBe(
      "Current input voxel size X Y Z: 3 mm, 6 µm, 9 nm; axes: column, row, depth.",
    );
    expect(current.querySelector("input")).toBeNull();
    expect(session.sourceMetadata).toBe(input);
    expect(body.textContent).not.toContain("Confirmed input voxel size X Y Z");
    expect(body.textContent).toContain(
      "I verified the native input voxel size",
    );
    expect(body.textContent).not.toMatch(/input spacing/i);
    expect(session.confirmed).toBe(true);
    expect(
      body.querySelector<HTMLInputElement>(
        'input[name="confirm-inference-settings"]',
      )!.checked,
    ).toBe(true);
  });

  it("shows native spacing for a rejected source and clears it when selecting another source", async () => {
    const { session, a, b, controller } = fixture();
    session.selectSource(undefined);
    session.dependencies.inspectInput = vi.fn((layer) => {
      if (layer !== a.layer) throw new Error("Native metadata unavailable");
      return {
        spacingZYX: [4e-8, 8e-9, 8e-9],
        axisNamesZYX: ["z", "y", "x"],
        unitsZYX: ["m", "m", "m"],
      };
    });
    const error = "Unsupported input transform: resampling is not supported";
    vi.spyOn(session.dependencies, "prepareInput").mockImplementation(() => {
      throw new Error(error);
    });
    session.selectSource(a);
    session.open();
    await Promise.resolve();
    let body = session.dialog!.body;
    const status =
      session.dialog!.content.querySelector<HTMLElement>('[role="status"]')!;
    const current = () =>
      body.querySelector('[aria-label="Current input voxel size X Y Z"]')!
        .textContent;
    expect(current()).toBe(
      "Current input voxel size X Y Z: 8e-9 m, 8e-9 m, 4e-8 m; axes: x, y, z.",
    );
    expect(body.textContent).toContain("Inference unavailable");
    expect(body.textContent).not.toContain("select a ready supported");
    expect(status.textContent).toBe(error);
    expect(session.statusLevel).toBe("error");
    expect(status.dataset.severity).toBe("error");
    expect(getComputedStyle(status)).toMatchObject({
      fontWeight: "700",
      color: "rgb(183, 28, 28)",
    });
    expect(session.input).toBeUndefined();
    expect(inputScaleField(session).value).toBe("0");
    expect(session.inputScales).toEqual([
      expect.objectContaining({
        scaleIndex: 0,
        spacingZYX: [4e-8, 8e-9, 8e-9],
      }),
    ]);
    expect(session.confirmed).toBe(false);
    const run = Array.from(
      session.dialog!.footer.querySelectorAll("button"),
    ).find((button) => button.textContent === "Start live")!;
    expect(run.disabled).toBe(true);
    run.click();
    expect(controller.run).not.toHaveBeenCalled();

    const select = body.querySelector("select")!;
    select.value = "1";
    select.dispatchEvent(new Event("change"));
    expect(session.source).toBe(b);
    expect(session.sourceMetadata).toBeUndefined();
    expect(current()).toBe("Current input voxel size X Y Z: unavailable.");
    expect(session.inputScales).toEqual([]);
    expect(inputScaleField(session).disabled).toBe(true);
    expect(body.textContent).not.toContain("4e-8 m");
    expect(status.textContent).toBe(error);
    expect(run.disabled).toBe(true);
    session.dialog!.close();
    session.open();
    await Promise.resolve();
    body = session.dialog!.body;
    const reopenedStatus =
      session.dialog!.content.querySelector<HTMLElement>('[role="status"]')!;
    expect(reopenedStatus).not.toBe(status);
    expect(reopenedStatus.textContent).toBe(error);
    expect(session.statusLevel).toBe("error");
    expect(reopenedStatus.dataset.severity).toBe("error");
    expect(getComputedStyle(reopenedStatus)).toMatchObject({
      fontWeight: "700",
      color: "rgb(183, 28, 28)",
    });
    session.selectSource(undefined);
    expect(session.sourceMetadata).toBeUndefined();
    expect(body.textContent).toContain("select an image source");
    expect(body.textContent).not.toContain("Inference unavailable");
  });

  it("prepares input even if metadata inspection fails", () => {
    const { session, input, b } = fixture();
    session.dependencies.inspectInput = vi.fn(() => {
      throw new Error("Native metadata unavailable");
    });
    session.selectSource(b);
    expect(session.input).toBe(input);
    expect(session.sourceMetadata).toBe(input);
    expect(session.inputScales).toEqual([
      expect.objectContaining({ scaleIndex: 0, spacingZYX: [4, 2, 2] }),
    ]);
    expect(session.status).not.toContain("Native metadata unavailable");
  });

  it("registers and binds open-onnx-inference feature-locally without loading until a URL click", async () => {
    const { viewer } = fixture();
    const owner = new RefCounted();
    disposers.push(() => owner.dispose());
    const element = document.createElement("div");
    const commandRegistry = owner.registerDisposer(new CommandRegistry());
    Object.assign(viewer, {
      element,
      commandRegistry,
      registerDisposer: owner.registerDisposer.bind(owner),
      bindAction: (id: string, handler: () => void) =>
        owner.registerDisposer(registerActionListener(element, id, handler)),
    });
    // The binding uses production dependencies; do not fetch the real asset.
    const fetchModel = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected model fetch"));
    const loadBundled = vi
      .spyOn(OnnxInferenceSession.prototype, "loadBundledModel")
      .mockResolvedValue();
    const session = bindOnnxInference(viewer);
    const loadModel = vi
      .spyOn(session.controller, "loadModel")
      .mockResolvedValue(metadata);
    expect(session.status).toContain("Load model URL");
    expect(session.dialog).toBeUndefined();
    expect(commandRegistry.get("open-onnx-inference")?.label).toBe(
      "Local ONNX Inference",
    );
    new ActionCommand("open-onnx-inference", "Inference").invoke({
      dispatchTarget: element,
    });
    expect(session.dialog?.headerTitle.textContent).toBe(
      "Local ONNX inference",
    );
    expect(
      session.dialog!.content.querySelector('[role="status"]')!.textContent,
    ).toBe(session.status);
    session.dialog!.close();
    new ActionCommand("open-onnx-inference", "Inference").invoke({
      dispatchTarget: element,
    });
    await Promise.resolve();
    expect(loadBundled).not.toHaveBeenCalled();
    expect(fetchModel).not.toHaveBeenCalled();
    expect(loadModel).not.toHaveBeenCalled();
    loadUrlButton(session).click();
    expect(loadBundled).toHaveBeenCalledOnce();
  });

  it("retains the ready runtime when choosing a source after model load and other idle invalidations", async () => {
    const { session, controller, a } = fixture();
    session.selectSource(undefined);
    await session.loadModel(new File(["model"], "model.onnx"));
    expect(session.metadata).toEqual(metadata);
    expect(session.busy).toBe(false);
    const cancels = controller.cancel.mock.calls.length;
    session.selectSource(a);
    expect(controller.cancel).toHaveBeenCalledTimes(cancels);
    a.layer!.dataSourcesChanged.dispatch();
    await Promise.resolve();
    expect(controller.cancel).toHaveBeenCalledTimes(cancels);
    session.reset();
    expect(controller.cancel).toHaveBeenCalledTimes(cancels);
    expect(session.metadata).toEqual(metadata);
  });

  it("analyzes a recognized model without rewriting until its legacy JSEP padding fixes are enabled", async () => {
    const { session, controller, fetchModel } = fixture();
    session.metadata = undefined;
    session.open();
    const analysis = () =>
      session.dialog!.body.querySelector(
        '[aria-label="Model compatibility analysis"]',
      )!.textContent;
    const toggle = () => compatibilityToggle(session);
    expect(session.compatibilityFixes).toBe(false);
    expect(toggle().checked).toBe(false);
    expect(toggle().labels![0].textContent!.trim()).toBe(
      "Apply legacy JSEP padding fixes",
    );
    expect(analysis()).toBe(
      `${LEGACY_JSEP_PADDING_HELP} Model compatibility analysis: load a model to check for verified legacy JSEP padding fixes.`,
    );
    const file = new File(["model"], "model.onnx");
    const analyzed: ModelMetadata = {
      ...metadata,
      compatibilityFixes: false,
      compatibilityAnalysis: {
        status: "available",
        model: "model6280000",
        fixes: ["Conv SAME_UPPER padding"],
        message: "Verified model6280000 export: WebGPU fixes available.",
      },
    };
    controller.loadModel.mockResolvedValueOnce(analyzed);
    await session.loadModel(file);
    session.confirmed = true;
    session.open();
    expect(controller.loadModel).toHaveBeenLastCalledWith(
      file,
      "auto",
      false,
      "float32",
    );
    expect(toggle().checked).toBe(false);
    expect(analysis()).toBe(
      `${LEGACY_JSEP_PADDING_HELP} Verified model6280000 export: WebGPU fixes available. Fixes: Conv SAME_UPPER padding. Legacy JSEP padding fixes are disabled.`,
    );
    const loading = deferred<ModelMetadata>();
    controller.loadModel.mockReturnValueOnce(loading.promise);
    const cancels = controller.cancel.mock.calls.length;
    toggle().click();
    expect(session.compatibilityFixes).toBe(true);
    expect(session.confirmed).toBe(false);
    expect(session.metadata).toBeUndefined();
    expect(controller.cancel.mock.calls.length).toBeGreaterThan(cancels);
    expect(controller.loadModel).toHaveBeenLastCalledWith(
      file,
      "auto",
      true,
      "float32",
    );
    expect(toggle().disabled).toBe(true);
    loading.resolve({
      ...analyzed,
      compatibilityFixes: true,
      preparation: "model6280000-jsep",
    });
    await vi.waitFor(() => expect(session.busy).toBe(false));
    expect(toggle().checked).toBe(true);
    expect(analysis()).toBe(
      `${LEGACY_JSEP_PADDING_HELP} Verified model6280000 export: WebGPU fixes available. Fixes: Conv SAME_UPPER padding. Legacy JSEP padding fixes enabled. CPU uses the original model.`,
    );
    expect(session.dialog!.body.textContent).toContain(
      "Browser preparation: model6280000-jsep",
    );
    session.dialog!.close();
    session.open();
    expect(toggle().checked).toBe(true);
    await session.selectProvider("cpu");
    expect(controller.loadModel).toHaveBeenLastCalledWith(
      file,
      "cpu",
      true,
      "float32",
    );
    expect(fetchModel).not.toHaveBeenCalled();
    await session.selectCompatibilityFixes(false);
    expect(controller.loadModel).toHaveBeenLastCalledWith(
      file,
      "cpu",
      false,
      "float32",
    );
    expect(toggle().checked).toBe(false);
  });

  it.each(
    (["unverified", "already-prepared"] as const).flatMap((status) =>
      [false, true].map((enabled) => ({ status, enabled })),
    ),
  )(
    "shows $status model analysis without recommending legacy fixes (enabled=$enabled)",
    ({ status, enabled }) => {
      const { session, controller } = fixture();
      expect(session.compatibilityFixes).toBe(false);
      session.compatibilityFixes = enabled;
      session.open();
      controller.onMetadata({
        ...metadata,
        compatibilityAnalysis: {
          status,
          fixes: [],
          message: `Analysis: ${status}`,
        },
      });
      const text = session.dialog!.body.querySelector(
        '[aria-label="Model compatibility analysis"]',
      )!.textContent;
      expect(text).toBe(`${LEGACY_JSEP_PADDING_HELP} Analysis: ${status}`);
      expect(text).not.toContain("Recommendation:");
      expect(session.compatibilityFixes).toBe(enabled);
      expect(compatibilityToggle(session).checked).toBe(enabled);
    },
  );

  it.each([false, true])(
    "persists compatibility fixes=%s in the actual outgoing recipe",
    async (enabled) => {
      const { session } = fixture();
      session.compatibilityFixes = enabled;
      await session.run();
      const recipe = vi.mocked(makeInferenceRecipeSource).mock.lastCall![1];
      expect(recipe.compatibilityFixes).toBe(enabled);
      expect(JSON.parse(JSON.stringify(recipe)).compatibilityFixes).toBe(
        enabled,
      );
    },
  );

  it("reloads provider changes, invalidates confirmation and shows failures instead of stale ready state", async () => {
    const { session, controller } = fixture();
    const file = new File(["model"], "model.onnx");
    await session.loadModel(file);
    session.confirmed = true;
    session.open();
    const status = () =>
      session.dialog!.body.querySelector(
        '[aria-label="Execution provider status"]',
      )!.textContent;
    expect(status()).toContain("Requested: auto");
    expect(status()).toContain("CPU (WASM)");
    expect(status()).toContain(`WASM threads: ${metadata.threads}.`);
    expect(status()).toContain(
      "CPU inference is single-threaded to keep popup login compatible.",
    );
    expect(status()).not.toContain("enable COOP/COEP response headers");
    expect(status()).toContain("WebGPU unavailable in test");
    const pending = deferred<ModelMetadata>();
    controller.loadModel.mockReturnValueOnce(pending.promise);
    const cancels = controller.cancel.mock.calls.length;
    const changing = session.selectProvider("webgpu");
    expect(controller.cancel.mock.calls.length).toBeGreaterThan(cancels);
    expect(controller.loadModel).toHaveBeenLastCalledWith(
      file,
      "webgpu",
      false,
      "float32",
    );
    expect(session.metadata).toBeUndefined();
    expect(session.confirmed).toBe(false);
    expect(status()).toContain("Requested: webgpu. Runtime not initialized.");
    pending.reject(new Error("WebGPU initialization failed: unavailable"));
    await changing;
    expect(session.status).toContain("WebGPU initialization failed");
    expect(session.metadata).toBeUndefined();
    controller.loadModel.mockResolvedValueOnce({
      ...metadata,
      requestedProvider: "cpu",
      fallbackReason: undefined,
    });
    await session.selectProvider("cpu");
    expect(controller.loadModel).toHaveBeenLastCalledWith(
      file,
      "cpu",
      false,
      "float32",
    );
    expect(status()).toContain("Requested: cpu");
    expect(status()).not.toContain("CPU fallback:");
  });

  it("refreshes provider/fallback visibility after later worker reloads and first runs, including dialog reopen", () => {
    const { session, controller } = fixture();
    session.open();
    const gpu: ModelMetadata = {
      ...metadata,
      actualProvider: "webgpu",
      fallbackReason: undefined,
      preparation: "nooverseg-jsep",
    };
    controller.onMetadata(gpu);
    expect(session.metadata).toEqual(gpu);
    expect(session.dialog!.body.textContent).toContain(
      "WebGPU (native; CPU kernel fallback disabled)",
    );
    expect(session.dialog!.body.textContent).toContain(
      "Browser preparation: nooverseg-jsep (legacy JSEP padding fixes, in memory).",
    );
    session.dialog!.close();
    controller.onMetadata({
      ...metadata,
      threads: 4,
      fallbackReason: "WebGPU first execution failed: device lost",
    });
    session.open();
    expect(session.dialog!.body.textContent).toContain("WASM threads: 4.");
    expect(session.dialog!.body.textContent).not.toContain(
      "Cross-origin isolation is disabled",
    );
    expect(session.dialog!.body.textContent).toContain(
      "CPU fallback: WebGPU first execution failed: device lost",
    );
    expect(session.dialog!.body.textContent).not.toContain(
      "Browser preparation:",
    );
    // A later worker reload can choose GPU again; no stale CPU fallback text.
    controller.onMetadata(gpu);
    expect(session.dialog!.body.textContent).not.toContain("CPU fallback:");
    expect(session.dialog!.body.textContent).not.toContain("WASM threads:");
  });

  it("rejects unlinked source navigation before expensive inference or publication", async () => {
    const { session, controller, publishLive, viewer, a } = fixture();
    Object.assign(viewer.layout.container, {
      component: group([a], {
        type: "viewer",
        layers: [a.name],
        layout: "xy",
        position: { link: "unlinked", value: [10, 20, 30] },
      }),
    });
    await session.run();
    expect(session.status).toContain("Link source navigation first");
    expect(controller.run).not.toHaveBeenCalled();
    expect(publishLive).not.toHaveBeenCalled();
  });

  it("rejects navigation unlinked during live publication and releases the source", async () => {
    const { session, controller, publishLive, viewer, a } = fixture();
    const pending = deferred<{ url: string; dispose(): void }>();
    publishLive.mockReturnValue(pending.promise);
    const running = session.run();
    expect(publishLive).toHaveBeenCalledOnce();
    expect(controller.run).not.toHaveBeenCalled();
    Object.assign(viewer.layout.container, {
      component: group([a], {
        type: "viewer",
        layers: [a.name],
        layout: "xy",
        crossSectionScale: { link: "unlinked", value: 2 },
      }),
    });
    const dispose = vi.fn();
    pending.resolve({ url: "inference://test/live", dispose });
    await running;
    expect(session.status).toContain("Link source navigation first");
    expect(dispose).toHaveBeenCalledOnce();
    expect(session.liveActive).toBe(false);
  });

  it("surfaces live failures even with the dialog closed and rejects late publication", async () => {
    const { session, controller } = fixture();
    session.open();
    session.dialog!.close();
    const previousMessages = new Set(statusMessages);
    disposers.push(() => {
      for (const message of statusMessages) {
        if (!previousMessages.has(message)) message.dispose();
      }
    });
    const pending = deferred<{ url: string; dispose(): void }>();
    const publishLive = (session.dependencies.publishLive = vi
      .fn<NonNullable<typeof session.dependencies.publishLive>>()
      .mockReturnValue(pending.promise));
    const running = session.run();
    expect(session.dialog).toBeUndefined();
    controller.run.mockRejectedValueOnce(new Error("Model execution failed"));
    await expect(
      publishLive.mock.calls[0][1].readTile(
        [0, 0, 0],
        new AbortController().signal,
      ),
    ).rejects.toThrow("Model execution failed");
    expect(session.liveActive).toBe(false);
    expect(session.status).toBe(
      "Live inference failed: Model execution failed",
    );
    expect(
      [...statusMessages]
        .filter((message) => !previousMessages.has(message))
        .map((message) => message.element.textContent),
    ).toEqual([session.status]);
    session.open();
    const status =
      session.dialog!.content.querySelector<HTMLElement>('[role="status"]')!;
    expect(status.textContent).toBe(session.status);
    expect(session.statusLevel).toBe("error");
    expect(status.dataset.severity).toBe("error");
    expect(getComputedStyle(status)).toMatchObject({
      fontWeight: "700",
      color: "rgb(183, 28, 28)",
    });
    session.dialog!.close();
    const dispose = vi.fn();
    pending.resolve({ url: "inference://failed", dispose });
    await running;
    expect(dispose).toHaveBeenCalledOnce();
    expect(session.status).toContain("Live inference failed");
    session.open();
    const reopenedStatus =
      session.dialog!.content.querySelector<HTMLElement>('[role="status"]')!;
    expect(reopenedStatus).not.toBe(status);
    expect(reopenedStatus.textContent).toBe(
      "Live inference failed: Model execution failed",
    );
    expect(session.statusLevel).toBe("error");
    expect(reopenedStatus.dataset.severity).toBe("error");
    expect(getComputedStyle(reopenedStatus)).toMatchObject({
      fontWeight: "700",
      color: "rgb(183, 28, 28)",
    });
  });

  it.each([
    "cancel",
    "source",
    "reset",
    "model",
    "provider",
    "precision",
    "overlap",
  ])("live publication is lazy and cannot survive %s", async (action) => {
    const { session, controller, b } = fixture();
    const pending = deferred<{ url: string; dispose(): void }>();
    const publishLive = (session.dependencies.publishLive = vi
      .fn<NonNullable<typeof session.dependencies.publishLive>>()
      .mockReturnValue(pending.promise));
    session.confirmed = false;
    await session.run();
    expect(session.status).toContain("Confirm");
    expect(publishLive).not.toHaveBeenCalled();
    session.confirmed = true;
    const running = session.run();
    expect(session.liveActive).toBe(true);
    session.open();
    expect(precisionToggle(session).disabled).toBe(true);
    expect(publishLive).toHaveBeenCalledOnce();
    expect(controller.run).not.toHaveBeenCalled();
    const live = publishLive.mock.calls[0][1];
    expect(live.info.originZYX).toEqual([2, 10, 10]);
    if (action === "cancel") session.cancel();
    else if (action === "source") session.selectSource(b);
    else if (action === "reset") session.reset();
    else if (action === "provider") await session.selectProvider("cpu");
    else if (action === "precision") await session.selectPrecision("float16");
    else if (action === "overlap") session.selectOverlap(true);
    else await session.loadModel(new File(["model"], "new.onnx"));
    expect(session.liveActive).toBe(false);
    expect(session.confirmed).toBe(false);
    await expect(
      live.readTile([0, 0, 0], new AbortController().signal),
    ).rejects.toThrow("stopped");
    const dispose = vi.fn();
    pending.resolve({ url: "inference://obsolete", dispose });
    await running;
    expect(dispose).toHaveBeenCalledOnce();
    expect(controller.run).not.toHaveBeenCalled();
  });

  it("requires explicit voxel size and model geometry confirmation", async () => {
    const { session, controller } = fixture();
    session.confirmed = false;
    await session.run();
    expect(controller.run).not.toHaveBeenCalled();
    expect(session.status).toContain(
      "Confirm the input/output voxel size and model geometry first",
    );
    expect(session.inputScaleIndex).toBe(0);
  });

  it("closing/reopening the FramedDialog preserves live publication and voxel settings", async () => {
    const { session, controller, publishLive, input } = fixture();
    const pending = deferred<{ url: string; dispose(): void }>();
    publishLive.mockReturnValue(pending.promise);
    const running = session.run();
    expect(controller.run).not.toHaveBeenCalled();
    const live = publishLive.mock.calls[0][1];
    await live.readTile([0, 0, 0], new AbortController().signal);
    expect(controller.run.mock.calls[0][0]).toBe(input);
    expect(controller.run.mock.calls[0][1]).toEqual({
      originZYX: [2, 10, 10],
      shapeZYX: [16, 60, 60],
      overlap: false,
      geometry: {
        inputShape: [20, 80, 80],
        inputSpacing: [4, 2, 2],
        rawOutputShape: [20, 80, 80],
        outputChannels: 4,
        outputSpacing: [4, 2, 2],
        rawOutputOrigin: [0, 0, 0],
        cropBefore: [2, 10, 10],
        cropAfter: [2, 10, 10],
      },
    });
    session.open();
    const cancels = controller.cancel.mock.calls.length;
    session.dialog!.close();
    expect(session.dialog).toBeUndefined();
    expect(session.busy).toBe(true);
    expect(controller.cancel).toHaveBeenCalledTimes(cancels);
    session.open();
    expect(precisionToggle(session).disabled).toBe(true);
    expect(session.liveActive).toBe(true);
    expect(session.inputScaleIndex).toBe(0);
    expect(inputScaleField(session).value).toBe("0");
    expect(inputScaleField(session).disabled).toBe(true);
    expect(session.outputSpacing).toBe("2 2 4");
    expect(
      Array.from(
        session.dialog!.body.querySelectorAll<HTMLInputElement>(
          'input[type="text"]',
        ),
      ).map((field) => field.value),
    ).toEqual(["2 2 4"]);
    session.cancel();
    expect(controller.cancel).toHaveBeenCalledTimes(cancels + 1);
    const dispose = vi.fn();
    pending.resolve({ url: "inference://test/live", dispose });
    await running;
    expect(dispose).toHaveBeenCalledOnce();
    expect(session.status).toBe(
      "Live inference stopped; result layer removed.",
    );
  });

  it("refreshes source names and membership by identity, not duplicate names", () => {
    const { session, a, b, layerManager } = fixture();
    session.open();
    a.name = "renamed";
    a.layerChanged.dispatch();
    layerManager.layersChanged.dispatch();
    const select = session.dialog!.body.querySelector("select")!;
    expect(select.selectedOptions[0].text).toBe("renamed");
    select.value = "1";
    select.dispatchEvent(new Event("change"));
    expect(session.source).toBe(b);
    layerManager.managedLayers = [a];
    layerManager.layersChanged.dispatch();
    expect(session.source).toBeUndefined();
    expect(session.input).toBeUndefined();
  });

  it("defers replacement input registration until the actual dataSourcesChanged dispatch finishes", async () => {
    const { session, input, a } = fixture();
    session.selectSource(undefined);
    const { prepare, snapshots } = signalBackedInputs(session, input);
    session.selectSource(a);
    session.confirmed = true;
    a.layer!.dataSourcesChanged.dispatch();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(snapshots[0].input.dispose).toHaveBeenCalledOnce();
    expect(session.input).toBeUndefined();
    expect(session.sourceMetadata).toBeUndefined();
    expect(session.confirmed).toBe(false);
    await Promise.resolve();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(session.input).toBe(snapshots[1].input);
    expect(session.sourceMetadata).toBe(snapshots[1].input);
    expect(session.input!.isValid()).toBe(true);
    // Repeated changes must recover too, without changing source identity.
    a.layer!.dataSourcesChanged.dispatch();
    await Promise.resolve();
    expect(session.source).toBe(a);
    expect(session.input!.isValid()).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(3);
  });

  it.each(["refresh", "run"])(
    "recovers a silently stale selected input on %s and requires reconfirmation",
    async (trigger) => {
      const { session, input, a, controller } = fixture();
      session.selectSource(undefined);
      const { prepare, snapshots } = signalBackedInputs(session, input);
      session.selectSource(a);
      session.confirmed = true;
      snapshots[0].invalidate();
      if (trigger === "refresh") session.refreshSources();
      else void session.run();
      expect(session.input).toBeUndefined();
      expect(session.confirmed).toBe(false);
      expect(snapshots[0].input.dispose).toHaveBeenCalledOnce();
      expect(controller.run).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(session.source).toBe(a);
      expect(session.input!.isValid()).toBe(true);
      expect(prepare).toHaveBeenCalledTimes(2);
      await session.run();
      expect(controller.run).not.toHaveBeenCalled();
      expect(session.status).toContain("Confirm");
    },
  );

  it.each(["source", "cancel", "reset", "dispose"])(
    "guards deferred preparation against %s invalidation",
    async (change) => {
      const { session, input, a, b } = fixture();
      session.selectSource(undefined);
      const { prepare } = signalBackedInputs(session, input);
      session.selectSource(a);
      a.layer!.dataSourcesChanged.dispatch();
      if (change === "source") session.selectSource(b);
      else if (change === "cancel") session.cancel();
      else if (change === "reset") session.reset();
      else {
        disposers.pop();
        session.dispose();
      }
      const count = prepare.mock.calls.length;
      await Promise.resolve();
      expect(prepare).toHaveBeenCalledTimes(count);
      if (change === "source") expect(session.source).toBe(b);
      else expect(session.input).toBeUndefined();
    },
  );

  it.each(["source", "data", "reset", "dispose", "precision"])(
    "invalidates pending live publication on %s without inserting a result",
    async (change) => {
      const { session, controller, publishLive, b, a, viewer } = fixture();
      const pending = deferred<{ url: string; dispose(): void }>();
      publishLive.mockReturnValue(pending.promise);
      const add = vi.fn();
      Object.assign(viewer.layerSpecification, { add });
      const running = session.run();
      if (change === "source") session.selectSource(b);
      else if (change === "data") a.layer!.dataSourcesChanged.dispatch();
      else if (change === "reset") viewer.state.stateReset.dispatch();
      else if (change === "precision") await session.selectPrecision("float16");
      else {
        disposers.pop();
        session.dispose();
      }
      const dispose = vi.fn();
      pending.resolve({ url: "inference://obsolete", dispose });
      await running;
      expect(controller.run).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledOnce();
      expect(add).not.toHaveBeenCalled();
      expect(session.liveActive).toBe(false);
      expect(session.busy).toBe(false);
    },
  );

  it("releases a late asynchronous publication after cancellation without touching layout", async () => {
    const { session, publishLive } = fixture();
    const publication = deferred<{ url: string; dispose(): void }>();
    const release = vi.fn();
    publishLive.mockReturnValue(publication.promise);
    const running = session.run();
    expect(publishLive).toHaveBeenCalledOnce();
    session.cancel();
    publication.resolve({ url: "inference://late", dispose: release });
    await running;
    expect(release).toHaveBeenCalledOnce();
    expect(session.status).toBe(
      "Live inference stopped; result layer removed.",
    );
  });
});
