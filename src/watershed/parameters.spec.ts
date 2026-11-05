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

import { describe, expect, it, vi } from "vitest";
import { DEFAULT_WATERSHED_OPTIONS } from "#src/watershed/base.js";
import { WatershedParametersState } from "#src/watershed/parameters.js";
import type { WatershedRecipe } from "#src/watershed/recipe.js";

function fixture() {
  const recipe: WatershedRecipe = {
    version: 1,
    profile: "visible-slice-union-v1",
    mode: "live",
    source: {
      name: "affinities",
      source: "precomputed://https://example.com/affinities",
    },
    inputScaleIndex: 0,
    channelsXYZ: [0, 1, 2],
    options: { ...DEFAULT_WATERSHED_OPTIONS },
    spacingXYZ: [4e-9, 4e-9, 40e-9],
  };
  const apply = vi.fn<(recipe: WatershedRecipe) => void>();
  const state = new WatershedParametersState(recipe, apply);
  const changed = vi.fn();
  state.changed.add(changed);
  return { recipe, apply, state, changed };
}

describe("editable watershed recipe state", () => {
  it("does not compute or add defaults when read and owns detached snapshots", () => {
    const { recipe, apply, state, changed } = fixture();
    const initial = structuredClone(recipe);
    recipe.options = { ...recipe.options, dustThreshold: 100 };
    recipe.channelsXYZ[0] = 9;
    const saved = state.toJSON();
    expect(saved).toEqual(initial);
    expect(saved).not.toHaveProperty("halo");
    saved.source.name = "mutated";
    saved.channelsXYZ[0] = 8;
    expect(state.toJSON()).toEqual(initial);
    expect(apply).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });

  it("applies all algorithm settings and zero halo before publishing changed JSON", () => {
    const { state, apply, changed } = fixture();
    const recipe = state.toJSON();
    recipe.options = {
      highThreshold: 0.9,
      lowThreshold: 0.1,
      sizeThreshold: 123,
      dustThreshold: 7,
      maskThreshold: 0.3,
      aggThreshold: 0,
    };
    recipe.halo = 0;
    recipe.channelsXYZ = [2, 0, 1];
    apply.mockImplementation(() => {
      expect(changed).not.toHaveBeenCalled();
      expect(state.toJSON().options).toEqual(DEFAULT_WATERSHED_OPTIONS);
    });
    state.restoreState(recipe);
    expect(apply).toHaveBeenCalledExactlyOnceWith(recipe);
    expect(changed).toHaveBeenCalledOnce();
    expect(state.toJSON()).toEqual(recipe);
    recipe.halo = 20;
    recipe.options = { ...recipe.options, aggThreshold: 1 };
    expect(state.toJSON().halo).toBe(0);
    expect(state.toJSON().options.aggThreshold).toBe(0);
  });

  it("omits disabled optional settings and resets to the original recipe", () => {
    const { state, apply, recipe, changed } = fixture();
    state.restoreState({
      ...recipe,
      halo: 2,
      options: { ...recipe.options, aggThreshold: 0.15, maskThreshold: 0.3 },
    });
    state.restoreState({ ...recipe, halo: 0 });
    expect(state.toJSON().options).not.toHaveProperty("aggThreshold");
    expect(state.toJSON().options).not.toHaveProperty("maskThreshold");
    state.reset();
    expect(state.toJSON()).toEqual(recipe);
    expect(apply).toHaveBeenCalledTimes(3);
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it("does not reapply equivalent JSON", () => {
    const { state, apply, changed } = fixture();
    state.restoreState(JSON.parse(JSON.stringify(state.toJSON())));
    expect(apply).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });

  it.each([
    { halo: -1 },
    { halo: 0.5 },
    { halo: Number.MAX_SAFE_INTEGER + 1 },
    { halo: undefined },
    { options: { ...DEFAULT_WATERSHED_OPTIONS, lowThreshold: 1 } },
    { options: { ...DEFAULT_WATERSHED_OPTIONS, aggThreshold: NaN } },
    { channelsXYZ: [0, -1, 2] },
    { channelsXYZ: [0, 1] },
  ])(
    "rejects invalid state without touching the running producer: %j",
    (patch) => {
      const { state, apply, recipe, changed } = fixture();
      expect(() => state.restoreState({ ...recipe, ...patch })).toThrow();
      expect(state.toJSON()).toEqual(recipe);
      expect(apply).not.toHaveBeenCalled();
      expect(changed).not.toHaveBeenCalled();
    },
  );

  it.each([
    { inputScaleIndex: 1 },
    {
      source: { name: "other", source: "precomputed://https://example.com/b" },
    },
    { spacingXYZ: [8e-9, 8e-9, 40e-9] },
  ])("rejects changing prepared input geometry: %j", (patch) => {
    const { state, apply, recipe, changed } = fixture();
    expect(() => state.restoreState({ ...recipe, ...patch })).toThrow(
      /requires a new layer/,
    );
    expect(state.toJSON()).toEqual(recipe);
    expect(apply).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });

  it("preserves the recipe if producer channel validation fails", () => {
    const { state, apply, recipe, changed } = fixture();
    apply.mockImplementation(() => {
      throw new Error("Watershed needs three in-bounds affinity channels");
    });
    expect(() =>
      state.restoreState({ ...recipe, channelsXYZ: [99, 0, 0] }),
    ).toThrow(/in-bounds/);
    expect(state.toJSON()).toEqual(recipe);
    expect(changed).not.toHaveBeenCalled();
  });

  it("does not treat null as a reset", () => {
    const { state, apply } = fixture();
    expect(() => state.restoreState(null)).toThrow();
    expect(apply).not.toHaveBeenCalled();
  });
});
