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

// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { InferenceRecipe } from "#src/inference/recipe.js";
import {
  INFERENCE_RECIPE_URL,
  parseInferenceRecipe,
} from "#src/inference/recipe.js";
import {
  DEFAULT_WATERSHED_HALO,
  DEFAULT_WATERSHED_OPTIONS,
  validateWatershedChannels,
  validateWatershedOptions,
} from "#src/watershed/base.js";
import type { WatershedRecipe } from "#src/watershed/recipe.js";
import {
  parseWatershedRecipe,
  WATERSHED_RECIPE_URL,
} from "#src/watershed/recipe.js";

function recipe(): WatershedRecipe {
  return {
    version: 1,
    profile: "visible-slice-union-v1",
    mode: "live",
    source: {
      name: "affinities",
      source: "precomputed://https://example.com/aff",
    },
    inputScaleIndex: 0,
    channelsXYZ: [0, 1, 2],
    options: { ...DEFAULT_WATERSHED_OPTIONS },
    spacingXYZ: [8, 8, 40],
  };
}

function inferenceRecipe(): Extract<InferenceRecipe, { version: 2 }> {
  return {
    version: 2,
    profile: "ncdhw-centered-v2",
    mode: "live",
    source: { name: "raw", source: "zarr://https://example.com/raw" },
    model: {
      kind: "url",
      name: "affinities.onnx",
      urls: [
        "https://example.com/model.part1",
        "https://example.com/model.part2",
      ],
      size: 3,
      sha256:
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    },
    provider: "webgpu",
    precision: "float16",
    compatibilityFixes: false,
    overlap: true,
    inputScaleIndex: 2,
    spacingZYX: [40, 8, 8],
    outputSpacingZYX: [20, 4, 4],
  };
}

function parseWith(overrides: Record<string, unknown>) {
  return parseWatershedRecipe({ ...recipe(), ...overrides });
}

function parseSource(source: unknown) {
  return parseWith({ source: { name: "affinities", source } });
}

function inferenceSource(state: unknown = inferenceRecipe()) {
  return { url: INFERENCE_RECIPE_URL, state };
}

function richSources() {
  return [
    {
      url: "precomputed://gs://bucket/affinities",
      transform: {
        matrix: [[1, 0, 0, 5]],
        outputDimensions: { x: [8, "nm"] },
      },
      subsources: { default: true, meshes: false },
      enableDefaultSubsources: false,
      state: {
        shader:
          "// watershed://recipe inference://id blob: file:/// are only shader text",
        nested: [null, true, 1],
      },
      unused: undefined,
    },
    { url: "zarr://https://example.com/b", state: { name: "other" } },
  ];
}

