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
import type { ModelMetadata } from "#src/inference/model.js";
import {
  INPUT_SHAPE,
  MAX_MODEL_BYTES,
  OUTPUT_SHAPE,
} from "#src/inference/model.js";
import type { InferenceRecipe } from "#src/inference/recipe.js";
import {
  fetchInferenceModel,
  getInferenceRecipeGeometry,
  INFERENCE_RECIPE_URL,
  parseInferenceRecipe,
  validateInferenceModelUrl,
} from "#src/inference/recipe.js";

// SHA-256 of the original bytes "abc", not of a URL or a prepared model.
const model: Extract<InferenceRecipe["model"], { kind: "url" }> = {
  kind: "url",
  name: "test.onnx",
  urls: ["https://example.com/model"],
  size: 3,
  sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
};

function recipe(): InferenceRecipe {
  return {
    version: 1,
    profile: "nooverseg-ncdhw-native-grid-v1",
    source: { name: "raw", source: "precomputed://https://example.com/raw" },
    model: { ...model, urls: [...model.urls] },
    provider: "auto",
    mode: "live",
    spacingZYX: [40, 8, 8],
  };
}

function dynamicRecipe(): Extract<InferenceRecipe, { version: 2 }> {
  return {
    ...recipe(),
    version: 2,
    profile: "ncdhw-centered-v2",
    outputSpacingZYX: [20, 4, 4],
  };
}

function metadata(overrides: Partial<ModelMetadata> = {}): ModelMetadata {
  return {
    inputNames: ["input"],
    outputNames: ["output"],
    inputShape: INPUT_SHAPE,
    outputShape: OUTPUT_SHAPE,
    requestedProvider: "cpu",
    actualProvider: "wasm",
    initMs: 0,
    threads: 1,
    ...overrides,
  };
}

function parseWith(overrides: Record<string, unknown>) {
  return parseInferenceRecipe({ ...recipe(), ...overrides });
}

function mockFetch(response: () => Response | Promise<Response>) {
  return vi.fn<typeof fetch>(async () => response());
}

function streamResponse(chunks: string[], cancel = vi.fn()) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks)
          controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
      cancel,
    }),
  );
}

const signal = () => new AbortController().signal;

