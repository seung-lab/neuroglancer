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

import type * as ort from "onnxruntime-web/webgpu";

import {
  type ExecutionProvider,
  type InferenceProvider,
  type InferencePrecision,
  type InferenceCompatibilityAnalysis,
  type ModelMetadata,
  MAX_MODEL_BYTES,
  validateModelMetadata,
} from "#src/inference/model.js";

import {
  inspectWebGpuCompatibility,
  prepareModelForWebGpu,
} from "#src/inference/prepare.js";

/** Called in the dedicated module worker, not on the viewer's main thread. */
export async function requireWebGpu() {
  if (!globalThis.isSecureContext)
    throw new Error("WebGPU requires a secure context (HTTPS or localhost)");
  // Keep browser capability detection independent of ambient WebGPU typings.
  const gpu = (
    navigator as Navigator & {
      gpu?: {
        requestAdapter(): Promise<{
          info?: { isFallbackAdapter?: boolean };
          features?: { has(feature: string): boolean };
        } | null>;
      };
    }
  ).gpu;
  if (gpu === undefined)
    throw new Error("WebGPU is unavailable in this inference worker");
  const adapter = await gpu.requestAdapter();
  if (adapter === null)
    throw new Error(
      "WebGPU could not obtain an adapter in this inference worker",
    );
  if (adapter.info?.isFallbackAdapter)
    throw new Error(
      "WebGPU adapter is software/fallback, not hardware acceleration",
    );
  return adapter;
}

export const WEBGPU_SESSION_OPTIONS: ort.InferenceSession.SessionOptions = {
  executionProviders: [{ name: "webgpu", preferredLayout: "NCHW" }],
  // ORT otherwise assigns unsupported graph nodes to its implicit CPU EP.
  extra: { session: { disable_cpu_ep_fallback: "1" } },
};

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Provider policy only. Profile/output validation must never trigger a retry.
 * A CPU retry must itself succeed and validate before any result is published;
 * it establishes whether a failure inside GPU create/run is provider-specific.
 */
export class ProviderSession {
  metadata: ModelMetadata | undefined;
  private session: ort.InferenceSession | undefined;
  private model: ArrayBuffer | undefined;
  private requested: InferenceProvider = "auto";
  private firstRun = true;
  private compatibilityFixes: boolean | undefined;
  private compatibilityAnalysis: InferenceCompatibilityAnalysis | undefined;
  private requestedPrecision: InferencePrecision = "float32";
  private precisionFallbackReason: string | undefined;
  private prepared: Awaited<ReturnType<ProviderSession["prepare"]>> | undefined;

  constructor(
    private readonly create: (
      model: ArrayBuffer,
      options: ort.InferenceSession.SessionOptions,
    ) => Promise<ort.InferenceSession>,
    private readonly threads: number,
    private readonly checkWebGpu: () => Promise<unknown> = requireWebGpu,
    private readonly prepare: (
      model: ArrayBuffer,
      enabled: boolean | undefined,
    ) => Promise<{
      model: ArrayBuffer;
      preparation?: ModelMetadata["preparation"];
      compatibilityAnalysis?: InferenceCompatibilityAnalysis;
    }> = prepareModelForWebGpu,
    private readonly inspect: (
      model: ArrayBuffer,
    ) => Promise<InferenceCompatibilityAnalysis> = inspectWebGpuCompatibility,
    private readonly prepareFp16: (
      model: ArrayBuffer,
    ) => Promise<{ model: ArrayBuffer }> = async (model) =>
      (await import("#src/inference/precision.js")).prepareModelForFp16(model),
  ) {}

