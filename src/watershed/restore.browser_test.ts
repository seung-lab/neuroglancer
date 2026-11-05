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

/** No viewer/WebGL or worker: the scheduler, run path and publication are real. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { makeCoordinateSpace } from "#src/coordinate_transform.js";
import type {
  DataSource,
  GetDataSourceOptions,
} from "#src/datasource/index.js";
import {
  makeWatershedRecipeSource,
  publishLiveWatershed,
  WatershedDataSourceProvider,
  type WatershedMultiscaleVolumeChunkSource,
} from "#src/datasource/watershed/frontend.js";
import { ImageUserLayer } from "#src/layer/image/index.js";
import type {
  ManagedUserLayer,
  TopLevelLayerListSpecification,
} from "#src/layer/index.js";
import { makeLayer } from "#src/layer/index.js";
import { statusMessages } from "#src/status.js";
import { WatchableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import { MessageList, MessageSeverity } from "#src/util/message_list.js";
import { NullarySignal } from "#src/util/signal.js";
import type { Viewer } from "#src/viewer.js";
import { attachWatershedVolume } from "#src/watershed/attachment.js";
import {
  prepareAffinityInput,
  type PreparedAffinityInput,
} from "#src/watershed/input.js";
import { LiveWatershed } from "#src/watershed/live.js";
import { WatershedParametersState } from "#src/watershed/parameters.js";
import {
  WATERSHED_RECIPE_URL,
  type WatershedRecipe,
} from "#src/watershed/recipe.js";
import {
  installWatershedRecipeContext,
  restoreWatershedRecipe,
} from "#src/watershed/restore.js";
import { watchWatershedViewport } from "#src/watershed/viewport.js";

vi.mock("#src/async_computation/request.js", () => ({
  requestAsyncComputation: vi.fn(),
}));
vi.mock("#src/watershed/input.js", () => ({
  prepareAffinityInput: vi.fn(),
}));
vi.mock("#src/watershed/live.js", async (importOriginal) => {
  const actual = await importOriginal<{
    LiveWatershed: typeof LiveWatershed;
  }>();
  return {
    ...actual,
    LiveWatershed: vi.fn(function (
      ...args: ConstructorParameters<typeof actual.LiveWatershed>
    ) {
      return new actual.LiveWatershed(...args);
    }),
  };
});
vi.mock("#src/watershed/viewport.js", () => ({
  watchWatershedViewport: vi.fn(),
}));
vi.mock("#src/layer/index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  makeLayer: vi.fn(),
}));

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requestAsyncComputation).mockImplementation(
    async (_computation, _signal, _transfers, _affinities, shape) =>
      new Uint32Array((shape as number[]).reduce((a, b) => a * b, 1)).fill(7),
  );
  vi.mocked(watchWatershedViewport).mockImplementation(() => vi.fn());
});

function makeInput(overrides: Partial<PreparedAffinityInput> = {}) {
  const invalidation = new AbortController();
  const input: PreparedAffinityInput = {
    lowerBoundXYZ: [2, 3, 4],
    upperBoundXYZ: [22, 15, 14],
    originXYZ: [100, 200, -5],
    spacingXYZ: [16e-9, 20e-9, 40e-9],
    unitsXYZ: ["m", "m", "m"],
    channelCount: 4,
    signal: invalidation.signal,
    isValid: () => !invalidation.signal.aborted,
    assertValid: vi.fn(() => invalidation.signal.throwIfAborted()),
    readRegion: vi.fn<PreparedAffinityInput["readRegion"]>(
      async (_lower, shape, channels) =>
        new Float32Array(
          shape.reduce((a, b) => a * b, 1) * channels.length,
        ).fill(0.75),
    ),
    // Abort as the real reader does, exposing reentrant/double cleanup bugs.
    dispose: vi.fn(() => invalidation.abort()),
    ...overrides,
  };
  return { input, invalidation };
}

function makeHidden() {
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
  const disposeHidden = vi.spyOn(hidden, "dispose");
  return { image, hidden, disposeHidden };
}

function fixture(sharedChunkManager?: ChunkManager) {
  const chunkManager =
    sharedChunkManager?.addRef() ??
    (Object.assign(new RefCounted(), {
      rpc: { invoke: vi.fn(), promiseInvoke: vi.fn() },
      rpcId: 123,
    }) as unknown as ChunkManager);
  const coordinateSpace = new WatchableValue(
    makeCoordinateSpace({
      names: ["x", "y", "z"],
      units: ["m", "m", "m"],
      scales: Float64Array.of(16e-9, 20e-9, 40e-9),
    }),
  );
  const root = Object.assign(new RefCounted(), {
    coordinateSpace,
    chunkManager,
    add: vi.fn(),
  }) as unknown as TopLevelLayerListSpecification;
  const viewer = Object.assign(new RefCounted(), {
    layerSpecification: root,
    coordinateSpace,
    dataContext: { chunkManager },
  }) as unknown as Viewer;
  const uninstall = installWatershedRecipeContext(viewer);
  const abort = new AbortController();
  disposers.push(() => {
    abort.abort();
    if (!viewer.wasDisposed) viewer.dispose();
    if (!root.wasDisposed) root.dispose();
    if (!chunkManager.wasDisposed) chunkManager.dispose();
    uninstall();
  });
  const source = makeHidden();
  vi.mocked(makeLayer).mockReturnValue(source.hidden);
  const prepared = makeInput();
  vi.mocked(prepareAffinityInput).mockReturnValue(prepared.input);
  const recipe: WatershedRecipe = {
    version: 1,
    profile: "visible-slice-union-v1",
    mode: "live",
    source: {
      name: "deleted source name, not a visible-layer lookup",
      source: [
        {
          url: "precomputed://https://example.com/affinities",
          transform: {
            outputDimensions: {
              x: [16e-9, "m"],
              y: [20e-9, "m"],
              z: [40e-9, "m"],
            },
          },
          subsources: { default: true },
        },
      ],
    },
    inputScaleIndex: 2,
    channelsXYZ: [2, 0, 1],
    options: {
      highThreshold: 0.95,
      lowThreshold: 0.05,
      sizeThreshold: 17,
      dustThreshold: 3,
      maskThreshold: 0.5,
    },
    spacingXYZ: [16e-9, 20e-9, 40e-9],
  };
  const options: GetDataSourceOptions = {
    url: WATERSHED_RECIPE_URL,
    state: recipe,
    registry: { chunkManager } as GetDataSourceOptions["registry"],
    globalCoordinateSpace: coordinateSpace,
    transform: undefined,
    signal: abort.signal,
    providerUrl: "recipe",
    providerScheme: "watershed",
  };
  return {
    chunkManager,
    root,
    viewer,
    uninstall,
    abort,
    recipe,
    options,
    ...source,
    ...prepared,
  };
}

function volume(data: DataSource) {
  return data.subsources[0].subsource
    .volume as WatershedMultiscaleVolumeChunkSource;
}

function parameters(data: DataSource): WatershedParametersState {
  expect(data.state).toBeInstanceOf(WatershedParametersState);
  return data.state as WatershedParametersState;
}

async function publicationIsAlive(options: GetDataSourceOptions, url: string) {
  const data = await new WatershedDataSourceProvider().get({ ...options, url });
  volume(data).dispose();
}

function makeOutput() {
  const output = new RefCounted() as ManagedUserLayer;
  disposers.push(() => {
    if (!output.wasDisposed) output.dispose();
  });
  return output;
}

function latestWatch() {
  return vi.mocked(watchWatershedViewport).mock.calls.at(-1)!;
}

function latestLive(): LiveWatershed {
  return vi.mocked(LiveWatershed).mock.results.at(-1)!.value;
}

const region = { lowerXYZ: [10, 8, 8], shapeXYZ: [2, 2, 1] };

describe("watershed recipe datasource restoration", () => {
  it("rebuilds a serialized copy without a visible source, dialog or eager computation", async () => {
    const f = fixture();
    const saved = JSON.stringify(f.recipe);
    const state = JSON.parse(saved);
    const data = await new WatershedDataSourceProvider().get({
      ...f.options,
      state,
    });
    expect(makeLayer).toHaveBeenCalledExactlyOnceWith(
      f.root,
      f.recipe.source.name,
      { type: "image", source: state.source.source },
    );
    expect(f.root.add).not.toHaveBeenCalled();
    expect(prepareAffinityInput).toHaveBeenCalledExactlyOnceWith(f.image, 2);
    expect(LiveWatershed).toHaveBeenCalledExactlyOnceWith(
      f.input,
      [2, 0, 1],
      f.recipe.options,
      expect.any(Function),
      undefined,
    );
    expect(f.input.readRegion).not.toHaveBeenCalled();
    expect(requestAsyncComputation).not.toHaveBeenCalled();
    expect(watchWatershedViewport).not.toHaveBeenCalled();
    expect(data.canonicalUrl).toBe(WATERSHED_RECIPE_URL);
    expect([...data.modelTransform.inputSpace.scales]).toEqual(
      f.recipe.spacingXYZ,
    );
    expect(Array.from(data.modelTransform.transform!.subarray(12, 15))).toEqual(
      [102, 203, -1],
    );
    expect(volume(data).info.shapeXYZ).toEqual([20, 12, 10]);
    expect(JSON.stringify(state)).toBe(saved);
    volume(data).dispose();
    f.abort.abort();
    expect(f.input.dispose).toHaveBeenCalledOnce();
    expect(f.disposeHidden).toHaveBeenCalledOnce();
  });

  it.each([0, 2])(
    "restores custom halo %s into the real scheduler rather than its default bounds",
    async (halo) => {
      const f = fixture();
      f.recipe.halo = halo;
      const data = await new WatershedDataSourceProvider().get(f.options);
      expect(LiveWatershed).toHaveBeenCalledExactlyOnceWith(
        f.input,
        f.recipe.channelsXYZ,
        f.recipe.options,
        expect.any(Function),
        halo,
      );
      expect(parameters(data).toJSON()).toEqual(f.recipe);
      expect(f.input.readRegion).not.toHaveBeenCalled();
      const detach = attachWatershedVolume(volume(data), makeOutput());
      expect(detach).toBeTypeOf("function");
      latestWatch()[3](region);
      const lower = region.lowerXYZ.map((n) => n - halo);
      const shape = region.shapeXYZ.map((n) => n + 2 * halo);
      await vi.waitFor(() =>
        expect(requestAsyncComputation).toHaveBeenCalledOnce(),
      );
      expect(f.input.readRegion).toHaveBeenCalledExactlyOnceWith(
        lower,
        shape,
        [2, 0, 1, 3],
        expect.any(AbortSignal),
      );
      expect(vi.mocked(requestAsyncComputation).mock.calls[0].slice(3)).toEqual(
        [
          new Float32Array(shape.reduce((n, x) => n * x, 1) * 4).fill(0.75),
          shape,
          f.recipe.options,
        ],
      );
      await vi.waitFor(async () => {
        const labels = await latestLive().readTile(
          [0, 0, 0],
          [20, 12, 10],
          f.abort.signal,
        );
        expect(labels.filter((label) => label === 7n)).toHaveLength(
          shape.reduce((n, x) => n * x, 1),
        );
      });
      volume(data).dispose();
      detach!();
    },
  );

  it("forwards full upstream ONNX recipe state, transforms and subsource selections unchanged", async () => {
    const f = fixture();
    f.recipe.source.source = [
      {
        url: "inference://recipe",
        state: {
          version: 2,
          profile: "ncdhw-centered-v2",
          mode: "live",
          source: {
            name: "raw image also absent from the layer list",
            source: [
              {
                url: "precomputed://https://example.com/raw",
                subsources: { default: true },
              },
            ],
          },
          model: {
            kind: "url",
            name: "affinities.onnx",
            urls: ["https://example.com/affinities.onnx"],
            size: 3,
            sha256: "a".repeat(64),
          },
          provider: "cpu",
          precision: "float16",
          compatibilityFixes: false,
          overlap: false,
          inputScaleIndex: 1,
          spacingZYX: [80e-9, 40e-9, 32e-9],
          outputSpacingZYX: [40e-9, 20e-9, 16e-9],
        },
        transform: {
          outputDimensions: {
            x: [16e-9, "m"],
            y: [20e-9, "m"],
            z: [40e-9, "m"],
          },
        },
        subsources: { default: true },
      },
    ];
    const saved = JSON.stringify(f.recipe);
    const restored = await restoreWatershedRecipe(f.options, JSON.parse(saved));
    expect(vi.mocked(makeLayer).mock.calls[0][2]).toEqual({
      type: "image",
      source: f.recipe.source.source,
    });
    expect(JSON.stringify(f.recipe)).toBe(saved);
    restored.dispose();
  });

  it("gives JSON copies independent hidden sources, publications and lifetimes", async () => {
    const f = fixture();
    const secondSource = makeHidden();
    const secondInput = makeInput();
    vi.mocked(makeLayer)
      .mockReturnValueOnce(f.hidden)
      .mockReturnValueOnce(secondSource.hidden);
    vi.mocked(prepareAffinityInput)
      .mockReturnValueOnce(f.input)
      .mockReturnValueOnce(secondInput.input);
    const saved = JSON.stringify(f.recipe);
    const a = await restoreWatershedRecipe(f.options, JSON.parse(saved));
    const otherAbort = new AbortController();
    disposers.push(() => otherAbort.abort());
    const otherOptions = { ...f.options, signal: otherAbort.signal };
    const b = await restoreWatershedRecipe(otherOptions, JSON.parse(saved));
    expect(a.url).not.toBe(b.url);
    expect(makeLayer).toHaveBeenCalledTimes(2);
    expect(LiveWatershed).toHaveBeenNthCalledWith(
      2,
      secondInput.input,
      f.recipe.channelsXYZ,
      f.recipe.options,
      expect.any(Function),
      undefined,
    );
    f.abort.abort();
    expect(f.input.dispose).toHaveBeenCalledOnce();
    expect(f.hidden.wasDisposed).toBe(true);
    expect(secondInput.input.dispose).not.toHaveBeenCalled();
    expect(secondSource.hidden.wasDisposed).not.toBe(true);
    await expect(publicationIsAlive(otherOptions, a.url)).rejects.toThrow(
      /unavailable/,
    );
    await publicationIsAlive(otherOptions, b.url);
    b.dispose();
    expect(secondInput.input.dispose).toHaveBeenCalledOnce();
    expect(secondSource.disposeHidden).toHaveBeenCalledOnce();
  });

  it.each([0, 2])(
    "selects native scale %s before comparing saved spacing and publishing geometry",
    async (scaleIndex) => {
      const f = fixture();
      const coarse = makeInput({
        spacingXYZ: [64e-9, 80e-9, 160e-9],
        originXYZ: [25, 50, -2],
      }).input;
      vi.mocked(prepareAffinityInput).mockImplementation((_image, scale) =>
        scale === 2 ? coarse : f.input,
      );
      const selected = scaleIndex === 2 ? coarse : f.input;
      f.recipe.inputScaleIndex = scaleIndex;
      f.recipe.spacingXYZ = [...selected.spacingXYZ] as [
        number,
        number,
        number,
      ];
      const data = await new WatershedDataSourceProvider().get(f.options);
      expect(prepareAffinityInput).toHaveBeenCalledExactlyOnceWith(
        f.image,
        scaleIndex,
      );
      expect(LiveWatershed).toHaveBeenCalledWith(
        selected,
        f.recipe.channelsXYZ,
        f.recipe.options,
        expect.any(Function),
        undefined,
      );
      expect([...data.modelTransform.inputSpace.scales]).toEqual(
        selected.spacingXYZ,
      );
      expect(
        Array.from(data.modelTransform.transform!.subarray(12, 15)),
      ).toEqual(
        selected.lowerBoundXYZ.map((n, i) => n + selected.originXYZ[i]),
      );
      volume(data).dispose();
      expect(selected.dispose).toHaveBeenCalledOnce();
    },
  );

  it.each([2, 1 + Number.EPSILON])(
    "rejects changed selected-scale spacing (factor %s) before live construction",
    async (factor) => {
      const f = fixture();
      f.recipe.spacingXYZ[0] *= factor;
      await expect(restoreWatershedRecipe(f.options, f.recipe)).rejects.toThrow(
        /native.*voxel size changed|spacing.*changed/i,
      );
      expect(prepareAffinityInput).toHaveBeenCalledExactlyOnceWith(f.image, 2);
      expect(LiveWatershed).not.toHaveBeenCalled();
      expect(f.input.dispose).toHaveBeenCalledOnce();
      expect(f.disposeHidden).toHaveBeenCalledOnce();
    },
  );

  it("waits for hidden source/model metadata readiness rather than preparing early", async () => {
    const f = fixture();
    f.hidden.isReady = () => false;
    f.image.dataType.value = undefined;
    f.image.renderLayers = [];
    const restoring = restoreWatershedRecipe(f.options, f.recipe);
    await Promise.resolve();
    expect(prepareAffinityInput).not.toHaveBeenCalled();
    f.hidden.readyStateChanged.dispatch();
    f.image.dataSourcesChanged.dispatch();
    await Promise.resolve();
    expect(LiveWatershed).not.toHaveBeenCalled();
    f.image.dataType.value = 1;
    f.image.renderLayers = [{}];
    f.hidden.isReady = () => true;
    f.hidden.readyStateChanged.dispatch();
    const restored = await restoring;
    expect(prepareAffinityInput).toHaveBeenCalledOnce();
    expect(LiveWatershed).toHaveBeenCalledOnce();
    expect(f.input.readRegion).not.toHaveBeenCalled();
    restored.dispose();
  });

  it.each(["loadState", "activation"] as const)(
    "rejects asynchronous %s source errors and releases the waiting hidden layer",
    async (kind) => {
      const f = fixture();
      f.hidden.isReady = () => false;
      const restoring = restoreWatershedRecipe(f.options, f.recipe);
      const rejected = expect(restoring).rejects.toThrow(
        "upstream model failed",
      );
      if (kind === "loadState") {
        f.image.dataSources = [
          { loadState: { error: new Error("upstream model failed") } },
        ];
        f.image.dataSourcesChanged.dispatch();
      } else {
        f.image.messages.addMessage({
          severity: MessageSeverity.error,
          message: "upstream model failed",
        });
      }
      await rejected;
      expect(prepareAffinityInput).not.toHaveBeenCalled();
      expect(LiveWatershed).not.toHaveBeenCalled();
      expect(f.disposeHidden).toHaveBeenCalledOnce();
    },
  );

  it("releases the hidden source if native metadata preparation rejects", async () => {
    const f = fixture();
    vi.mocked(prepareAffinityInput).mockImplementation(() => {
      throw new Error("Unsupported affinity input: user transform changed");
    });
    await expect(restoreWatershedRecipe(f.options, f.recipe)).rejects.toThrow(
      "user transform changed",
    );
    expect(LiveWatershed).not.toHaveBeenCalled();
    expect(f.disposeHidden).toHaveBeenCalledOnce();
  });

  it.each(["abort", "root", "manager"] as const)(
    "cancels source loading on %s disposal and ignores late readiness",
    async (owner) => {
      const f = fixture();
      f.hidden.isReady = () => false;
      const restoring = restoreWatershedRecipe(f.options, f.recipe);
      const rejected = expect(restoring).rejects.toMatchObject({
        name: "AbortError",
      });
      if (owner === "abort") f.abort.abort();
      else if (owner === "root") f.root.dispose();
      else f.chunkManager.dispose();
      await rejected;
      f.hidden.isReady = () => true;
      f.hidden.readyStateChanged.dispatch();
      f.image.dataSourcesChanged.dispatch();
      await Promise.resolve();
      expect(prepareAffinityInput).not.toHaveBeenCalled();
      expect(LiveWatershed).not.toHaveBeenCalled();
      expect(f.disposeHidden).toHaveBeenCalledOnce();
      expect(f.hidden.refCount).toBe(0);
    },
  );

  it("attaches viewport demand lazily, waits for affinities, and clears on detach", async () => {
    const f = fixture();
    let resolveAffinities!: (value: Float32Array) => void;
    vi.mocked(f.input.readRegion).mockReturnValue(
      new Promise((resolve) => {
        resolveAffinities = resolve;
      }),
    );
    const restored = await restoreWatershedRecipe(f.options, f.recipe);
    const output = makeOutput();
    const detach = restored.attach(output);
    expect(watchWatershedViewport).toHaveBeenCalledWith(
      f.viewer,
      f.input,
      output,
      expect.any(Function),
      expect.any(Function),
    );
    const onRegion = latestWatch()[3];
    onRegion(region);
    await vi.waitFor(() => expect(f.input.readRegion).toHaveBeenCalledOnce());
    // Halo-expanded input is still fetched as ONE native whole region. Mask is
    // the last channel, distinct from the saved XYZ affinity permutation.
    expect(f.input.readRegion).toHaveBeenCalledWith(
      [2, 3, 4],
      [18, 12, 10],
      [2, 0, 1, 3],
      expect.any(AbortSignal),
    );
    expect(requestAsyncComputation).not.toHaveBeenCalled();
    resolveAffinities(new Float32Array(18 * 12 * 10 * 4).fill(0.75));
    await vi.waitFor(() =>
      expect(requestAsyncComputation).toHaveBeenCalledOnce(),
    );
    expect(vi.mocked(requestAsyncComputation).mock.calls[0].slice(3)).toEqual([
      new Float32Array(18 * 12 * 10 * 4).fill(0.75),
      [18, 12, 10],
      f.recipe.options,
    ]);
    const live = latestLive();
    await vi.waitFor(async () => {
      const tile = await live.readTile([0, 0, 0], [20, 12, 10], f.abort.signal);
      expect(tile.some((label) => label === 7n)).toBe(true);
    });
    const removeWatch = vi.mocked(watchWatershedViewport).mock.results[0].value;
    detach();
    detach();
    expect(removeWatch).toHaveBeenCalledOnce();
    expect(
      (await live.readTile([0, 0, 0], [20, 12, 10], f.abort.signal)).every(
        (label) => label === 0n,
      ),
    ).toBe(true);
    expect(f.input.dispose).not.toHaveBeenCalled();
    await publicationIsAlive(f.options, restored.url);
    restored.dispose();
  });

  it("rebinds viewport ownership and ignores callbacks from a detached layer", async () => {
    const f = fixture();
    const baseline = statusMessages.size;
    const restored = await restoreWatershedRecipe(f.options, f.recipe);
    const setRegion = vi.spyOn(latestLive(), "setRegion");
    const firstDetach = restored.attach(makeOutput());
    const firstWatch = latestWatch();
    const firstRemove = vi.mocked(watchWatershedViewport).mock.results[0].value;
    const secondDetach = restored.attach(makeOutput());
    expect(firstRemove).toHaveBeenCalledOnce();
    expect(setRegion).toHaveBeenLastCalledWith();
    setRegion.mockClear();
    firstWatch[3](region);
    firstWatch[4](new Error("obsolete output error"));
    firstDetach();
    expect(setRegion).not.toHaveBeenCalled();
    expect(statusMessages.size).toBe(baseline);
    latestWatch()[3](region);
    expect(setRegion).toHaveBeenCalledExactlyOnceWith(
      region.lowerXYZ,
      region.shapeXYZ,
    );
    secondDetach();
    expect(setRegion).toHaveBeenLastCalledWith();
    restored.dispose();
    restored.attach(makeOutput());
    expect(watchWatershedViewport).toHaveBeenCalledTimes(2);
  });

  it("registers attachment only for the owned datasource volume and removes it on disposal", async () => {
    const f = fixture();
    const data = await new WatershedDataSourceProvider().get(f.options);
    const output = makeOutput();
    const detach = attachWatershedVolume(volume(data), output);
    expect(detach).toBeTypeOf("function");
    expect(watchWatershedViewport).toHaveBeenCalledWith(
      f.viewer,
      f.input,
      output,
      expect.any(Function),
      expect.any(Function),
    );
    const unwatch = vi.mocked(watchWatershedViewport).mock.results[0].value;
    volume(data).dispose();
    expect(unwatch).toHaveBeenCalledOnce();
    expect(f.input.dispose).toHaveBeenCalledOnce();
    expect(attachWatershedVolume(volume(data), output)).toBeUndefined();
    detach!();
    expect(unwatch).toHaveBeenCalledOnce();
  });

  it("keeps viewport and compute errors recoverable, reporting again after recovery", async () => {
    const f = fixture();
    const baseline = statusMessages.size;
    const restored = await restoreWatershedRecipe(f.options, f.recipe);
    const detach = restored.attach(makeOutput());
    const [, , , onRegion, onError] = latestWatch();
    onError(new Error("Cannot map watershed viewport units/scale for axis x"));
    expect(statusMessages.size).toBe(baseline + 1);
    expect([...statusMessages].at(-1)?.element.textContent).toContain(
      "Cannot map watershed viewport",
    );
    expect(f.input.dispose).not.toHaveBeenCalled();
    vi.mocked(requestAsyncComputation).mockRejectedValueOnce(
      new Error("temporary watershed computation failure"),
    );
    onRegion(region);
    await vi.waitFor(() =>
      expect([...statusMessages].at(-1)?.element.textContent).toContain(
        "temporary watershed computation failure",
      ),
    );
    await publicationIsAlive(f.options, restored.url);
    expect(latestLive().signal.aborted).toBe(false);
    onRegion({ lowerXYZ: [11, 8, 8], shapeXYZ: [2, 2, 1] });
    await vi.waitFor(() =>
      expect(requestAsyncComputation).toHaveBeenCalledTimes(2),
    );
    await vi.waitFor(async () => {
      const tile = await latestLive().readTile(
        [0, 0, 0],
        [20, 12, 10],
        f.abort.signal,
      );
      expect(tile.some((label) => label === 7n)).toBe(true);
    });
    onError(new Error("second viewport error after a successful compute"));
    expect([...statusMessages].at(-1)?.element.textContent).toContain(
      "second viewport error",
    );
    expect(statusMessages.size).toBe(baseline + 1);
    detach();
    restored.dispose();
    expect(statusMessages.size).toBe(baseline);
  });

  it("retires an invalidated source but keeps saved state and a visible error until deletion", async () => {
    const f = fixture();
    const saved = JSON.stringify(f.recipe);
    const baseline = statusMessages.size;
    const data = await new WatershedDataSourceProvider().get(f.options);
    f.invalidation.abort(new Error("native source metadata changed"));
    expect(f.input.dispose).toHaveBeenCalledOnce();
    expect(f.disposeHidden).toHaveBeenCalledOnce();
    expect(latestLive().signal.aborted).toBe(true);
    expect(statusMessages.size).toBe(baseline + 1);
    expect([...statusMessages].at(-1)?.element.textContent).toMatch(
      /source.*changed/i,
    );
    expect(data.canonicalUrl).toBe(WATERSHED_RECIPE_URL);
    expect(JSON.stringify(f.options.state)).toBe(saved);
    await expect(
      publicationIsAlive(f.options, `watershed://${volume(data).resultId}`),
    ).rejects.toThrow(/unavailable/);
    volume(data).dispose();
    f.abort.abort();
    expect(statusMessages.size).toBe(baseline);
    expect(f.input.dispose).toHaveBeenCalledOnce();
    expect(f.disposeHidden).toHaveBeenCalledOnce();
  });

  it.each(["abort", "root", "manager", "handle"] as const)(
    "releases watcher, publication, source and private status exactly once on %s teardown",
    async (owner) => {
      const f = fixture();
      const baseline = statusMessages.size;
      const restored = await restoreWatershedRecipe(f.options, f.recipe);
      const detach = restored.attach(makeOutput());
      latestWatch()[4](new Error("private restore error"));
      expect(statusMessages.size).toBe(baseline + 1);
      const removeWatch = vi.mocked(watchWatershedViewport).mock.results[0]
        .value;
      if (owner === "abort") f.abort.abort();
      else if (owner === "root") f.root.dispose();
      else if (owner === "manager") f.chunkManager.dispose();
      else restored.dispose();
      restored.dispose();
      detach();
      f.abort.abort();
      expect(removeWatch).toHaveBeenCalledOnce();
      expect(f.input.dispose).toHaveBeenCalledOnce();
      expect(f.disposeHidden).toHaveBeenCalledOnce();
      expect(f.hidden.refCount).toBe(0);
      expect(statusMessages.size).toBe(baseline);
      const query = { ...f.options, signal: new AbortController().signal };
      await expect(publicationIsAlive(query, restored.url)).rejects.toThrow(
        /unavailable/,
      );
    },
  );

  it("uses the initial identity hint once without stealing the original publication", async () => {
    const f = fixture();
    const seedInput = makeInput().input;
    const seedLive = new LiveWatershed(seedInput, [2, 0, 1], f.recipe.options);
    const publication = publishLiveWatershed(f.chunkManager, seedLive);
    disposers.push(publication.dispose);
    vi.mocked(LiveWatershed).mockClear();
    const source = makeWatershedRecipeSource(
      publication,
      f.recipe,
      f.root.coordinateSpace,
    );
    expect(source.state).toBe(f.recipe);
    const provider = new WatershedDataSourceProvider();
    const hinted = await provider.get({ ...f.options, ...source });
    expect(hinted.canonicalUrl).toBe(WATERSHED_RECIPE_URL);
    expect(makeLayer).not.toHaveBeenCalled();
    expect(LiveWatershed).not.toHaveBeenCalled();
    volume(hinted).dispose();
    expect(seedInput.dispose).not.toHaveBeenCalled();
    const restored = await provider.get({ ...f.options, ...source });
    expect(makeLayer).toHaveBeenCalledOnce();
    expect(LiveWatershed).toHaveBeenCalledOnce();
    expect(volume(restored).resultId).not.toBe(volume(hinted).resultId);
    volume(restored).dispose();
    expect(f.input.dispose).toHaveBeenCalledOnce();
    await publicationIsAlive(f.options, publication.url);
    publication.dispose();
    expect(seedInput.dispose).toHaveBeenCalledOnce();
  });

  it("does not use or consume an unconsumed hint for copied JSON", async () => {
    const a = fixture();
    const seedInput = makeInput().input;
    const publication = publishLiveWatershed(
      a.chunkManager,
      new LiveWatershed(seedInput, [2, 0, 1], a.recipe.options),
    );
    disposers.push(publication.dispose);
    const source = makeWatershedRecipeSource(
      publication,
      a.recipe,
      a.root.coordinateSpace,
    );
    const provider = new WatershedDataSourceProvider();
    const copy = await provider.get({
      ...a.options,
      ...JSON.parse(JSON.stringify(source)),
    });
    expect(makeLayer).toHaveBeenCalledOnce();
    expect(volume(copy).resultId).not.toBe(
      publication.url.slice("watershed://".length),
    );
    volume(copy).dispose();
    const original = await provider.get({ ...a.options, ...source });
    expect(volume(original).resultId).toBe(
      publication.url.slice("watershed://".length),
    );
    expect(makeLayer).toHaveBeenCalledOnce();
    volume(original).dispose();
    expect(seedInput.dispose).not.toHaveBeenCalled();
  });

  it("restores in another ChunkManager without consuming the owner's initial hint", async () => {
    const a = fixture();
    const seedInput = makeInput().input;
    const publication = publishLiveWatershed(
      a.chunkManager,
      new LiveWatershed(seedInput, [2, 0, 1], a.recipe.options),
    );
    disposers.push(publication.dispose);
    const source = makeWatershedRecipeSource(
      publication,
      a.recipe,
      a.root.coordinateSpace,
    );
    const b = fixture();
    const provider = new WatershedDataSourceProvider();
    const other = await provider.get({ ...b.options, ...source });
    expect(makeLayer).toHaveBeenCalledExactlyOnceWith(
      b.root,
      a.recipe.source.name,
      { type: "image", source: a.recipe.source.source },
    );
    expect(volume(other).resultId).not.toBe(
      publication.url.slice("watershed://".length),
    );
    volume(other).dispose();
    expect(b.input.dispose).toHaveBeenCalledOnce();
    // If the foreign read incorrectly consumed the hint, an erroneous second
    // restoration can still complete, so assertions expose the lost hint.
    vi.mocked(makeLayer).mockReturnValue(a.hidden);
    vi.mocked(prepareAffinityInput).mockReturnValue(a.input);
    const original = await provider.get({ ...a.options, ...source });
    expect(volume(original).resultId).toBe(
      publication.url.slice("watershed://".length),
    );
    expect(makeLayer).toHaveBeenCalledOnce();
    volume(original).dispose();
    expect(a.input.dispose).not.toHaveBeenCalled();
    expect(seedInput.dispose).not.toHaveBeenCalled();
    await publicationIsAlive(a.options, publication.url);
  });

  it("restores a foreign viewer independently even with a shared ChunkManager and preserves the owner's hint", async () => {
    const a = fixture();
    const seedInput = makeInput().input;
    const seedLive = new LiveWatershed(seedInput, [2, 0, 1], a.recipe.options);
    const publication = publishLiveWatershed(a.chunkManager, seedLive);
    disposers.push(publication.dispose);
    const source = makeWatershedRecipeSource(
      publication,
      a.recipe,
      a.root.coordinateSpace,
    );
    vi.mocked(LiveWatershed).mockClear();
    const b = fixture(a.chunkManager);
    expect(b.chunkManager).toBe(a.chunkManager);
    expect(b.root.coordinateSpace).not.toBe(a.root.coordinateSpace);
    const provider = new WatershedDataSourceProvider();
    // Exact original state identity, not a serialized copy: viewer B must not
    // borrow viewer A's producer or consume A's single-use optimization.
    const other = await provider.get({ ...b.options, ...source });
    expect(volume(other).resultId).not.toBe(
      publication.url.slice("watershed://".length),
    );
    expect(makeLayer).toHaveBeenCalledExactlyOnceWith(
      b.root,
      a.recipe.source.name,
      { type: "image", source: a.recipe.source.source },
    );
    expect(LiveWatershed).toHaveBeenCalledExactlyOnceWith(
      b.input,
      a.recipe.channelsXYZ,
      a.recipe.options,
      expect.any(Function),
      undefined,
    );
    const output = makeOutput();
    const detach = attachWatershedVolume(volume(other), output);
    expect(detach).toBeTypeOf("function");
    expect(watchWatershedViewport).toHaveBeenCalledExactlyOnceWith(
      b.viewer,
      b.input,
      output,
      expect.any(Function),
      expect.any(Function),
    );
    const unwatch = vi.mocked(watchWatershedViewport).mock.results[0].value;
    const setRegion = vi.spyOn(latestLive(), "setRegion");
    latestWatch()[3](region);
    expect(setRegion).toHaveBeenCalledExactlyOnceWith(
      region.lowerXYZ,
      region.shapeXYZ,
    );
    const original = await provider.get({ ...a.options, ...source });
    expect(volume(original).resultId).toBe(
      publication.url.slice("watershed://".length),
    );
    expect(makeLayer).toHaveBeenCalledOnce();
    expect(LiveWatershed).toHaveBeenCalledOnce();
    volume(other).dispose();
    detach!();
    expect(unwatch).toHaveBeenCalledOnce();
    expect(b.input.dispose).toHaveBeenCalledOnce();
    expect(b.disposeHidden).toHaveBeenCalledOnce();
    expect(seedInput.dispose).not.toHaveBeenCalled();
    expect(seedInput.readRegion).not.toHaveBeenCalled();
    expect(seedLive.signal.aborted).toBe(false);
    volume(original).dispose();
    await publicationIsAlive(a.options, publication.url);
    expect(seedInput.dispose).not.toHaveBeenCalled();
  });

  it("requires the matching installed viewer context and never crosses coordinate-space owners", async () => {
    const f = fixture();
    const other = fixture();
    await expect(
      restoreWatershedRecipe(
        {
          ...f.options,
          registry: other.options.registry,
        },
        f.recipe,
      ),
    ).rejects.toThrow(/ChunkManager/);
    const alien = Object.assign(new RefCounted(), {
      layerSpecification: other.root,
      coordinateSpace: f.options.globalCoordinateSpace,
      dataContext: { chunkManager: other.chunkManager },
    }) as unknown as Viewer;
    // Both APIs expose the same key, but it must never alias two viewers.
    const originalSpace = other.root.coordinateSpace;
    Object.assign(other.root, {
      coordinateSpace: f.options.globalCoordinateSpace,
    });
    try {
      expect(() => installWatershedRecipeContext(alien)).toThrow(
        /another viewer/i,
      );
    } finally {
      Object.assign(other.root, { coordinateSpace: originalSpace });
      alien.dispose();
    }
    f.uninstall();
    await expect(restoreWatershedRecipe(f.options, f.recipe)).rejects.toThrow(
      /installed viewer context/i,
    );
    expect(makeLayer).not.toHaveBeenCalled();
  });

  it("uninstalls only its own reference to a shared viewer context", async () => {
    const f = fixture();
    const second = installWatershedRecipeContext(f.viewer);
    f.uninstall();
    f.uninstall();
    const restored = await restoreWatershedRecipe(f.options, f.recipe);
    restored.dispose();
    second();
    await expect(restoreWatershedRecipe(f.options, f.recipe)).rejects.toThrow(
      /installed viewer context/i,
    );
  });
});

describe("live watershed recipe parameter state", () => {
  it("updates the retained producer and current region before publishing changed state, clearing stale labels", async () => {
    const f = fixture();
    const data = await new WatershedDataSourceProvider().get(f.options);
    const state = parameters(data);
    const live = latestLive();
    const source = volume(data);
    const resultId = source.resultId;
    const modelTransform = data.modelTransform;
    const original = state.toJSON();
    const setParameters = vi.spyOn(live, "setParameters");
    const setRegion = vi.spyOn(live, "setRegion");
    const detach = attachWatershedVolume(source, makeOutput());
    latestWatch()[3](region);
    const readLabels = () =>
      live.readTile([0, 0, 0], [20, 12, 10], f.abort.signal);
    await vi.waitFor(async () =>
      expect((await readLabels()).some((label) => label === 7n)).toBe(true),
    );
    const next: WatershedRecipe = {
      ...state.toJSON(),
      channelsXYZ: [1, 2, 0],
      halo: 2,
      options: {
        highThreshold: 0.9,
        lowThreshold: 0.1,
        sizeThreshold: 8,
        dustThreshold: 1,
        maskThreshold: 0.4,
        aggThreshold: 0,
      },
    };
    let resolveRead!: (value: Float32Array) => void;
    vi.mocked(f.input.readRegion).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );
    const duringApply: WatershedRecipe[] = [];
    const removeChanged = live.changed.add(() =>
      duringApply.push(state.toJSON()),
    );
    const changed = vi.fn(() => state.toJSON());
    state.changed.add(changed);
    state.restoreState(next);
    removeChanged();
    expect(setParameters).toHaveBeenCalledExactlyOnceWith(
      next.channelsXYZ,
      next.options,
      next.halo,
    );
    expect(duringApply).toEqual([original]);
    expect(changed).toHaveBeenCalledOnce();
    expect(changed.mock.results[0].value).toEqual(next);
    expect((await readLabels()).every((label) => label === 0n)).toBe(true);
    await vi.waitFor(() => expect(f.input.readRegion).toHaveBeenCalledTimes(2));
    expect(f.input.readRegion).toHaveBeenLastCalledWith(
      [8, 6, 6],
      [6, 6, 5],
      [1, 2, 0, 3],
      expect.any(AbortSignal),
    );
    expect(requestAsyncComputation).toHaveBeenCalledOnce();
    expect((await readLabels()).every((label) => label === 0n)).toBe(true);
    resolveRead(new Float32Array(6 * 6 * 5 * 4).fill(0.75));
    await vi.waitFor(async () =>
      expect((await readLabels()).filter((label) => label === 7n)).toHaveLength(
        6 * 6 * 5,
      ),
    );
    expect(requestAsyncComputation).toHaveBeenCalledTimes(2);
    expect(vi.mocked(requestAsyncComputation).mock.calls[1].slice(3)).toEqual([
      new Float32Array(6 * 6 * 5 * 4).fill(0.75),
      [6, 6, 5],
      next.options,
    ]);
    state.restoreState(JSON.parse(JSON.stringify(next)));
    expect(setParameters).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledOnce();
    expect(state.toJSON()).toEqual(next);
    expect(JSON.parse(JSON.stringify(state))).toEqual(next);
    expect(f.options.state).toEqual(original);
    expect(data.state).toBe(state);
    expect(volume(data)).toBe(source);
    expect(source.resultId).toBe(resultId);
    expect(data.modelTransform).toBe(modelTransform);
    expect(latestLive()).toBe(live);
    expect(setRegion).toHaveBeenCalledExactlyOnceWith(
      region.lowerXYZ,
      region.shapeXYZ,
    );
    // Hidden image construction is the upstream model-controller boundary.
    // An edit must not cross it, re-prepare its input, or rebind its viewport.
    expect(makeLayer).toHaveBeenCalledOnce();
    expect(prepareAffinityInput).toHaveBeenCalledOnce();
    expect(LiveWatershed).toHaveBeenCalledOnce();
    expect(watchWatershedViewport).toHaveBeenCalledOnce();
    expect(f.input.dispose).not.toHaveBeenCalled();
    expect(f.disposeHidden).not.toHaveBeenCalled();
    volume(data).dispose();
    detach!();
  });

  it("edits hidden state without work, disables the mask, and resets optional parameters on the same current region", async () => {
    const f = fixture();
    const data = await new WatershedDataSourceProvider().get(f.options);
    const state = parameters(data);
    const live = latestLive();
    const original = state.toJSON();
    const changed = vi.fn();
    state.changed.add(changed);
    const { maskThreshold: _mask, ...unmasked } = original.options;
    const next: WatershedRecipe = {
      ...original,
      channelsXYZ: [3, 1, 0],
      halo: 0,
      options: { ...unmasked, aggThreshold: 0 },
    };
    state.restoreState(next);
    expect(state.toJSON()).toEqual(next);
    expect(f.input.readRegion).not.toHaveBeenCalled();
    expect(requestAsyncComputation).not.toHaveBeenCalled();
    expect(watchWatershedViewport).not.toHaveBeenCalled();
    attachWatershedVolume(volume(data), makeOutput());
    latestWatch()[3](region);
    const readLabels = () =>
      live.readTile([0, 0, 0], [20, 12, 10], f.abort.signal);
    await vi.waitFor(async () =>
      expect((await readLabels()).filter((label) => label === 7n)).toHaveLength(
        4,
      ),
    );
    expect(f.input.readRegion).toHaveBeenCalledExactlyOnceWith(
      region.lowerXYZ,
      region.shapeXYZ,
      [3, 1, 0],
      expect.any(AbortSignal),
    );
    expect(vi.mocked(requestAsyncComputation).mock.calls[0][5]).toEqual(
      next.options,
    );
    state.reset();
    expect(state.toJSON()).toEqual(original);
    expect(state.toJSON()).not.toHaveProperty("halo");
    expect(state.toJSON().options).not.toHaveProperty("aggThreshold");
    expect((await readLabels()).every((label) => label === 0n)).toBe(true);
    await vi.waitFor(async () =>
      expect((await readLabels()).filter((label) => label === 7n)).toHaveLength(
        18 * 12 * 10,
      ),
    );
    expect(f.input.readRegion).toHaveBeenLastCalledWith(
      [2, 3, 4],
      [18, 12, 10],
      [2, 0, 1, 3],
      expect.any(AbortSignal),
    );
    expect(vi.mocked(requestAsyncComputation).mock.calls[1][5]).toEqual(
      original.options,
    );
    expect(changed).toHaveBeenCalledTimes(2);
    expect(makeLayer).toHaveBeenCalledOnce();
    expect(prepareAffinityInput).toHaveBeenCalledOnce();
    expect(LiveWatershed).toHaveBeenCalledOnce();
    expect(watchWatershedViewport).toHaveBeenCalledOnce();
    volume(data).dispose();
  });

  it("gives a seeded live publication editable state and persists edits for an independent JSON restoration", async () => {
    const f = fixture();
    const seedInput = makeInput().input;
    const live = new LiveWatershed(seedInput, [2, 0, 1], f.recipe.options);
    const publication = publishLiveWatershed(f.chunkManager, live);
    disposers.push(publication.dispose);
    const source = makeWatershedRecipeSource(
      publication,
      f.recipe,
      f.root.coordinateSpace,
    );
    const provider = new WatershedDataSourceProvider();
    const data = await provider.get({ ...f.options, ...source });
    const state = parameters(data);
    live.setRegion(region.lowerXYZ, region.shapeXYZ);
    const next: WatershedRecipe = {
      ...state.toJSON(),
      channelsXYZ: [0, 2, 1],
      halo: 0,
      options: { ...f.recipe.options, aggThreshold: 0.6 },
    };
    const setParameters = vi.spyOn(live, "setParameters");
    state.restoreState(next);
    expect(setParameters).toHaveBeenCalledExactlyOnceWith(
      next.channelsXYZ,
      next.options,
      0,
    );
    await vi.waitFor(() =>
      expect(requestAsyncComputation).toHaveBeenCalledOnce(),
    );
    expect(seedInput.readRegion).toHaveBeenCalledExactlyOnceWith(
      region.lowerXYZ,
      region.shapeXYZ,
      [0, 2, 1, 3],
      expect.any(AbortSignal),
    );
    expect(makeLayer).not.toHaveBeenCalled();
    expect(prepareAffinityInput).not.toHaveBeenCalled();
    expect(LiveWatershed).toHaveBeenCalledOnce();
    expect(watchWatershedViewport).not.toHaveBeenCalled();
    expect(volume(data).resultId).toBe(
      publication.url.slice("watershed://".length),
    );
    const saved = JSON.parse(JSON.stringify(state));
    expect(saved).toEqual(next);
    expect(source.state).toBe(f.recipe);
    expect(f.recipe).not.toEqual(next);
    volume(data).dispose();
    expect(seedInput.dispose).not.toHaveBeenCalled();
    const restored = await provider.get({ ...f.options, state: saved });
    expect(parameters(restored).toJSON()).toEqual(next);
    expect(LiveWatershed).toHaveBeenLastCalledWith(
      f.input,
      next.channelsXYZ,
      next.options,
      expect.any(Function),
      0,
    );
    expect(volume(restored).resultId).not.toBe(
      publication.url.slice("watershed://".length),
    );
    volume(restored).dispose();
    await publicationIsAlive(f.options, publication.url);
    expect(seedInput.dispose).not.toHaveBeenCalled();
  });

  it("rejects invalid channel and halo edits without saving state, clearing labels, or scheduling work", async () => {
    const f = fixture();
    const data = await new WatershedDataSourceProvider().get(f.options);
    const state = parameters(data);
    const original = state.toJSON();
    const live = latestLive();
    attachWatershedVolume(volume(data), makeOutput());
    latestWatch()[3](region);
    const readLabels = () =>
      live.readTile([0, 0, 0], [20, 12, 10], f.abort.signal);
    await vi.waitFor(async () =>
      expect((await readLabels()).some((label) => label === 7n)).toBe(true),
    );
    const labels = await readLabels();
    const changed = vi.fn();
    state.changed.add(changed);
    const liveChanged = vi.fn();
    const removeChanged = live.changed.add(liveChanged);
    for (const [edit, error] of [
      [{ channelsXYZ: [4, 0, 1] }, /in-bounds affinity channels/],
      [{ channelsXYZ: [3, 0, 1] }, /mask, not an affinity channel/],
      [{ halo: -1 }, /halo/],
      [{ halo: 0.5 }, /halo/],
    ] as const) {
      expect(() => state.restoreState({ ...original, ...edit })).toThrow(error);
      expect(state.toJSON()).toEqual(original);
      expect(await readLabels()).toEqual(labels);
    }
    expect(changed).not.toHaveBeenCalled();
    expect(liveChanged).not.toHaveBeenCalled();
    expect(f.input.readRegion).toHaveBeenCalledOnce();
    expect(requestAsyncComputation).toHaveBeenCalledOnce();
    expect(live.signal.aborted).toBe(false);
    state.restoreState({ ...original, halo: 0 });
    expect(changed).toHaveBeenCalledOnce();
    expect(liveChanged).toHaveBeenCalledOnce();
    expect(state.toJSON().halo).toBe(0);
    removeChanged();
    volume(data).dispose();
  });

  it.each([false, true])(
    "clears an oversized-halo error after a parameter-only retry without navigating (dismissed=%s)",
    async (dismissed) => {
      const f = fixture();
      Object.assign(f.input, { upperBoundXYZ: [1026, 1027, 1028] });
      const baseline = statusMessages.size;
      const data = await new WatershedDataSourceProvider().get(f.options);
      const state = parameters(data);
      const detach = attachWatershedVolume(volume(data), makeOutput())!;
      latestWatch()[3](region);
      const original = state.toJSON();
      state.restoreState({ ...original, halo: 512 });
      expect(statusMessages.size).toBe(baseline + 1);
      expect([...statusMessages].at(-1)?.element.textContent).toContain(
        "2**21 voxel limit",
      );
      expect(requestAsyncComputation).not.toHaveBeenCalled();
      if (dismissed) {
        [...statusMessages].at(-1)!.element.querySelector("button")!.click();
        expect(statusMessages.size).toBe(baseline);
      }
      expect(() => state.restoreState({ ...original, halo: 0 })).not.toThrow();
      await vi.waitFor(async () => {
        const labels = await latestLive().readTile(
          [0, 0, 0],
          [64, 64, 32],
          f.abort.signal,
        );
        expect(labels.some((label) => label === 7n)).toBe(true);
      });
      expect(requestAsyncComputation).toHaveBeenCalledOnce();
      expect(watchWatershedViewport).toHaveBeenCalledOnce();
      expect(statusMessages.size).toBe(baseline);
      detach();
      volume(data).dispose();
    },
  );

  it("reports source invalidation after a dismissed compute error and disposes the message safely", async () => {
    const f = fixture();
    Object.assign(f.input, { upperBoundXYZ: [1026, 1027, 1028] });
    const baseline = statusMessages.size;
    const data = await new WatershedDataSourceProvider().get(f.options);
    attachWatershedVolume(volume(data), makeOutput());
    latestWatch()[3](region);
    parameters(data).restoreState({ ...f.recipe, halo: 512 });
    const oldStatus = [...statusMessages].at(-1)!;
    oldStatus.element.querySelector("button")!.click();
    expect(statusMessages.size).toBe(baseline);
    f.invalidation.abort();
    expect(statusMessages.size).toBe(baseline + 1);
    expect([...statusMessages].at(-1)).not.toBe(oldStatus);
    expect([...statusMessages].at(-1)?.element.textContent).toMatch(
      /affinity source changed/i,
    );
    expect(latestLive().signal.aborted).toBe(true);
    volume(data).dispose();
    expect(statusMessages.size).toBe(baseline);
  });

  it("rejects upstream source, native scale and spacing replacements before touching the producer", async () => {
    const f = fixture();
    const data = await new WatershedDataSourceProvider().get(f.options);
    const state = parameters(data);
    const original = state.toJSON();
    const setParameters = vi.spyOn(latestLive(), "setParameters");
    const changed = vi.fn();
    state.changed.add(changed);
    for (const edit of [
      {
        source: {
          ...original.source,
          source: "precomputed://https://example.com/different-affinities",
        },
      },
      { inputScaleIndex: 0 },
      { spacingXYZ: [32e-9, 20e-9, 40e-9] },
    ]) {
      expect(() => state.restoreState({ ...original, ...edit })).toThrow(
        /input or native scale requires a new layer/,
      );
      expect(state.toJSON()).toEqual(original);
    }
    expect(setParameters).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(makeLayer).toHaveBeenCalledOnce();
    expect(prepareAffinityInput).toHaveBeenCalledOnce();
    expect(LiveWatershed).toHaveBeenCalledOnce();
    expect(watchWatershedViewport).not.toHaveBeenCalled();
    expect(f.input.readRegion).not.toHaveBeenCalled();
    volume(data).dispose();
  });

  it.each(["disposal", "source invalidation"] as const)(
    "rejects an update after %s without replacing the saved recipe",
    async (reason) => {
      const f = fixture();
      const data = await new WatershedDataSourceProvider().get(f.options);
      const state = parameters(data);
      const original = state.toJSON();
      const changed = vi.fn();
      state.changed.add(changed);
      if (reason === "disposal") volume(data).dispose();
      else f.invalidation.abort(new Error("native source metadata changed"));
      expect(latestLive().signal.aborted).toBe(true);
      expect(() =>
        state.restoreState({ ...original, channelsXYZ: [0, 1, 2], halo: 0 }),
      ).toThrow("Live watershed stopped");
      expect(state.toJSON()).toEqual(original);
      expect(JSON.parse(JSON.stringify(state))).toEqual(original);
      expect(changed).not.toHaveBeenCalled();
      expect(makeLayer).toHaveBeenCalledOnce();
      expect(prepareAffinityInput).toHaveBeenCalledOnce();
      expect(LiveWatershed).toHaveBeenCalledOnce();
      expect(requestAsyncComputation).not.toHaveBeenCalled();
      volume(data).dispose();
      expect(f.input.dispose).toHaveBeenCalledOnce();
      expect(f.disposeHidden).toHaveBeenCalledOnce();
    },
  );
});