describe("parseInferenceRecipe", () => {
  it("round-trips live-only URL JSON and native grid settings without preprocessing", () => {
    expect(INFERENCE_RECIPE_URL).toBe("inference://recipe");
    for (const value of [recipe(), dynamicRecipe()]) {
      expect(parseInferenceRecipe(JSON.parse(JSON.stringify(value)))).toEqual(
        value,
      );
    }
  });

  it.each([recipe, dynamicRecipe])(
    "round-trips absent, disabled and enabled compatibility policies without changing old recipes (%#)",
    (makeRecipe) => {
      const original = makeRecipe();
      const before = JSON.stringify(original);
      const legacy = parseInferenceRecipe(original);
      expect(legacy).not.toHaveProperty("compatibilityFixes");
      expect(legacy).toEqual(JSON.parse(before));
      for (const compatibilityFixes of [false, true]) {
        const value = { ...original, compatibilityFixes };
        expect(parseInferenceRecipe(JSON.parse(JSON.stringify(value)))).toEqual(
          value,
        );
        expect(parseInferenceRecipe(value).compatibilityFixes).toBe(
          compatibilityFixes,
        );
      }
      expect(JSON.stringify(original)).toBe(before);
    },
  );

  it.each([recipe, dynamicRecipe])(
    "round-trips explicit precision and preserves the legacy FP32 default by omission (%#)",
    (makeRecipe) => {
      const original = makeRecipe();
      const before = JSON.stringify(original);
      const legacy = parseInferenceRecipe(JSON.parse(before));
      expect(legacy).not.toHaveProperty("precision");
      expect(legacy).toEqual(JSON.parse(before));
      expect(JSON.stringify(parseInferenceRecipe(legacy))).toBe(
        JSON.stringify(legacy),
      );
      for (const precision of ["float32", "float16"] as const) {
        const value = { ...original, precision };
        const saved = JSON.stringify(value);
        expect(parseInferenceRecipe(JSON.parse(saved))).toEqual(value);
        expect(saved).not.toBe(before);
      }
      expect(JSON.stringify(original)).toBe(before);
    },
  );

  it.each([
    undefined,
    null,
    0,
    1,
    true,
    false,
    "fp16",
    "FLOAT16",
    "float64",
    "",
    [],
    {},
    new String("float16"),
  ])("rejects a present invalid precision: %j", (precision) => {
    for (const value of [recipe(), dynamicRecipe()]) {
      expect(() => parseInferenceRecipe({ ...value, precision })).toThrow(
        'Invalid inference recipe precision: expected "float32" or "float16"',
      );
    }
  });

  it.each([undefined, null, 0, 1, "true", "false", [], {}])(
    "rejects a present nonboolean compatibility flag: %j",
    (compatibilityFixes) => {
      for (const value of [recipe(), dynamicRecipe()]) {
        expect(() =>
          parseInferenceRecipe({ ...value, compatibilityFixes }),
        ).toThrow(
          "Invalid inference recipe compatibilityFixes: expected a boolean",
        );
      }
    },
  );

  it.each([recipe, dynamicRecipe])(
    "round-trips overlap without inserting a default into legacy JSON (%#)",
    (makeRecipe) => {
      const original = makeRecipe();
      const legacy = parseInferenceRecipe(original);
      expect(legacy).not.toHaveProperty("overlap");
      expect(legacy).toEqual(original);
      expect(JSON.stringify(parseInferenceRecipe(legacy))).toBe(
        JSON.stringify(legacy),
      );
      for (const overlap of [false, true]) {
        const value = { ...structuredClone(original), overlap };
        const parsed = parseInferenceRecipe(value);
        const saved = JSON.stringify(parsed);
        expect(JSON.parse(saved).overlap).toBe(overlap);
        expect(parseInferenceRecipe(JSON.parse(saved))).toEqual(value);
        expect(saved).not.toBe(JSON.stringify(legacy));
        expect(saved).not.toBe(
          JSON.stringify(
            parseInferenceRecipe({ ...original, overlap: !overlap }),
          ),
        );
        parsed.overlap = !overlap;
        expect(value.overlap).toBe(overlap);
        parsed.overlap = overlap;
        value.overlap = !overlap;
        value.spacingZYX[0] = 999;
        expect(parsed.overlap).toBe(overlap);
        expect(parsed.spacingZYX[0]).not.toBe(999);
        expect(JSON.parse(saved).overlap).toBe(overlap);
      }
    },
  );

  it.each([undefined, null, 0, 1, "true", "false", [], {}, new Boolean(false)])(
    "rejects a present nonboolean overlap flag: %j",
    (overlap) => {
      for (const value of [recipe(), dynamicRecipe()]) {
        expect(() => parseInferenceRecipe({ ...value, overlap })).toThrow(
          "Invalid inference recipe overlap: expected a boolean",
        );
      }
    },
  );

  it.each([recipe, dynamicRecipe])(
    "round-trips input scale indices without inserting a default into legacy JSON (%#)",
    (makeRecipe) => {
      const original = makeRecipe();
      const before = JSON.stringify(original);
      const legacy = parseInferenceRecipe(JSON.parse(before));
      expect(legacy).not.toHaveProperty("inputScaleIndex");
      expect(legacy).toEqual(original);
      for (const inputScaleIndex of [0, 2, Number.MAX_SAFE_INTEGER]) {
        const value = { ...original, inputScaleIndex };
        const parsed = parseInferenceRecipe(JSON.parse(JSON.stringify(value)));
        expect(parsed).toEqual(value);
        expect(
          parseInferenceRecipe(JSON.parse(JSON.stringify(parsed))),
        ).toEqual(value);
      }
      expect(JSON.stringify(original)).toBe(before);
    },
  );

  it.each([
    undefined,
    null,
    true,
    false,
    "0",
    "2",
    [],
    {},
    new Number(2),
    -1,
    0.5,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects a present invalid input scale index: %j", (inputScaleIndex) => {
    for (const value of [recipe(), dynamicRecipe()]) {
      expect(() => parseInferenceRecipe({ ...value, inputScaleIndex })).toThrow(
        "Invalid inference recipe inputScaleIndex: expected a nonnegative safe integer",
      );
    }
  });

  it("snapshots v2 output spacing without adding inferred geometry to URL state", () => {
    const value = dynamicRecipe();
    const parsed = parseInferenceRecipe(value);
    expect(parsed).toEqual(value);
    value.outputSpacingZYX[0] = 999;
    expect(parsed).toMatchObject({ outputSpacingZYX: [20, 4, 4] });
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(value).sort());
  });

  it.each([
    { version: 3 },
    { version: "2" },
    { profile: "nooverseg-ncdhw-native-grid-v1" },
    { profile: "ncdhw-centered-v3" },
    { outputSpacingZYX: undefined },
    { outputSpacingZYX: null },
    { outputSpacingZYX: [1, 2] },
    { outputSpacingZYX: [1, 2, 3, 4] },
    { outputSpacingZYX: [0, 1, 1] },
    { outputSpacingZYX: [-1, 1, 1] },
    { outputSpacingZYX: [NaN, 1, 1] },
    { outputSpacingZYX: [Infinity, 1, 1] },
    { outputSpacingZYX: ["1", 1, 1] },
    { inputShape: [20, 80, 80] },
    { geometry: {} },
  ])("rejects unsupported v2 policy fields: %j", (overrides) => {
    expect(() =>
      parseInferenceRecipe({ ...dynamicRecipe(), ...overrides }),
    ).toThrow(/Invalid inference recipe/);
  });

  it("requires v2 output spacing and forbids it in v1 even if undefined", () => {
    const missing: Partial<Extract<InferenceRecipe, { version: 2 }>> =
      dynamicRecipe();
    delete missing.outputSpacingZYX;
    expect(() => parseInferenceRecipe(missing)).toThrow(/outputSpacingZYX/);
    for (const outputSpacingZYX of [undefined, [40, 8, 8]]) {
      expect(() => parseWith({ outputSpacingZYX })).toThrow(/outputSpacingZYX/);
    }
    expect(() => parseWith({ profile: "ncdhw-centered-v2" })).toThrow(
      /profile/,
    );
    expect(
      parseInferenceRecipe({
        ...dynamicRecipe(),
        outputSpacingZYX: [0.5, 1.5, 2],
      }),
    ).toMatchObject({ outputSpacingZYX: [0.5, 1.5, 2] });
  });

  it("preserves and detaches multi-source transforms, subsources, and state", () => {
    const sources = [
      "zarr://https://example.com/a",
      {
        url: "precomputed://gs://bucket/b",
        transform: {
          matrix: [[1, 0, 0, 5]],
          outputDimensions: { x: [8, "nm"] },
        },
        subsources: { default: true, meshes: false },
        enableDefaultSubsources: false,
        state: {
          shader: "// inference://recipe is just shader text",
          nested: [null, true, 1],
        },
        unused: undefined,
      },
    ];
    const input = { ...recipe(), source: { name: "raw", source: sources } };
    const parsed = parseInferenceRecipe(input);
    expect(parsed.source.source).toEqual(JSON.parse(JSON.stringify(sources)));
    expect(parseInferenceRecipe(JSON.parse(JSON.stringify(parsed)))).toEqual(
      parsed,
    );
    const objectSource = sources[1];
    if (typeof objectSource !== "string") {
      objectSource.transform.matrix[0][3] = 99;
      objectSource.subsources.default = false;
    }
    expect(parsed.source.source).toMatchObject([
      sources[0],
      { transform: { matrix: [[1, 0, 0, 5]] }, subsources: { default: true } },
    ]);
    sources[1] = "https://example.com/changed";
    input.spacingZYX[0] = 99;
    if (input.model.kind === "url")
      input.model.urls[0] = "https://example.com/changed";
    expect(parsed.source.source).not.toEqual(sources);
    expect(parsed.spacingZYX).toEqual([40, 8, 8]);
    expect(parsed.model).toEqual(model);
  });

  it("supports a single source object and a local model descriptor without a session ID", () => {
    const local = { kind: "local", name: "local.onnx", size: MAX_MODEL_BYTES };
    expect(
      parseWith({
        model: local,
        source: { name: "raw", source: { url: "https://example.com/raw" } },
      }).model,
    ).toEqual(local);
    for (const provider of ["auto", "cpu", "webgpu"]) {
      expect(parseWith({ provider }).provider).toBe(provider);
    }
  });

  it.each([
    { version: 2 },
    { version: "1" },
    { profile: "other" },
    { provider: "wasm" },
    { mode: "batch" },
    { sessionId: "ephemeral" },
    { source: { name: "", source: "https://example.com" } },
    { source: { name: "raw", source: "" } },
    { preprocessing: { scale: Infinity, offset: 0 } },
    { preprocessing: { scale: 1, offset: NaN } },
    { preprocessing: { scale: 1 } },
    { preprocessing: { scale: 1, offset: 0, typo: true } },
    { roi: { originZYX: [0, 0, 0], shapeZYX: [1, 1, 1] } },
    { mode: "roi" },
  ])("rejects invalid fields visibly: %j", (overrides) => {
    expect(() => parseWith(overrides)).toThrow(/Invalid inference recipe/);
  });

  it.each([null, undefined, [], "recipe", 1].map((value) => [value]))(
    "rejects non-object recipe %j",
    (value) => {
      expect(() => parseInferenceRecipe(value)).toThrow(/JSON object/);
    },
  );

  it.each(
    [
      [1, 2],
      [1, 2, 3, 4],
      [0, 1, 1],
      [-1, 1, 1],
      [NaN, 1, 1],
      [Infinity, 1, 1],
      ["1", 1, 1],
    ].map((value) => [value]),
  )("rejects invalid spacing %j", (spacingZYX) => {
    expect(() => parseWith({ spacingZYX })).toThrow(/spacingZYX/);
  });

  it("allows fractional spacing", () => {
    expect(parseWith({ spacingZYX: [0.5, 1.5, 2] }).spacingZYX).toEqual([
      0.5, 1.5, 2,
    ]);
  });

  it.each([recipe, dynamicRecipe])(
    "rejects legacy ROI and preprocessing links rather than changing their output (%#)",
    (makeRecipe) => {
      for (const preprocessing of [
        { scale: 1, offset: 0 },
        { scale: 1 / 255, offset: -0.5 },
        { scale: 0, offset: -5 },
      ]) {
        expect(() =>
          parseInferenceRecipe({ ...makeRecipe(), preprocessing }),
        ).toThrow(/Invalid inference recipe .*preprocessing/);
      }
      expect(() =>
        parseInferenceRecipe({ ...makeRecipe(), mode: "roi" }),
      ).toThrow('Invalid inference recipe mode: expected "live"');
      expect(() =>
        parseInferenceRecipe({
          ...makeRecipe(),
          mode: "roi",
          roi: { originZYX: [-2, 0, 10], shapeZYX: [20, 80, 80] },
        }),
      ).toThrow(/Invalid inference recipe .*roi/);
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
      { url: "" },
      { url: 1 },
      ["https://example.com", {}],
      [["https://example.com"]],
    ].map((value) => [value]),
  )("rejects invalid source specs %j", (source) => {
    expect(() => parseWith({ source: { name: "raw", source } })).toThrow(
      /source/,
    );
  });

  it.each(
    [
      "inference://session-id",
      { url: "INFERENCE://recipe" },
      ["https://example.com", "inference://recipe"],
      { url: "zarr://inference://recipe" },
      { url: "https://example.com/raw|inference://recipe" },
      {
        url: "https://example.com/raw",
        state: { input: { source: ["inference://recipe"] } },
      },
      {
        url: "https://example.com/raw",
        state: { nested: { url: "inference://recipe" } },
      },
    ].map((value) => [value]),
  )("rejects recursive inference sources %j", (source) => {
    expect(() => parseWith({ source: { name: "raw", source } })).toThrow(
      /recursive inference/,
    );
  });

  it("rejects runtime references, lossy JSON values, accessors, and cycles", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const getter = vi.fn(() => "runtime");
    const accessor = Object.defineProperty({}, "value", {
      get: getter,
      enumerable: true,
    });
    for (const state of [
      new Map(),
      new Date(),
      new Float32Array(3),
      () => {},
      1n,
      NaN,
      cycle,
      accessor,
      [undefined],
    ]) {
      expect(() =>
        parseWith({
          source: {
            name: "raw",
            source: { url: "https://example.com/raw", state },
          },
        }),
      ).toThrow(/Invalid inference recipe/);
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    "https://example.com/a",
    "http://localhost:8000/a",
    "http://127.0.0.1/a",
    "http://[::1]:8000/a",
  ])("allows model URL %s", (url) => {
    expect(validateInferenceModelUrl(url)).toBe(url);
    expect(parseWith({ model: { ...model, urls: [url] } }).model).toEqual({
      ...model,
      urls: [url],
    });
  });

  it.each([
    "http://example.com/a",
    "http://localhost.example.com/a",
    "http://192.168.1.1/a",
    "file:///model",
    "data:a",
    "/model",
    "https://",
    "https://user:password@example.com/model",
    "https://user@example.com/model",
    "https://example.com/a b",
  ])("rejects unsupported model URL %s", (url) => {
    expect(() => validateInferenceModelUrl(url)).toThrow(/model.urls/);
    expect(() => parseWith({ model: { ...model, urls: [url] } })).toThrow(
      /model.urls/,
    );
  });

  it.each([
    { kind: "session" },
    { name: " " },
    { urls: [] },
    { urls: [""] },
    { size: 0 },
    { size: -1 },
    { size: 1.5 },
    { size: NaN },
    { size: Infinity },
    { size: MAX_MODEL_BYTES + 1 },
    { sha256: "a".repeat(63) },
    { sha256: "A".repeat(64) },
    { sha256: "g".repeat(64) },
    { extra: true },
  ])("rejects invalid model descriptor %j", (overrides) => {
    expect(() => parseWith({ model: { ...model, ...overrides } })).toThrow(
      /model/,
    );
  });

  it("validates local names and sizes, with no URL-only fields", () => {
    for (const local of [
      { kind: "local", name: "", size: 1 },
      { kind: "local", name: "local", size: MAX_MODEL_BYTES + 1 },
      { kind: "local", name: "local", size: 0 },
      { kind: "local", name: "local", size: 3, urls: [] },
    ])
      expect(() => parseWith({ model: local })).toThrow(/model/);
  });
});

