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

import {
  blendCroppedTile,
  getInferenceStrides,
  getRetainedOutputShape,
  makeWuPatchMask,
  planBlendedInferenceTiles,
  stitchCroppedTile,
  type InferenceGeometry,
  type Zyx,
} from "#src/inference/geometry.js";
import type { PreparedInferenceInput } from "#src/inference/input.js";
import {
  MAX_MODEL_BYTES,
  MAX_RESULT_BYTES,
  MAX_TILES,
  makeModelGeometry,
  validateModelGeometry,
  type InferenceProvider,
  type InferencePrecision,
  type InferenceResult,
  type InferenceWorkerRequest,
  type InferenceWorkerResponse,
  type ModelMetadata,
} from "#src/inference/model.js";

export interface RunInferenceOptions {
  originZYX: number[];
  shapeZYX: number[];
  /** Defaults to geometry inferred from the loaded model on the input grid. */
  geometry?: InferenceGeometry;
  /** Half-input-stride Wu blending by default; false directly stitches retained outputs. */
  overlap?: boolean;
}

function triple(values: readonly number[]): Zyx {
  if (values.length !== 3) throw new Error("Expected a ZYX triple");
  return [values[0], values[1], values[2]];
}

export class OnnxInferenceController {
  private worker: Worker | undefined;
  private requestId = 0;
  private generation = 0;
  private disposed = false;
  private active: object | undefined;
  private abort: AbortController | undefined;
  private file: File | undefined;
  private metadata: ModelMetadata | undefined;
  private provider: InferenceProvider = "auto";
  private compatibilityFixes: boolean | undefined;
  private precision: InferencePrecision | undefined;
  private readonly patchCache = new Map<string, Float32Array>();
  private patchCacheBytes = 0;
  // Pure geometry only: independent of prediction cache invalidation/lifecycle.
  private wuMaskCache: { key: string; mask: Float32Array } | undefined;
  private cacheInput: PreparedInferenceInput | undefined;
  private cacheConfig: string | undefined;
  private cacheMetadata: string | undefined;
  private readonly onCacheInputAborted = () => this.releaseCacheInput();
  /** Includes worker reloads and first-execution Auto fallback, not just loads. */
  onMetadata: (metadata: ModelMetadata) => void = () => {};
  private pending = new Map<
    number,
    {
      resolve: (response: InferenceWorkerResponse) => void;
      reject: (error: unknown) => void;
    }
  >();

  constructor(
    private readonly workerFactory = () =>
      new Worker(
        /* webpackChunkName: "neuroglancer_inference_worker" */
        new URL("../inference_worker.bundle.js", import.meta.url),
        { type: "module" },
      ),
    private readonly patchCacheBudget = 128 * 1024 * 1024,
  ) {
    if (!Number.isSafeInteger(patchCacheBudget) || patchCacheBudget < 0)
      throw new Error("Patch cache budget must be a nonnegative safe integer");
  }

  private clearPatchCache() {
    this.patchCache.clear();
    this.patchCacheBytes = 0;
  }

  private getWuPatchMask(retainedShape: Zyx, outputStride: Zyx) {
    const key = JSON.stringify([retainedShape, outputStride]);
    if (this.wuMaskCache?.key !== key) {
      this.wuMaskCache = {
        key,
        mask: makeWuPatchMask(retainedShape, outputStride),
      };
    }
    return this.wuMaskCache.mask;
  }

  private releaseCacheInput() {
    this.clearPatchCache();
    this.cacheInput?.signal?.removeEventListener(
      "abort",
      this.onCacheInputAborted,
    );
    this.cacheInput = undefined;
    this.cacheConfig = undefined;
  }

  private cachePatch(key: string, output: Float32Array) {
    if (output.byteLength > this.patchCacheBudget) return;
    while (this.patchCacheBytes + output.byteLength > this.patchCacheBudget) {
      const oldest = this.patchCache.keys().next().value!;
      this.patchCacheBytes -= this.patchCache.get(oldest)!.byteLength;
      this.patchCache.delete(oldest);
    }
    this.patchCache.set(key, output);
    this.patchCacheBytes += output.byteLength;
  }

