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
  makeInferenceRecipeSource,
  publishLiveInference,
} from "#src/datasource/inference/frontend.js";
import { BUNDLED_INFERENCE_MODEL } from "#src/inference/bundled_model.js";
import { OnnxInferenceController } from "#src/inference/controller.js";
import type { Zyx } from "#src/inference/geometry.js";
import {
  getInferenceStrides,
  getRetainedOutputShape,
} from "#src/inference/geometry.js";
import type { PreparedInferenceInput } from "#src/inference/input.js";
import {
  getInferenceInputMetadata,
  getInferenceInputScales,
  prepareInferenceInput,
} from "#src/inference/input.js";
import { LiveInference } from "#src/inference/live.js";
import type {
  InferencePrecision,
  InferenceProvider,
  ModelMetadata,
} from "#src/inference/model.js";
import { MAX_MODEL_BYTES, makeModelGeometry } from "#src/inference/model.js";
import {
  parseInferenceRecipe,
  validateInferenceModelUrl,
  type InferenceRecipe,
} from "#src/inference/recipe.js";
import { installInferenceRecipeContext } from "#src/inference/restore.js";
import { ImageUserLayer } from "#src/layer/image/index.js";
import type { ManagedUserLayer } from "#src/layer/index.js";
import { deleteLayer, makeLayer } from "#src/layer/index.js";
import { LayerGroupViewer } from "#src/layer_group_viewer.js";
import type { LayoutComponentContainer } from "#src/layer_groups_layout.js";
import {
  SingletonLayerGroupViewer,
  StackLayoutComponent,
} from "#src/layer_groups_layout.js";
import { FramedDialog } from "#src/overlay.js";
import { StatusMessage } from "#src/status.js";
import { ActionCommand } from "#src/ui/command.js";
import { animationFrameDebounce } from "#src/util/animation_frame_debounce.js";
import { disposableOnce, RefCounted } from "#src/util/disposable.js";
import { formatScaleWithUnitAsString } from "#src/util/si_units.js";
import { NullarySignal } from "#src/util/signal.js";
import type { Viewer } from "#src/viewer.js";

const INFERENCE_NAVIGATION_KEYS = [
  "dimensionRenderScales",
  "displayDimensions",
  "position",
  "velocity",
  "crossSectionOrientation",
  "crossSectionScale",
  "crossSectionDepth",
  "projectionOrientation",
  "projectionScale",
  "projectionDepth",
] as const;

export function getInferenceResultShader(channels: number): string {
  if (!Number.isSafeInteger(channels) || channels <= 0)
    throw new Error("Output channel count must be a positive integer");
  return channels === 1
    ? "void main() { emitGrayscale(getDataValue(0)); }"
    : `#uicontrol int channel slider(min=0, max=${channels - 1}, step=1, default=0)\nvoid main() { emitGrayscale(getDataValue(channel)); }`;
}

export const INFERENCE_RESULT_SHADER = getInferenceResultShader(4);

/** Prepare immediately before publication, not before an asynchronous run. */
export function planAdjacentInferenceView(
  root: LayoutComponentContainer,
  source: ManagedUserLayer,
): (resultName: string) => void {
  function find(
    container: LayoutComponentContainer,
  ): LayoutComponentContainer | undefined {
    const { component } = container;
    if (component instanceof StackLayoutComponent) {
      for (const child of component) {
        const found = find(child);
        if (found !== undefined) return found;
      }
    } else {
      const group =
        component instanceof SingletonLayerGroupViewer
          ? component.layerGroupViewer
          : component;
      if (group instanceof LayerGroupViewer && group.layerManager.has(source))
        return container;
    }
    return undefined;
  }
  const target = find(root);
  if (target === undefined)
    throw new Error("Source is not displayed in a layer group");
  const { component, parent } = target;
  // Singleton.toJSON() serializes only its data-panel layout, losing membership.
  const sourceSpec =
    component instanceof SingletonLayerGroupViewer
      ? component.layerGroupViewer.toJSON()
      : component.toJSON();
  for (const key of INFERENCE_NAVIGATION_KEYS) {
    if (sourceSpec[key]?.link === "unlinked")
      throw new Error(
        `Source layer group has unlinked ${key} navigation. Link source navigation first; independent snapshot panels are not supported.`,
      );
  }
  const original = target.toJSON();
  const flex = target.flex.value;
  return (resultName) => {
    // Existing links use the root as peer. Identical relative offsets retain
    // ongoing correspondence without changing source navigation or membership.
    const resultSpec: Record<string, unknown> = {
      type: "viewer",
      layers: [resultName],
      layout: sourceSpec.layout,
    };
    for (const key of INFERENCE_NAVIGATION_KEYS) {
      if (sourceSpec[key] !== undefined)
        resultSpec[key] = structuredClone(sourceSpec[key]);
    }
    if (parent?.direction === "row") {
      const index = Array.from(parent).indexOf(target);
      const before =
        index + 1 < parent.length ? parent.get(index + 1) : undefined;
      // insertChild constructs before attaching, so failed construction leaves
      // the old tree intact. Unlike split("right"), this is truly adjacent.
      parent.insertChild(resultSpec, before);
    } else {
      try {
        target.setSpecification({
          type: "row",
          flex,
          children: [sourceSpec, resultSpec],
        });
      } catch (error) {
        // Synchronous rollback only. Nothing from before the async run is restored.
        target.setSpecification(original);
        throw error;
      }
    }
  };
}

function parseSpacing(text: string, name = "Input"): Zyx {
  const parts = text.trim().split(/[\s,]+/);
  const values = parts.map(Number);
  if (parts.length !== 3 || !values.every((x) => Number.isFinite(x) && x > 0)) {
    throw new Error(
      `${name} voxel size must contain three positive numbers in X Y Z order`,
    );
  }
  return [values[2], values[1], values[0]];
}

