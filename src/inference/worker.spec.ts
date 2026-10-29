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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InferencePrecision,
  InferenceProvider,
  InferenceWorkerRequest,
  InferenceWorkerResponse,
  ModelMetadata,
} from "#src/inference/model.js";
import { makeModelGeometry } from "#src/inference/model.js";

const mocks = vi.hoisted(() => ({
  env: { wasm: {}, webgpu: {} },
  create: vi.fn(),
  run: vi.fn(),
  tensor: vi.fn(),
  dispose: vi.fn(),
  prepareFp16: vi.fn(),
}));
vi.mock("onnxruntime-web/webgpu", () => ({
  env: mocks.env,
  InferenceSession: { create: mocks.create },
  Tensor: class {
    dispose = mocks.dispose;
    constructor(type: string, data: Float32Array, dims: number[]) {
      mocks.tensor(type, data, dims);
    }
  },
}));

vi.mock("#src/inference/precision.js", () => ({
  prepareModelForFp16: mocks.prepareFp16,
}));

const metadata: ModelMetadata = {
  inputNames: ["volume:0"],
  outputNames: ["prediction/upsampled"],
  inputShape: [1, 1, 24, 64, 64],
  outputShape: [1, 1, 48, 128, 128],
  requestedProvider: "cpu",
  actualProvider: "wasm",
  threads: 1,
  initMs: 0,
};
const geometry = makeModelGeometry(metadata, [40, 16, 10]);
const elements = (shape: readonly number[]) => shape.reduce((a, b) => a * b, 1);
let handler: (event: MessageEvent<InferenceWorkerRequest>) => void;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.prepareFp16.mockResolvedValue({ model: new ArrayBuffer(2) });
  mocks.create.mockResolvedValue({
    inputNames: metadata.inputNames,
    outputNames: metadata.outputNames,
    inputMetadata: [
      { isTensor: true, type: "float32", shape: metadata.inputShape },
    ],
    outputMetadata: [
      { isTensor: true, type: "float32", shape: metadata.outputShape },
    ],
    run: mocks.run,
    release: vi.fn(),
  });
  const scope = {
    onmessage: undefined,
    location: new URL("https://inference.example/app/inference-worker.js"),
  };
  vi.stubGlobal("self", scope);
  vi.stubGlobal("crossOriginIsolated", false);
  await import("#src/inference/worker.js");
  handler = scope.onmessage!;
});
afterEach(() => vi.unstubAllGlobals());

function send(request: InferenceWorkerRequest) {
  return new Promise<InferenceWorkerResponse>((resolve) => {
    vi.stubGlobal("postMessage", vi.fn(resolve));
    handler({ data: request } as MessageEvent<InferenceWorkerRequest>);
  });
}

async function load(
  compatibilityFixes?: boolean,
  precision?: InferencePrecision,
  provider: InferenceProvider = "cpu",
) {
  const response = await send({
    id: 1,
    kind: "load",
    model: new ArrayBuffer(1),
    provider,
    ...(precision === undefined ? {} : { precision }),
    ...(compatibilityFixes === undefined ? {} : { compatibilityFixes }),
  });
  expect(response.kind).toBe("loaded");
  if (response.kind !== "loaded") throw new Error("Expected loaded");
  expect(mocks.create).toHaveBeenCalledExactlyOnceWith(
    expect.any(ArrayBuffer),
    provider === "cpu"
      ? { executionProviders: ["wasm"] }
      : {
          executionProviders: [{ name: "webgpu", preferredLayout: "NCHW" }],
          extra: { session: { disable_cpu_ep_fallback: "1" } },
        },
  );
  return response.metadata;
}

function run(
  input = new Float32Array(elements(metadata.inputShape)),
  customGeometry = geometry,
) {
  return send({ id: 7, kind: "run", input, geometry: customGeometry });
}

function rawOutput() {
  return {
    type: "float32",
    dims: [...metadata.outputShape],
    data: Float32Array.from(
      { length: elements(metadata.outputShape) },
      (_, i) => i,
    ),
    dispose: vi.fn(),
  };
}

