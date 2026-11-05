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

import { userEvent } from "@vitest/browser/context";
import type CodeMirror from "codemirror";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataSourceSpecification } from "#src/datasource/index.js";
import { makeEmptyDataSourceSpecification } from "#src/datasource/index.js";
import { INFERENCE_RECIPE_URL } from "#src/inference/recipe.js";
import type {
  LayerDataSource,
  LayerDataSourceLoadState,
} from "#src/layer/layer_data_source.js";
import { LoadedLayerDataSource } from "#src/layer/layer_data_source.js";
import type { LayerDataSourcesTab } from "#src/ui/layer_data_sources_tab.js";
import { DataSourceView } from "#src/ui/layer_data_sources_tab.js";
import { MessageList, MessageSeverity } from "#src/util/message_list.js";
import { MultiConsumerProgressListener } from "#src/util/progress_listener.js";
import { NullarySignal } from "#src/util/signal.js";
import { WatershedParametersState } from "#src/watershed/parameters.js";
import {
  parseWatershedRecipe,
  WATERSHED_RECIPE_URL,
} from "#src/watershed/recipe.js";

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length) disposers.pop()!();
  vi.restoreAllMocks();
});

function inferenceRecipeState() {
  return {
    version: 2,
    profile: "ncdhw-centered-v2",
    source: {
      name: "raw image",
      source: { url: "precomputed://https://example.com/raw" },
    },
    model: {
      kind: "url",
      name: "segmentation.onnx",
      urls: ["https://example.com/segmentation.onnx"],
      size: 12345,
      sha256: "ab".repeat(32),
    },
    provider: "cpu",
    mode: "live",
    spacingZYX: [9, 3, 2],
    outputSpacingZYX: [12, 4, 1],
    // The view must show all saved JSON, not just selected recipe fields.
    metadata: { inputShape: [1, 1, 20, 80, 80], note: "saved metadata" },
  };
}

function sourceFixture(
  options: {
    url?: string;
    state?: unknown;
    loadState?: LayerDataSourceLoadState;
  } = {},
) {
  const { url = INFERENCE_RECIPE_URL, loadState = undefined } = options;
  let spec: DataSourceSpecification = {
    ...makeEmptyDataSourceSpecification(),
    url,
    state: "state" in options ? options.state : inferenceRecipeState(),
  };
  const setSpec = vi.fn((value: DataSourceSpecification) => {
    spec = value;
  });
  const registry = {
    completeUrl: vi.fn().mockResolvedValue({ offset: 0, completions: [] }),
    get: vi.fn(),
  };
  // Deliberately avoid constructing a UserLayer or starting a source load.
  // A spec assignment would reload a real LayerDataSource, so track writes.
  const source = {
    get spec() {
      return spec;
    },
    set spec(value: DataSourceSpecification) {
      setSpec(value);
    },
    changed: new NullarySignal(),
    messages: new MessageList(),
    progressListener: new MultiConsumerProgressListener(),
    layer: { manager: { dataSourceProviderRegistry: registry } },
    loadState,
  };
  const loadedState =
    loadState instanceof LoadedLayerDataSource
      ? loadState.dataSource?.state
      : undefined;
  if (loadedState !== undefined) {
    // Mirror LayerDataSource's existing Trackable-state serialization hook.
    disposers.push(
      loadedState.changed.add(() => {
        spec = { ...spec, state: loadedState.toJSON() };
      }),
    );
  }
  const tab = { detectedLayerConstructor: undefined };
  const view = new DataSourceView(
    tab as unknown as LayerDataSourcesTab,
    source as unknown as LayerDataSource,
  );
  const host = document.createElement("div");
  host.appendChild(view.element);
  document.body.appendChild(host);
  disposers.push(() => host.remove());
  disposers.push(() => {
    if (!view.wasDisposed) view.dispose();
  });
  return {
    source,
    view,
    host,
    registry,
    setSpec,
    update(patch: Partial<DataSourceSpecification> = {}) {
      // Model-side change, not a write by the view. The containing Source tab
      // calls updateView after source.changed propagates to dataSourcesChanged.
      spec = { ...spec, ...patch };
      source.changed.dispatch();
      view.updateView();
    },
  };
}