export interface OnnxInferenceDependencies {
  createController(): Pick<
    OnnxInferenceController,
    "loadModel" | "run" | "cancel" | "dispose" | "onMetadata"
  >;
  prepareInput: typeof prepareInferenceInput;
  inspectInput?: typeof getInferenceInputMetadata;
  listInputScales?: typeof getInferenceInputScales;
  publishLive?: typeof publishLiveInference;
  /** Omit in tests/integrations that manage model selection themselves. */
  bundledModel?: {
    name: string;
    urls: readonly string[];
    size: number;
    sha256: string;
  };
  fetchModel?: typeof fetch;
}

const defaultDependencies: OnnxInferenceDependencies = {
  createController: () => new OnnxInferenceController(),
  prepareInput: prepareInferenceInput,
  inspectInput: getInferenceInputMetadata,
  listInputScales: getInferenceInputScales,
  publishLive: publishLiveInference,
  bundledModel: BUNDLED_INFERENCE_MODEL,
  fetchModel: (url, options) => fetch(url, options),
};

/** Viewer-owned state. A dialog is merely a disposable view of this state. */
export class OnnxInferenceSession extends RefCounted {
  readonly changed = new NullarySignal();
  readonly controller;
  dialog: OnnxInferenceDialog | undefined;
  source: ManagedUserLayer | undefined;
  input: PreparedInferenceInput | undefined;
  sourceMetadata: ReturnType<typeof getInferenceInputMetadata> | undefined;
  inputScales: ReturnType<typeof getInferenceInputScales> = [];
  inputScaleIndex = 0;
  metadata: ModelMetadata | undefined;
  modelName = "";
  // Viewer-owned draft: metadata notifications and dialog recreation must not
  // replace text that the user is editing.
  modelUrl = "";
  private pendingModelUrl: string | undefined;
  modelReference: InferenceRecipe["model"] | undefined;
  provider: InferenceProvider = "auto";
  precision: InferencePrecision = "float32";
  compatibilityFixes = false;
  overlap = false;
  private modelFile: File | undefined;
  private bundledFile: File | undefined;
  downloadingModel = false;
  status = "Click Load model URL to load the model at the URL above.";
  statusLevel: "info" | "warning" | "error" = "info";
  busy = false;
  outputSpacing = "";
  outputSpacingEdited = false;
  confirmed = false;
  private live:
    | { inference: LiveInference; release(): void; layer?: ManagedUserLayer }
    | undefined;
  get liveActive() {
    return this.live !== undefined;
  }
  private generation = 0;
  private alive = true;
  private sourceDisposers: Array<() => void> = [];
  private pendingAbort: AbortController | undefined;
  private pendingSourcePreparation: object | undefined;
  private resultDisposers = new Set<() => void>();

  constructor(
    readonly viewer: Viewer,
    readonly dependencies = defaultDependencies,
  ) {
    super();
    this.modelUrl = dependencies.bundledModel?.urls[0] ?? "";
    this.controller = dependencies.createController();
    this.controller.onMetadata = (metadata) => {
      if (!this.alive) return;
      this.metadata = metadata;
      this.updateOutputSpacing();
      this.changed.dispatch();
    };
    this.registerDisposer(
      viewer.layerManager.layersChanged.add(() => this.refreshSources()),
    );
    this.registerDisposer(
      viewer.layerManager.readyStateChanged.add(() => this.refreshSources()),
    );
    this.registerDisposer(viewer.resetInitiated.add(() => this.reset()));
    this.registerDisposer(viewer.state.stateReset.add(() => this.reset()));
  }

  open() {
    if (!this.alive) return;
    if (this.dialog === undefined) this.dialog = new OnnxInferenceDialog(this);
    else this.dialog.content.focus();
    this.refreshSources();
  }

  get sources() {
    return this.viewer.layerManager.managedLayers.filter(
      (x) => x.layer instanceof ImageUserLayer,
    );
  }

  refreshSources() {
    if (!this.alive) return;
    if (this.source !== undefined && !this.sources.includes(this.source))
      this.selectSource(undefined);
    this.discardStaleInput();
    if (this.source !== undefined && this.input === undefined && !this.busy)
      this.schedulePrepareSource();
    this.changed.dispatch();
  }

  selectSource(source: ManagedUserLayer | undefined) {
    if (source === this.source) {
      this.refreshSources();
      return;
    }
    this.invalidate(
      "Source changed; confirm settings before running.",
      "warning",
    );
    this.clearSource();
    this.source = source;
    this.inputScaleIndex = 0;
    this.outputSpacing = "";
    this.outputSpacingEdited = false;
    if (source !== undefined) {
      const layer = source.layer;
      this.sourceDisposers.push(
        source.layerChanged.add(() => {
          // This signal also reports rename/visibility/render-layer changes.
          // Keep selection by identity unless the actual user layer is replaced.
          if (source.layer !== layer) this.selectSource(undefined);
          else this.changed.dispatch();
        }),
      );
      if (layer instanceof ImageUserLayer) {
        this.sourceDisposers.push(
          layer.dataSourcesChanged.add(() => this.invalidateSourceInput()),
        );
      }
      this.prepareSource();
    }
    this.changed.dispatch();
  }

  selectInputScale(scaleIndex: number) {
    if (scaleIndex === this.inputScaleIndex) return;
    if (!this.inputScales.some((scale) => scale.scaleIndex === scaleIndex))
      throw new Error("Select an available input scale");
    this.invalidate(
      "Input scale changed; confirm settings before running.",
      "warning",
    );
    this.input?.dispose();
    this.input = undefined;
    this.inputScaleIndex = scaleIndex;
    this.outputSpacingEdited = false;
    this.outputSpacing = "";
    this.prepareSource();
    this.changed.dispatch();
  }

  private discardStaleInput(): boolean {
    if (this.input === undefined || this.input.isValid()) return false;
    this.invalidateSourceInput();
    return true;
  }

  private invalidateSourceInput() {
    const input = this.input;
    this.input = undefined;
    this.sourceMetadata = undefined;
    input?.dispose();
    this.invalidate(
      "Source data or transform changed; verify and confirm settings again.",
      "warning",
    );
    this.schedulePrepareSource();
  }