describe("worker native runtime configuration", () => {
  it("uses a matching version-pinned CDN Asyncify JS/WASM pair for GPU and CPU", () => {
    expect(mocks.env.wasm).toEqual({
      wasmPaths: {
        mjs: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort-wasm-simd-threaded.asyncify.mjs",
        wasm: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort-wasm-simd-threaded.asyncify.wasm",
      },
      numThreads: 1,
      proxy: false,
    });
    expect(mocks.env.webgpu).toEqual({}); // No custom device.
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.prepareFp16).not.toHaveBeenCalled();
  });

  describe.each(["cpu", "webgpu"] as const)("%s provider", (provider) => {
    it.each([
      [
        "/ort-conv3d-cd11e2c068ae/",
        "https://inference.example/ort-conv3d-cd11e2c068ae/",
      ],
      [
        "https://runtime.example/ort-conv3d-cd11e2c068ae/",
        "https://runtime.example/ort-conv3d-cd11e2c068ae/",
      ],
    ])(
      "resolves custom runtime directory %s without changing lazy sessions or provider options",
      async (base, expectedBase) => {
        vi.resetModules();
        vi.stubGlobal("NEUROGLANCER_INFERENCE_WASM_BASE", base);
        vi.stubGlobal("isSecureContext", true);
        vi.stubGlobal("navigator", {
          gpu: { requestAdapter: async () => ({}) },
        });
        await import("#src/inference/worker.js");
        handler = self.onmessage!;
        expect(mocks.env.wasm).toEqual({
          wasmPaths: {
            mjs: `${expectedBase}ort-wasm-simd-threaded.asyncify.mjs`,
            wasm: `${expectedBase}ort-wasm-simd-threaded.asyncify.wasm`,
          },
          numThreads: 1,
          proxy: false,
        });
        expect(mocks.env.webgpu).toEqual({});
        expect(mocks.create).not.toHaveBeenCalled();
        expect(await load(undefined, undefined, provider)).toMatchObject({
          requestedProvider: provider,
          actualProvider: provider === "cpu" ? "wasm" : "webgpu",
          threads: 1,
        });
        expect(mocks.prepareFp16).not.toHaveBeenCalled();
      },
    );
  });

  it.each([
    [false, 16, 1],
    [false, 2, 1],
    [false, undefined, 1],
    [true, 16, 4],
    [true, 4, 4],
    [true, 2, 2],
    [true, 1, 1],
    [true, 0, 1],
    [true, -2, 1],
    [true, undefined, 1],
  ])(
    "isolation=%s with %s logical cores configures and reports %s WASM threads",
    async (isolated, cores, threads) => {
      vi.resetModules();
      vi.stubGlobal("crossOriginIsolated", isolated);
      vi.stubGlobal("navigator", { hardwareConcurrency: cores });
      await import("#src/inference/worker.js");
      handler = self.onmessage!;
      expect(mocks.env.wasm).toMatchObject({ numThreads: threads });
      const loaded = await load();
      expect(loaded.threads).toBe(threads);
      mocks.run.mockResolvedValue({ [metadata.outputNames[0]]: rawOutput() });
      expect(await run()).toMatchObject({
        kind: "output",
        metadata: { actualProvider: "wasm", threads },
      });
    },
  );
});

