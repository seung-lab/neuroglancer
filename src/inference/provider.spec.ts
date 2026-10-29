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

import type * as ort from "onnxruntime-web/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  InferenceCompatibilityAnalysis,
  ModelMetadata,
} from "#src/inference/model.js";
import {
  ProviderSession,
  requireWebGpu,
  WEBGPU_SESSION_OPTIONS,
} from "#src/inference/provider.js";

function fakeSession() {
  const fake = {
    inputNames: ["input"],
    outputNames: ["output"],
    inputMetadata: [
      { isTensor: true, type: "float32", shape: [1, 1, 20, 80, 80] },
    ],
    outputMetadata: [
      { isTensor: true, type: "float32", shape: [1, 4, 20, 80, 80] },
    ],
    run: vi.fn().mockResolvedValue({ output: "sentinel" }),
    release: vi.fn().mockResolvedValue(undefined),
  };
  return { fake, session: fake as unknown as ort.InferenceSession };
}

function setup() {
  const gpu = fakeSession();
  const cpu = fakeSession();
  const fp16 = fakeSession();
  const fp16Model = new ArrayBuffer(3);
  const convert = vi.fn(async (_model: ArrayBuffer) => ({ model: fp16Model }));
  const create = vi.fn(async (_model, options) =>
    options.executionProviders[0] === "wasm"
      ? cpu.session
      : _model === fp16Model
        ? fp16.session
        : gpu.session,
  );
  const check = vi.fn(async (): Promise<unknown> => undefined);
  const analysis: InferenceCompatibilityAnalysis = {
    status: "available",
    model: "model6280000",
    fixes: ["Verified GPU graph rewrite"],
    message: "Verified compatibility fixes are available.",
  };
  const inspect = vi.fn(async () => analysis);
  const prepare = vi.fn(
    async (model: ArrayBuffer, _enabled: boolean | undefined) => ({
      model,
      preparation: undefined as ModelMetadata["preparation"],
      compatibilityAnalysis: analysis,
    }),
  );
  const policy = new ProviderSession(
    create,
    1,
    check,
    prepare,
    inspect,
    convert,
  );
  const model = new ArrayBuffer(1);
  return {
    gpu,
    cpu,
    fp16,
    fp16Model,
    convert,
    create,
    check,
    prepare,
    inspect,
    analysis,
    policy,
    model,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("worker WebGPU detection", () => {
  it("requires a secure context and the dedicated worker API", async () => {
    vi.stubGlobal("isSecureContext", false);
    await expect(requireWebGpu()).rejects.toThrow("secure context");
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("navigator", {});
    await expect(requireWebGpu()).rejects.toThrow("inference worker");
  });

  it("requires an available hardware adapter, not SwiftShader/software", async () => {
    vi.stubGlobal("isSecureContext", true);
    const requestAdapter = vi.fn().mockResolvedValue(null);
    vi.stubGlobal("navigator", { gpu: { requestAdapter } });
    await expect(requireWebGpu()).rejects.toThrow("obtain an adapter");
    requestAdapter.mockResolvedValue({ info: { isFallbackAdapter: true } });
    await expect(requireWebGpu()).rejects.toThrow("software/fallback");
    const adapter = { info: { isFallbackAdapter: false } };
    requestAdapter.mockResolvedValue(adapter);
    expect(await requireWebGpu()).toBe(adapter);
  });
});

describe("experimental native FP16 policy", () => {
  const adapter = { features: new Set(["shader-f16"]) };

  it.each([undefined, "float32"] as const)(
    "FP32 default/explicit %s never converts",
    async (precision) => {
      const { policy, model, convert, check, create } = setup();
      check.mockResolvedValue(adapter);
      expect(
        await policy.load(model, "webgpu", undefined, precision),
      ).toMatchObject({
        requestedPrecision: "float32",
        actualPrecision: "float32",
        actualProvider: "webgpu",
      });
      expect(convert).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledTimes(1);
      expect(policy.metadata?.precisionFallbackReason).toBeUndefined();
    },
  );

  it("checks the actual worker adapter's shader-f16 feature", async () => {
    vi.stubGlobal("isSecureContext", true);
    const has = vi.fn().mockReturnValue(false);
    vi.stubGlobal("navigator", {
      gpu: { requestAdapter: async () => ({ features: { has } }) },
    });
    const { create, prepare, inspect, convert, model } = setup();
    const policy = new ProviderSession(
      create,
      1,
      requireWebGpu,
      prepare,
      inspect,
      convert,
    );
    expect(await policy.load(model, "webgpu", true, "float16")).toMatchObject({
      requestedPrecision: "float16",
      actualPrecision: "float32",
      actualProvider: "webgpu",
      precisionFallbackReason: expect.stringContaining("lacks shader-f16"),
    });
    expect(has).toHaveBeenCalledExactlyOnceWith("shader-f16");
    expect(convert).not.toHaveBeenCalled();
  });

  it("CPU ignores FP16 visibly without detection or conversion", async () => {
    const { policy, model, check, convert, prepare } = setup();
    expect(await policy.load(model, "cpu", true, "float16")).toMatchObject({
      requestedPrecision: "float16",
      actualPrecision: "float32",
      actualProvider: "wasm",
      precisionFallbackReason: "FP16 is GPU-only; CPU uses FP32",
    });
    expect(check).not.toHaveBeenCalled();
    expect(convert).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each(["auto", "webgpu"] as const)(
    "%s runs native FP16 from original bytes, without building FP32 too",
    async (provider) => {
      const {
        policy,
        model,
        check,
        convert,
        create,
        fp16Model,
        fp16,
        prepare,
      } = setup();
      check.mockResolvedValue(adapter);
      expect(await policy.load(model, provider, true, "float16")).toMatchObject(
        {
          requestedPrecision: "float16",
          actualPrecision: "float16",
          actualProvider: "webgpu",
        },
      );
      expect(convert).toHaveBeenCalledExactlyOnceWith(model);
      expect(prepare).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledExactlyOnceWith(
        fp16Model,
        WEBGPU_SESSION_OPTIONS,
      );
      await policy.run({});
      expect(fp16.fake.run).toHaveBeenCalledTimes(1);
      expect(policy.metadata?.precisionFallbackReason).toBeUndefined();
    },
  );

  it.each(["conversion", "create", "run"])(
    "falls back visibly to FP32 GPU on FP16 %s, even with strict GPU",
    async (phase) => {
      const { policy, model, check, convert, create, fp16, gpu, prepare } =
        setup();
      check.mockResolvedValue(adapter);
      if (phase === "conversion")
        convert.mockRejectedValue(
          new Error(
            "FP16 preparation failed: existing Cast nodes are unsupported",
          ),
        );
      if (phase === "create")
        create.mockRejectedValueOnce(new Error("Native FP16 create failed"));
      if (phase === "run")
        fp16.fake.run.mockRejectedValue(new Error("Native FP16 run failed"));
      await policy.load(model, "webgpu", true, "float16");
      await policy.run({});
      expect(policy.metadata).toMatchObject({
        requestedProvider: "webgpu",
        actualProvider: "webgpu",
        requestedPrecision: "float16",
        actualPrecision: "float32",
        precisionFallbackReason: expect.stringContaining(
          phase === "run"
            ? "FP16 first execution failed"
            : "FP16 initialization failed",
        ),
      });
      if (phase === "conversion")
        expect(policy.metadata?.precisionFallbackReason).toContain(
          "FP16 preparation failed: existing Cast nodes are unsupported",
        );
      expect(gpu.fake.run).toHaveBeenCalledTimes(1);
      expect(prepare).toHaveBeenCalledExactlyOnceWith(model, true);
      expect(
        create.mock.calls.every(
          ([, options]) => options === WEBGPU_SESSION_OPTIONS,
        ),
      ).toBe(true);
    },
  );

  it.each(["auto", "webgpu"] as const)(
    "%s retains provider semantics if FP16 and FP32 GPU both fail",
    async (provider) => {
      const { policy, model, check, fp16, gpu, cpu, create } = setup();
      check.mockResolvedValue(adapter);
      fp16.fake.run.mockRejectedValue(new Error("FP16 execution"));
      gpu.fake.run.mockRejectedValue(new Error("FP32 execution"));
      await policy.load(model, provider, false, "float16");
      if (provider === "webgpu") {
        await expect(policy.run({})).rejects.toThrow(
          "WebGPU execution failed: FP32 execution",
        );
        expect(create).toHaveBeenCalledTimes(2);
        expect(cpu.fake.run).not.toHaveBeenCalled();
      } else {
        await policy.run({});
        expect(policy.metadata).toMatchObject({
          actualProvider: "wasm",
          requestedPrecision: "float16",
          actualPrecision: "float32",
          fallbackReason: "WebGPU first execution failed: FP32 execution",
          precisionFallbackReason: expect.stringContaining("using FP32 CPU"),
        });
        expect(cpu.fake.run).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("does not retry later native FP16 execution failures", async () => {
    const { policy, model, check, fp16, create, prepare } = setup();
    check.mockResolvedValue(adapter);
    await policy.load(model, "auto", true, "float16");
    await policy.run({});
    fp16.fake.run.mockRejectedValue(new Error("later failure"));
    await expect(policy.run({})).rejects.toThrow(
      "WebGPU execution failed: later failure",
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each(["profile", "output"])(
    "does not precision-retry invalid native FP16 %s",
    async (phase) => {
      const { policy, model, check, fp16, create, prepare } = setup();
      check.mockResolvedValue(adapter);
      if (phase === "profile") {
        fp16.fake.outputMetadata[0].type = "float16";
        await expect(
          policy.load(model, "auto", true, "float16"),
        ).rejects.toThrow("float32 tensors");
        expect(fp16.fake.release).toHaveBeenCalledTimes(1);
      } else {
        await policy.load(model, "auto", true, "float16");
        const invalid = {
          output: { data: new Float32Array([NaN]), dims: [1] },
        };
        fp16.fake.run.mockResolvedValue(invalid);
        expect(await policy.run({})).toBe(invalid);
      }
      expect(create).toHaveBeenCalledTimes(1);
      expect(prepare).not.toHaveBeenCalled();
    },
  );
});

describe("inference provider policy", () => {
  it("CPU bypasses GPU detection and never retries failures", async () => {
    const { policy, cpu, model, check, create, prepare, inspect, analysis } =
      setup();
    const metadata = await policy.load(model, "cpu", true);
    expect(metadata).toMatchObject({
      requestedProvider: "cpu",
      actualProvider: "wasm",
      compatibilityFixes: true,
      compatibilityAnalysis: analysis,
    });
    expect(inspect).toHaveBeenCalledExactlyOnceWith(model);
    expect(metadata.fallbackReason).toBeUndefined();
    expect(check).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(model, {
      executionProviders: ["wasm"],
    });
    cpu.fake.run.mockRejectedValue(new Error("CPU error"));
    await expect(policy.run({})).rejects.toThrow("CPU error");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each(["auto", "webgpu"] as const)(
    "%s uses strict GPU sessions and reports actual provider",
    async (requested) => {
      const { policy, model, check, create } = setup();
      expect(await policy.load(model, requested)).toMatchObject({
        requestedProvider: requested,
        actualProvider: "webgpu",
      });
      expect(check).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledWith(model, WEBGPU_SESSION_OPTIONS);
      expect(WEBGPU_SESSION_OPTIONS).toEqual({
        executionProviders: [{ name: "webgpu", preferredLayout: "NCHW" }],
        extra: { session: { disable_cpu_ep_fallback: "1" } },
      });
      expect(await policy.run({})).toEqual({ output: "sentinel" });
      expect(create).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["check", "create"] as const)(
    "Auto falls back visibly on GPU %s failure; explicit GPU fails",
    async (phase) => {
      for (const requested of ["auto", "webgpu"] as const) {
        const { policy, model, check, create } = setup();
        const failure = new Error("GPU unavailable");
        if (phase === "check") check.mockRejectedValue(failure);
        else create.mockRejectedValueOnce(failure);
        if (requested === "webgpu") {
          await expect(policy.load(model, requested)).rejects.toThrow(
            "WebGPU initialization failed: GPU unavailable",
          );
          expect(create).toHaveBeenCalledTimes(phase === "check" ? 0 : 1);
          expect(policy.metadata).toBeUndefined();
        } else {
          expect(await policy.load(model, requested)).toMatchObject({
            requestedProvider: "auto",
            actualProvider: "wasm",
            fallbackReason: "WebGPU initialization failed: GPU unavailable",
          });
          expect(create).toHaveBeenLastCalledWith(model, {
            executionProviders: ["wasm"],
          });
        }
      }
    },
  );

  it("prepares only GPU bytes, preserves the original for Auto CPU retry, and clears preparation metadata", async () => {
    const { policy, model, gpu, create, prepare, inspect, analysis } = setup();
    const prepared = new ArrayBuffer(2);
    prepare.mockResolvedValue({
      model: prepared,
      preparation: "model6280000-jsep",
      compatibilityAnalysis: analysis,
    });
    expect(await policy.load(model, "auto", true)).toMatchObject({
      actualProvider: "webgpu",
      preparation: "model6280000-jsep",
      compatibilityFixes: true,
      compatibilityAnalysis: analysis,
    });
    expect(prepare).toHaveBeenCalledExactlyOnceWith(model, true);
    expect(inspect).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(prepared, WEBGPU_SESSION_OPTIONS);
    gpu.fake.run.mockRejectedValue(new Error("device lost"));
    await policy.run({});
    expect(create).toHaveBeenLastCalledWith(model, {
      executionProviders: ["wasm"],
    });
    expect(policy.metadata).toMatchObject({
      actualProvider: "wasm",
      compatibilityFixes: true,
      compatibilityAnalysis: analysis,
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(inspect).not.toHaveBeenCalled();
    expect(policy.metadata?.preparation).toBeUndefined();
  });

  it("uses original CPU bytes when GPU session creation rejects prepared bytes", async () => {
    const { policy, model, create, prepare, analysis } = setup();
    const prepared = new ArrayBuffer(2);
    prepare.mockResolvedValue({
      model: prepared,
      preparation: "nooverseg-jsep",
      compatibilityAnalysis: analysis,
    });
    create.mockRejectedValueOnce(new Error("GPU graph rejected"));
    expect(await policy.load(model, "auto", true)).toMatchObject({
      actualProvider: "wasm",
      fallbackReason: "WebGPU initialization failed: GPU graph rejected",
      compatibilityFixes: true,
      compatibilityAnalysis: analysis,
    });
    expect(create).toHaveBeenNthCalledWith(1, prepared, WEBGPU_SESSION_OPTIONS);
    expect(create).toHaveBeenNthCalledWith(2, model, {
      executionProviders: ["wasm"],
    });
    expect(policy.metadata?.preparation).toBeUndefined();
  });

  it.each(["auto", "webgpu"] as const)(
    "fails closed on preparation errors for %s without provider retry",
    async (requested) => {
      const { policy, model, create, prepare } = setup();
      prepare.mockRejectedValue(new Error("Preparation validation failed"));
      await expect(policy.load(model, requested, true)).rejects.toThrow(
        "Preparation validation failed",
      );
      expect(create).not.toHaveBeenCalled();
      expect(policy.metadata).toBeUndefined();
    },
  );

  it.each(["auto", "webgpu"] as const)(
    "%s uses prepared bytes only when fixes are requested, and disabled loads inspect only",
    async (requested) => {
      const { policy, model, create, prepare, inspect, analysis } = setup();
      const prepared = new ArrayBuffer(2);
      prepare.mockResolvedValue({
        model: prepared,
        preparation: "model6280000-jsep",
        compatibilityAnalysis: analysis,
      });
      await policy.load(model, requested, true);
      expect(create).toHaveBeenLastCalledWith(prepared, WEBGPU_SESSION_OPTIONS);
      expect(prepare).toHaveBeenCalledExactlyOnceWith(model, true);
      expect(inspect).not.toHaveBeenCalled();
      expect(await policy.load(model, requested, false)).toMatchObject({
        actualProvider: "webgpu",
        compatibilityFixes: false,
        compatibilityAnalysis: analysis,
      });
      expect(create).toHaveBeenLastCalledWith(model, WEBGPU_SESSION_OPTIONS);
      expect(policy.metadata?.preparation).toBeUndefined();
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(inspect).toHaveBeenCalledExactlyOnceWith(model);
    },
  );

  it("passes the absent legacy policy through without recording an explicit opt-in", async () => {
    const { policy, model, prepare } = setup();
    await policy.load(model, "webgpu");
    expect(prepare).toHaveBeenCalledExactlyOnceWith(model, undefined);
    expect(policy.metadata).not.toHaveProperty("compatibilityFixes");
  });

  it("analyzes Auto adapter fallback without preparing CPU bytes", async () => {
    const { policy, model, check, create, prepare, inspect, analysis } =
      setup();
    check.mockRejectedValue(new Error("No adapter"));
    expect(await policy.load(model, "auto", true)).toMatchObject({
      actualProvider: "wasm",
      compatibilityFixes: true,
      compatibilityAnalysis: analysis,
      fallbackReason: "WebGPU initialization failed: No adapter",
    });
    expect(inspect).toHaveBeenCalledExactlyOnceWith(model);
    expect(prepare).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledExactlyOnceWith(model, {
      executionProviders: ["wasm"],
    });
  });

  it.each(["cpu", "auto", "webgpu"] as const)(
    "fails visibly on inspection errors for %s",
    async (requested) => {
      const { policy, model, inspect, create } = setup();
      inspect.mockRejectedValue(new Error("Analysis failed"));
      await expect(policy.load(model, requested, false)).rejects.toThrow(
        "Analysis failed",
      );
      expect(create).not.toHaveBeenCalled();
      expect(policy.metadata).toBeUndefined();
    },
  );

  it.each([false, true, undefined])(
    "leaves unverified models untouched with requested fixes %s",
    async (enabled) => {
      const { create, check, model } = setup();
      // Real inspection/preparation: malformed, unknown bytes must not be rewritten.
      const policy = new ProviderSession(create, 1, check);
      expect(await policy.load(model, "webgpu", enabled)).toMatchObject({
        actualProvider: "webgpu",
        compatibilityAnalysis: { status: "unverified" },
      });
      expect(policy.metadata?.preparation).toBeUndefined();
      expect(create).toHaveBeenCalledExactlyOnceWith(
        model,
        WEBGPU_SESSION_OPTIONS,
      );
    },
  );

  it("Auto retries a first GPU execution failure with CPU and updates metadata", async () => {
    const { policy, model, gpu, cpu, create } = setup();
    await policy.load(model, "auto");
    gpu.fake.run.mockRejectedValue(new Error("device lost"));
    expect(await policy.run({})).toEqual({ output: "sentinel" });
    expect(gpu.fake.release).toHaveBeenCalledTimes(1);
    expect(cpu.fake.run).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenLastCalledWith(model, {
      executionProviders: ["wasm"],
    });
    expect(policy.metadata).toMatchObject({
      requestedProvider: "auto",
      actualProvider: "wasm",
      fallbackReason: "WebGPU first execution failed: device lost",
    });
    await policy.run({});
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("does not retry explicit GPU or a later GPU execution failure", async () => {
    for (const requested of ["webgpu", "auto"] as const) {
      const { policy, model, gpu, create } = setup();
      await policy.load(model, requested);
      if (requested === "auto") await policy.run({});
      gpu.fake.run.mockRejectedValue(new Error("device lost"));
      await expect(policy.run({})).rejects.toThrow(
        "WebGPU execution failed: device lost",
      );
      expect(create).toHaveBeenCalledTimes(1);
    }
  });

  it("does not turn CPU retry errors into success", async () => {
    const { policy, model, gpu, cpu } = setup();
    await policy.load(model, "auto");
    gpu.fake.run.mockRejectedValue(new Error("GPU error"));
    cpu.fake.run.mockRejectedValue(new Error("invalid model execution"));
    await expect(policy.run({})).rejects.toThrow("invalid model execution");
  });

  it.each(["shape", "type"] as const)(
    "never falls back for an invalid model %s",
    async (kind) => {
      const { policy, model, gpu, create } = setup();
      if (kind === "shape") gpu.fake.inputMetadata[0].shape = [1, 2, 3];
      else gpu.fake.inputMetadata[0].type = "int32";
      await expect(policy.load(model, "auto")).rejects.toThrow();
      expect(create).toHaveBeenCalledTimes(1);
      expect(gpu.fake.release).toHaveBeenCalledTimes(1);
      expect(policy.metadata).toBeUndefined();
    },
  );

  it("accepts bounded arbitrary-name single-channel supersampling metadata", async () => {
    const { policy, model, gpu, create } = setup();
    gpu.fake.inputNames = ["volume:0"];
    gpu.fake.outputNames = ["prediction/upsampled"];
    gpu.fake.inputMetadata[0].shape = [1, 1, 24, 64, 64];
    gpu.fake.outputMetadata[0].shape = [1, 1, 48, 128, 128];
    expect(await policy.load(model, "auto")).toMatchObject({
      inputNames: ["volume:0"],
      outputNames: ["prediction/upsampled"],
      inputShape: [1, 1, 24, 64, 64],
      outputShape: [1, 1, 48, 128, 128],
      actualProvider: "webgpu",
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each([
    "multiple inputs",
    "multiple outputs",
    "extra input metadata",
    "extra output metadata",
    "symbolic",
    "dynamic",
    "oversize input",
    "oversize output",
    "batch",
    "input channels",
    "output type",
    "nontensor",
    "missing input",
    "missing output",
  ])("rejects %s metadata without Auto fallback", async (kind) => {
    const { policy, model, gpu, create } = setup();
    const { fake } = gpu;
    switch (kind) {
      case "multiple inputs":
        fake.inputNames.push("extra");
        break;
      case "multiple outputs":
        fake.outputNames.push("extra");
        break;
      case "extra input metadata":
        fake.inputMetadata.push(fake.inputMetadata[0]);
        break;
      case "extra output metadata":
        fake.outputMetadata.push(fake.outputMetadata[0]);
        break;
      case "symbolic":
        fake.outputMetadata[0].shape = [
          1,
          1,
          "depth",
          128,
          128,
        ] as unknown as number[];
        break;
      case "dynamic":
        fake.inputMetadata[0].shape = [1, 1, -1, 64, 64];
        break;
      case "oversize input":
        fake.inputMetadata[0].shape = [1, 1, 1024, 1024, 1024];
        break;
      case "oversize output":
        fake.outputMetadata[0].shape = [1, 1024, 48, 128, 128];
        break;
      case "batch":
        fake.outputMetadata[0].shape = [2, 1, 48, 128, 128];
        break;
      case "input channels":
        fake.inputMetadata[0].shape = [1, 2, 24, 64, 64];
        break;
      case "output type":
        fake.outputMetadata[0].type = "float64";
        break;
      case "nontensor":
        fake.outputMetadata[0].isTensor = false;
        break;
      case "missing input":
        fake.inputMetadata.length = 0;
        break;
      case "missing output":
        fake.outputMetadata.length = 0;
        break;
    }
    await expect(policy.load(model, "auto")).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(1);
    expect(fake.release).toHaveBeenCalledTimes(1);
    expect(policy.metadata).toBeUndefined();
  });

  it("rejects an empty reload before session creation and does not reuse the old model", async () => {
    const { policy, model, gpu, create } = setup();
    await policy.load(model, "auto");
    await expect(policy.load(new ArrayBuffer(0), "auto")).rejects.toThrow(
      "Model size",
    );
    expect(gpu.fake.release).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(policy.metadata).toBeUndefined();
    await expect(policy.run({})).rejects.toThrow("Load a model");
  });

  it("validates CPU fallback metadata before running it", async () => {
    const { policy, model, gpu, cpu, create } = setup();
    await policy.load(model, "auto");
    gpu.fake.run.mockRejectedValue(new Error("device lost"));
    cpu.fake.outputMetadata[0].shape = [1, 0, 48, 128, 128];
    await expect(policy.run({})).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(2);
    expect(cpu.fake.run).not.toHaveBeenCalled();
    expect(cpu.fake.release).toHaveBeenCalledTimes(1);
  });

  it("leaves malformed/nonfinite successful outputs to validation, never GPU fallback", async () => {
    const { policy, model, gpu, create } = setup();
    await policy.load(model, "auto");
    const invalid = { output: { data: new Float32Array([NaN]), dims: [1] } };
    gpu.fake.run.mockResolvedValue(invalid);
    expect(await policy.run({})).toBe(invalid);
    expect(create).toHaveBeenCalledTimes(1);
    expect(policy.metadata?.actualProvider).toBe("webgpu");
  });

  it("replaces sessions/metadata when a model/provider is reloaded", async () => {
    const { policy, model, gpu, cpu, check } = setup();
    await policy.load(model, "auto");
    await policy.load(model, "cpu");
    expect(gpu.fake.release).toHaveBeenCalledTimes(1);
    expect(policy.metadata).toMatchObject({
      requestedProvider: "cpu",
      actualProvider: "wasm",
    });
    expect(check).toHaveBeenCalledTimes(1);
    await policy.load(model, "webgpu");
    expect(cpu.fake.release).toHaveBeenCalledTimes(1);
    expect(policy.metadata?.fallbackReason).toBeUndefined();
  });
});