  private async accept(
    next: ort.InferenceSession,
    actualProvider: ExecutionProvider,
    start: number,
    fallbackReason?: string,
    preparation?: ModelMetadata["preparation"],
    actualPrecision: InferencePrecision = "float32",
  ) {
    try {
      if (
        next.inputNames.length !== 1 ||
        next.outputNames.length !== 1 ||
        next.inputMetadata.length !== 1 ||
        next.outputMetadata.length !== 1
      )
        throw new Error(
          "Model must have exactly one input and one output tensor",
        );
      const input = next.inputMetadata[0];
      const output = next.outputMetadata[0];
      if (
        !input?.isTensor ||
        !output?.isTensor ||
        input.type !== "float32" ||
        output.type !== "float32"
      )
        throw new Error("Model input and output must be float32 tensors");
      const metadata: ModelMetadata = {
        inputNames: [...next.inputNames],
        outputNames: [...next.outputNames],
        inputShape: [...input.shape] as number[],
        outputShape: [...output.shape] as number[],
        initMs: performance.now() - start,
        threads: this.threads,
        requestedProvider: this.requested,
        actualProvider,
        requestedPrecision: this.requestedPrecision,
        actualPrecision,
        ...(this.precisionFallbackReason === undefined
          ? {}
          : { precisionFallbackReason: this.precisionFallbackReason }),
        ...(this.compatibilityFixes === undefined
          ? {}
          : { compatibilityFixes: this.compatibilityFixes }),
        ...(this.compatibilityAnalysis === undefined
          ? {}
          : { compatibilityAnalysis: this.compatibilityAnalysis }),
        ...(fallbackReason === undefined ? {} : { fallbackReason }),
        ...(preparation === undefined ? {} : { preparation }),
      };
      validateModelMetadata(metadata);
      this.session = next;
      this.metadata = metadata;
      return metadata;
    } catch (error) {
      await next.release();
      throw error;
    }
  }

  async load(
    model: ArrayBuffer,
    requested: InferenceProvider,
    compatibilityFixes?: boolean,
    precision: InferencePrecision = "float32",
  ) {
    await this.session?.release();
    this.session = undefined;
    this.metadata = undefined;
    this.model = undefined;
    this.requested = requested;
    this.compatibilityFixes = compatibilityFixes;
    this.compatibilityAnalysis = undefined;
    this.requestedPrecision = precision;
    this.precisionFallbackReason = undefined;
    this.prepared = undefined;
    this.firstRun = true;
    if (model.byteLength === 0 || model.byteLength > MAX_MODEL_BYTES)
      throw new Error(
        `Model size must be between 1 and ${MAX_MODEL_BYTES} bytes`,
      );
    const start = performance.now();
    let next: ort.InferenceSession;
    let actual: ExecutionProvider = "wasm";
    let fallbackReason: string | undefined;
    let preparation: ModelMetadata["preparation"];
    let adapter: unknown;
    if (requested !== "cpu") {
      try {
        adapter = await this.checkWebGpu();
      } catch (error) {
        if (requested === "webgpu")
          throw new Error(`WebGPU initialization failed: ${message(error)}`);
        fallbackReason = `WebGPU initialization failed: ${message(error)}`;
      }
    }
    if (precision === "float16") {
      const features = (
        adapter as { features?: { has(name: string): boolean } } | undefined
      )?.features;
      if (requested === "cpu")
        this.precisionFallbackReason = "FP16 is GPU-only; CPU uses FP32";
      else if (fallbackReason !== undefined)
        this.precisionFallbackReason = `FP16 unavailable; using FP32: ${fallbackReason}`;
      else if (!features?.has("shader-f16"))
        this.precisionFallbackReason =
          "FP16 unavailable: worker WebGPU adapter lacks shader-f16; using FP32 WebGPU";
      else {
        // Convert original bytes only. Do not also build an FP32 graph unless
        // native conversion/create/run actually requires a precision fallback.
        this.compatibilityAnalysis = await this.inspect(model);
        let native: ort.InferenceSession | undefined;
        try {
          const converted = await this.prepareFp16(model);
          // ORT owns its device, including shader-f16 feature negotiation.
          native = await this.create(converted.model, WEBGPU_SESSION_OPTIONS);
        } catch (error) {
          this.precisionFallbackReason = `FP16 initialization failed: ${message(error)}; using FP32 WebGPU`;
        }
        if (native !== undefined) {
          // Profile validation is deliberately outside the precision retry catch.
          const metadata = await this.accept(
            native,
            "webgpu",
            start,
            undefined,
            undefined,
            "float16",
          );
          this.model = model;
          return metadata;
        }
      }
    }
    if (requested === "cpu" || fallbackReason !== undefined) {
      this.compatibilityAnalysis = await this.inspect(model);
      next = await this.create(model, { executionProviders: ["wasm"] });
    } else {
      // Inspect exactly once per load. Preparation returns its own analysis;
      // disabled fixes inspect without ever invoking a graph rewrite.
      // Fail closed on inspection/preparation errors, outside provider retry.
      const prepared = await this.prepareFp32(model);
      try {
        // Native ORT owns its device/limits; do not inject a custom GPUDevice.
        next = await this.create(prepared.model, WEBGPU_SESSION_OPTIONS);
        preparation = prepared.preparation;
        actual = "webgpu";
      } catch (error) {
        if (requested === "webgpu")
          throw new Error(`WebGPU initialization failed: ${message(error)}`);
        fallbackReason = `WebGPU initialization failed: ${message(error)}`;
        next = await this.create(model, { executionProviders: ["wasm"] });
      }
    }
    if (actual === "wasm" && precision === "float16" && requested !== "cpu")
      this.precisionFallbackReason = `${this.precisionFallbackReason ?? "FP16 unavailable"}; using FP32 CPU`;
    // Outside the GPU create catch: invalid profiles cannot fall back.
    const metadata = await this.accept(
      next,
      actual,
      start,
      fallbackReason,
      preparation,
    );
    if (requested === "auto" && actual === "webgpu") this.model = model;
    return metadata;
  }

