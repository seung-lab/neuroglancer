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

/** Focused recipe reconstruction tests: no ONNX download/worker or WebGL viewer. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { makeCoordinateSpace } from "#src/coordinate_transform.js";
import type { GetDataSourceOptions } from "#src/datasource/index.js";
import {
  DELETE_INFERENCE_RESULT_RPC_ID,
  PUBLISH_INFERENCE_RESULT_RPC_ID,
} from "#src/datasource/inference/base.js";
import {
  InferenceDataSourceProvider,
  type InferenceMultiscaleVolumeChunkSource,
  makeInferenceRecipeSource,
  publishInferenceResult,
} from "#src/datasource/inference/frontend.js";
import { OnnxInferenceController } from "#src/inference/controller.js";
import { getBlendedOutputBounds } from "#src/inference/geometry.js";
import type { PreparedInferenceInput } from "#src/inference/input.js";
import { prepareInferenceInput } from "#src/inference/input.js";
import { LiveInference } from "#src/inference/live.js";
import type { ModelMetadata } from "#src/inference/model.js";
import { INPUT_SHAPE, OUTPUT_SHAPE } from "#src/inference/model.js";
import type { InferenceRecipe } from "#src/inference/recipe.js";
import {
  getInferenceRecipeGeometry,
  INFERENCE_RECIPE_URL,
} from "#src/inference/recipe.js";
import {
  installInferenceRecipeContext,
  restoreInferenceRecipe,
} from "#src/inference/restore.js";
import { ImageUserLayer } from "#src/layer/image/index.js";
import type {
  ManagedUserLayer,
  TopLevelLayerListSpecification,
} from "#src/layer/index.js";
import { makeLayer } from "#src/layer/index.js";
import { statusMessages } from "#src/status.js";
import { WatchableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import { MessageList } from "#src/util/message_list.js";
import { NullarySignal } from "#src/util/signal.js";

vi.mock("#src/inference/controller.js", () => ({
  OnnxInferenceController: vi.fn(),
}));
vi.mock("#src/inference/live.js", async (importOriginal) => {
  const actual = await importOriginal<{
    LiveInference: typeof LiveInference;
  }>();
  return {
    ...actual,
    LiveInference: vi.fn(function (
      ...args: ConstructorParameters<typeof actual.LiveInference>
    ) {
      return new actual.LiveInference(...args);
    }),
  };
});
vi.mock("#src/inference/input.js", () => ({
  prepareInferenceInput: vi.fn(),
}));
vi.mock("#src/layer/index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  makeLayer: vi.fn(),
}));

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const result = {
  data: new Float32Array(3 * 4 * 5 * 4),
  shapeZYX: [3, 4, 5],
  originZYX: [-3, 110, 210],
  spacingZYX: [40e-9, 16e-9, 16e-9],
  axisNamesZYX: ["z", "y", "x"],
  unitsZYX: ["m", "m", "m"],
  channels: 4 as const,
  provenance: {},
};

async function fixture() {
  const rpc = {
    promiseInvoke: vi.fn().mockResolvedValue(undefined),
    invoke: vi.fn(),
  };
  const chunkManager = Object.assign(new RefCounted(), {
    rpc,
    rpcId: 123,
  }) as unknown as ChunkManager;
  const coordinateSpace = new WatchableValue(
    makeCoordinateSpace({
      names: ["x", "y", "z"],
      units: ["m", "m", "m"],
      scales: Float64Array.of(16e-9, 16e-9, 40e-9),
    }),
  );
  const root = Object.assign(new RefCounted(), {
    coordinateSpace,
    chunkManager,
    add: vi.fn(),
  }) as unknown as TopLevelLayerListSpecification;
  const uninstall = installInferenceRecipeContext(root);
  disposers.push(() => {
    if (!root.wasDisposed) root.dispose();
    if (!chunkManager.wasDisposed) chunkManager.dispose();
    uninstall();
  });
  const image = Object.assign(Object.create(ImageUserLayer.prototype), {
    dataSources: [],
    dataSourcesChanged: new NullarySignal(),
    messages: new MessageList(),
    dataType: { value: 1 },
    renderLayers: [{}],
  });
  const hidden = Object.assign(new RefCounted(), {
    layer: image,
    readyStateChanged: new NullarySignal(),
    layerChanged: new NullarySignal(),
    isReady: () => true,
  }) as unknown as ManagedUserLayer;
  vi.mocked(makeLayer).mockReturnValue(hidden);
  const invalidation = new AbortController();
  const input = {
    shapeZYX: [40, 160, 200],
    originZYX: [-5, 100, 200],
    spacingZYX: [...result.spacingZYX],
    axisNamesZYX: result.axisNamesZYX,
    unitsZYX: result.unitsZYX,
    signal: invalidation.signal,
    isValid: () => true,
    assertValid: vi.fn(),
    readPatch: vi.fn(),
    dispose: vi.fn(),
  } as unknown as PreparedInferenceInput;
  vi.mocked(prepareInferenceInput).mockReturnValue(input);
  const metadata: ModelMetadata = {
    inputNames: ["input"],
    outputNames: ["output"],
    inputShape: INPUT_SHAPE,
    outputShape: OUTPUT_SHAPE,
    requestedProvider: "cpu",
    actualProvider: "wasm",
    initMs: 0,
    threads: 1,
  };
  const controller = {
    loadModel: vi.fn().mockResolvedValue(metadata),
    onMetadata: (_metadata: ModelMetadata) => {},
    run: vi.fn().mockResolvedValue(result),
    cancel: vi.fn(),
    dispose: vi.fn(),
  };
  vi.mocked(OnnxInferenceController).mockImplementation(function () {
    return controller as unknown as OnnxInferenceController;
  });
  const bytes = new Uint8Array([1, 2, 3]);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(digest), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
  const fetchModel = vi
    .fn()
    .mockImplementation(async () => new Response(bytes));
  vi.stubGlobal("fetch", fetchModel);
  const recipe: InferenceRecipe = {
    version: 1,
    profile: "nooverseg-ncdhw-native-grid-v1",
    source: {
      name: "source no longer present in visible layers",
      source: [
        {
          url: "precomputed://https://example.com/image",
          transform: {
            outputDimensions: {
              x: [16e-9, "m"],
              y: [16e-9, "m"],
              z: [40e-9, "m"],
            },
          },
          subsources: { default: true },
        },
      ],
    },
    model: {
      kind: "url",
      name: "model.onnx",
      urls: ["https://example.com/model"],
      size: bytes.length,
      sha256,
    },
    provider: "cpu",
    mode: "live",
    spacingZYX: [40e-9, 16e-9, 16e-9],
  };
  const abort = new AbortController();
  const options: GetDataSourceOptions = {
    url: INFERENCE_RECIPE_URL,
    state: recipe,
    registry: { chunkManager } as GetDataSourceOptions["registry"],
    globalCoordinateSpace: coordinateSpace,
    transform: undefined,
    signal: abort.signal,
    providerUrl: "recipe",
    providerScheme: "inference",
  };
  return {
    rpc,
    root,
    chunkManager,
    image,
    hidden,
    input,
    invalidation,
    controller,
    recipe,
    options,
    abort,
    fetchModel,
    uninstall,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("inference recipe datasource restoration", () => {
  it("uses the same recipe identity as a hint, preserving the stable URL and UI ownership", async () => {
    const f = await fixture();
    const publication = await publishInferenceResult(f.chunkManager, result);
    const source = makeInferenceRecipeSource(publication, f.recipe);
    expect(source.state).toBe(f.recipe);
    const data = await new InferenceDataSourceProvider().get({
      ...f.options,
      ...source,
    });
    expect(data.canonicalUrl).toBe(INFERENCE_RECIPE_URL);
    expect(f.fetchModel).not.toHaveBeenCalled();
    expect(makeLayer).not.toHaveBeenCalled();
    (
      data.subsources[0].subsource
        .volume as InferenceMultiscaleVolumeChunkSource
    ).dispose();
    f.abort.abort();
    expect(f.rpc.invoke).not.toHaveBeenCalledWith(
      DELETE_INFERENCE_RESULT_RPC_ID,
      expect.anything(),
    );
    publication.dispose();
  });

  it.each([
    [1, undefined],
    [1, false],
    [1, true],
    [2, undefined],
    [2, false],
    [2, true],
  ] as const)(
    "restores v%s compatibility policy %s exactly without opting legacy recipes in",
    async (version, compatibilityFixes) => {
      const f = await fixture();
      const recipe: InferenceRecipe = {
        ...f.recipe,
        ...(version === 1
          ? { version: 1, profile: "nooverseg-ncdhw-native-grid-v1" }
          : {
              version: 2,
              profile: "ncdhw-centered-v2",
              outputSpacingZYX: [...f.recipe.spacingZYX],
            }),
        ...(compatibilityFixes === undefined ? {} : { compatibilityFixes }),
      };
      const before = JSON.stringify(recipe);
      const restored = await restoreInferenceRecipe(
        f.options,
        JSON.parse(before),
      );
      expect(f.controller.loadModel).toHaveBeenCalledExactlyOnceWith(
        expect.any(File),
        "cpu",
        compatibilityFixes,
        undefined,
      );
      expect(JSON.stringify(recipe)).toBe(before);
      restored.dispose();
    },
  );

  it.each([
    [1, undefined],
    [1, "float32"],
    [1, "float16"],
    [2, undefined],
    [2, "float32"],
    [2, "float16"],
  ] as const)(
    "restores v%s precision %s as the fourth load argument without rewriting saved JSON",
    async (version, precision) => {
      const f = await fixture();
      const recipe: InferenceRecipe = {
        ...f.recipe,
        ...(version === 1
          ? { version: 1, profile: "nooverseg-ncdhw-native-grid-v1" }
          : {
              version: 2,
              profile: "ncdhw-centered-v2",
              outputSpacingZYX: [...f.recipe.spacingZYX],
            }),
        compatibilityFixes: false,
        ...(precision === undefined ? {} : { precision }),
      };
      const saved = JSON.stringify(recipe);
      const restored = await restoreInferenceRecipe(
        f.options,
        JSON.parse(saved),
      );
      expect(f.controller.loadModel).toHaveBeenCalledExactlyOnceWith(
        expect.any(File),
        "cpu",
        false,
        precision,
      );
      expect(JSON.stringify(recipe)).toBe(saved);
      restored.dispose();
    },
  );

  it.each([undefined, 0, 2])(
    "restores input scale %s before verifying spacing and constructing live geometry",
    async (inputScaleIndex) => {
      const f = await fixture();
      // Both native scales must fit the legacy model's full context patch.
      f.input.shapeZYX.splice(0, 3, 80, 320, 400);
      const coarse = {
        ...f.input,
        spacingZYX: f.input.spacingZYX.map((x) => x * 4),
        shapeZYX: f.input.shapeZYX.map((x) => x / 4),
      };
      vi.mocked(prepareInferenceInput).mockImplementation(
        (_image, scaleIndex = 0) => (scaleIndex === 2 ? coarse : f.input),
      );
      const selected = inputScaleIndex === 2 ? coarse : f.input;
      const recipe: InferenceRecipe = {
        ...f.recipe,
        ...(inputScaleIndex === undefined ? {} : { inputScaleIndex }),
        spacingZYX: [...selected.spacingZYX] as [number, number, number],
      };
      const saved = JSON.stringify(recipe);
      const restored = await restoreInferenceRecipe(
        f.options,
        JSON.parse(saved),
      );
      expect(prepareInferenceInput).toHaveBeenCalledExactlyOnceWith(
        f.image,
        inputScaleIndex ?? 0,
      );
      expect(LiveInference).toHaveBeenCalledWith(
        f.controller,
        selected,
        expect.any(Function),
        expect.objectContaining({ inputSpacing: selected.spacingZYX }),
        undefined,
      );
      expect(f.rpc.promiseInvoke).toHaveBeenCalledWith(
        PUBLISH_INFERENCE_RESULT_RPC_ID,
        expect.objectContaining({
          result: expect.objectContaining({ spacingZYX: selected.spacingZYX }),
        }),
        expect.anything(),
      );
      expect(JSON.stringify(recipe)).toBe(saved);
      restored.dispose();
      expect(selected.dispose).toHaveBeenCalledOnce();
    },
  );

  it("rejects even a tiny spacing mismatch at the selected coarse scale before downloading", async () => {
    const f = await fixture();
    f.recipe.inputScaleIndex = 2;
    f.input.spacingZYX[0] *= 4;
    f.recipe.spacingZYX = [...f.input.spacingZYX] as [number, number, number];
    f.recipe.spacingZYX[0] *= 1 + Number.EPSILON;
    await expect(restoreInferenceRecipe(f.options, f.recipe)).rejects.toThrow(
      "native input voxel size changed",
    );
    expect(prepareInferenceInput).toHaveBeenCalledExactlyOnceWith(f.image, 2);
    expect(f.fetchModel).not.toHaveBeenCalled();
    expect(LiveInference).not.toHaveBeenCalled();
    expect(f.input.dispose).toHaveBeenCalledOnce();
    expect(f.hidden.wasDisposed).toBe(true);
  });

  it("keeps precision fallback visible on restored layers and releases status on disposal", async () => {
    const f = await fixture();
    f.recipe.precision = "float16";
    const restored = await restoreInferenceRecipe(f.options, f.recipe);
    const previous = statusMessages.size;
    const metadata: ModelMetadata = {
      inputNames: ["input"],
      outputNames: ["output"],
      inputShape: INPUT_SHAPE,
      outputShape: OUTPUT_SHAPE,
      requestedProvider: "auto",
      actualProvider: "webgpu",
      initMs: 0,
      threads: 1,
      requestedPrecision: "float16",
      actualPrecision: "float32",
      precisionFallbackReason:
        "FP16 first execution failed: native error; using FP32 WebGPU",
    };
    f.controller.onMetadata(metadata);
    expect(statusMessages.size).toBe(previous + 1);
    expect([...statusMessages].at(-1)?.element.textContent).toContain(
      "requested float16, actual float32 (webgpu)",
    );
    // A cancellation/restart can succeed natively: do not leave a stale warning.
    f.controller.onMetadata({
      ...metadata,
      actualPrecision: "float16",
      precisionFallbackReason: undefined,
    });
    expect(statusMessages.size).toBe(previous);
    f.controller.onMetadata(metadata);
    expect(statusMessages.size).toBe(previous + 1);
    restored.dispose();
    expect(statusMessages.size).toBe(previous);
  });

  it.each([
    [1, undefined],
    [1, false],
    [1, true],
    [2, undefined],
    [2, false],
    [2, true],
  ] as const)(
    "restores v%s overlap %s through the real live scheduler without preprocessing",
    async (version, overlap) => {
      const f = await fixture();
      const recipe: InferenceRecipe = {
        ...f.recipe,
        ...(version === 1
          ? { version: 1, profile: "nooverseg-ncdhw-native-grid-v1" }
          : {
              version: 2,
              profile: "ncdhw-centered-v2",
              outputSpacingZYX: [...f.recipe.spacingZYX],
            }),
        ...(overlap === undefined ? {} : { overlap }),
      };
      const saved = JSON.stringify(recipe);
      const restored = await restoreInferenceRecipe(
        f.options,
        JSON.parse(saved),
      );
      expect(LiveInference).toHaveBeenLastCalledWith(
        f.controller,
        f.input,
        expect.any(Function),
        expect.any(Object),
        overlap,
      );
      expect(f.controller.run).not.toHaveBeenCalled();
      const live = vi.mocked(LiveInference).mock.results.at(-1)!.value;
      await live.readTile([0, 0, 0], f.abort.signal);
      expect(f.controller.run).toHaveBeenCalledExactlyOnceWith(
        f.input,
        expect.objectContaining({ overlap: overlap ?? true }),
      );
      const runOptions = f.controller.run.mock.calls[0][1];
      expect(runOptions).not.toHaveProperty("scale");
      expect(runOptions).not.toHaveProperty("offset");
      expect(JSON.stringify(recipe)).toBe(saved);
      restored.dispose();
    },
  );

  it("reconstructs live from JSON in a fresh runtime and releases all owned resources", async () => {
    const f = await fixture();
    // Seed elsewhere first: neither an identity clone nor a different manager
    // may resolve an old UI publication.
    makeInferenceRecipeSource({ url: "inference://old-session" }, f.recipe);
    const state = JSON.parse(JSON.stringify(f.recipe));
    const data = await new InferenceDataSourceProvider().get({
      ...f.options,
      state,
    });
    expect(data.canonicalUrl).toBe(INFERENCE_RECIPE_URL);
    expect(makeLayer).toHaveBeenCalledWith(f.root, f.recipe.source.name, {
      type: "image",
      source: state.source.source,
    });
    expect(f.root.add).not.toHaveBeenCalled();
    expect(f.controller.loadModel).toHaveBeenCalledWith(
      expect.any(File),
      "cpu",
      undefined,
      undefined,
    );
    expect(
      (f.controller.loadModel.mock.calls[0] as unknown as [File])[0].name,
    ).toBe("model.onnx");
    expect(f.rpc.promiseInvoke).toHaveBeenCalledWith(
      PUBLISH_INFERENCE_RESULT_RPC_ID,
      expect.objectContaining({ live: true }),
      expect.anything(),
    );
    expect(f.controller.run).not.toHaveBeenCalled();
    expect(Array.from(data.modelTransform.transform!.slice(20, 24))).toEqual([
      210, 110, -3, 0,
    ]);
    expect(data.modelTransform.inputSpace.names).toEqual(["x", "y", "z", "c^"]);
    expect(state).toEqual(f.recipe);
    const volume = data.subsources[0].subsource
      .volume as InferenceMultiscaleVolumeChunkSource;
    volume.dispose();
    volume.dispose();
    f.abort.abort();
    expect(f.hidden.wasDisposed).toBe(true);
    expect(f.input.dispose).toHaveBeenCalledTimes(1);
    expect(f.controller.dispose).toHaveBeenCalledTimes(1);
    expect(f.rpc.invoke).toHaveBeenCalledWith(
      DELETE_INFERENCE_RESULT_RPC_ID,
      expect.anything(),
    );
  });

  it("restores v2 live using actual C1 supersampled metadata and saved output spacing", async () => {
    const f = await fixture();
    const metadata: ModelMetadata = {
      inputNames: ["image"],
      outputNames: ["probabilities"],
      inputShape: [1, 1, 24, 40, 48],
      // Smaller output spacing with a centered, integer-aligned FOV.
      outputShape: [1, 1, 45, 77, 93],
      requestedProvider: "cpu",
      actualProvider: "wasm",
      initMs: 0,
      threads: 1,
    };
    f.controller.loadModel.mockResolvedValue(metadata);
    const recipe: InferenceRecipe = {
      ...f.recipe,
      version: 2,
      profile: "ncdhw-centered-v2",
      outputSpacingZYX: [20e-9, 8e-9, 8e-9],
    };
    const state = JSON.parse(JSON.stringify(recipe));
    const geometry = getInferenceRecipeGeometry(recipe, metadata);
    expect(geometry.inputShape).toEqual([24, 40, 48]);
    expect(geometry.outputChannels).toBe(1);
    expect(geometry.rawOutputShape).toEqual([45, 77, 93]);
    expect(geometry.cropBefore).toEqual([5, 9, 11]);
    for (const [axis, expected] of [20e-9, 8e-9, 8e-9].entries()) {
      expect(geometry.rawOutputOrigin[axis]).toBeCloseTo(expected, 15);
    }
    const bounds = getBlendedOutputBounds(geometry, {
      origin: [-5, 100, 200],
      shape: [40, 160, 200],
    });
    const output = {
      ...result,
      data: new Float32Array(3 * 4 * 5),
      channels: 1,
      spacingZYX: recipe.outputSpacingZYX,
      provenance: { geometry: { ...geometry } },
    };
    f.controller.run.mockResolvedValue(output);
    const data = await new InferenceDataSourceProvider().get({
      ...f.options,
      state,
    });
    expect(makeLayer).toHaveBeenCalledWith(f.root, recipe.source.name, {
      type: "image",
      source: state.source.source,
    });
    expect(f.root.add).not.toHaveBeenCalled();
    expect(f.controller.loadModel).toHaveBeenCalledWith(
      expect.any(File),
      "cpu",
      undefined,
      undefined,
    );
    expect(f.controller.run).not.toHaveBeenCalled();
    const origin = bounds.origin;
    expect(f.rpc.promiseInvoke).toHaveBeenCalledWith(
      PUBLISH_INFERENCE_RESULT_RPC_ID,
      expect.objectContaining({
        live: true,
        result: expect.objectContaining({
          channels: 1,
          spacingZYX: recipe.outputSpacingZYX,
          originZYX: origin,
          provenance: expect.objectContaining({ geometry }),
        }),
      }),
      expect.anything(),
    );
    expect(Array.from(data.modelTransform.transform!.slice(20, 24))).toEqual([
      origin[2],
      origin[1],
      origin[0],
      0,
    ]);
    expect(
      Array.from(data.modelTransform.inputSpace.scales).slice(0, 3),
    ).toEqual([...recipe.outputSpacingZYX].reverse());
    const volume = data.subsources[0].subsource
      .volume as InferenceMultiscaleVolumeChunkSource;
    expect(volume.info.channels).toBe(1);
    expect(state).toEqual(recipe);
    volume.dispose();
    f.abort.abort();
    expect(f.hidden.wasDisposed).toBe(true);
    expect(f.input.dispose).toHaveBeenCalledTimes(1);
    expect(f.controller.dispose).toHaveBeenCalledTimes(1);
  });

  it("does not allow a v1 recipe to silently adopt a different loaded model contract", async () => {
    const f = await fixture();
    f.controller.loadModel.mockResolvedValue({
      inputNames: ["image"],
      outputNames: ["probabilities"],
      inputShape: [1, 1, 24, 40, 48],
      outputShape: [1, 1, 48, 80, 96],
    });
    await expect(restoreInferenceRecipe(f.options, f.recipe)).rejects.toThrow(
      /Unsupported model profile/,
    );
    expect(f.controller.run).not.toHaveBeenCalled();
    expect(f.hidden.wasDisposed).toBe(true);
    expect(f.input.dispose).toHaveBeenCalledTimes(1);
    expect(f.controller.dispose).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a seeded publication from a different ChunkManager", async () => {
    const a = await fixture();
    const publication = await publishInferenceResult(a.chunkManager, result);
    makeInferenceRecipeSource(publication, a.recipe);
    const b = await fixture();
    await new InferenceDataSourceProvider().get({
      ...b.options,
      state: a.recipe,
    });
    expect(b.controller.loadModel).toHaveBeenCalledTimes(1);
    b.abort.abort();
    expect(b.hidden.wasDisposed).toBe(true);
    publication.dispose();
  });

  it.each([
    { mode: "roi" },
    { roi: { originZYX: [-3, 110, 210], shapeZYX: [3, 4, 5] } },
    { preprocessing: { scale: 2, offset: -1 } },
    { preprocessing: { scale: 1, offset: 0 } },
  ])(
    "rejects legacy recipe fields visibly before restoring: %j",
    async (legacy) => {
      const f = await fixture();
      const recipe = { ...f.recipe, ...legacy };
      await expect(
        new InferenceDataSourceProvider().get({ ...f.options, state: recipe }),
      ).rejects.toThrow(
        /Invalid inference recipe .*mode|Invalid inference recipe .*roi|Invalid inference recipe .*preprocessing/,
      );
      expect(makeLayer).not.toHaveBeenCalled();
      expect(f.fetchModel).not.toHaveBeenCalled();
      expect(f.controller.loadModel).not.toHaveBeenCalled();
      expect(f.controller.run).not.toHaveBeenCalled();
      expect(LiveInference).not.toHaveBeenCalled();
    },
  );

  it("rejects local and invalid/recursive recipes without creating hidden sources", async () => {
    const f = await fixture();
    f.recipe.model = { kind: "local", name: "private.onnx", size: 3 };
    await expect(
      new InferenceDataSourceProvider().get(f.options),
    ).rejects.toThrow(
      "Local model private.onnx is not included in shared state; load a model URL and rerun inference to create a shareable layer.",
    );
    f.recipe.source.source = "inference://recipe";
    await expect(
      new InferenceDataSourceProvider().get(f.options),
    ).rejects.toThrow("recursive inference");
    expect(makeLayer).not.toHaveBeenCalled();
  });

  it("rejects changed native input voxel size, download failures and source activation errors cleanly", async () => {
    const f = await fixture();
    f.recipe.spacingZYX[0] *= 2;
    await expect(restoreInferenceRecipe(f.options, f.recipe)).rejects.toThrow(
      "native input voxel size changed",
    );
    expect(f.hidden.wasDisposed).toBe(true);
    expect(f.input.dispose).toHaveBeenCalledTimes(1);
    expect(f.fetchModel).not.toHaveBeenCalled();
    const g = await fixture();
    g.fetchModel.mockRejectedValue(new Error("network failed"));
    await expect(restoreInferenceRecipe(g.options, g.recipe)).rejects.toThrow(
      "network failed",
    );
    expect(g.hidden.wasDisposed).toBe(true);
    expect(g.input.dispose).toHaveBeenCalledTimes(1);
    const h = await fixture();
    h.image.dataSources = [
      { loadState: { error: new Error("source failed") } },
    ];
    await expect(restoreInferenceRecipe(h.options, h.recipe)).rejects.toThrow(
      "source failed",
    );
    expect(h.hidden.wasDisposed).toBe(true);
  });

  it("cancels an in-flight publication and releases a late RPC result", async () => {
    const f = await fixture();
    let resolve!: () => void;
    const pending = new Promise<void>((r) => {
      resolve = r;
    });
    f.rpc.promiseInvoke.mockImplementation(async (id) => {
      if (id === PUBLISH_INFERENCE_RESULT_RPC_ID) await pending;
    });
    const restoring = new InferenceDataSourceProvider().get(f.options);
    await vi.waitFor(() =>
      expect(f.rpc.promiseInvoke).toHaveBeenCalledWith(
        PUBLISH_INFERENCE_RESULT_RPC_ID,
        expect.anything(),
        expect.anything(),
      ),
    );
    f.abort.abort();
    expect(f.controller.dispose).toHaveBeenCalledTimes(1);
    resolve();
    await expect(restoring).rejects.toMatchObject({ name: "AbortError" });
    expect(f.hidden.wasDisposed).toBe(true);
    expect(f.rpc.invoke).toHaveBeenCalledWith(
      DELETE_INFERENCE_RESULT_RPC_ID,
      expect.anything(),
    );
  });

  it("waits for source readiness without polling and aborts the wait", async () => {
    const f = await fixture();
    f.hidden.isReady = () => false;
    const restoring = restoreInferenceRecipe(f.options, f.recipe);
    f.abort.abort();
    await expect(restoring).rejects.toMatchObject({ name: "AbortError" });
    expect(f.hidden.wasDisposed).toBe(true);
    expect(f.fetchModel).not.toHaveBeenCalled();
  });

  it("shows live invalidation errors without deleting saved configuration, then clears on deletion", async () => {
    const f = await fixture();
    const data = await new InferenceDataSourceProvider().get(f.options);
    const previous = statusMessages.size;
    f.invalidation.abort();
    expect(f.input.dispose).toHaveBeenCalledTimes(1);
    expect(f.hidden.wasDisposed).toBe(true);
    expect(data.canonicalUrl).toBe(INFERENCE_RECIPE_URL);
    expect(statusMessages.size).toBe(previous + 1);
    f.abort.abort();
    expect(statusMessages.size).toBe(previous);
  });

  it.each(["abort", "root", "manager"] as const)(
    "releases restored resources on %s teardown without mutating owner disposal iteration",
    async (owner) => {
      const f = await fixture();
      await new InferenceDataSourceProvider().get(f.options);
      if (owner === "abort") f.abort.abort();
      else if (owner === "root") f.root.dispose();
      else f.chunkManager.dispose();
      expect(f.hidden.wasDisposed).toBe(true);
      expect(f.input.dispose).toHaveBeenCalledTimes(1);
      expect(f.controller.dispose).toHaveBeenCalledTimes(1);
    },
  );

  it("consumes the seeded hint so a reused state object restores independently", async () => {
    const f = await fixture();
    const publication = await publishInferenceResult(f.chunkManager, result);
    const source = makeInferenceRecipeSource(publication, f.recipe);
    await new InferenceDataSourceProvider().get({ ...f.options, ...source });
    f.recipe.overlap = false;
    await new InferenceDataSourceProvider().get({ ...f.options, ...source });
    expect(f.controller.loadModel).toHaveBeenCalledOnce();
    expect(LiveInference).toHaveBeenLastCalledWith(
      f.controller,
      f.input,
      expect.any(Function),
      expect.any(Object),
      false,
    );
    f.abort.abort();
    publication.dispose();
  });

  it("uninstalls only its own runtime context registration", async () => {
    const f = await fixture();
    const second = installInferenceRecipeContext(f.root);
    f.uninstall();
    const publication = await restoreInferenceRecipe(f.options, f.recipe);
    publication.dispose();
    second();
    await expect(restoreInferenceRecipe(f.options, f.recipe)).rejects.toThrow(
      "installed viewer context",
    );
  });
});