describe("getInferenceRecipeGeometry", () => {
  it("preserves the exact v1 geometry and enforces the legacy model contract", () => {
    expect(getInferenceRecipeGeometry(recipe(), metadata())).toEqual({
      inputShape: [20, 80, 80],
      inputSpacing: [40, 8, 8],
      rawOutputShape: [20, 80, 80],
      outputSpacing: [40, 8, 8],
      rawOutputOrigin: [0, 0, 0],
      cropBefore: [2, 10, 10],
      cropAfter: [2, 10, 10],
      outputChannels: 4,
    });
    for (const changed of [
      { inputNames: ["image"] },
      { outputNames: ["prediction"] },
      { inputShape: [1, 1, 24, 80, 80] },
      { outputShape: [1, 1, 20, 80, 80] },
    ]) {
      expect(() =>
        getInferenceRecipeGeometry(recipe(), metadata(changed)),
      ).toThrow(/Unsupported model profile/);
    }
  });

  it("infers v2 shapes/channels and centered cropped geometry from actual model metadata", () => {
    const geometry = getInferenceRecipeGeometry(
      dynamicRecipe(),
      metadata({
        inputNames: ["image"],
        outputNames: ["probabilities"],
        inputShape: [1, 1, 24, 40, 48],
        outputShape: [1, 1, 48, 80, 96],
      }),
    );
    expect(geometry).toEqual({
      inputShape: [24, 40, 48],
      inputSpacing: [40, 8, 8],
      rawOutputShape: [48, 80, 96],
      outputSpacing: [20, 4, 4],
      rawOutputOrigin: [-10, -2, -2],
      cropBefore: [6, 10, 12],
      cropAfter: [6, 10, 12],
      outputChannels: 1,
    });
  });

  it("uses explicit user output spacing rather than silently recomputing it", () => {
    const value = dynamicRecipe();
    value.outputSpacingZYX = [40, 6, 2];
    const geometry = getInferenceRecipeGeometry(value, metadata());
    expect(geometry.outputSpacing).toEqual([40, 6, 2]);
    expect(geometry.rawOutputOrigin).toEqual([0, 79, 237]);
  });
});