  private async prepareFp32(model: ArrayBuffer) {
    // Reuse the prepared graph on first-execution precision fallback.
    this.prepared ??=
      this.compatibilityFixes === false
        ? {
            model,
            compatibilityAnalysis:
              this.compatibilityAnalysis ?? (await this.inspect(model)),
          }
        : await this.prepare(model, this.compatibilityFixes);
    this.compatibilityAnalysis = this.prepared.compatibilityAnalysis;
    return this.prepared;
  }

  private async retryCpu(reason: string) {
    const start = performance.now();
    const next = await this.create(this.model!, {
      executionProviders: ["wasm"],
    });
    if (this.requestedPrecision === "float16")
      this.precisionFallbackReason = `${this.precisionFallbackReason ?? "FP16 unavailable"}; using FP32 CPU`;
    await this.accept(next, "wasm", start, reason);
    return next;
  }

  private async retryFp32() {
    const start = performance.now();
    const prepared = await this.prepareFp32(this.model!);
    let next: ort.InferenceSession;
    try {
      next = await this.create(prepared.model, WEBGPU_SESSION_OPTIONS);
    } catch (error) {
      const reason = `WebGPU initialization failed: ${message(error)}`;
      if (this.requested !== "auto") throw new Error(reason);
      return this.retryCpu(reason);
    }
    // Invalid profiles must not trigger either precision or provider retries.
    await this.accept(next, "webgpu", start, undefined, prepared.preparation);
    return next;
  }

  private async runFp32(feeds: ort.InferenceSession.FeedsType) {
    try {
      return await this.session!.run(feeds);
    } catch (error) {
      if (this.metadata?.actualProvider !== "webgpu") throw error;
      if (this.requested !== "auto")
        throw new Error(`WebGPU execution failed: ${message(error)}`);
      await this.session!.release();
      this.session = undefined;
      const next = await this.retryCpu(
        `WebGPU first execution failed: ${message(error)}`,
      );
      return next.run(feeds);
    }
  }

  async run(feeds: ort.InferenceSession.FeedsType) {
    if (this.session === undefined)
      throw new Error("Load a model before running inference");
    try {
      let outputs: ort.InferenceSession.ReturnType;
      try {
        outputs = await this.session.run(feeds);
      } catch (error) {
        if (this.metadata?.actualProvider !== "webgpu") throw error;
        if (!this.firstRun || this.model === undefined)
          throw new Error(`WebGPU execution failed: ${message(error)}`);
        if (this.metadata.actualPrecision === "float16") {
          this.precisionFallbackReason = `FP16 first execution failed: ${message(error)}; using FP32 WebGPU`;
          await this.session.release();
          this.session = undefined;
          await this.retryFp32();
          outputs = await this.runFp32(feeds);
        } else {
          if (this.requested !== "auto")
            throw new Error(`WebGPU execution failed: ${message(error)}`);
          const reason = `WebGPU first execution failed: ${message(error)}`;
          await this.session.release();
          this.session = undefined;
          const next = await this.retryCpu(reason);
          outputs = await next.run(feeds);
        }
      }
      return outputs;
    } finally {
      this.firstRun = false;
      this.model = undefined;
      this.prepared = undefined;
    }
  }
}
