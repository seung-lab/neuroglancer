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
  getPlannedTileInputBounds,
  getRetainedOutputShape,
  makeWuPatchMask,
  planBlendedInferenceTiles,
  stitchCroppedTile,
  type InferenceGeometry,
  type InferenceTile,
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
import { StatusMessage } from "#src/status.js";

export interface RunInferenceOptions {
  originZYX: number[];
  shapeZYX: number[];
  /** Defaults to geometry inferred from the loaded model on the input grid. */
  geometry?: InferenceGeometry;
  /** Half-input-stride Wu blending by default; false directly stitches retained outputs. */
  overlap?: boolean;
  /** Cancels this run without terminating shared workers or clearing cached patches. */
  signal?: AbortSignal;
  /** Invoked once when the first worker run request of this call has been dispatched. */
  onFirstRunDispatched?: () => void;
}

declare const NEUROGLANCER_INFERENCE_PATCH_CACHE_MIB: number | undefined;
declare const NEUROGLANCER_INFERENCE_MAX_WEBGPU_WORKERS: number | undefined;

const DEFAULT_PATCH_CACHE_MIB =
  typeof NEUROGLANCER_INFERENCE_PATCH_CACHE_MIB === "number" &&
  Number.isFinite(NEUROGLANCER_INFERENCE_PATCH_CACHE_MIB)
    ? Math.max(0, Math.min(512, NEUROGLANCER_INFERENCE_PATCH_CACHE_MIB))
    : 128;

export const DEFAULT_PATCH_CACHE_BYTES = Math.round(
  DEFAULT_PATCH_CACHE_MIB * 1024 * 1024,
);

const DEFAULT_MAX_WEBGPU_WORKERS: 1 | 2 | 3 =
  typeof NEUROGLANCER_INFERENCE_MAX_WEBGPU_WORKERS === "number" &&
  Number.isSafeInteger(NEUROGLANCER_INFERENCE_MAX_WEBGPU_WORKERS) &&
  NEUROGLANCER_INFERENCE_MAX_WEBGPU_WORKERS >= 1 &&
  NEUROGLANCER_INFERENCE_MAX_WEBGPU_WORKERS <= 3
    ? (NEUROGLANCER_INFERENCE_MAX_WEBGPU_WORKERS as 1 | 2 | 3)
    : 1;

function triple(values: readonly number[]): Zyx {
  if (values.length !== 3) throw new Error("Expected a ZYX triple");
  return [values[0], values[1], values[2]];
}