  private schedulePrepareSource() {
    const source = this.source;
    if (!this.alive || source === undefined) return;
    const generation = this.generation;
    const token = {};
    this.pendingSourcePreparation = token;
    // Signal visits handlers added during dispatch. Preparing synchronously from
    // dataSourcesChanged would register the new input's invalidation listener on
    // that same dispatch and immediately invalidate the replacement snapshot.
    queueMicrotask(() => {
      if (this.pendingSourcePreparation !== token) return;
      this.pendingSourcePreparation = undefined;
      if (
        !this.alive ||
        source !== this.source ||
        generation !== this.generation ||
        this.busy ||
        this.input !== undefined
      )
        return;
      this.prepareSource();
      this.changed.dispatch();
    });
  }

  private prepareSource() {
    this.sourceMetadata = undefined;
    this.inputScales = [];
    const layer = this.source?.layer;
    if (!(layer instanceof ImageUserLayer)) return;
    try {
      this.sourceMetadata = this.dependencies.inspectInput?.(layer);
    } catch {
      // Metadata inspection must not prevent normal input preparation.
    }
    try {
      if (this.dependencies.listInputScales !== undefined) {
        this.inputScales = this.dependencies.listInputScales(layer);
        this.sourceMetadata = this.inputScales.find(
          (scale) => scale.scaleIndex === this.inputScaleIndex,
        );
      }
      this.input = this.dependencies.prepareInput(layer, this.inputScaleIndex);
      this.sourceMetadata = this.input;
    } catch (error) {
      this.setStatus(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    }
    if (
      this.dependencies.listInputScales === undefined &&
      this.sourceMetadata !== undefined
    ) {
      this.inputScales = [{ ...this.sourceMetadata, scaleIndex: 0 }];
    }
    this.updateOutputSpacing();
  }

  private updateOutputSpacing() {
    const spacing = this.sourceMetadata?.spacingZYX;
    if (this.outputSpacingEdited || spacing === undefined) return;
    const outputSpacing =
      this.metadata === undefined
        ? spacing
        : makeModelGeometry(this.metadata, [spacing[0], spacing[1], spacing[2]])
            .outputSpacing;
    this.outputSpacing = [...outputSpacing]
      .map((value) => Number(value.toPrecision(12)))
      .reverse()
      .join(", ");
  }

  private clearSource() {
    for (const dispose of this.sourceDisposers.splice(0)) dispose();
    this.input?.dispose();
    this.input = undefined;
    this.sourceMetadata = undefined;
    this.inputScales = [];
    this.inputScaleIndex = 0;
    this.source = undefined;
  }

  private setStatus(
    message: string,
    level: OnnxInferenceSession["statusLevel"] = "info",
  ) {
    this.status = message;
    this.statusLevel = level;
  }

  private invalidate(
    message: string,
    level: OnnxInferenceSession["statusLevel"] = "info",
  ) {
    ++this.generation;
    this.stopLive();
    this.pendingSourcePreparation = undefined;
    this.pendingAbort?.abort();
    this.pendingAbort = undefined;
    this.pendingModelUrl = undefined;
    this.downloadingModel = false;
    // Idle invalidation must retain an already initialized model/runtime. The
    // controller's cancel terminates its worker and is only needed for a job.
    if (this.busy) this.controller.cancel();
    this.busy = false;
    this.confirmed = false;
    this.setStatus(message, level);
    this.changed.dispatch();
  }

  private stopLive() {
    const live = this.live;
    if (live === undefined) return;
    this.live = undefined;
    // A linked result is retained by both the root and its adjacent layer group.
    // Remove all memberships before invalidating its datasource cache.
    if (live.layer !== undefined) deleteLayer(live.layer);
    live.release();
  }

  cancel() {
    this.invalidate(
      this.liveActive
        ? "Live inference stopped; result layer removed."
        : "Cancelled. No partial result was published.",
    );
  }

  reset() {
    this.invalidate("Viewer reset; select a source and confirm settings.");
    this.clearSource();
    this.changed.dispatch();
  }

  async selectProvider(provider: InferenceProvider) {
    if (provider === this.provider) return;
    const wasDownloading = this.downloadingModel;
    const pendingModelUrl = this.pendingModelUrl;
    this.provider = provider;
    this.invalidate(
      "Execution provider changed; reload and confirm settings.",
      "warning",
    );
    // Even an idle initialized worker must not survive a provider change.
    this.controller.cancel();
    this.metadata = undefined;
    this.changed.dispatch();
    if (this.modelFile !== undefined)
      await this.loadModel(this.modelFile, this.modelReference);
    else if (wasDownloading) {
      if (pendingModelUrl !== undefined)
        await this.loadModelUrl(pendingModelUrl);
      else await this.loadBundledModel();
    }
  }

  async selectPrecision(precision: InferencePrecision) {
    if (precision === this.precision) return;
    const wasDownloading = this.downloadingModel;
    const pendingModelUrl = this.pendingModelUrl;
    this.precision = precision;
    this.invalidate(
      "Precision changed; reload and confirm settings.",
      "warning",
    );
    this.controller.cancel();
    this.metadata = undefined;
    this.changed.dispatch();
    if (this.modelFile !== undefined)
      await this.loadModel(this.modelFile, this.modelReference);
    else if (wasDownloading) {
      if (pendingModelUrl !== undefined)
        await this.loadModelUrl(pendingModelUrl);
      else await this.loadBundledModel();
    }
  }

  selectOverlap(enabled: boolean) {
    if (enabled === this.overlap) return;
    this.overlap = enabled;
    this.invalidate(
      "Overlap/blending changed; confirm settings before running.",
      "warning",
    );
  }

  async selectCompatibilityFixes(enabled: boolean) {
    if (enabled === this.compatibilityFixes) return;
    const wasDownloading = this.downloadingModel;
    const pendingModelUrl = this.pendingModelUrl;
    this.compatibilityFixes = enabled;
    this.invalidate(
      "Compatibility fixes changed; reload and confirm settings.",
      "warning",
    );
    this.controller.cancel();
    this.metadata = undefined;
    this.changed.dispatch();
    if (this.modelFile !== undefined)
      await this.loadModel(this.modelFile, this.modelReference);
    else if (wasDownloading) {
      if (pendingModelUrl !== undefined)
        await this.loadModelUrl(pendingModelUrl);
      else await this.loadBundledModel();
    }
  }

  async loadBundledModel() {
    const model = this.dependencies.bundledModel;
    if (!this.alive || model === undefined || this.downloadingModel) return;
    const reference: InferenceRecipe["model"] = {
      kind: "url",
      name: model.name,
      urls: [...model.urls],
      size: model.size,
      sha256: model.sha256,
    };
    this.modelUrl = model.urls[0];
    if (this.bundledFile !== undefined) {
      await this.loadModel(this.bundledFile, reference);
      return;
    }
    await this.downloadModel(reference, true);
  }

  editModelUrl(value: string) {
    this.modelUrl = value;
    if (this.downloadingModel)
      this.invalidate(
        "Model URL changed; load the new URL to continue.",
        "warning",
      );
    else this.changed.dispatch();
  }

  async loadModelUrl(value = this.modelUrl) {
    if (!this.alive) return;
    this.modelUrl = value;
    // Invalid URLs also supersede previous work; never leave an old model ready.
    this.invalidate("Validating model URL…");
    this.modelFile = undefined;
    this.modelReference = undefined;
    this.metadata = undefined;
    try {
      if (value.trim() === this.dependencies.bundledModel?.urls[0]) {
        await this.loadBundledModel();
        return;
      }
      const url = validateInferenceModelUrl(value.trim());
      const pathname = new URL(url).pathname;
      const name =
        pathname.slice(pathname.lastIndexOf("/") + 1) || "model.onnx";
      await this.downloadModel({ name, urls: [url] }, false);
    } catch (error) {
      this.setStatus(
        `Model URL load failed: ${error instanceof Error ? error.message : error}`,
        "error",
      );
      this.changed.dispatch();
    }
  }

  /** One bounded, anonymous downloader for default multipart and custom URLs. */
  private async downloadModel(
    model: {
      name: string;
      urls: readonly string[];
      size?: number;
      sha256?: string;
    },
    bundled: boolean,
  ) {
    const description = `${bundled ? "default model" : "model"} ${model.name}`;
    this.invalidate(`Downloading ${description}…`);
    const generation = this.generation;
    const abort = (this.pendingAbort = new AbortController());
    this.pendingModelUrl = bundled ? undefined : model.urls[0];
    this.modelFile = undefined;
    this.modelReference = undefined;
    this.metadata = undefined;
    this.modelName = model.name;
    this.busy = this.downloadingModel = true;
    this.changed.dispatch();
    try {
      const parts: Blob[] = [];
      let received = 0;
      const limit = Math.min(model.size ?? MAX_MODEL_BYTES, MAX_MODEL_BYTES);
      const oversized = () =>
        new Error(
          model.size === undefined
            ? `Model exceeds maximum size of ${MAX_MODEL_BYTES} bytes`
            : `Expected ${model.size} model bytes, received too many`,
        );
      for (const [index, url] of model.urls.entries()) {
        this.setStatus(
          `Downloading ${description}${model.urls.length > 1 ? ` (part ${index + 1}/${model.urls.length})` : ""}…`,
        );
        this.changed.dispatch();
        const response = await (this.dependencies.fetchModel ?? fetch)(url, {
          signal: abort.signal,
          mode: "cors",
          credentials: "omit",
        });
        const reader = response.body?.getReader();
        const cancel = () => {
          void reader?.cancel(abort.signal.reason).catch(() => {});
        };
        abort.signal.addEventListener("abort", cancel, { once: true });
        try {
          abort.signal.throwIfAborted();
          if (!response.ok)
            throw new Error(
              `HTTP ${response.status} ${response.statusText}`.trim(),
            );
          const encoding = response.headers.get("Content-Encoding");
          const length = response.headers.get("Content-Length");
          if (
            (encoding === null || encoding === "identity") &&
            length !== null &&
            Number(length) > limit - received
          )
            throw oversized();
          if (reader !== undefined) {
            while (true) {
              const chunk = await reader.read();
              abort.signal.throwIfAborted();
              if (chunk.done) break;
              if (chunk.value.byteLength > limit - received) throw oversized();
              parts.push(new Blob([chunk.value]));
              received += chunk.value.byteLength;
            }
          }
        } catch (error) {
          await reader?.cancel(error).catch(() => {});
          throw error;
        } finally {
          abort.signal.removeEventListener("abort", cancel);
          reader?.releaseLock();
        }
      }
      const file = new File(parts, model.name);
      if (model.size !== undefined && file.size !== model.size)
        throw new Error(
          `Expected ${model.size} model bytes, received ${file.size}`,
        );
      if (file.size === 0) throw new Error("Model download is empty");
      this.setStatus(`Verifying ${description}…`);
      this.changed.dispatch();
      const bytes = await file.arrayBuffer();
      if (!this.alive || generation !== this.generation) return;
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      if (!this.alive || generation !== this.generation) return;
      const hash = Array.from(new Uint8Array(digest), (x) =>
        x.toString(16).padStart(2, "0"),
      ).join("");
      if (model.sha256 !== undefined && hash !== model.sha256)
        throw new Error("Model SHA-256 mismatch");
      this.pendingAbort = undefined;
      this.pendingModelUrl = undefined;
      this.downloadingModel = false;
      if (bundled) this.bundledFile = file;
      // Original downloaded bytes, not provider-specific prepared bytes.
      await this.loadModel(file, {
        kind: "url",
        name: model.name,
        urls: [...model.urls],
        size: file.size,
        sha256: hash,
      });
    } catch (error) {
      if (!this.alive || generation !== this.generation) return;
      this.setStatus(
        `${bundled ? "Default model download" : "Model URL load"} failed: ${error instanceof Error ? error.message : error}. Retry with Load model URL or enter another URL.`,
        "error",
      );
    } finally {
      if (this.alive && generation === this.generation) {
        abort.abort();
        if (this.pendingAbort === abort) this.pendingAbort = undefined;
        this.pendingModelUrl = undefined;
        this.busy = this.downloadingModel = false;
        // Keep model failures visible; readiness signals can retry the source.
        if (this.metadata !== undefined && this.input === undefined)
          this.schedulePrepareSource();
        this.changed.dispatch();
      }
    }
  }

  async loadModel(
    file: File,
    reference: InferenceRecipe["model"] = {
      kind: "local",
      name: file.name,
      size: file.size,
    },
  ) {
    if (!this.alive) return;
    this.invalidate(
      "Loading model and analyzing WebGPU compatibility in background…",
    );
    if (this.modelFile !== file) {
      this.outputSpacing = "";
      this.outputSpacingEdited = false;
    }
    this.modelFile = file;
    this.modelReference = reference;
    const generation = this.generation;
    this.metadata = undefined;
    this.modelName = file.name;
    this.busy = true;
    this.changed.dispatch();
    try {
      const metadata = await this.controller.loadModel(
        file,
        this.provider,
        this.compatibilityFixes,
        this.precision,
      );
      if (!this.alive || generation !== this.generation) return;
      this.metadata = metadata;
      this.updateOutputSpacing();
      this.setStatus(
        "Model ready. Verify input/output voxel size and model geometry.",
      );
    } catch (error) {
      if (generation !== this.generation) return;
      this.setStatus(
        `Model load failed: ${error instanceof Error ? error.message : error}`,
        "error",
      );
    } finally {
      if (generation === this.generation && this.alive) {
        this.busy = false;
        // Keep model failures visible; readiness signals can retry the source.
        if (this.metadata !== undefined && this.input === undefined)
          this.schedulePrepareSource();
        this.changed.dispatch();
      }
    }
  }

  async run() {
    if (!this.alive || this.busy || this.liveActive || this.discardStaleInput())
      return;
    if (this.source !== undefined && this.input === undefined) {
      this.confirmed = false;
      this.setStatus(
        "Preparing source; verify and confirm settings before running.",
        "warning",
      );
      this.schedulePrepareSource();
      this.changed.dispatch();
      return;
    }
    const generation = ++this.generation;
    const input = this.input;
    const source = this.source;
    try {
      if (this.metadata === undefined)
        throw new Error("Load a supported .onnx model first");
      if (source === undefined || !(source.layer instanceof ImageUserLayer))
        throw new Error("Select an image source");
      if (input === undefined) throw new Error(this.status);
      if (!this.confirmed)
        throw new Error(
          "Confirm the input/output voxel size and model geometry first",
        );
      const outputSpacing = parseSpacing(this.outputSpacing, "Output");
      const geometry = makeModelGeometry(
        this.metadata,
        [input.spacingZYX[0], input.spacingZYX[1], input.spacingZYX[2]],
        outputSpacing,
      );
      getInferenceStrides(geometry, this.overlap);
      const recipe = parseInferenceRecipe({
        version: 2,
        profile: "ncdhw-centered-v2",
        outputSpacingZYX: outputSpacing,
        source: { name: source.name, source: source.layer.toJSON().source },
        model: this.modelReference,
        provider: this.provider,
        precision: this.precision,
        compatibilityFixes: this.compatibilityFixes,
        overlap: this.overlap,
        mode: "live",
        spacingZYX: input.spacingZYX,
        inputScaleIndex: this.inputScaleIndex,
      });
      // Validate before expensive inference, then replan against the current
      // layout when publishing rather than retaining this preflight snapshot.
      planAdjacentInferenceView(this.viewer.layout.container, source);
      this.busy = true;
      this.setStatus("Starting live inference…");
      this.changed.dispatch();
      const live = {
        inference: new LiveInference(
          this.controller,
          input,
          (error) => {
            // Do not dispose a layer from within a chunk/RPC dispatch.
            queueMicrotask(() => {
              if (this.alive && generation === this.generation) {
                this.invalidate(
                  `Live inference failed: ${error instanceof Error ? error.message : error}`,
                  "error",
                );
                // The live layer can fail after its dialog has been closed.
                StatusMessage.showTemporaryMessage(this.status, 10_000);
              }
            });
          },
          geometry,
          this.overlap,
        ),
        release: () => {},
        layer: undefined as ManagedUserLayer | undefined,
      };
      live.release = () => live.inference.dispose();
      this.live = live;
      this.setStatus("Preparing result layer…");
      this.changed.dispatch();
      const publication = await (
        this.dependencies.publishLive ?? publishLiveInference
      )(this.viewer.chunkManager, live.inference);
      const release = disposableOnce(publication);
      live.release = release;
      if (!this.alive || generation !== this.generation) {
        release();
        return;
      }
      let layer: ManagedUserLayer | undefined;
      let abort: AbortController | undefined;
      let published = false;
      try {
        // Publication is asynchronous; reject newly unlinked navigation before
        // constructing a result layer, then recheck after layer readiness.
        planAdjacentInferenceView(this.viewer.layout.container, source);
        layer = makeLayer(
          this.viewer.layerSpecification,
          `${source.name} inference`,
          {
            type: "image",
            source: makeInferenceRecipeSource(publication, recipe),
            // Preserve raw channels without assuming scores are probabilities.
            shader: getInferenceResultShader(geometry.outputChannels),
          },
        );
        abort = this.pendingAbort = new AbortController();
        await waitForInferenceLayer(layer, abort.signal);
        if (!this.alive || generation !== this.generation) return;
        input.assertValid();
        // Plan against the CURRENT layout before adding the result to root.
        const insert = planAdjacentInferenceView(
          this.viewer.layout.container,
          source,
        );
        this.viewer.layerSpecification.add(layer.addRef());
        try {
          insert(layer.name);
        } catch (error) {
          this.viewer.layerManager.removeManagedLayer(layer);
          throw error;
        }
        // The layer and viewer retain the in-memory source until deletion or
        // viewer disposal. No dialog reference participates in ownership.
        const releaseResult = disposableOnce(() => {
          this.resultDisposers.delete(releaseResult);
          release();
          if (this.live === live) {
            this.live = undefined;
            this.setStatus("Live result deleted; inference stopped.");
            this.changed.dispatch();
          }
        });
        this.resultDisposers.add(releaseResult);
        layer.registerDisposer(releaseResult);
        live.layer = layer;
        published = true;
        this.setStatus(
          `Live: ${layer.name}. Visible tiles only; confirmed output voxel size, ${geometry.outputChannels} channels. Stop live removes the layer.`,
        );
      } finally {
        if (this.pendingAbort === abort) this.pendingAbort = undefined;
        layer?.dispose();
        if (!published) release();
      }
    } catch (error) {
      if (this.alive && generation === this.generation) {
        this.stopLive();
        this.setStatus(
          `Inference failed: ${error instanceof Error ? error.message : error}`,
          "error",
        );
      }
    } finally {
      if (this.alive && generation === this.generation) {
        this.busy = false;
        this.changed.dispatch();
      }
    }
  }

  disposed() {
    this.alive = false;
    this.invalidate("Viewer disposed.");
    this.dialog?.dispose();
    this.clearSource();
    this.controller.dispose();
    for (const dispose of this.resultDisposers) dispose();
    super.disposed();
  }
}

/** isReady alone is insufficient: failed data sources also finish loading. */
export function waitForInferenceLayer(
  layer: ManagedUserLayer,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const disposers: Array<() => void> = [];
    const finish = (error?: unknown) => {
      for (const dispose of disposers.splice(0)) dispose();
      if (error === undefined) resolve();
      else reject(error);
    };
    const check = () => {
      if (signal.aborted) {
        finish(new DOMException("Cancelled", "AbortError"));
        return;
      }
      const image = layer.layer;
      if (!(image instanceof ImageUserLayer)) {
        finish(new Error("Result is not an image layer"));
        return;
      }
      for (const source of image.dataSources) {
        const state = source.loadState;
        if (state !== undefined && "error" in state) {
          finish(state.error);
          return;
        }
      }
      if (layer.isReady()) {
        finish(
          image.dataType.value === undefined || image.renderLayers.length === 0
            ? new Error("Result image data failed to activate")
            : undefined,
        );
      }
    };
    disposers.push(
      layer.readyStateChanged.add(check),
      layer.layerChanged.add(check),
    );
    const image = layer.layer;
    if (image !== null) disposers.push(image.dataSourcesChanged.add(check));
    signal.addEventListener("abort", check, { once: true });
    disposers.push(() => signal.removeEventListener("abort", check));
    check();
  });
}