describe("fetchInferenceModel", () => {
  it("fetches all parts with CORS and omitted credentials and verifies the combined SHA-256", async () => {
    const fetchModel = mockFetch(() => streamResponse(["a"]));
    fetchModel.mockImplementationOnce(async () => streamResponse(["a", "b"]));
    fetchModel.mockImplementationOnce(async () => streamResponse(["c"]));
    const urls = ["https://example.com/part1", "https://example.com/part2"];
    const abortSignal = signal();
    const file = await fetchInferenceModel(
      { ...model, urls },
      abortSignal,
      fetchModel,
    );
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe(model.name);
    expect(file.size).toBe(3);
    expect(await file.text()).toBe("abc");
    expect(fetchModel.mock.calls).toEqual(
      urls.map((url) => [
        url,
        { signal: abortSignal, mode: "cors", credentials: "omit" },
      ]),
    );
  });

  it("accepts a single model and a missing Content-Length", async () => {
    const file = await fetchInferenceModel(
      model,
      signal(),
      mockFetch(() => new Response("abc")),
    );
    expect(await file.text()).toBe("abc");
  });

  it("uses streamed decoded bytes rather than an encoded Content-Length", async () => {
    const file = await fetchInferenceModel(
      model,
      signal(),
      mockFetch(
        () =>
          new Response("abc", {
            headers: { "Content-Encoding": "gzip", "Content-Length": "23" },
          }),
      ),
    );
    expect(await file.text()).toBe("abc");
  });

  it("snapshots the model descriptor before the first await", async () => {
    const input = { ...model, urls: [...model.urls] };
    const file = await fetchInferenceModel(
      input,
      signal(),
      mockFetch(() => {
        input.urls.push("http://example.com/unwanted");
        input.sha256 = "0".repeat(64);
        input.name = "changed";
        return new Response("abc");
      }),
    );
    expect(file.name).toBe(model.name);
    expect(await file.text()).toBe("abc");
  });

  it("rejects a same-sized corrupt model", async () => {
    await expect(
      fetchInferenceModel(
        model,
        signal(),
        mockFetch(() => new Response("abd")),
      ),
    ).rejects.toThrow("Model SHA-256 mismatch");
  });

  it("rejects short and empty replies", async () => {
    for (const response of [new Response("ab"), new Response(null)]) {
      await expect(
        fetchInferenceModel(
          model,
          signal(),
          mockFetch(() => response),
        ),
      ).rejects.toThrow(/Expected 3 model bytes, received [02]/);
    }
  });

  it("stops and cancels an oversized stream without draining it", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(4));
        },
        cancel,
      }),
    );
    await expect(
      fetchInferenceModel(
        model,
        signal(),
        mockFetch(() => response),
      ),
    ).rejects.toThrow(/received too many/);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("enforces the cumulative bound across parts, even with a misleading Content-Length", async () => {
    const cancel = vi.fn();
    const fetchModel = mockFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("bc"));
            },
            cancel,
          }),
          { headers: { "Content-Length": "1" } },
        ),
    );
    fetchModel.mockImplementationOnce(async () => new Response("ab"));
    await expect(
      fetchInferenceModel(
        { ...model, urls: [model.urls[0], model.urls[0]] },
        signal(),
        fetchModel,
      ),
    ).rejects.toThrow(/received too many/);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects an oversized Content-Length before reading the body", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      headers: { "Content-Length": "1000000000" },
    });
    await expect(
      fetchInferenceModel(
        model,
        signal(),
        mockFetch(() => response),
      ),
    ).rejects.toThrow(/exceeds remaining size/);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("reports HTTP errors and cancels their bodies", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      status: 404,
      statusText: "Not Found",
    });
    await expect(
      fetchInferenceModel(
        model,
        signal(),
        mockFetch(() => response),
      ),
    ).rejects.toThrow("HTTP 404 Not Found");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("propagates network and stream errors without fetching later parts", async () => {
    const error = new Error("network failed");
    const fetchModel = vi.fn<typeof fetch>().mockRejectedValue(error);
    await expect(fetchInferenceModel(model, signal(), fetchModel)).rejects.toBe(
      error,
    );
    const broken = mockFetch(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(error);
            },
          }),
        ),
    );
    await expect(
      fetchInferenceModel(
        { ...model, urls: [model.urls[0], model.urls[0]] },
        signal(),
        broken,
      ),
    ).rejects.toBe(error);
    expect(broken).toHaveBeenCalledOnce();
  });

  it("rejects invalid direct-call descriptors before fetching", async () => {
    const fetchModel = mockFetch(() => new Response("abc"));
    for (const invalid of [
      { ...model, size: MAX_MODEL_BYTES + 1 },
      { ...model, urls: ["http://example.com/model"] },
    ]) {
      await expect(
        fetchInferenceModel(invalid, signal(), fetchModel),
      ).rejects.toThrow(/Invalid inference recipe/);
    }
    expect(fetchModel).not.toHaveBeenCalled();
  });

  it("honors cancellation before fetching and while fetch is pending", async () => {
    const abort = new AbortController();
    abort.abort();
    const fetchModel = mockFetch(() => new Response("abc"));
    await expect(
      fetchInferenceModel(model, abort.signal, fetchModel),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchModel).not.toHaveBeenCalled();
    const pending = new AbortController();
    fetchModel.mockImplementationOnce(
      async (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        }),
    );
    const result = fetchInferenceModel(model, pending.signal, fetchModel);
    pending.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancels a stalled body read on abort", async () => {
    const abort = new AbortController();
    const cancel = vi.fn();
    const reading = Promise.withResolvers<void>();
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull() {
            reading.resolve();
          },
          cancel,
        },
        { highWaterMark: 0 },
      ),
    );
    const result = fetchInferenceModel(
      model,
      abort.signal,
      mockFetch(() => response),
    );
    await reading.promise;
    abort.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not return a file if cancelled during hashing", async () => {
    const abort = new AbortController();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const spy = vi
      .spyOn(crypto.subtle, "digest")
      .mockImplementationOnce(async (algorithm, bytes) => {
        abort.abort();
        return digest(algorithm, bytes);
      });
    try {
      await expect(
        fetchInferenceModel(
          model,
          abort.signal,
          mockFetch(() => new Response("abc")),
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      spy.mockRestore();
    }
  });
});