describe("parseWatershedRecipe", () => {
  it("round-trips default options and saves policy, not current bounds or runtime state", () => {
    expect(WATERSHED_RECIPE_URL).toBe("watershed://recipe");
    const value = recipe();
    const parsed = parseWatershedRecipe(JSON.parse(JSON.stringify(value)));
    expect(parsed).toEqual(value);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(value).sort());
    expect(Object.hasOwn(parsed, "halo")).toBe(false);
    expect(parsed.halo ?? DEFAULT_WATERSHED_HALO).toBe(8);
    expect(parsed.options).not.toHaveProperty("maskThreshold");
    expect(parsed.options).not.toHaveProperty("aggThreshold");
    expect(JSON.stringify(parseWatershedRecipe(parsed))).toBe(
      JSON.stringify(parsed),
    );
  });

  it("preserves old version-1 JSON exactly without inserting halo or agglomeration defaults", () => {
    const legacy = {
      ...recipe(),
      options: {
        highThreshold: 0.99999,
        lowThreshold: 0.00005,
        sizeThreshold: 50,
        dustThreshold: 50,
      },
    };
    const saved = JSON.stringify(legacy);
    const parsed = parseWatershedRecipe(JSON.parse(saved));
    expect(() => validateWatershedOptions(parsed.options)).not.toThrow();
    expect(parsed).toStrictEqual(legacy);
    expect(Object.hasOwn(parsed, "halo")).toBe(false);
    expect(Object.hasOwn(legacy, "halo")).toBe(false);
    expect(Object.hasOwn(parsed.options, "aggThreshold")).toBe(false);
    expect(JSON.stringify(parsed)).toBe(saved);
    const restored = parseWatershedRecipe(JSON.parse(JSON.stringify(parsed)));
    expect(Object.hasOwn(restored, "halo")).toBe(false);
    expect(Object.hasOwn(restored.options, "aggThreshold")).toBe(false);
    expect(JSON.stringify(restored)).toBe(saved);
  });

  it.each([0, 1, 8, 23, Number.MAX_SAFE_INTEGER])(
    "round-trips explicit top-level halo %s with plain and nested ONNX sources and mask/agglomeration options",
    (halo) => {
      const legacy = recipe();
      const legacyJSON = JSON.stringify(legacy);
      for (const source of [legacy.source.source, inferenceSource()]) {
        for (const optionalOptions of [
          {},
          { maskThreshold: 0, aggThreshold: 0 },
          { maskThreshold: 0.3, aggThreshold: 0.15 },
        ]) {
          const input = {
            ...legacy,
            halo,
            source: { name: "affinities", source },
            options: { ...legacy.options, ...optionalOptions },
          };
          const parsed = parseWatershedRecipe(input);
          const detached = parseWatershedRecipe(
            JSON.parse(JSON.stringify(input)),
          );
          expect(parsed).toStrictEqual(input);
          expect(detached).toStrictEqual(input);
          expect(Object.hasOwn(parsed, "halo")).toBe(true);
          expect(parsed.halo).toBe(halo);
          expect(parsed.halo ?? DEFAULT_WATERSHED_HALO).toBe(halo);
          expect(parsed.options).not.toHaveProperty("halo");
          const saved = JSON.stringify(parsed);
          expect(JSON.stringify(parseWatershedRecipe(JSON.parse(saved)))).toBe(
            saved,
          );
        }
      }
      expect(JSON.stringify(legacy)).toBe(legacyJSON);
      expect(legacy).not.toHaveProperty("halo");
    },
  );

  it("detaches explicit halo, nested ONNX state, and mask/agglomeration options in both directions", () => {
    const state = inferenceRecipe();
    const input = {
      ...recipe(),
      halo: 0,
      source: { name: "affinities", source: inferenceSource(state) },
      options: {
        ...DEFAULT_WATERSHED_OPTIONS,
        maskThreshold: 0.3,
        aggThreshold: 0,
      },
    };
    const original = JSON.parse(JSON.stringify(input));
    const parsed = parseWatershedRecipe(input);
    const second = parseWatershedRecipe(input);
    input.halo = 23;
    input.options.maskThreshold = 1;
    input.options.aggThreshold = 1;
    state.precision = "float32";
    expect(parsed).toStrictEqual(original);
    parsed.halo = 8;
    Object.assign(parsed.options, { maskThreshold: 0, aggThreshold: 0.15 });
    const outputSource = parsed.source.source as { state: typeof state };
    outputSource.state.precision = "float16";
    outputSource.state.spacingZYX[0] = 999;
    expect(input.halo).toBe(23);
    expect(input.options.maskThreshold).toBe(1);
    expect(input.options.aggThreshold).toBe(1);
    expect(state.precision).toBe("float32");
    expect(state.spacingZYX).toEqual([40, 8, 8]);
    expect(second).toStrictEqual(original);
  });

  it.each(
    [
      undefined,
      null,
      "0",
      "8",
      true,
      false,
      -1,
      -0.5,
      0.5,
      NaN,
      Infinity,
      -Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      1n,
      [],
      [8, 8, 8],
      {},
      new Number(8),
    ].map((halo) => [halo]),
  )(
    "rejects invalid or explicitly undefined top-level halo %s visibly",
    (halo) => {
      expect(() => parseWith({ halo })).toThrow(/halo/i);
    },
  );

  it.each(
    [
      null,
      "0",
      "8",
      true,
      false,
      -1,
      -0.5,
      0.5,
      2 ** 53,
      [],
      [8, 8, 8],
      {},
    ].map((halo) => [halo]),
  )("rejects invalid halo %j in detached saved JSON", (halo) => {
    const input = JSON.parse(JSON.stringify({ ...recipe(), halo }));
    expect(() => parseWatershedRecipe(input)).toThrow(/halo/i);
  });

  it.each([0, 23])(
    "keeps full recipe/source/options field validation strict with halo %s",
    (halo) => {
      expect(() => parseWith({ halo, haloXYZ: [8, 8, 8] })).toThrow(
        /haloXYZ: expected a supported field/,
      );
      expect(() => parseWith({ halo, haloZYX: [8, 8, 8] })).toThrow(
        /haloZYX: expected a supported field/,
      );
      expect(() => parseWith({ halo, typo: undefined })).toThrow(
        /typo: expected a supported field/,
      );
      expect(() =>
        parseWith({ halo, source: { ...recipe().source, halo } }),
      ).toThrow(/source\.halo: expected a supported field/);
      expect(() =>
        parseWith({ halo, options: { ...DEFAULT_WATERSHED_OPTIONS, halo } }),
      ).toThrow(/options\.halo: expected a supported field/);
    },
  );

  it.each([0, 0.15, 1])(
    "preserves optional agglomeration threshold %s in saved JSON with and without masking",
    (aggThreshold) => {
      for (const maskOptions of [
        {},
        { maskThreshold: 0 },
        { maskThreshold: 0.3 },
        { maskThreshold: 1 },
      ]) {
        const value = {
          ...recipe(),
          options: {
            ...DEFAULT_WATERSHED_OPTIONS,
            ...maskOptions,
            aggThreshold,
          },
        };
        const saved = JSON.stringify(value);
        const parsed = parseWatershedRecipe(JSON.parse(saved));
        expect(() => validateWatershedOptions(parsed.options)).not.toThrow();
        expect(parsed).toStrictEqual(value);
        expect(Object.hasOwn(parsed.options, "aggThreshold")).toBe(true);
        expect(parsed.options.aggThreshold).toBe(aggThreshold);
        expect(JSON.stringify(parsed)).toBe(saved);
        expect(JSON.stringify(parseWatershedRecipe(parsed))).toBe(saved);
      }
    },
  );

  it("detaches agglomeration and mask options in both directions and across parses", () => {
    const input = {
      ...recipe(),
      options: {
        ...DEFAULT_WATERSHED_OPTIONS,
        maskThreshold: 0.3,
        aggThreshold: 0.15,
      },
    };
    const saved = JSON.stringify(input);
    const parsed = parseWatershedRecipe(input);
    const second = parseWatershedRecipe(input);
    input.options.aggThreshold = 0;
    input.options.maskThreshold = 1;
    expect(JSON.stringify(parsed)).toBe(saved);
    Object.assign(parsed.options, { aggThreshold: 1, maskThreshold: 0 });
    expect(input.options.aggThreshold).toBe(0);
    expect(input.options.maskThreshold).toBe(1);
    expect(JSON.stringify(second)).toBe(saved);
  });

  it.each(
    [undefined, null, "0", "0.15", true, false, NaN, Infinity, -Infinity].map(
      (value) => [value],
    ),
  )(
    "rejects a present nonfinite/nonnumeric agglomeration threshold %j visibly",
    (aggThreshold) => {
      expect(() =>
        parseWith({ options: { ...DEFAULT_WATERSHED_OPTIONS, aggThreshold } }),
      ).toThrow(/options\.aggThreshold: expected a finite number/);
    },
  );

  it.each([-0.01, 1.01])(
    "rejects out-of-range agglomeration threshold %s through base validation",
    (aggThreshold) => {
      expect(() =>
        parseWith({ options: { ...DEFAULT_WATERSHED_OPTIONS, aggThreshold } }),
      ).toThrow(/agglomeration/i);
    },
  );

  it.each(["agg_threshold", "agglomerationThreshold"])(
    "still rejects unsupported agglomeration option spelling %s",
    (key) => {
      expect(() =>
        parseWith({ options: { ...DEFAULT_WATERSHED_OPTIONS, [key]: 0.15 } }),
      ).toThrow(`options.${key}: expected a supported field`);
    },
  );

  it("round-trips repeated channels, non-default parameters, and optional mask endpoints", () => {
    for (const maskThreshold of [0, 0.3, 1]) {
      const value: WatershedRecipe = {
        ...recipe(),
        channelsXYZ: [0, 0, 0],
        inputScaleIndex: 3,
        spacingXYZ: [0.5, 1.5, 2],
        options: {
          highThreshold: 1,
          lowThreshold: 0,
          sizeThreshold: 0,
          dustThreshold: 0xffffffff,
          maskThreshold,
        },
      };
      expect(parseWatershedRecipe(JSON.parse(JSON.stringify(value)))).toEqual(
        value,
      );
    }
    expect(parseWith({ channelsXYZ: [0, 0, 0] }).channelsXYZ).toEqual([
      0, 0, 0,
    ]);
  });

  it("defers channel-count, mask-channel, and scale-count bounds to native input preparation", () => {
    const parsed = parseWith({
      channelsXYZ: [Number.MAX_SAFE_INTEGER, 3, 3],
      inputScaleIndex: Number.MAX_SAFE_INTEGER,
      options: { ...DEFAULT_WATERSHED_OPTIONS, maskThreshold: 0.3 },
    });
    expect(parsed.channelsXYZ).toEqual([Number.MAX_SAFE_INTEGER, 3, 3]);
    expect(parsed.inputScaleIndex).toBe(Number.MAX_SAFE_INTEGER);
    expect(() =>
      validateWatershedChannels(4, parsed.channelsXYZ, parsed.options),
    ).toThrow();
    const maskChannel = parseWith({
      channelsXYZ: [0, 1, 3],
      options: { ...DEFAULT_WATERSHED_OPTIONS, maskThreshold: 0.3 },
    });
    expect(() =>
      validateWatershedChannels(
        4,
        maskChannel.channelsXYZ,
        maskChannel.options,
      ),
    ).toThrow("mask, not an affinity");
  });

  it("snapshots string, single-spec, and mixed-array sources with transforms/subsources/state", () => {
    const sources = richSources();
    for (const source of [
      "https://example.com/affinities",
      sources[0],
      ["zarr://https://example.com/a", ...sources],
    ]) {
      const parsed = parseSource(source);
      expect(parsed.source.source).toEqual(JSON.parse(JSON.stringify(source)));
      expect(parseWatershedRecipe(JSON.parse(JSON.stringify(parsed)))).toEqual(
        parsed,
      );
    }
    expect(
      (parseSource(sources).source.source as typeof sources)[0],
    ).not.toHaveProperty("unused");
  });

  it("isolates mutations in both directions and across repeated parses", () => {
    const sources = richSources();
    const input = {
      ...recipe(),
      source: { name: "affinities", source: sources },
    };
    const original = JSON.parse(JSON.stringify(input));
    const parsed = parseWatershedRecipe(input);
    const second = parseWatershedRecipe(input);
    expect(parsed).not.toBe(input);
    expect(parsed.source).not.toBe(input.source);
    expect(parsed.options).not.toBe(input.options);
    expect(parsed.channelsXYZ).not.toBe(input.channelsXYZ);
    expect(parsed.spacingXYZ).not.toBe(input.spacingXYZ);
    expect(parsed.source.source).not.toBe(input.source.source);
    input.source.name = "changed";
    sources[0].transform!.matrix[0][3] = 999;
    sources[0].subsources!.default = false;
    input.channelsXYZ[0] = 9;
    input.spacingXYZ[0] = 99;
    input.options = { ...input.options, lowThreshold: 0.2 };
    expect(parsed).toEqual(original);
    const outputSources = parsed.source.source as typeof sources;
    outputSources[0].transform!.matrix[0][3] = -5;
    outputSources[0].state!.nested!.push(2);
    parsed.channelsXYZ[1] = 5;
    parsed.spacingXYZ[1] = 5;
    Object.assign(parsed.options, { dustThreshold: 0 });
    expect(input.options.dustThreshold).toBe(
      DEFAULT_WATERSHED_OPTIONS.dustThreshold,
    );
    expect(sources[0].transform!.matrix[0][3]).toBe(999);
    expect(sources[0].state!.nested).toEqual([null, true, 1]);
    expect(input.channelsXYZ[1]).toBe(1);
    expect(input.spacingXYZ[1]).toBe(8);
    expect(second).toEqual(original);
  });

  it("round-trips upstream ONNX recipe state, model hash/precision, and source-spec metadata", () => {
    const { outputSpacingZYX: _outputSpacing, ...common } = inferenceRecipe();
    const legacy: InferenceRecipe = {
      ...common,
      version: 1,
      profile: "nooverseg-ncdhw-native-grid-v1",
    };
    for (const state of [inferenceRecipe(), legacy]) {
      expect(state).toEqual(parseInferenceRecipe(state));
      const source = { ...richSources()[0], ...inferenceSource(state) };
      const parsed = parseSource(source);
      expect(parsed.source.source).toEqual(JSON.parse(JSON.stringify(source)));
      expect(parseWatershedRecipe(JSON.parse(JSON.stringify(parsed)))).toEqual(
        parsed,
      );
      expect(
        parseSource(["zarr://https://example.com/a", source]).source.source,
      ).toEqual([
        "zarr://https://example.com/a",
        JSON.parse(JSON.stringify(source)),
      ]);
      if (state.model.kind === "url")
        state.model.urls[0] = "https://example.com/changed";
      state.spacingZYX[0] = 999;
      expect(parsed.source.source).toMatchObject({
        state: {
          precision: "float16",
          spacingZYX: [40, 8, 8],
          model: {
            urls: [
              "https://example.com/model.part1",
              "https://example.com/model.part2",
            ],
          },
        },
      });
    }
  });

  it.each([0, 0.15, 1])(
    "preserves nested ONNX recipe JSON and validation with agglomeration threshold %s",
    (aggThreshold) => {
      const state = inferenceRecipe();
      const source = {
        ...richSources()[0],
        ...inferenceSource(state),
      };
      const input = {
        ...recipe(),
        source: { name: "affinities", source: [source] },
        options: {
          ...DEFAULT_WATERSHED_OPTIONS,
          maskThreshold: 0.3,
          aggThreshold,
        },
      };
      const saved = JSON.parse(JSON.stringify(input));
      const parsed = parseWatershedRecipe(input);
      expect(JSON.parse(JSON.stringify(parsed))).toStrictEqual(saved);
      expect(parsed.options.aggThreshold).toBe(aggThreshold);
      state.precision = "float32";
      expect(JSON.parse(JSON.stringify(parsed))).toStrictEqual(saved);
      expect(
        parseWatershedRecipe(JSON.parse(JSON.stringify(parsed))),
      ).toStrictEqual(parsed);
      expect(() =>
        parseWatershedRecipe({
          ...input,
          source: {
            name: "affinities",
            source: inferenceSource({
              ...inferenceRecipe(),
              precision: "fp16",
            }),
          },
        }),
      ).toThrow(
        /Invalid watershed recipe .*state: Error: Invalid inference recipe/,
      );
      expect(() =>
        parseWatershedRecipe({
          ...input,
          source: {
            name: "affinities",
            source: inferenceSource({
              ...inferenceRecipe(),
              source: { name: "raw", source: inferenceSource() },
            }),
          },
        }),
      ).toThrow(/recursive inference/);
      expect(() =>
        parseWatershedRecipe({
          ...input,
          source: {
            name: "affinities",
            source: inferenceSource({
              ...inferenceRecipe(),
              source: { name: "raw", source: "watershed://recipe" },
            }),
          },
        }),
      ).toThrow(/recursive watershed/);
    },
  );

  it("preserves a local-model inference descriptor without pretending it has a hosted URL", () => {
    const local = { kind: "local", name: "local.onnx", size: 3 } as const;
    const source = inferenceSource({ ...inferenceRecipe(), model: local });
    const parsed = parseSource(source);
    expect(parsed.source.source).toEqual(source);
    expect(parsed.source.source).toMatchObject({ state: { model: local } });
    expect(parseWatershedRecipe(JSON.parse(JSON.stringify(parsed)))).toEqual(
      parsed,
    );
  });

  it.each([
    { model: { ...inferenceRecipe().model, sha256: "bad" } },
    {
      model: {
        ...inferenceRecipe().model,
        urls: ["blob:https://example.com/id"],
      },
    },
    { precision: "fp16" },
    { precision: undefined },
    { provider: "wasm" },
    { roi: {} },
    { inputScaleIndex: -1 },
    { profile: "other" },
  ])(
    "validates nested inference state through parseInferenceRecipe: %j",
    (overrides) => {
      expect(() =>
        parseSource(inferenceSource({ ...inferenceRecipe(), ...overrides })),
      ).toThrow(
        /Invalid watershed recipe .*state: Error: Invalid inference recipe/,
      );
    },
  );

  it.each(
    [null, undefined, {}, { model: "model.onnx" }].map((state) => [state]),
  )("requires saved inference state: %j", (state) => {
    expect(() => parseSource({ url: INFERENCE_RECIPE_URL, state })).toThrow(
      /state/,
    );
  });

  it.each([
    "watershed://recipe",
    "WATERSHED://session-id",
    "zarr://watershed://recipe",
    "https://example.com/raw|watershed://recipe",
  ])("rejects recursive watershed URL %s", (url) => {
    for (const source of [url, { url }, ["https://example.com/a", { url }]]) {
      expect(() => parseSource(source)).toThrow(/recursive watershed/);
    }
  });

  it.each([
    "inference://session-id",
    "INFERENCE://recipe",
    "inference://recipe/other",
    "inference://recipe?state=unsaved",
    "zarr://inference://recipe",
    "https://example.com/raw|inference://recipe",
  ])(
    "rejects session/wrapped inference URL %s with restoration guidance",
    (url) => {
      expect(() => parseSource({ url, state: inferenceRecipe() })).toThrow(
        /save the upstream inference recipe/,
      );
    },
  );

  it("does not accept a bare inference recipe URL without its state", () => {
    expect(() => parseSource(INFERENCE_RECIPE_URL)).toThrow(
      /source object with saved recipe state/,
    );
  });

  it.each([
    "blob:https://example.com/session",
    "file:///tmp/affinities",
    "zarr://file:///tmp/affinities",
    "precomputed://blob:https://example.com/session",
  ])("rejects ephemeral data URL %s with hosting guidance", (url) => {
    expect(() => parseSource({ url })).toThrow(
      /ephemeral blob\/file source; host the data/,
    );
  });

  it("inspects nested URL/source fields including upstream inputs, but not shader text", () => {
    for (const url of [
      "watershed://recipe",
      "inference://session",
      "file:///tmp/raw",
      "blob:https://example.com/id",
    ]) {
      for (const nested of [
        { url },
        { source: [url] },
        { sources: [{ url }] },
      ]) {
        expect(() =>
          parseSource({ url: "https://example.com/raw", state: { nested } }),
        ).toThrow();
      }
      expect(() =>
        parseSource(
          inferenceSource({
            ...inferenceRecipe(),
            source: { name: "raw", source: { url } },
          }),
        ),
      ).toThrow();
    }
    expect(() =>
      parseSource(
        inferenceSource({
          ...inferenceRecipe(),
          source: { name: "raw", source: inferenceSource() },
        }),
      ),
    ).toThrow(/recursive inference/);
    expect(() => parseSource(richSources())).not.toThrow();
  });

  it.each([
    { version: 2 },
    { version: "1" },
    { profile: "other" },
    { mode: "roi" },
    { roi: { lowerXYZ: [0, 0, 0], shapeXYZ: [1, 1, 1] } },
    { bounds: [] },
    { sessionId: "ephemeral" },
    { haloXYZ: [8, 8, 8] },
    { debounceMs: 150 },
    { preprocessing: {} },
    { typo: undefined },
    { source: { name: " ", source: "https://example.com" } },
    { source: { name: "raw", source: "https://example.com", typo: undefined } },
    { options: { ...DEFAULT_WATERSHED_OPTIONS, typo: undefined } },
  ])("rejects unsupported or malformed recipe fields: %j", (overrides) => {
    expect(() => parseWith(overrides)).toThrow(/Invalid watershed recipe/);
  });

  it("requires all agreed fields and options rather than silently inserting defaults", () => {
    const value = recipe();
    for (const key of Object.keys(value)) {
      const missing: Record<string, unknown> = { ...value };
      delete missing[key];
      expect(() => parseWatershedRecipe(missing)).toThrow();
    }
    for (const key of Object.keys(DEFAULT_WATERSHED_OPTIONS)) {
      const options: Record<string, unknown> = { ...DEFAULT_WATERSHED_OPTIONS };
      delete options[key];
      expect(() => parseWith({ options })).toThrow();
    }
  });

  it.each(
    [
      undefined,
      null,
      true,
      "0",
      -1,
      0.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ].map((value) => [value]),
  )("rejects invalid inputScaleIndex and channel coordinates %j", (value) => {
    expect(() => parseWith({ inputScaleIndex: value })).toThrow(
      /inputScaleIndex/,
    );
    expect(() => parseWith({ channelsXYZ: [0, value, 0] })).toThrow();
  });

  it.each(
    [undefined, null, "1", false, 0, -1, NaN, Infinity, -Infinity].map(
      (value) => [value],
    ),
  )("rejects nonpositive/nonfinite spacing coordinate %j", (value) => {
    expect(() => parseWith({ spacingXYZ: [1, value, 1] })).toThrow();
  });

  it.each([[], [1, 2], [1, 2, 3, 4], {}, null].map((value) => [value]))(
    "rejects malformed triples %j",
    (value) => {
      expect(() => parseWith({ channelsXYZ: value })).toThrow(/channelsXYZ/);
      expect(() => parseWith({ spacingXYZ: value })).toThrow(/spacingXYZ/);
    },
  );

  it.each([
    { highThreshold: 0 },
    { highThreshold: 1.01 },
    { highThreshold: NaN },
    { highThreshold: "1" },
    { lowThreshold: -0.01 },
    { lowThreshold: Infinity },
    { lowThreshold: 0.99999 },
    { lowThreshold: 0.9999899999 },
    { sizeThreshold: -1 },
    { sizeThreshold: 0.5 },
    { sizeThreshold: 2 ** 32 },
    { dustThreshold: NaN },
    { dustThreshold: 2 ** 32 },
    { dustThreshold: "50" },
    { maskThreshold: undefined },
    { maskThreshold: null },
    { maskThreshold: "0.3" },
    { maskThreshold: NaN },
    { maskThreshold: Infinity },
    { maskThreshold: -0.01 },
    { maskThreshold: 1.01 },
  ])(
    "uses base option validation, including float32 threshold collapse and masks: %j",
    (options) => {
      expect(() =>
        parseWith({ options: { ...DEFAULT_WATERSHED_OPTIONS, ...options } }),
      ).toThrow();
    },
  );

  it.each(
    [
      "",
      "not a URL",
      "https://",
      "https:///",
      [],
      {},
      { url: 1 },
      ["https://example.com", {}],
      [["https://example.com"]],
    ].map((source) => [source]),
  )("rejects malformed source specs %j", (source) => {
    expect(() => parseSource(source)).toThrow(/source/);
  });

  it.each(
    [null, undefined, [], "recipe", 1, new Date()].map((value) => [value]),
  )("rejects non-object recipes %j", (value) => {
    expect(() => parseWatershedRecipe(value)).toThrow(
      /Invalid watershed recipe/,
    );
  });

  it("rejects runtime objects, non-JSON values, and cycles without retaining/invoking them", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const arrayCycle: unknown[] = [];
    arrayCycle.push(arrayCycle);
    const toJSON = vi.fn(() => ({ portable: true }));
    for (const state of [
      new Map(),
      new Date(),
      new Float32Array(3),
      new Number(1),
      () => {},
      1n,
      Symbol("runtime"),
      NaN,
      Infinity,
      cycle,
      arrayCycle,
      [undefined],
      { toJSON },
      Object.create({ inherited: true }),
      { [Symbol("hidden")]: "value" },
    ]) {
      expect(() =>
        parseSource({ url: "https://example.com/raw", state }),
      ).toThrow(/Invalid watershed recipe/);
    }
    expect(toJSON).not.toHaveBeenCalled();
  });

  it("rejects sparse arrays everywhere, extra array properties, and custom iterators", () => {
    const sparse = new Array<number>(3);
    sparse[0] = sparse[2] = 1;
    expect(() => parseWith({ channelsXYZ: sparse })).toThrow(
      /dense JSON array/,
    );
    expect(() => parseWith({ spacingXYZ: sparse })).toThrow(/dense JSON array/);
    expect(() => parseSource(sparse)).toThrow(/dense JSON array/);
    expect(() =>
      parseSource({ url: "https://example.com", state: sparse }),
    ).toThrow(/dense JSON array/);
    expect(() =>
      parseSource(
        inferenceSource({
          ...inferenceRecipe(),
          model: { ...inferenceRecipe().model, urls: sparse },
        }),
      ),
    ).toThrow(/dense JSON array/);
    const iterator = vi.fn();
    const custom = Object.assign([1, 2, 3], { [Symbol.iterator]: iterator });
    expect(() => parseWith({ channelsXYZ: custom })).toThrow(
      /dense JSON array/,
    );
    expect(iterator).not.toHaveBeenCalled();
    const extra = Object.assign([1, 2, 3], { typo: true });
    expect(() => parseWith({ spacingXYZ: extra })).toThrow(/dense JSON array/);
  });

  it("rejects accessors at the root, options, triples, source specs, and nested model state without invoking them", () => {
    const getter = vi.fn(() => 1);
    for (const enumerable of [false, true]) {
      const accessor = (value: object, key: string) =>
        Object.defineProperty(value, key, {
          get: getter,
          enumerable,
          configurable: true,
        });
      const nested = inferenceRecipe();
      accessor(nested.model, "sha256");
      for (const value of [
        accessor(recipe(), "version"),
        accessor(recipe(), "halo"),
        { ...recipe(), source: accessor({ ...recipe().source }, "source") },
        {
          ...recipe(),
          options: accessor({ ...DEFAULT_WATERSHED_OPTIONS }, "highThreshold"),
        },
        {
          ...recipe(),
          options: accessor({ ...DEFAULT_WATERSHED_OPTIONS }, "aggThreshold"),
        },
        { ...recipe(), channelsXYZ: accessor([0, 1, 2], "1") },
        { ...recipe(), spacingXYZ: accessor([1, 1, 1], "0") },
        {
          ...recipe(),
          source: {
            name: "raw",
            source: accessor({ url: "https://example.com" }, "url"),
          },
        },
        {
          ...recipe(),
          source: { name: "raw", source: inferenceSource(nested) },
        },
        {
          ...recipe(),
          source: {
            name: "raw",
            source: {
              url: "https://example.com",
              state: accessor({}, "value"),
            },
          },
        },
      ])
        expect(() => parseWatershedRecipe(value)).toThrow(/not an accessor/);
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it("allows plain null-prototype JSON and snapshots shared noncyclic objects independently", () => {
    const shared = Object.assign(Object.create(null), { value: 1 });
    const source = {
      url: "https://example.com",
      state: { a: shared, b: shared },
    };
    const parsed = parseSource(source).source.source as typeof source;
    expect(parsed.state).toEqual({ a: { value: 1 }, b: { value: 1 } });
    expect(parsed.state.a).not.toBe(parsed.state.b);
    expect(parsed.state.a).not.toBe(shared);
  });
});