function sameArray<T>(a: readonly T[], b: readonly T[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; ++i) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Checks auxiliary-session compatibility with canonical execution. */
export function matchesCanonicalExecution(
  canonical: ModelMetadata,
  candidate: ModelMetadata | undefined,
): boolean {
  if (candidate === undefined) return false;
  if (canonical.actualProvider !== "webgpu") return false;
  if (candidate.actualProvider !== "webgpu") return false;
  if (
    (canonical.actualPrecision ?? "float32") !==
    (candidate.actualPrecision ?? "float32")
  )
    return false;
  if ((canonical.preparation ?? "as-is") !== (candidate.preparation ?? "as-is"))
    return false;
  if (
    Boolean(canonical.compatibilityFixes) !==
    Boolean(candidate.compatibilityFixes)
  )
    return false;
  if (!sameArray(canonical.inputNames, candidate.inputNames)) return false;
  if (!sameArray(canonical.outputNames, candidate.outputNames)) return false;
  if (!sameArray(canonical.inputShape, candidate.inputShape)) return false;
  if (!sameArray(canonical.outputShape, candidate.outputShape)) return false;
  return true;
}

interface AuxWorkerSlot {
  worker: Worker;
  busy: boolean;
  ready: boolean;
  retired: boolean;
  pending: Map<
    number,
    {
      resolve: (response: InferenceWorkerResponse) => void;
      reject: (error: unknown) => void;
    }
  >;
}

interface InflightPatch {
  promise: Promise<Float32Array>;
  abort: AbortController;
  waiters: number;
  startedOnWorker: boolean;
  minOrder: number;
}

export class OnnxInferenceController {
  private worker: Worker | undefined;
  private primaryBusy = false;
  private auxSlots: AuxWorkerSlot[] = [];
  private auxModelBytes: Uint8Array | undefined;
  private auxSpinningUp = false;
  private auxScalingCapped = false;
  private canonicalMetadata: ModelMetadata | undefined;
  private poolWaiters: { order: number; wake: () => void }[] = [];
  private inflightPatches = new Map<string, InflightPatch>();
  private runSequence = 0;
  private requestId = 0;
  private generation = 0;
  private disposed = false;
  private loadingOperation: object | undefined;
  private activeRunSet = new Set<object>();
  private get active(): object | undefined {
    if (this.loadingOperation !== undefined) return this.loadingOperation;
    for (const op of this.activeRunSet) return op;
    return undefined;
  }
  private abort: AbortController | undefined;
  private file: File | undefined;
  private metadata: ModelMetadata | undefined;
  private provider: InferenceProvider = "auto";
  private compatibilityFixes: boolean | undefined;
  private precision: InferencePrecision | undefined;
  private warnedMissingSubgroupMatrix = false;
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
    private readonly patchCacheBudget = DEFAULT_PATCH_CACHE_BYTES,
    private readonly maxWebGpuWorkers = DEFAULT_MAX_WEBGPU_WORKERS,
  ) {
    if (!Number.isSafeInteger(patchCacheBudget) || patchCacheBudget < 0)
      throw new Error("Patch cache budget must be a nonnegative safe integer");
    if (
      !Number.isSafeInteger(maxWebGpuWorkers) ||
      maxWebGpuWorkers < 1 ||
      maxWebGpuWorkers > 3
    )
      throw new Error("WebGPU worker pool size must be 1, 2, or 3");
  }

  /** Whether live-tile cancellation can preserve shared workers. */
  get supportsRunSignal(): boolean {
    return this.allowsConcurrentRuns;
  }

  private get allowsConcurrentRuns() {
    if (
      this.maxWebGpuWorkers <= 1 ||
      this.metadata?.actualProvider !== "webgpu" ||
      this.metadata.inputShape[0] !== 1
    ) {
      return false;
    }
    if (this.canonicalMetadata !== undefined) {
      return (
        this.canonicalMetadata.actualProvider === "webgpu" &&
        this.canonicalMetadata.inputShape[0] === 1
      );
    }
    return true;
  }

  /** Live-run concurrency stays at one until canonical execution is validated. */
  get maxConcurrentRuns() {
    if (!this.allowsConcurrentRuns) return 1;
    if (this.canonicalMetadata === undefined) return 1;
    return this.maxWebGpuWorkers * 2;
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
    const previous = this.patchCache.get(key);
    if (previous !== undefined) {
      this.patchCache.delete(key);
      this.patchCacheBytes -= previous.byteLength;
    }
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

  private stopAuxSlots(error: Error) {
    const slots = this.auxSlots.slice();
    this.auxSlots = [];
    this.auxSpinningUp = false;
    for (const slot of slots) {
      slot.retired = true;
      slot.ready = false;
      slot.worker.terminate();
      for (const pending of slot.pending.values()) pending.reject(error);
      slot.pending.clear();
    }
  }

  private retireAuxSlot(slot: AuxWorkerSlot, error: Error) {
    slot.retired = true;
    slot.ready = false;
    const idx = this.auxSlots.indexOf(slot);
    if (idx !== -1) this.auxSlots.splice(idx, 1);
    slot.worker.terminate();
    for (const pending of slot.pending.values()) pending.reject(error);
    slot.pending.clear();
  }

  private notifyNextPoolWaiter() {
    if (this.poolWaiters.length === 0) return;
    let bestIdx = 0;
    for (let i = 1; i < this.poolWaiters.length; ++i) {
      if (this.poolWaiters[i].order < this.poolWaiters[bestIdx].order) {
        bestIdx = i;
      }
    }
    const [chosen] = this.poolWaiters.splice(bestIdx, 1);
    chosen.wake();
  }

  private createAuxSlot(): AuxWorkerSlot {
    const worker = this.workerFactory();
    try {
      worker.postMessage({ wasmThreads: 1 });
    } catch {
      // Mock unit-test workers or unusual environments may ignore config hints.
    }
    const slot: AuxWorkerSlot = {
      worker,
      busy: false,
      ready: false,
      retired: false,
      pending: new Map(),
    };
    this.auxSlots.push(slot);
    worker.onmessage = (event: MessageEvent<InferenceWorkerResponse>) => {
      if (slot.retired) return;
      const response = event.data;
      const req = slot.pending.get(response.id);
      if (req === undefined) return;
      slot.pending.delete(response.id);
      if (response.kind === "error") {
        req.reject(new Error(response.message));
      } else {
        req.resolve(response);
      }
    };
    worker.onerror = (event) => {
      if (slot.retired) return;
      this.auxScalingCapped = true;
      this.retireAuxSlot(
        slot,
        new Error(`Auxiliary inference worker failed: ${event.message}`),
      );
      this.notifyNextPoolWaiter();
    };
    return slot;
  }

  private requestAux(
    slot: AuxWorkerSlot,
    request: InferenceWorkerRequest,
    transfer: Transferable[],
  ) {
    return new Promise<InferenceWorkerResponse>((resolve, reject) => {
      slot.pending.set(request.id, { resolve, reject });
      try {
        slot.worker.postMessage(request, transfer);
      } catch (error) {
        slot.pending.delete(request.id);
        reject(error);
      }
    });
  }

  private maybeScaleAuxWorkers(generation: number) {
    if (
      this.disposed ||
      generation !== this.generation ||
      this.auxSpinningUp ||
      this.auxScalingCapped ||
      this.maxWebGpuWorkers <= 1 ||
      this.auxModelBytes === undefined ||
      this.canonicalMetadata === undefined ||
      this.canonicalMetadata.actualProvider !== "webgpu" ||
      this.canonicalMetadata.inputShape[0] !== 1
    )
      return;
    const readyCount = this.auxSlots.filter(
      (s) => s.ready && !s.retired,
    ).length;
    if (readyCount >= this.maxWebGpuWorkers - 1) return;
    if (this.poolWaiters.length === 0) return;

    const canonical = this.canonicalMetadata;
    const canonicalPrecision: InferencePrecision =
      canonical.actualPrecision ?? "float32";
    this.auxSpinningUp = true;
    const modelBytes = this.auxModelBytes;
    void (async () => {
      try {
        while (
          !this.disposed &&
          generation === this.generation &&
          !this.auxScalingCapped &&
          this.canonicalMetadata === canonical &&
          this.auxSlots.filter((s) => s.ready && !s.retired).length <
            this.maxWebGpuWorkers - 1 &&
          this.poolWaiters.length > 0
        ) {
          const copy = modelBytes.slice().buffer;
          const slot = this.createAuxSlot();
          try {
            const response = await this.requestAux(
              slot,
              {
                id: ++this.requestId,
                kind: "load",
                model: copy,
                provider: "webgpu",
                precision: canonicalPrecision,
                ...(this.compatibilityFixes === undefined
                  ? {}
                  : { compatibilityFixes: this.compatibilityFixes }),
              },
              [copy],
            );
            if (
              this.disposed ||
              generation !== this.generation ||
              slot.retired ||
              this.canonicalMetadata !== canonical ||
              response.kind !== "loaded" ||
              !matchesCanonicalExecution(canonical, response.metadata)
            ) {
              if (!slot.retired) {
                if (
                  !this.disposed &&
                  generation === this.generation &&
                  this.canonicalMetadata === canonical
                ) {
                  this.auxScalingCapped = true;
                }
                this.retireAuxSlot(
                  slot,
                  new Error(
                    "Auxiliary WebGPU worker did not match canonical session metadata",
                  ),
                );
              }
              break;
            }
            slot.ready = true;
            this.notifyNextPoolWaiter();
          } catch {
            if (!slot.retired) {
              this.auxScalingCapped = true;
              this.retireAuxSlot(
                slot,
                new Error("Auxiliary WebGPU worker failed to initialize"),
              );
            }
            break;
          }
        }
      } catch {
        // Allocation and Worker construction can fail before a slot exists.
        // This detached task must never reject or repeatedly retry a bad pool.
        if (generation === this.generation && !this.disposed) {
          this.auxScalingCapped = true;
          this.notifyNextPoolWaiter();
        }
      } finally {
        if (generation === this.generation) {
          this.auxSpinningUp = false;
        }
      }
    })();
  }

  private async acquireWorkerSlot(
    check: () => void,
    generation: number,
    order: number,
    signal: AbortSignal,
  ): Promise<{ kind: "primary" } | { kind: "aux"; slot: AuxWorkerSlot }> {
    try {
      for (;;) {
        check();
        if (!this.primaryBusy) {
          this.primaryBusy = true;
          return { kind: "primary" };
        }
        if (this.canonicalMetadata?.actualProvider === "webgpu") {
          for (const slot of this.auxSlots) {
            if (slot.ready && !slot.retired && !slot.busy) {
              slot.busy = true;
              return { kind: "aux", slot };
            }
          }
          this.maybeScaleAuxWorkers(generation);
        }
        await new Promise<void>((resolve) => {
          const wake = () => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          };
          const waiter = { order, wake };
          const onAbort = () => {
            const index = this.poolWaiters.indexOf(waiter);
            if (index !== -1) this.poolWaiters.splice(index, 1);
            wake();
          };
          this.poolWaiters.push(waiter);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
      }
    } catch (error) {
      // A selected waiter can abort after handoff but before claiming the slot.
      // Pass the free slot onward rather than stranding the next valid waiter.
      this.notifyNextPoolWaiter();
      throw error;
    }
  }

  private releaseWorkerSlot(
    leased: { kind: "primary" } | { kind: "aux"; slot: AuxWorkerSlot },
  ) {
    if (leased.kind === "primary") {
      this.primaryBusy = false;
    } else {
      leased.slot.busy = false;
    }
    this.notifyNextPoolWaiter();
  }

  private async runOnPooledWorker(
    patch: Float32Array,
    geometry: InferenceGeometry,
    check: () => void,
    generation: number,
    order: number,
    signal: AbortSignal,
    onDispatched: () => void,
  ): Promise<InferenceWorkerResponse> {
    check();
    for (let i = 0; i < patch.length; ++i) {
      if (!Number.isFinite(patch[i]))
        throw new Error("Inference input values must be finite");
    }
    if (
      !this.warnedMissingSubgroupMatrix &&
      this.metadata!.actualProvider === "webgpu" &&
      this.metadata!.webgpuSubgroupMatrix === false
    ) {
      this.warnedMissingSubgroupMatrix = true;
      StatusMessage.showTemporaryMessage(
        "ONNX inference is running without submatrix matmul acceleration. Enable experimental WebGPU support (Unsafe WebGPU Support) at chrome://flags/#enable-unsafe-webgpu and restart Chrome. On NVIDIA GPUs, also launch Chrome with --enable-dawn-features=vulkan_enable_f16_on_nvidia. Requires compatible hardware and drivers.",
        20_000,
      );
    }
    const leased = await this.acquireWorkerSlot(
      check,
      generation,
      order,
      signal,
    );
    try {
      check();
      const req: InferenceWorkerRequest = {
        id: ++this.requestId,
        kind: "run",
        input: patch,
        geometry,
      };
      if (leased.kind === "primary") {
        const pending = this.request(req, [patch.buffer]);
        onDispatched();
        const response = await pending;
        if (
          response.kind === "output" &&
          generation === this.generation &&
          !this.disposed
        ) {
          const updatedMeta = response.metadata ?? this.metadata!;
          if (this.canonicalMetadata === undefined) {
            this.canonicalMetadata = updatedMeta;
            if (updatedMeta.actualProvider !== "webgpu") {
              this.auxScalingCapped = true;
              this.stopAuxSlots(
                new Error(
                  "Primary session fell back from WebGPU; auxiliary WebGPU pool disabled",
                ),
              );
            }
          } else if (
            this.canonicalMetadata.actualProvider === "webgpu" &&
            !matchesCanonicalExecution(this.canonicalMetadata, updatedMeta)
          ) {
            // A later change would mix already-blended predictions in every
            // active ROI. Only the first execution may establish a new mode.
            this.cancel();
            throw new Error(
              "Primary inference execution changed after canonical validation",
            );
          }
        }
        return response;
      }
      let response: InferenceWorkerResponse;
      try {
        const pending = this.requestAux(leased.slot, req, [patch.buffer]);
        onDispatched();
        response = await pending;
      } catch (error) {
        if (generation === this.generation && !this.disposed) {
          this.auxScalingCapped = true;
          if (!leased.slot.retired) {
            this.retireAuxSlot(
              leased.slot,
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        }
        throw error;
      }
      if (generation === this.generation && !this.disposed) {
        const canonical = this.canonicalMetadata;
        if (
          canonical === undefined ||
          response.kind !== "output" ||
          !matchesCanonicalExecution(canonical, response.metadata)
        ) {
          this.auxScalingCapped = true;
          this.retireAuxSlot(
            leased.slot,
            new Error(
              "Auxiliary WebGPU worker execution diverged from canonical primary session",
            ),
          );
          throw new Error(
            "Auxiliary WebGPU worker execution diverged from canonical primary session; refusing to mix outputs",
          );
        }
      }
      return response;
    } finally {
      this.releaseWorkerSlot(leased);
    }
  }

  private stopWorker(error: Error) {
    this.releaseCacheInput();
    this.cacheMetadata = undefined;
    this.canonicalMetadata = undefined;
    this.auxScalingCapped = false;
    this.worker?.terminate();
    this.worker = undefined;
    this.primaryBusy = false;
    this.metadata = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.stopAuxSlots(error);
    for (const inflight of this.inflightPatches.values()) {
      inflight.abort.abort(error);
    }
    this.inflightPatches.clear();
    const waiters = this.poolWaiters.splice(0);
    for (const w of waiters) w.wake();
  }

  cancel() {
    ++this.generation;
    this.abort?.abort(new DOMException("Inference canceled", "AbortError"));
    this.abort = undefined;
    this.loadingOperation = undefined;
    this.activeRunSet.clear();
    this.stopWorker(new DOMException("Inference canceled", "AbortError"));
  }

  dispose() {
    this.cancel();
    this.disposed = true;
    this.file = undefined;
    this.auxModelBytes = undefined;
    this.wuMaskCache = undefined;
  }

  private async initialize(file: File, generation: number) {
    const model = await file.arrayBuffer();
    if (generation !== this.generation || this.disposed)
      throw new DOMException("Inference canceled", "AbortError");
    const auxTemplate =
      this.maxWebGpuWorkers > 1 && this.provider !== "cpu"
        ? new Uint8Array(model.slice(0))
        : undefined;
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
    this.canonicalMetadata = undefined;
    this.auxScalingCapped = response.metadata.actualProvider !== "webgpu";
    this.auxModelBytes =
      response.metadata.actualProvider === "webgpu" &&
      response.metadata.inputShape[0] === 1
        ? auxTemplate
        : undefined;
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
    this.auxModelBytes = undefined;
    this.provider = provider;
    this.compatibilityFixes = compatibilityFixes;
    this.precision = precision;
    const operation = (this.loadingOperation = {});
    try {
      const metadata = await this.initialize(file, this.generation);
      this.file = file;
      return metadata;
    } finally {
      if (this.loadingOperation === operation)
        this.loadingOperation = undefined;
    }
  }

  async run(
    input: PreparedInferenceInput,
    options: RunInferenceOptions,
    onProgress: (completed: number, total: number) => void = () => {},
  ): Promise<InferenceResult> {
    if (this.loadingOperation !== undefined)
      throw new Error("An inference job is already active");
    if (
      this.activeRunSet.size > 0 &&
      (!this.allowsConcurrentRuns ||
        this.activeRunSet.size >= this.maxConcurrentRuns)
    )
      throw new Error("An inference job is already active");
    if (this.file === undefined)
      throw new Error("Select and load a local ONNX model first");
    const callerSignal = options.signal;
    callerSignal?.throwIfAborted();
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
    const runOrder = ++this.runSequence;
    if (this.abort === undefined || this.abort.signal.aborted) {
      this.abort = new AbortController();
    }
    const controllerAbort = this.abort;
    const abort = new AbortController();
    const onControllerAbort = () => abort.abort(controllerAbort.signal.reason);
    const onCallerAbort = () => abort.abort(callerSignal?.reason);
    controllerAbort.signal.addEventListener("abort", onControllerAbort, {
      once: true,
    });
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    const check = () => {
      callerSignal?.throwIfAborted();
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
    const operation = {};
    this.activeRunSet.add(operation);
    let usePooledScheduler =
      this.allowsConcurrentRuns || callerSignal !== undefined;
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
      if (
        (this.activeRunSet.size > 1 || this.inflightPatches.size > 0) &&
        (this.cacheInput !== input || this.cacheConfig !== config)
      ) {
        throw new Error(
          "Concurrent inference runs must share the same input and geometry configuration",
        );
      }
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
      const batchSize = this.metadata!.inputShape[0];
      const inputVoxels = geometry.inputShape.reduce((a, b) => a * b, 1);
      const outputElements = retainedShape.reduce(
        (a, b) => a * b,
        geometry.outputChannels,
      );
      const batches = (function* () {
        let batch: InferenceTile[] = [];
        for (const tile of tiles) {
          batch.push(tile);
          if (batch.length === batchSize) {
            yield batch;
            batch = [];
          }
        }
        if (batch.length > 0) yield batch;
      })();
      const tileKey = (tile: InferenceTile) => {
        const [o0, o1, o2] = tile.input.origin;
        const [s0, s1, s2] = tile.input.shape;
        return `[[${o0},${o1},${o2}],[${s0},${s1},${s2}]]`;
      };
      const isCached = (batch: InferenceTile[]) =>
        batch.every((tile) => this.patchCache.has(tileKey(tile)));
      const getCached = (batch: InferenceTile[]) => {
        const outputs: Float32Array[] = [];
        for (const tile of batch) {
          const output = this.patchCache.get(tileKey(tile));
          if (output === undefined) return undefined;
          outputs.push(output);
        }
        return outputs;
      };
      const readPatch = async (batch: InferenceTile[]) => {
        try {
          check();
          // Preserve the zero-copy batch-one path. Larger batches own their
          // packed buffer; each tile still reads only its native spatial patch.
          if (batchSize === 1) {
            const tile = batch[0];
            return {
              patch: await input.readPatch(
                [...tile.input.origin],
                [...tile.input.shape],
                abort.signal,
              ),
            };
          }
          const patch = new Float32Array(batchSize * inputVoxels);
          for (const [n, tile] of batch.entries()) {
            check();
            const sample = await input.readPatch(
              [...tile.input.origin],
              [...tile.input.shape],
              abort.signal,
            );
            check();
            if (
              !(sample instanceof Float32Array) ||
              sample.length !== inputVoxels
            )
              throw new Error(
                "Input patch length/type does not match model geometry",
              );
            patch.set(sample, n * inputVoxels);
          }
          // A short final batch repeats a real patch, never reads beyond the
          // source bounds. Only the real tiles' predictions are published.
          for (let n = batch.length; n < batchSize; ++n)
            patch.copyWithin(
              n * inputVoxels,
              (n - 1) * inputVoxels,
              n * inputVoxels,
            );
          return { patch };
        } catch (error) {
          // A speculative read may fail before its turn or be abandoned on cancel.
          return { error };
        }
      };
      const runPatch = async (patch: Float32Array) => {
        try {
          check();
          for (let i = 0; i < patch.length; ++i) {
            if (!Number.isFinite(patch[i]))
              throw new Error("Inference input values must be finite");
          }
          if (
            !this.warnedMissingSubgroupMatrix &&
            this.metadata!.actualProvider === "webgpu" &&
            this.metadata!.webgpuSubgroupMatrix === false
          ) {
            this.warnedMissingSubgroupMatrix = true;
            StatusMessage.showTemporaryMessage(
              "ONNX inference is running without submatrix matmul acceleration. Enable experimental WebGPU support (Unsafe WebGPU Support) at chrome://flags/#enable-unsafe-webgpu and restart Chrome. On NVIDIA GPUs, also launch Chrome with --enable-dawn-features=vulkan_enable_f16_on_nvidia. Requires compatible hardware and drivers.",
              20_000,
            );
          }
          return {
            response: await this.request(
              { id: ++this.requestId, kind: "run", input: patch, geometry },
              [patch.buffer],
            ),
          };
        } catch (error) {
          return { error };
        }
      };
      let remainingVolumePrefetched = false;
      let firstRunNotified = false;
      const prefetchRemainingUncachedVolume = () => {
        if (remainingVolumePrefetched) return;
        remainingVolumePrefetched = true;
        if (input.prefetchVolume === undefined) return;
        const bounds = getPlannedTileInputBounds(
          geometry,
          roi,
          {
            origin: triple(input.originZYX),
            shape: triple(input.shapeZYX),
          },
          overlap,
        );
        input.prefetchVolume(bounds.origin, bounds.shape, abort.signal);
      };
      const notifyFirstRunDispatched = () => {
        prefetchRemainingUncachedVolume();
        if (firstRunNotified) return;
        firstRunNotified = true;
        options.onFirstRunDispatched?.();
      };
      let completed = 0;
      onProgress(0, total);
      usePooledScheduler =
        batchSize === 1 &&
        (this.allowsConcurrentRuns || callerSignal !== undefined);
      if (usePooledScheduler) {
        const tileList = Array.from(tiles);
        const getOrComputePooledPatch = async (
          tile: InferenceTile,
        ): Promise<{ output: Float32Array; cached: boolean }> => {
          const key = tileKey(tile);
          const hit = this.patchCache.get(key);
          if (hit !== undefined) {
            return { output: hit, cached: true };
          }
          let entry = this.inflightPatches.get(key);
          if (entry?.abort.signal.aborted) {
            this.inflightPatches.delete(key);
            entry = undefined;
          }
          if (entry === undefined) {
            const patchAbort = new AbortController();
            const onCtrlAbort = () =>
              patchAbort.abort(controllerAbort.signal.reason);
            if (controllerAbort.signal.aborted) {
              patchAbort.abort(controllerAbort.signal.reason);
            } else {
              controllerAbort.signal.addEventListener("abort", onCtrlAbort, {
                once: true,
              });
            }
            const inflight: InflightPatch = {
              promise: undefined!,
              abort: patchAbort,
              waiters: 0,
              startedOnWorker: false,
              minOrder: runOrder,
            };
            const checkShared = () => {
              patchAbort.signal.throwIfAborted();
              controllerAbort.signal.throwIfAborted();
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
            inflight.promise = (async () => {
              try {
                checkShared();
                const patch = await input.readPatch(
                  [...tile.input.origin],
                  [...tile.input.shape],
                  patchAbort.signal,
                );
                checkShared();
                if (
                  !(patch instanceof Float32Array) ||
                  patch.length !== inputVoxels
                )
                  throw new Error(
                    "Input patch length/type does not match model geometry",
                  );
                const response = await this.runOnPooledWorker(
                  patch,
                  geometry,
                  checkShared,
                  generation,
                  inflight.minOrder,
                  patchAbort.signal,
                  () => {
                    inflight.startedOnWorker = true;
                    notifyFirstRunDispatched();
                  },
                );
                checkShared();
                if (
                  response.kind !== "output" ||
                  !(response.output instanceof Float32Array) ||
                  response.output.length !== outputElements
                )
                  throw new Error("Invalid inference worker output response");
                for (let i = 0; i < response.output.length; ++i) {
                  if (!Number.isFinite(response.output[i]))
                    throw new Error("Inference predictions must be finite");
                }
                if (
                  generation === this.generation &&
                  !this.disposed &&
                  this.cacheInput === input &&
                  this.cacheConfig === config
                ) {
                  this.cachePatch(key, response.output);
                }
                return response.output;
              } finally {
                controllerAbort.signal.removeEventListener(
                  "abort",
                  onCtrlAbort,
                );
                if (this.inflightPatches.get(key) === inflight) {
                  this.inflightPatches.delete(key);
                }
              }
            })();
            inflight.promise.catch(() => {});
            entry = inflight;
            this.inflightPatches.set(key, entry);
          } else if (runOrder < entry.minOrder) {
            entry.minOrder = runOrder;
          }
          ++entry.waiters;
          if (entry.startedOnWorker) notifyFirstRunDispatched();
          const releaseWaiter = () => {
            --entry.waiters;
            if (entry.waiters === 0 && !entry.startedOnWorker) {
              entry.abort.abort(
                callerSignal?.reason ??
                  new DOMException("Inference canceled", "AbortError"),
              );
            }
          };
          try {
            const computed = await new Promise<Float32Array>(
              (resolve, reject) => {
                if (abort.signal.aborted) {
                  reject(abort.signal.reason);
                  return;
                }
                const onAbort = () => {
                  abort.signal.removeEventListener("abort", onAbort);
                  reject(abort.signal.reason);
                };
                abort.signal.addEventListener("abort", onAbort, { once: true });
                entry.promise.then(
                  (val) => {
                    abort.signal.removeEventListener("abort", onAbort);
                    resolve(val);
                  },
                  (err) => {
                    abort.signal.removeEventListener("abort", onAbort);
                    reject(err);
                  },
                );
              },
            );
            notifyFirstRunDispatched();
            return { output: computed, cached: false };
          } finally {
            releaseWaiter();
          }
        };

        const MISS_LOOKAHEAD = 3;
        const launched = new Map<
          number,
          ReturnType<typeof getOrComputePooledPatch>
        >();
        let scanCursor = 0;
        const pumpLookahead = (minIndex: number) => {
          if (scanCursor < minIndex) scanCursor = minIndex;
          while (
            launched.size < MISS_LOOKAHEAD &&
            scanCursor < tileList.length
          ) {
            const k = scanCursor++;
            if (this.patchCache.has(tileKey(tileList[k]))) continue;
            const p = getOrComputePooledPatch(tileList[k]);
            p.catch(() => {});
            launched.set(k, p);
          }
        };
        pumpLookahead(0);

        for (let idx = 0; idx < tileList.length; ++idx) {
          check();
          const tile = tileList[idx];
          let task = launched.get(idx);
          if (task !== undefined) {
            launched.delete(idx);
          } else {
            task = getOrComputePooledPatch(tile);
          }
          pumpLookahead(idx + 1);
          const { output, cached } = await task;
          check();
          pumpLookahead(idx + 1);
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
          const key = tileKey(tile);
          if (cached && this.patchCache.has(key)) {
            this.patchCache.delete(key);
            this.patchCache.set(key, output);
          }
          onProgress(++completed, total);
        }
      } else {
        type PrefetchedPatch = {
          pending: ReturnType<typeof readPatch>;
          ready?: Awaited<ReturnType<typeof readPatch>>;
        };
        let prefetched: PrefetchedPatch | undefined;
        let responsePending: ReturnType<typeof runPatch> | undefined;
        let next = batches.next();
        type DeferredBlend = {
          tile: InferenceTile;
          output: Float32Array;
          key: string;
          alreadyCached?: boolean;
        };
        const deferredCachedBlends: DeferredBlend[] = [];
        const flushDeferredCachedBlends = () => {
          while (deferredCachedBlends.length !== 0) {
            check();
            const { tile, output, key, alreadyCached } =
              deferredCachedBlends.shift()!;
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
            if (!alreadyCached) {
              this.patchCache.delete(key);
              this.patchCache.set(key, output);
            }
            onProgress(++completed, total);
          }
        };
        while (!next.done) {
          check();
          const batch = next.value;
          next = batches.next();
          const pendingPatch = prefetched;
          prefetched = undefined;
          // Recompute a whole batch on a partial cache hit: every sample then
          // comes from the same execution, including after provider fallback.
          let outputs =
            responsePending === undefined ? getCached(batch) : undefined;
          const cached = outputs !== undefined;
          if (cached && !next.done) {
            for (const [n, tile] of batch.entries()) {
              deferredCachedBlends.push({
                tile,
                output: outputs![n],
                key: tileKey(tile),
              });
            }
            continue;
          }
          if (outputs === undefined) {
            if (responsePending === undefined) {
              const prepared = await (pendingPatch?.pending ??
                readPatch(batch));
              if ("error" in prepared) throw prepared.error;
              responsePending = runPatch(prepared.patch);
              if (this.pending.size > 0) notifyFirstRunDispatched();
            }
            if (!next.done && this.pending.size > 0 && !isCached(next.value)) {
              const ahead: PrefetchedPatch = {
                pending: readPatch(next.value),
              };
              ahead.pending.then((ready) => {
                ahead.ready = ready;
              });
              prefetched = ahead;
            }
            if (this.pending.size > 0 && deferredCachedBlends.length !== 0) {
              flushDeferredCachedBlends();
            }
            const outcome = await responsePending;
            responsePending = undefined;
            if ("error" in outcome) throw outcome.error;
            check();
            const { response } = outcome;
            if (
              response.kind !== "output" ||
              !(response.output instanceof Float32Array)
            )
              throw new Error("Invalid inference worker output response");
            this.canonicalMetadata ??= response.metadata ?? this.metadata;
            if (batchSize === 1) outputs = [response.output];
            else {
              if (response.output.length !== batchSize * outputElements)
                throw new Error(
                  "Inference worker batch output length does not match model geometry",
                );
              if (!response.output.every(Number.isFinite))
                throw new Error("Inference predictions must be finite");
              // Independent buffers keep per-tile LRU byte accounting accurate
              // and do not retain the rest of a potentially large batch.
              outputs = batch.map((_, n) =>
                response.output.slice(
                  n * outputElements,
                  (n + 1) * outputElements,
                ),
              );
            }
            if (
              !next.done &&
              prefetched?.ready !== undefined &&
              !("error" in prefetched.ready) &&
              !isCached(next.value)
            ) {
              // Post ready work before CPU stitching, without waiting for a slow read.
              responsePending = runPatch(prefetched.ready.patch);
              prefetched = undefined;
            }
          }
          flushDeferredCachedBlends();
          if (
            !cached &&
            responsePending === undefined &&
            !next.done &&
            isCached(next.value)
          ) {
            for (const [n, tile] of batch.entries()) {
              check();
              const output = outputs[n];
              if (output.length !== outputElements)
                throw new Error(
                  "Cropped NCDHW or destination length does not match geometry",
                );
              for (let i = 0; i < output.length; ++i) {
                if (!Number.isFinite(output[i]))
                  throw new Error(
                    overlap
                      ? "Blending predictions must be finite"
                      : "Stitching predictions must be finite",
                  );
              }
              const key = tileKey(tile);
              this.cachePatch(key, output);
              deferredCachedBlends.push({
                tile,
                output,
                key,
                alreadyCached: true,
              });
            }
            continue;
          }
          for (const [n, tile] of batch.entries()) {
            check();
            const output = outputs[n];
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
            const key = tileKey(tile);
            if (cached) {
              this.patchCache.delete(key);
              this.patchCache.set(key, output);
            } else {
              this.cachePatch(key, output);
            }
            onProgress(++completed, total);
          }
        }
        flushDeferredCachedBlends();
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
      const cooperativeCallerAbort =
        callerSignal?.aborted === true && !controllerAbort.signal.aborted;
      // An older canceled operation must not clear a newer operation's cache,
      // and a cooperative per-tile abort must preserve workers and patchCache.
      if (
        !cooperativeCallerAbort &&
        generation === this.generation &&
        !usePooledScheduler
      ) {
        if (
          this.pending.size > 0 ||
          this.auxSlots.some((s) => s.pending.size > 0)
        ) {
          this.stopWorker(
            error instanceof Error ? error : new Error(String(error)),
          );
        } else {
          this.clearPatchCache();
        }
      }
      throw error;
    } finally {
      abort.abort();
      controllerAbort.signal.removeEventListener("abort", onControllerAbort);
      callerSignal?.removeEventListener("abort", onCallerAbort);
      this.activeRunSet.delete(operation);
      if (this.activeRunSet.size === 0 && this.abort === controllerAbort)
        this.abort = undefined;
    }
  }
}