/** Closing this framed dialog only hides the view; explicit Cancel stops work. */
export class OnnxInferenceDialog extends FramedDialog {
  constructor(readonly session: OnnxInferenceSession) {
    super("Local ONNX inference", "Close");
    const { body, footer } = this;
    this.content.style.cssText =
      "display:flex;flex-direction:column;max-height:95vh;max-width:calc(100vw - 2rem)";
    this.header.style.flexShrink = footer.style.flexShrink = "0";
    body.style.cssText =
      "display:flex;flex-direction:column;gap:8px;max-width:680px;max-height:75vh;min-height:0;overflow:auto;white-space:normal";
    const status = document.createElement("div");
    status.setAttribute("role", "status");
    status.style.cssText =
      "padding:8px 1.5rem;max-height:30vh;overflow:auto;font-weight:bold;overflow-wrap:anywhere;flex-shrink:0";
    body.before(status);
    const addText = (text: string, parent: HTMLElement = body) => {
      const p = document.createElement("div");
      p.textContent = text;
      parent.append(p);
      return p;
    };
    const addDetails = (title: string, text = "") => {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = title;
      details.append(summary);
      body.append(details);
      return addText(text, details);
    };
    const row = (text: string, control: HTMLElement) => {
      const label = document.createElement("label");
      const title = document.createElement("strong");
      title.textContent = text;
      label.append(title, " ", control);
      body.append(label);
      return control;
    };
    const modelUrl = document.createElement("textarea");
    modelUrl.rows = 2;
    modelUrl.wrap = "soft";
    modelUrl.spellcheck = false;
    modelUrl.style.cssText =
      "display:block;width:100%;box-sizing:border-box;overflow-wrap:anywhere;resize:none;overflow:hidden";
    modelUrl.setAttribute("aria-label", "Model URL (.onnx)");
    row("Model URL (.onnx)", modelUrl);
    const resizeModelUrl = () => {
      modelUrl.style.height = "auto";
      modelUrl.style.height = `${modelUrl.scrollHeight + modelUrl.offsetHeight - modelUrl.clientHeight}px`;
    };
    const scheduleModelUrlResize = animationFrameDebounce(resizeModelUrl);
    const modelUrlResizeObserver = new ResizeObserver(scheduleModelUrlResize);
    modelUrlResizeObserver.observe(modelUrl);
    this.registerDisposer(() => {
      modelUrlResizeObserver.disconnect();
      scheduleModelUrlResize.cancel();
    });
    modelUrl.addEventListener("input", () =>
      session.editModelUrl(modelUrl.value),
    );
    const loadUrl = document.createElement("button");
    loadUrl.textContent = "Load model URL";
    loadUrl.addEventListener("click", () => void session.loadModelUrl());
    body.append(loadUrl);
    addDetails(
      "Model download and sharing details",
      "The default model is downloaded from Google Cloud Storage. A model URL overrides it and cancels any pending download. Use HTTPS (or HTTP on loopback) with anonymous CORS access. Inference runs locally in your browser. The model URL, verified size/hash, and inference settings are saved in URL state; shared pages download the model and recompute predictions.",
    );
    const model = addText("");
    const source = document.createElement("select");
    row("Image source", source);
    let identities: ManagedUserLayer[] = [];
    source.addEventListener("change", () =>
      session.selectSource(identities[Number(source.value)]),
    );
    const provider = document.createElement("select");
    provider.setAttribute("aria-label", "Execution provider");
    provider.add(new Option("Auto (prefer hardware WebGPU)", "auto"));
    provider.add(new Option("WebGPU (strict, no CPU kernels)", "webgpu"));
    provider.add(new Option("CPU (WASM)", "cpu"));
    row("Execution provider", provider);
    provider.addEventListener(
      "change",
      () => void session.selectProvider(provider.value as InferenceProvider),
    );
    const providerStatus = addText("");
    providerStatus.setAttribute("aria-label", "Execution provider status");
    const precision = document.createElement("input");
    precision.type = "checkbox";
    precision.setAttribute("aria-label", "Experimental FP16 GPU inference");
    row("Experimental FP16 GPU inference", precision);
    precision.addEventListener(
      "change",
      () =>
        void session.selectPrecision(precision.checked ? "float16" : "float32"),
    );
    const precisionStatus = addText("");
    precisionStatus.setAttribute("aria-label", "Inference precision status");
    addDetails(
      "Experimental FP16 details",
      "Experimental FP16 changes model arithmetic and can affect predictions. Enabling this attempts conversion for any model, including unverified exports; public input/output stay FP32. Unsupported models may still fail conversion or execution. Requires the browser's shader-f16 feature. This option cannot enable Chrome startup flags. Missing support or a first-execution failure retries FP32 with a visible reason; inaccurate finite outputs cannot be detected automatically. CPU always uses FP32.",
    );
    const compatibility = document.createElement("input");
    compatibility.type = "checkbox";
    row("Apply legacy JSEP padding fixes", compatibility);
    compatibility.addEventListener(
      "change",
      () => void session.selectCompatibilityFixes(compatibility.checked),
    );
    const compatibilityStatus = addDetails("Legacy JSEP padding details");
    compatibilityStatus.setAttribute(
      "aria-label",
      "Model compatibility analysis",
    );
    const overlap = document.createElement("input");
    overlap.type = "checkbox";
    overlap.setAttribute("aria-label", "Overlap and blend output patches");
    row("Overlap and blend output patches (chunkflow)", overlap);
    overlap.addEventListener("change", () =>
      session.selectOverlap(overlap.checked),
    );
    const currentSpacing = addText("");
    currentSpacing.setAttribute("aria-label", "Current input voxel size X Y Z");
    const native = addText("");
    const profile = addText("");
    profile.setAttribute("aria-label", "Model geometry");
    addDetails(
      "Model geometry details",
      "Input/output names, shapes and channel count come from the model (float32, batch-one NCDHW, scalar input). Crop 12.5% from each output face, rounded down to whole voxels. With overlap enabled, input stride is 50% of the input patch and blending uses Chunkflow's wu mask, normalized by available weights per voxel/channel. With overlap disabled, output stride equals the retained cropped output patch; patches are copied directly without blending, and the corresponding input stride must align to whole input voxels. Centered input/output fields of view. Native input only: no resampling or padding. Output voxel size is editable and must match the model's training geometry. Live inference follows visible slices with fixed displayed XYZ chunks 60×60×16, independent of model patch size; only full output chunks are published.",
    );
    const inputScale = document.createElement("select");
    inputScale.setAttribute("aria-label", "Input scale X Y Z");
    row("Input scale X Y Z", inputScale);
    inputScale.addEventListener("change", () =>
      session.selectInputScale(Number(inputScale.value)),
    );
    const outputSpacingField = document.createElement("input");
    outputSpacingField.type = "text";
    row(
      "Output voxel size X Y Z (native units shown above)",
      outputSpacingField,
    );
    outputSpacingField.addEventListener("input", () => {
      session.outputSpacing = outputSpacingField.value;
      session.outputSpacingEdited = true;
      session.confirmed = false;
      session.changed.dispatch();
    });
    addDetails(
      "Navigation and raw input details",
      "Result navigation stays linked to the source. Link any unlinked source-group navigation first; existing groups are never relinked automatically. Source raw float values are passed to the model unchanged, without normalization. Verify that the source values and voxel sizes match the model's training requirements.",
    );
    const confirm = document.createElement("input");
    confirm.type = "checkbox";
    confirm.name = "confirm-inference-settings";
    row(
      "I verified the native input voxel size, output voxel size, centered model/crop geometry, and raw source values against this model's training requirements.",
      confirm,
    );
    confirm.addEventListener("change", () => {
      session.confirmed = confirm.checked;
      session.changed.dispatch();
    });
    const run = document.createElement("button");
    run.textContent = "Start live";
    run.addEventListener("click", () => void session.run());
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => session.cancel());
    footer.prepend(run, cancel);
    const update = () => {
      identities = session.sources;
      source.replaceChildren();
      const empty = new Option("Select image layer…", "-1");
      source.add(empty);
      for (let i = 0; i < identities.length; ++i)
        source.add(new Option(identities[i].name, String(i)));
      source.value = String(
        session.source === undefined ? -1 : identities.indexOf(session.source),
      );
      model.textContent =
        session.metadata === undefined
          ? session.modelName
          : `${session.modelName}: input [${session.metadata.inputShape}] → output [${session.metadata.outputShape}]`;
      if (modelUrl.value !== session.modelUrl)
        modelUrl.value = session.modelUrl;
      resizeModelUrl();
      provider.value = session.provider;
      const metadata = session.metadata;
      providerStatus.textContent =
        metadata === undefined
          ? `Requested: ${session.provider}. Runtime not initialized.`
          : `Requested: ${metadata.requestedProvider}; last initialized provider: ${metadata.actualProvider === "wasm" ? "CPU (WASM)" : "WebGPU (native; CPU kernel fallback disabled)"}.${metadata.actualProvider !== "wasm" ? "" : ` WASM threads: ${metadata.threads}. CPU inference is single-threaded to keep popup login compatible.`}${metadata.fallbackReason === undefined ? "" : ` CPU fallback: ${metadata.fallbackReason}`}${metadata.preparation === undefined ? "" : ` Browser preparation: ${metadata.preparation} (legacy JSEP padding fixes, in memory).`}`;
      precision.checked = session.precision === "float16";
      precisionStatus.textContent =
        metadata === undefined
          ? `Requested precision: ${session.precision === "float16" ? "FP16 (experimental GPU)" : "FP32"}. Runtime not initialized.`
          : `Requested precision: ${(metadata.requestedPrecision ?? "float32") === "float16" ? "FP16 (experimental GPU)" : "FP32"}; last initialized precision: ${(metadata.actualPrecision ?? "float32") === "float16" ? "FP16 (public I/O FP32)" : "FP32"}.${metadata.precisionFallbackReason === undefined ? "" : ` FP32 fallback: ${metadata.precisionFallbackReason}`}`;
      compatibility.checked = session.compatibilityFixes;
      overlap.checked = session.overlap;
      const analysis = metadata?.compatibilityAnalysis;
      compatibilityStatus.textContent =
        "Padding workarounds for the older JavaScript WebGPU backend. Not required for the default model on the tested native runtime. " +
        (analysis === undefined
          ? "Model compatibility analysis: load a model to check for verified legacy JSEP padding fixes."
          : `${analysis.message}${analysis.fixes.length === 0 ? "" : ` Fixes: ${analysis.fixes.join("; ")}.`}${analysis.status !== "available" ? "" : session.compatibilityFixes ? " Legacy JSEP padding fixes enabled. CPU uses the original model." : " Legacy JSEP padding fixes are disabled."}`);
      const input = session.input;
      const sourceMetadata = session.sourceMetadata;
      currentSpacing.textContent =
        sourceMetadata === undefined
          ? "Current input voxel size X Y Z: unavailable."
          : `Current input voxel size X Y Z: ${sourceMetadata.spacingZYX
              .map(
                (value, i) =>
                  `${value} ${sourceMetadata.unitsZYX[i] || "unitless"}`,
              )
              .reverse()
              .join(
                ", ",
              )}; axes: ${[...sourceMetadata.axisNamesZYX].reverse().join(", ")}.`;
      native.textContent =
        input === undefined
          ? session.source === undefined
            ? "Native resolution: select an image source."
            : "Inference unavailable for the selected image source."
          : `Source scale ${session.inputScaleIndex} origin ZYX: ${input.originZYX.join(", ")}; shape ZYX: ${input.shapeZYX.join(", ")}; axes: ${input.axisNamesZYX.join(", ")}. Selected scale only; no resampling.`;
      profile.textContent =
        "Model geometry: load a model and select an image source.";
      if (metadata !== undefined && sourceMetadata !== undefined) {
        try {
          const geometry = makeModelGeometry(
            metadata,
            [
              sourceMetadata.spacingZYX[0],
              sourceMetadata.spacingZYX[1],
              sourceMetadata.spacingZYX[2],
            ],
            parseSpacing(session.outputSpacing, "Output"),
          );
          const strides = getInferenceStrides(geometry, session.overlap);
          profile.textContent = `Model geometry ZYX: input ${geometry.inputShape.join("×")}; raw output ${geometry.rawOutputShape.join("×")}; ${geometry.outputChannels} channels; crop ${geometry.cropBefore.join(", ")} per face retains ${getRetainedOutputShape(geometry).join("×")}; input stride ${strides.inputStride.join(", ")}; output stride ${strides.outputStride.join(", ")}; ${session.overlap ? "wu overlap/blending enabled" : "no overlap or blending"}; output voxel size ${geometry.outputSpacing.join(", ")}.`;
        } catch (error) {
          profile.textContent = `Model geometry: ${error instanceof Error ? error.message : error}`;
        }
      }
      status.textContent = session.status;
      status.dataset.severity = session.statusLevel;
      status.style.color = {
        info: "#1b5e20",
        warning: "#8a5700",
        error: "#b71c1c",
      }[session.statusLevel];
      if (outputSpacingField.value !== session.outputSpacing)
        outputSpacingField.value = session.outputSpacing;
      inputScale.replaceChildren();
      for (const scale of session.inputScales) {
        const label = scale.spacingZYX
          .map((value, i) =>
            formatScaleWithUnitAsString(value, scale.unitsZYX[i], {
              elide1: false,
            }),
          )
          .reverse()
          .join(" × ");
        inputScale.add(
          new Option(
            `Scale ${scale.scaleIndex}: ${label}`,
            String(scale.scaleIndex),
          ),
        );
      }
      if (session.inputScales.length === 0)
        inputScale.add(new Option("No available scales", ""));
      else inputScale.value = String(session.inputScaleIndex);
      confirm.checked = session.confirmed;
      const locked = session.busy || session.liveActive;
      source.disabled = session.busy;
      confirm.disabled = locked;
      inputScale.disabled = locked || session.inputScales.length === 0;
      outputSpacingField.disabled = locked;
      // Downloads may be superseded by another URL or provider change.
      modelUrl.disabled = loadUrl.disabled =
        locked && !session.downloadingModel;
      provider.disabled = locked && !session.downloadingModel;
      precision.disabled = locked && !session.downloadingModel;
      compatibility.disabled = locked;
      overlap.disabled = locked;
      run.disabled =
        locked ||
        session.metadata === undefined ||
        session.input === undefined ||
        !session.confirmed;
      cancel.textContent = session.liveActive ? "Stop live" : "Cancel";
      cancel.disabled = !locked;
    };
    this.registerDisposer(session.changed.add(update));
    this.registerDisposer(() => {
      if (session.dialog === this) session.dialog = undefined;
    });
    update();
  }
}

export function bindOnnxInference(viewer: Viewer): OnnxInferenceSession {
  viewer.registerDisposer(
    installInferenceRecipeContext(viewer.layerSpecification),
  );
  const session = viewer.registerDisposer(new OnnxInferenceSession(viewer));
  viewer.registerDisposer(
    viewer.commandRegistry.register(
      new ActionCommand(
        "open-onnx-inference",
        "Local ONNX Inference",
        "Download the default ONNX model or load a model URL and run confirmed live visible-slice inference locally in your browser.",
      ),
    ),
  );
  viewer.bindAction("open-onnx-inference", () => session.open());
  return session;
}