  private getWorker() {
    if (this.disposed) throw new Error("Inference controller is disposed");
    if (this.worker !== undefined) return this.worker;
    const worker = this.workerFactory();
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<InferenceWorkerResponse>) => {
      if (this.worker !== worker) return;
      const response = event.data;
      const request = this.pending.get(response.id);
      if (request === undefined) return;
      this.pending.delete(response.id);
      if (response.metadata !== undefined) {
        // Compare values, not object identity: normal responses carry fresh metadata.
        const {
          requestedProvider,
          actualProvider,
          fallbackReason,
          preparation,
          compatibilityFixes,
          compatibilityAnalysis,
          requestedPrecision,
          actualPrecision,
          precisionFallbackReason,
        } = response.metadata;
        const signature = JSON.stringify([
          requestedProvider,
          actualProvider,
          fallbackReason,
          preparation,
          compatibilityFixes,
          compatibilityAnalysis,
          requestedPrecision,
          actualPrecision,
          precisionFallbackReason,
          response.metadata.inputNames,
          response.metadata.outputNames,
          response.metadata.inputShape,
          response.metadata.outputShape,
        ]);
        if (signature !== this.cacheMetadata) this.clearPatchCache();
        this.cacheMetadata = signature;
        this.metadata = response.metadata;
        this.onMetadata(response.metadata);
      }
      if (response.kind === "error") {
        this.clearPatchCache();
        request.reject(new Error(response.message));
      } else request.resolve(response);
    };
    worker.onerror = (event) => {
      if (this.worker !== worker) return;
      this.stopWorker(new Error(`Inference worker failed: ${event.message}`));
    };
    return worker;
  }

  private request(request: InferenceWorkerRequest, transfer: Transferable[]) {
    const worker = this.getWorker();
    return new Promise<InferenceWorkerResponse>((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
      try {
        worker.postMessage(request, transfer);
      } catch (error) {
        this.clearPatchCache();
        this.pending.delete(request.id);
        reject(error);
      }
    });
  }

  private stopWorker(error: Error) {
    this.releaseCacheInput();
    this.cacheMetadata = undefined;
    this.worker?.terminate();
    this.worker = undefined;
    this.metadata = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  cancel() {
    ++this.generation;
    this.abort?.abort();
    this.abort = undefined;
    this.active = undefined;
    this.stopWorker(new DOMException("Inference canceled", "AbortError"));
  }

  dispose() {
    this.cancel();
    this.disposed = true;
    this.file = undefined;
    this.wuMaskCache = undefined;
  }

  private async initialize(file: File, generation: number) {
    const model = await file.arrayBuffer();
    if (generation !== this.generation || this.disposed)
      throw new DOMException("Inference canceled", "AbortError");
    const response = await this.request(
      {
        id: ++this.requestId,
        kind: "load",
        model,
        provider: this.provider,
        ...(this.precision === undefined ? {} : { precision: this.precision }),
        ...(this.compatibilityFixes === undefined
          ? {}
          : { compatibilityFixes: this.compatibilityFixes }),
      },
      [model],
    );
    if (response.kind !== "loaded")
      throw new Error("Invalid inference worker initialization response");
    if (generation !== this.generation)
      throw new DOMException("Inference canceled", "AbortError");
    this.metadata = response.metadata;
    return response.metadata;
  }

  async loadModel(
    file: File,
    provider: InferenceProvider = "auto",
    compatibilityFixes?: boolean,
    precision?: InferencePrecision,
  ): Promise<ModelMetadata> {
    if (this.active)
      throw new Error(
        "Cancel or finish the active inference job before selecting a model",
      );
    if (file.size === 0 || file.size > MAX_MODEL_BYTES)
      throw new Error("Local ONNX file must be nonempty and at most 256 MiB");
    this.cancel();
    this.file = undefined;
    this.provider = provider;
    this.compatibilityFixes = compatibilityFixes;
    this.precision = precision;
    const operation = (this.active = {});
    try {
      const metadata = await this.initialize(file, this.generation);
      this.file = file;
      return metadata;
    } finally {
      if (this.active === operation) this.active = undefined;
    }
  }

  async run(
    input: PreparedInferenceInput,
    options: RunInferenceOptions,
    onProgress: (completed: number, total: number) => void = () => {},
  ): Promise<InferenceResult> {
    if (this.active) throw new Error("An inference job is already active");
    if (this.file === undefined)
      throw new Error("Select and load a local ONNX model first");
    // Snapshot caller geometry before a possible asynchronous worker reload.
    const suppliedGeometry =
      options.geometry === undefined
        ? undefined
        : structuredClone(options.geometry);
    const overlap = options.overlap ?? true;
    const roi = {
      origin: triple(options.originZYX),
      shape: triple(options.shapeZYX),
    };
    // Snapshot mutable fixture/source fields as values as well as retaining input
    // identity. Only the current source + geometry is cached.
    const sourceConfig = () =>
      JSON.stringify([
        input.originZYX,
        input.shapeZYX,
        input.spacingZYX,
        input.axisNamesZYX,
        input.unitsZYX,
        input.validitySnapshot,
      ]);
    const sourceSnapshot = sourceConfig();
    const generation = this.generation;
    const abort = (this.abort = new AbortController());
    const check = () => {
      abort.signal.throwIfAborted();
      if (
        generation !== this.generation ||
        !input.isValid() ||
        input.signal?.aborted ||
        sourceConfig() !== sourceSnapshot
      )
        throw new Error(
          "Inference source changed; rerun with the current source",
        );
    };
    const operation = (this.active = {});
    try {
      check();
      if (this.metadata === undefined)
        await this.initialize(this.file, generation);
      check();
      const geometry =
        suppliedGeometry ??
        makeModelGeometry(this.metadata!, triple(input.spacingZYX));
      validateModelGeometry(this.metadata!, geometry);
      if (!geometry.inputSpacing.every((x, i) => x === input.spacingZYX[i]))
        throw new Error(
          "Inference geometry input spacing must match the prepared input",
        );
      const { tiles, total } = planBlendedInferenceTiles(
        geometry,
        roi,
        {
          inputBounds: {
            origin: triple(input.originZYX),
            shape: triple(input.shapeZYX),
          },
          maxTiles: MAX_TILES,
        },
        overlap,
      );
      const elements = roi.shape.reduce(
        (a, b) => a * b,
        geometry.outputChannels,
      );
      if (!Number.isSafeInteger(elements) || elements * 4 > MAX_RESULT_BYTES)
        throw new Error(
          "Prediction result exceeds the 256 MiB session result limit",
        );
      const config = JSON.stringify([
        sourceSnapshot,
        this.precision,
        geometry,
        overlap,
      ]);
      if (this.cacheInput !== input || this.cacheConfig !== config) {
        this.releaseCacheInput();
        // Do not retain an already disposed source: abort events do not replay.
        if (!input.signal?.aborted) {
          this.cacheInput = input;
          this.cacheConfig = config;
          input.signal?.addEventListener("abort", this.onCacheInputAborted, {
            once: true,
          });
        }
      }
      const data = new Float32Array(elements);
      const weights = overlap
        ? new Float64Array(elements / geometry.outputChannels)
        : undefined;
      const retainedShape = getRetainedOutputShape(geometry);
      const { inputStride, outputStride } = getInferenceStrides(
        geometry,
        overlap,
      );
      const patchMask = overlap
        ? this.getWuPatchMask(retainedShape, outputStride)
        : undefined;
      let completed = 0;
      onProgress(0, total);
      for (const tile of tiles) {
        check();
        const key = JSON.stringify([tile.input.origin, tile.input.shape]);
        let output = this.patchCache.get(key);
        const cached = output !== undefined;
        if (output === undefined) {
          const patch = await input.readPatch(
            [...tile.input.origin],
            [...tile.input.shape],
            abort.signal,
          );
          check();
          for (let i = 0; i < patch.length; ++i) {
            if (!Number.isFinite(patch[i]))
              throw new Error("Inference input values must be finite");
          }
          const response = await this.request(
            { id: ++this.requestId, kind: "run", input: patch, geometry },
            [patch.buffer],
          );
          check();
          if (
            response.kind !== "output" ||
            !(response.output instanceof Float32Array)
          )
            throw new Error("Invalid inference worker output response");
          output = response.output;
        }
        if (overlap) {
          blendCroppedTile(
            output,
            data,
            weights!,
            geometry,
            roi,
            tile.output,
            patchMask!,
          );
        } else {
          stitchCroppedTile(output, data, geometry, roi, tile.output);
        }
        // Both stitch helpers validate the entire prediction and never mutate it.
        // Cache only successful, full cropped predictions, never ROI result data.
        if (cached) {
          this.patchCache.delete(key);
          this.patchCache.set(key, output);
        } else {
          this.cachePatch(key, output);
        }
        onProgress(++completed, total);
      }
      check();
      if (weights !== undefined) {
        for (const weight of weights) {
          if (!Number.isFinite(weight) || weight <= 0)
            throw new Error("Inference blending left uncovered output voxels");
        }
      } else if (completed !== total) {
        // With outputStride === retainedShape the source-anchored Cartesian
        // lattice partitions the valid bounds. The planner selects precisely
        // every ROI-intersecting tile; copying all of them proves coverage with
        // no holes or overlap, without allocating per-voxel weights/coverage.
        throw new Error("Inference stitching left uncovered output voxels");
      }
      return {
        data,
        shapeZYX: [...roi.shape],
        originZYX: [...roi.origin],
        spacingZYX: [...geometry.outputSpacing],
        axisNamesZYX: [...input.axisNamesZYX],
        unitsZYX: [...input.unitsZYX],
        channels: geometry.outputChannels,
        provenance: {
          modelName: this.file.name,
          modelBytes: this.file.size,
          profile: "nooverseg-ncdhw-native-grid-v1",
          requestedProvider: this.metadata!.requestedProvider,
          actualProvider: this.metadata!.actualProvider,
          ...(this.metadata!.requestedPrecision === undefined
            ? {}
            : { requestedPrecision: this.metadata!.requestedPrecision }),
          ...(this.metadata!.actualPrecision === undefined
            ? {}
            : { actualPrecision: this.metadata!.actualPrecision }),
          ...(this.metadata!.precisionFallbackReason === undefined
            ? {}
            : {
                precisionFallbackReason: this.metadata!.precisionFallbackReason,
              }),
          ...(this.metadata!.fallbackReason === undefined
            ? {}
            : { fallbackReason: this.metadata!.fallbackReason }),
          ...(this.metadata!.preparation === undefined
            ? {}
            : { preparation: this.metadata!.preparation }),
          ...(this.compatibilityFixes === undefined
            ? {}
            : { compatibilityFixes: this.compatibilityFixes }),
          ...(this.metadata!.compatibilityAnalysis === undefined
            ? {}
            : {
                compatibilityAnalysis: {
                  ...this.metadata!.compatibilityAnalysis,
                  fixes: [...this.metadata!.compatibilityAnalysis.fixes],
                },
              }),
          geometry: { ...geometry },
          blending: {
            method: overlap ? "wu" : "none",
            inputStrideZYX: [...inputStride],
            retainedOutputShapeZYX: [...retainedShape],
          },
          completedTiles: completed,
          outputChannels: Array.from(
            { length: geometry.outputChannels },
            (_, i) => `output ${i}`,
          ),
          note: "Channel semantics and training normalization require user confirmation; shape-derived output spacing assumes matching fields of view.",
        },
      };
    } catch (error) {
      // An older canceled operation must not clear a newer operation's cache.
      if (generation === this.generation) this.clearPatchCache();
      throw error;
    } finally {
      if (this.active === operation) this.active = undefined;
      if (this.abort === abort) this.abort = undefined;
    }
  }
}