function watershedRecipeState() {
  return {
    version: 1,
    profile: "visible-slice-union-v1",
    mode: "live",
    source: {
      name: "ONNX affinities",
      source: { url: INFERENCE_RECIPE_URL, state: inferenceRecipeState() },
    },
    inputScaleIndex: 2,
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
}

type CodeMirrorWrapper = HTMLElement & { CodeMirror: CodeMirror.Editor };
const stateSelector = ".neuroglancer-layer-data-source-state";

function sourceStateEditor(view: DataSourceView, kind: string) {
  const container = view.element.querySelector<HTMLElement>(stateSelector);
  expect(container).not.toBeNull();
  expect(container!.checkVisibility()).toBe(true);
  expect(container!.textContent).toContain(`${kind} source state (read-only)`);
  const wrapper = container!.querySelector<CodeMirrorWrapper>(".CodeMirror");
  expect(wrapper).not.toBeNull();
  expect(wrapper!.getAttribute("aria-label")).toBe(`${kind} source state`);
  // CodeMirror attaches its real editor to the wrapper; do not mock it.
  expect(wrapper!.CodeMirror.getWrapperElement()).toBe(wrapper);
  return wrapper!.CodeMirror;
}

function expectHiddenState(view: DataSourceView) {
  const container = view.element.querySelector<HTMLElement>(stateSelector);
  // Both removing the panel and retaining a hidden, emptied panel are valid.
  if (container === null) return;
  expect(container.checkVisibility()).toBe(false);
  for (const wrapper of container.querySelectorAll<CodeMirrorWrapper>(
    ".CodeMirror",
  )) {
    expect(wrapper.CodeMirror.getValue()).toBe("");
  }
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

describe.each([
  {
    kind: "Inference",
    url: INFERENCE_RECIPE_URL,
    recipeState: inferenceRecipeState,
  },
  {
    kind: "Watershed",
    url: WATERSHED_RECIPE_URL,
    recipeState: watershedRecipeState,
  },
])("DataSourceView $kind source state", ({ kind, url, recipeState }) => {
  const fixture = (options: Parameters<typeof sourceFixture>[0] = {}) =>
    sourceFixture({ url, state: recipeState(), ...options });
  const visibleEditor = (view: DataSourceView) => sourceStateEditor(view, kind);
  it("shows the complete pretty-printed recipe in a read-only, wrapping CodeMirror", () => {
    const { view, source } = fixture();
    const editor = visibleEditor(view);
    expect(editor.getValue()).toBe(JSON.stringify(source.spec.state, null, 2));
    expect(JSON.parse(editor.getValue())).toEqual(recipeState());
    expect(editor.getOption("readOnly")).toBe(true);
    expect(editor.getOption("lineWrapping")).toBe(true);
    expect(editor.getInputField().getAttribute("aria-label")).toBe(
      `${kind} source state JSON`,
    );
    expect(view.element.querySelector(`${stateSelector} button`)).toBeNull();
  });

  it.each([
    ["loading", undefined],
    ["failed", { error: new Error("Model unavailable") }],
  ] as const)(
    "keeps state visible while the source is %s",
    (_name, loadState) => {
      const { view, source } = fixture({ loadState });
      expect(visibleEditor(view).getValue()).toBe(
        JSON.stringify(source.spec.state, null, 2),
      );
    },
  );

  it("keeps state visible across loading and error transitions", () => {
    const { view, source, update } = fixture();
    source.loadState = {
      error: new Error("Could not restore inference model"),
    };
    source.messages.addMessage({
      severity: MessageSeverity.error,
      message: source.loadState.error.message,
    });
    update();
    expect(visibleEditor(view).getValue()).toBe(
      JSON.stringify(source.spec.state, null, 2),
    );
    source.loadState = undefined;
    update();
    expect(visibleEditor(view).getValue()).toBe(
      JSON.stringify(source.spec.state, null, 2),
    );
  });

  it("updates JSON even when the same loaded source view is retained", () => {
    // Only the fields consumed by LoadedDataSourceView are needed. Retaining
    // this identity exercises updateView's loaded-view early-return path.
    const loaded = Object.assign(
      Object.create(LoadedLayerDataSource.prototype),
      {
        enableDefaultSubsources: true,
        enabledSubsourcesChanged: new NullarySignal(),
        subsources: [],
        transform: { mutableSourceRank: false, value: { sourceRank: 0 } },
      },
    ) as LoadedLayerDataSource;
    const { view, source, update } = fixture({ loadState: loaded });
    const loadedControls = view.element.querySelector(
      ".neuroglancer-layer-data-sources-source-default",
    );
    expect(loadedControls).not.toBeNull();
    visibleEditor(view);
    const state = recipeState();
    if ("options" in state) {
      state.inputScaleIndex = 1;
      state.channelsXYZ = [1, 1, 0];
      state.options.maskThreshold = 0.7;
      state.options.highThreshold = 0.9;
      state.spacingXYZ = [8e-9, 8e-9, 32e-9];
      state.source.source.state.model.name = "updated.onnx";
      state.source.source.state.metadata.note = "updated nested metadata";
    } else {
      state.spacingZYX = [30, 5, 2];
      state.metadata.note = "updated metadata";
      state.model.name = "updated.onnx";
    }
    state.source.name = "updated source";
    update({ state });
    expect(source.loadState).toBe(loaded);
    expect(
      view.element.querySelector(
        ".neuroglancer-layer-data-sources-source-default",
      ),
    ).toBe(loadedControls);
    expect(visibleEditor(view).getValue()).toBe(JSON.stringify(state, null, 2));
    // A change signal must also refresh an existing state object in place.
    state.source.name = "source name changed in place";
    update();
    expect(source.spec.state).toBe(state);
    expect(visibleEditor(view).getValue()).toBe(JSON.stringify(state, null, 2));
    update({ state: undefined });
    expectHiddenState(view);
  });

  it.each([
    "precomputed://https://example.com/raw",
    "inference://live/result",
    "watershed://legacy-session-result",
    `${INFERENCE_RECIPE_URL}/other`,
    `${WATERSHED_RECIPE_URL}/other`,
  ])("does not show state for non-recipe URL %s", (url) => {
    const { view } = fixture({ url });
    expectHiddenState(view);
  });

  it.each([null, {}])(
    "shows defined JSON state %j without validating it",
    (state) => {
      const { view } = fixture({ state });
      expect(visibleEditor(view).getValue()).toBe(
        JSON.stringify(state, null, 2),
      );
    },
  );

  it("starts hidden without state, then shows newly supplied recipe state", () => {
    const { view, update } = fixture({ state: undefined });
    expectHiddenState(view);
    const state = recipeState();
    update({ state });
    expect(visibleEditor(view).getValue()).toBe(JSON.stringify(state, null, 2));
  });

  it("clears stale JSON when state is removed or the URL stops being a recipe", () => {
    const { view, update } = fixture();
    visibleEditor(view);
    update({ state: undefined });
    expectHiddenState(view);
    const state = recipeState();
    state.source.name = "replacement state";
    update({ state });
    expect(visibleEditor(view).getValue()).toBe(JSON.stringify(state, null, 2));
    update({ url: "precomputed://https://example.com/other" });
    expectHiddenState(view);
    update({ url });
    expect(visibleEditor(view).getValue()).toBe(JSON.stringify(state, null, 2));
  });

  it("does not mutate or reload the source when viewing or trying to type", async () => {
    const { view, source, registry, setSpec } = fixture();
    const spec = source.spec;
    const state = spec.state;
    const snapshot = structuredClone(spec);
    const generation = source.changed.count;
    const editor = visibleEditor(view);
    editor.focus();
    await userEvent.keyboard("not an edit");
    view.updateView();
    await nextFrame();
    expect(editor.getValue()).toBe(JSON.stringify(state, null, 2));
    expect(source.spec).toBe(spec);
    expect(source.spec.state).toBe(state);
    expect(source.spec).toEqual(snapshot);
    expect(source.changed.count).toBe(generation);
    expect(setSpec).not.toHaveBeenCalled();
    expect(registry.get).not.toHaveBeenCalled();
  });

  it("updates the title and accessibility labels when changing recipe kinds", () => {
    const { view, update } = fixture();
    const editor = visibleEditor(view);
    const otherKind = kind === "Inference" ? "Watershed" : "Inference";
    const state =
      kind === "Inference" ? watershedRecipeState() : inferenceRecipeState();
    update({
      url: kind === "Inference" ? WATERSHED_RECIPE_URL : INFERENCE_RECIPE_URL,
      state,
    });
    expect(sourceStateEditor(view, otherKind)).toBe(editor);
    expect(editor.getValue()).toBe(JSON.stringify(state, null, 2));
    expect(editor.getInputField().getAttribute("aria-label")).toBe(
      `${otherKind} source state JSON`,
    );
  });

  it("refreshes when intersecting and disconnects the observer on disposal", async () => {
    const observe = vi.spyOn(IntersectionObserver.prototype, "observe");
    const disconnect = vi.spyOn(IntersectionObserver.prototype, "disconnect");
    const { view, host } = fixture();
    const editor = visibleEditor(view);
    const refresh = vi.spyOn(editor, "refresh");
    expect(observe).toHaveBeenCalled();
    const observers = observe.mock.contexts.filter((_, i) =>
      host.contains(observe.mock.calls[i][0]),
    );
    expect(observers.length).toBeGreaterThan(0);
    editor.getWrapperElement().scrollIntoView();
    await expect.poll(() => refresh.mock.calls.length).toBeGreaterThan(0);
    // Let the initial observer notifications settle before testing cleanup.
    await nextFrame();
    await nextFrame();
    view.dispose();
    expect(view.element.isConnected).toBe(false);
    for (const observer of observers) {
      expect(disconnect.mock.contexts).toContain(observer);
    }
    refresh.mockClear();
    host.appendChild(view.element);
    await nextFrame();
    await nextFrame();
    await nextFrame();
    expect(refresh).not.toHaveBeenCalled();
    view.element.remove();
  });
});

function editableWatershedFixture() {
  const recipe = parseWatershedRecipe({
    ...watershedRecipeState(),
    halo: 0,
    source: {
      name: "affinities",
      source: "precomputed://https://example.com/affinities",
    },
  });
  const apply = vi.fn();
  const state = new WatershedParametersState(recipe, apply);
  const loaded = Object.assign(Object.create(LoadedLayerDataSource.prototype), {
    dataSource: { state },
    enableDefaultSubsources: true,
    enabledSubsourcesChanged: new NullarySignal(),
    subsources: [],
    transform: { mutableSourceRank: false, value: { sourceRank: 0 } },
  }) as LoadedLayerDataSource;
  const fixture = sourceFixture({
    url: WATERSHED_RECIPE_URL,
    state: recipe,
    loadState: loaded,
  });
  return { ...fixture, state, apply, loaded };
}

describe("DataSourceView editable watershed parameters", () => {
  it("shows enabled controls alongside read-only JSON without changing the source", () => {
    const { view, source, apply, setSpec, registry } =
      editableWatershedFixture();
    const parameters = view.element.querySelector(
      ".neuroglancer-watershed-parameters",
    );
    expect(parameters).not.toBeNull();
    expect(parameters!.textContent).toContain("Watershed parameters");
    expect(
      parameters!.querySelector<HTMLInputElement>(
        '[aria-label="Size threshold"]',
      )!.disabled,
    ).toBe(false);
    for (const control of parameters!.querySelectorAll("input")) {
      expect(control.getAttribute("aria-label")).not.toMatch(
        /halo|affinity channel/i,
      );
    }
    expect(sourceStateEditor(view, "Watershed").getValue()).toBe(
      JSON.stringify(source.spec.state, null, 2),
    );
    expect(apply).not.toHaveBeenCalled();
    expect(setSpec).not.toHaveBeenCalled();
    expect(registry.get).not.toHaveBeenCalled();
  });

  it("persists valid control edits and refreshes JSON without a datasource reload", async () => {
    const { view, source, state, apply, loaded, setSpec, registry } =
      editableWatershedFixture();
    const size = view.element.querySelector<HTMLInputElement>(
      '[aria-label="Size threshold"]',
    )!;
    const editor = sourceStateEditor(view, "Watershed");
    size.value = "0";
    size.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => {
      expect(apply).toHaveBeenCalledOnce();
      expect(state.toJSON().options.sizeThreshold).toBe(0);
      expect(source.spec.state.options.sizeThreshold).toBe(0);
      expect(JSON.parse(editor.getValue()).options.sizeThreshold).toBe(0);
    });
    expect(JSON.parse(editor.getValue()).halo).toBe(0);
    expect(state.toJSON().channelsXYZ).toEqual([2, 0, 2]);
    expect(source.loadState).toBe(loaded);
    expect(sourceStateEditor(view, "Watershed")).toBe(editor);
    expect(setSpec).not.toHaveBeenCalled();
    expect(registry.get).not.toHaveBeenCalled();
  });

  it("refreshes from external state changes, then removes controls/listeners on URL changes", () => {
    const { view, source, state, update } = editableWatershedFixture();
    state.restoreState({
      ...state.toJSON(),
      halo: 3,
      options: { ...state.toJSON().options, sizeThreshold: 13 },
    });
    expect(
      view.element.querySelector<HTMLInputElement>(
        '[aria-label="Size threshold"]',
      )!.value,
    ).toBe("13");
    expect(
      JSON.parse(sourceStateEditor(view, "Watershed").getValue()).halo,
    ).toBe(3);
    update({ url: "precomputed://https://example.com/other" });
    expect(
      view.element.querySelector(".neuroglancer-watershed-parameters"),
    ).toBeNull();
    const generation = source.changed.count;
    state.restoreState({ ...state.toJSON(), halo: 4 });
    expect(source.changed.count).toBe(generation);
  });

  it("disables controls while loading and unsubscribes when the view is disposed", () => {
    const { view, source, state, update } = editableWatershedFixture();
    source.loadState = undefined;
    update();
    expect(
      view.element.querySelector<HTMLInputElement>(
        '[aria-label="Size threshold"]',
      )!.disabled,
    ).toBe(true);
    const generation = source.changed.count;
    view.dispose();
    state.restoreState({ ...state.toJSON(), halo: 5 });
    expect(source.changed.count).toBe(generation);
  });
});