describe("worker precision plumbing", () => {
  it("defaults to FP32 and never loads the converter", async () => {
    const loaded = await load();
    expect(loaded).toMatchObject({
      requestedPrecision: "float32",
      actualPrecision: "float32",
    });
    expect(mocks.prepareFp16).not.toHaveBeenCalled();
  });

  it("reports CPU FP16 requests as FP32 without loading the converter", async () => {
    expect(await load(undefined, "float16")).toMatchObject({
      requestedPrecision: "float16",
      actualPrecision: "float32",
      precisionFallbackReason: "FP16 is GPU-only; CPU uses FP32",
    });
    expect(mocks.prepareFp16).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "worker shader-f16=%s gates native conversion and keeps tensor I/O float32",
    async (supported) => {
      vi.stubGlobal("isSecureContext", true);
      vi.stubGlobal("navigator", {
        gpu: {
          requestAdapter: async () => ({
            features: new Set(supported ? ["shader-f16"] : []),
          }),
        },
      });
      const loaded = await load(false, "float16", "webgpu");
      expect(loaded).toMatchObject({
        requestedPrecision: "float16",
        actualPrecision: supported ? "float16" : "float32",
        actualProvider: "webgpu",
      });
      expect(mocks.prepareFp16).toHaveBeenCalledTimes(supported ? 1 : 0);
      const raw = rawOutput();
      mocks.run.mockResolvedValue({ [metadata.outputNames[0]]: raw });
      expect(await run()).toMatchObject({ kind: "output", metadata: loaded });
      expect(mocks.tensor.mock.calls[0][0]).toBe("float32");
    },
  );

  it.each(["shape", "nonfinite"])(
    "never retries successful native FP16 runs with invalid %s output",
    async (kind) => {
      vi.stubGlobal("isSecureContext", true);
      vi.stubGlobal("navigator", {
        gpu: {
          requestAdapter: async () => ({ features: new Set(["shader-f16"]) }),
        },
      });
      await load(false, "float16", "webgpu");
      const raw = rawOutput();
      if (kind === "shape") raw.dims = [1];
      else raw.data[0] = Infinity;
      mocks.run.mockResolvedValue({ [metadata.outputNames[0]]: raw });
      expect(await run()).toMatchObject({
        kind: "error",
        metadata: { actualPrecision: "float16" },
      });
      expect(mocks.create).toHaveBeenCalledTimes(1);
      expect(mocks.prepareFp16).toHaveBeenCalledTimes(1);
      expect(raw.dispose).toHaveBeenCalledTimes(1);
    },
  );
});

describe("worker dynamic tensor contract", () => {
  it.each([undefined, false, true])(
    "forwards compatibility policy %s and returns analysis on CPU without rewriting",
    async (compatibilityFixes) => {
      const loaded = await load(compatibilityFixes);
      expect(loaded.compatibilityFixes).toBe(compatibilityFixes);
      expect(Object.hasOwn(loaded, "compatibilityFixes")).toBe(
        compatibilityFixes !== undefined,
      );
      expect(loaded.compatibilityAnalysis).toMatchObject({
        status: "unverified",
      });
      expect(loaded.preparation).toBeUndefined();
      const raw = rawOutput();
      mocks.run.mockResolvedValue({ [metadata.outputNames[0]]: raw });
      const response = await run();
      expect(response).toMatchObject({ kind: "output", metadata: loaded });
      expect(mocks.create).toHaveBeenCalledTimes(1);
    },
  );

  it("feeds metadata names/shapes and crops a one-channel supersampled output", async () => {
    const loaded = await load();
    const raw = rawOutput();
    mocks.run.mockResolvedValue({ [metadata.outputNames[0]]: raw });
    const input = new Float32Array(elements(metadata.inputShape));
    const response = await run(input);
    expect(mocks.tensor).toHaveBeenCalledExactlyOnceWith(
      "float32",
      input,
      metadata.inputShape,
    );
    expect(Object.keys(mocks.run.mock.calls[0][0])).toEqual(
      metadata.inputNames,
    );
    expect(response.kind).toBe("output");
    if (response.kind !== "output") throw new Error("Expected output");
    expect(response.output.length).toBe(36 * 96 * 96);
    expect(
      response.output.every((value, i) => {
        const z = Math.floor(i / (96 * 96)) + 6;
        const y = (Math.floor(i / 96) % 96) + 16;
        const x = (i % 96) + 16;
        return value === (z * 128 + y) * 128 + x;
      }),
    ).toBe(true);
    expect(response.metadata).toEqual(loaded);
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
    expect(raw.dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects unloaded models, incorrect input length and mismatched geometry before Tensor allocation", async () => {
    expect(await run()).toMatchObject({
      kind: "error",
      message: "Load a model before running inference",
    });
    await load();
    expect(await run(new Float32Array(1))).toMatchObject({
      kind: "error",
      message: expect.stringContaining("Input length"),
    });
    expect(
      await run(undefined, { ...geometry, outputChannels: 4 }),
    ).toMatchObject({
      kind: "error",
      message: expect.stringContaining("do not match"),
    });
    expect(mocks.tensor).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("rejects oversized metadata before Tensor allocation", async () => {
    // Exercise the worker's independent check, not just provider acceptance.
    const loaded = await load();
    loaded.outputShape = [1, 1024, 48, 128, 128];
    expect(await run()).toMatchObject({
      kind: "error",
      message: expect.stringContaining("byte limit"),
    });
    expect(mocks.tensor).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it.each(["name", "type", "shape", "length", "nonfinite"])(
    "rejects runtime output %s and disposes tensors",
    async (kind) => {
      await load();
      const raw = rawOutput();
      if (kind === "type") raw.type = "float64";
      if (kind === "shape") raw.dims = [1, 1, 24, 128, 128];
      if (kind === "length") raw.data = new Float32Array(1);
      // A non-finite value in the discarded border must also be rejected.
      if (kind === "nonfinite") raw.data[0] = Infinity;
      mocks.run.mockResolvedValue({
        [kind === "name" ? "wrong" : metadata.outputNames[0]]: raw,
      });
      expect(await run()).toMatchObject({
        kind: "error",
        message: expect.stringContaining(
          kind === "nonfinite" ? "non-finite output" : "Runtime output",
        ),
      });
      expect(mocks.create).toHaveBeenCalledTimes(1);
      expect(mocks.dispose).toHaveBeenCalledTimes(1);
      expect(raw.dispose).toHaveBeenCalledTimes(1);
    },
  );
});
