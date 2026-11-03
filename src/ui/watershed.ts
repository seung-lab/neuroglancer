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

import { publishWatershedResult } from "#src/datasource/watershed/frontend.js";
import { ImageUserLayer } from "#src/layer/image/index.js";
import type { ManagedUserLayer } from "#src/layer/index.js";
import { deleteLayer, makeLayer } from "#src/layer/index.js";
import { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import { FramedDialog } from "#src/overlay.js";
import { ActionCommand } from "#src/ui/command.js";
import { disposableOnce, RefCounted } from "#src/util/disposable.js";
import { NullarySignal } from "#src/util/signal.js";
import type { Viewer } from "#src/viewer.js";
import {
  ABISS_WATERSHED_LICENSE_URL,
  ABISS_WATERSHED_SOURCE_URL,
  DEFAULT_WATERSHED_OPTIONS,
  MAX_WATERSHED_VOXELS,
  validateWatershedOptions,
  type WatershedOptions,
} from "#src/watershed/base.js";
import {
  prepareAffinityInput,
  type PreparedAffinityInput,
} from "#src/watershed/input.js";
import { computeWatershed } from "#src/watershed/run.js";

export interface WatershedDependencies {
  prepareInput: typeof prepareAffinityInput;
  compute: typeof computeWatershed;
  publish: typeof publishWatershedResult;
}

const defaultDependencies: WatershedDependencies = {
  prepareInput: prepareAffinityInput,
  compute: computeWatershed,
  publish: publishWatershedResult,
};

type InputMetadata = Pick<
  PreparedAffinityInput,
  "lowerBoundXYZ" | "upperBoundXYZ" | "channelCount" | "spacingXYZ" | "unitsXYZ"
>;

type Job = {
  input: PreparedAffinityInput;
  abort: AbortController;
  release(): void;
};

function integer(text: string, name: string, minimum?: number) {
  const value = text.trim() === "" ? NaN : Number(text);
  if (
    !Number.isSafeInteger(value) ||
    (minimum !== undefined && value < minimum)
  )
    throw new Error(
      `${name} must be ${minimum === undefined ? "an integer" : `an integer ≥ ${minimum}`}`,
    );
  return value;
}

function triple(text: string, name: string, minimum?: number) {
  const parts = text.trim().split(/[\s,]+/);
  if (parts.length !== 3)
    throw new Error(`${name} must contain three integers in X Y Z order`);
  return parts.map((part) => integer(part, name, minimum));
}

function threshold(text: string, name: string) {
  const value = text.trim() === "" ? NaN : Number(text);
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new Error(`${name} must be a number between 0 and 1`);
  return value;
}

/** Viewer-owned job and drafts. Neither jobs nor results belong to the dialog. */
export class WatershedSession extends RefCounted {
  readonly changed = new NullarySignal();
  dialog: WatershedDialog | undefined;
  source: ManagedUserLayer | undefined;
  metadata: InputMetadata | undefined;
  scaleIndex = "0";
  lowerXYZ = "";
  shapeXYZ = "";
  channelsXYZ = "0, 1, 2";
  highThreshold = String(DEFAULT_WATERSHED_OPTIONS.highThreshold);
  lowThreshold = String(DEFAULT_WATERSHED_OPTIONS.lowThreshold);
  sizeThreshold = String(DEFAULT_WATERSHED_OPTIONS.sizeThreshold);
  dustThreshold = String(DEFAULT_WATERSHED_OPTIONS.dustThreshold);
  status = "Select an affinity image layer and a native voxel ROI.";
  statusLevel: "info" | "error" = "info";
  private alive = true;
  private pending: Job | undefined;
  private sourceDisposers: Array<() => void> = [];
  private resultDisposers = new Set<() => void>();

  constructor(
    readonly viewer: Viewer,
    readonly dependencies = defaultDependencies,
  ) {
    super();
    this.registerDisposer(
      viewer.layerManager.layersChanged.add(() => this.refreshSources()),
    );
    this.registerDisposer(
      viewer.layerManager.readyStateChanged.add(() => {
        this.refreshSources();
        if (this.alive && !this.busy && this.metadata === undefined) {
          this.inspectSource(false);
          this.changed.dispatch();
        }
      }),
    );
    this.registerDisposer(viewer.resetInitiated.add(() => this.reset()));
    this.registerDisposer(viewer.state.stateReset.add(() => this.reset()));
  }

  get busy() {
    return this.pending !== undefined;
  }

  get sources() {
    return this.viewer.layerManager.managedLayers.filter(
      (layer) => layer.layer instanceof ImageUserLayer,
    );
  }

  open() {
    if (!this.alive) return;
    if (this.dialog === undefined) this.dialog = new WatershedDialog(this);
    else this.dialog.content.focus();
    this.refreshSources();
  }

  refreshSources() {
    if (!this.alive) return;
    if (this.source !== undefined && !this.sources.includes(this.source))
      this.selectSource(undefined);
    if (this.pending !== undefined && !this.pending.input.isValid())
      this.invalidate("Source data or transform changed; result discarded.");
    this.changed.dispatch();
  }

  selectSource(source: ManagedUserLayer | undefined) {
    if (source === this.source) return;
    this.invalidate("Select a native voxel ROI, then run watershed.");
    for (const dispose of this.sourceDisposers.splice(0)) dispose();
    this.source = source;
    this.metadata = undefined;
    this.scaleIndex = "0";
    this.lowerXYZ = this.shapeXYZ = "";
    const image = source?.layer;
    if (source !== undefined && image instanceof ImageUserLayer) {
      this.sourceDisposers.push(
        source.layerChanged.add(() => {
          // Rename, visibility and shader/render-layer notifications are not
          // replacements. Snapshot validity handles changes to source geometry.
          if (source.layer !== image) this.selectSource(undefined);
          else this.refreshSources();
        }),
        image.dataSourcesChanged.add(() => {
          this.invalidate("Source data changed; result discarded.");
          this.metadata = undefined;
          // Signal visits newly added handlers during the current dispatch.
          // Never prepare a replacement snapshot inside that dispatch.
          queueMicrotask(() => {
            if (this.alive && this.source === source && !this.busy) {
              this.inspectSource(false);
              this.changed.dispatch();
            }
          });
        }),
      );
      this.inspectSource(true);
    }
    this.changed.dispatch();
  }

  selectScale(text: string) {
    if (text === this.scaleIndex) return;
    this.invalidate("Source scale changed; verify the native voxel ROI.");
    this.scaleIndex = text;
    this.metadata = undefined;
    this.lowerXYZ = this.shapeXYZ = "";
    this.inspectSource(true);
    this.changed.dispatch();
  }

  private rememberMetadata(input: PreparedAffinityInput) {
    // Copy values only: an idle draft/result must not retain source chunk refs.
    this.metadata = {
      lowerBoundXYZ: [...input.lowerBoundXYZ],
      upperBoundXYZ: [...input.upperBoundXYZ],
      spacingXYZ: [...input.spacingXYZ],
      unitsXYZ: [...input.unitsXYZ],
      channelCount: input.channelCount,
    };
  }

  private inspectSource(initializeRoi: boolean) {
    const image = this.source?.layer;
    if (!(image instanceof ImageUserLayer)) return;
    let input: PreparedAffinityInput | undefined;
    try {
      input = this.dependencies.prepareInput(
        image,
        integer(this.scaleIndex, "Source scale index", 0),
      );
      input.assertValid();
      this.rememberMetadata(input);
      if (this.statusLevel === "error")
        this.setStatus("Select a native voxel ROI, then run watershed.");
      if (initializeRoi || (this.lowerXYZ === "" && this.shapeXYZ === "")) {
        this.lowerXYZ = input.lowerBoundXYZ.join(", ");
        this.shapeXYZ = input.upperBoundXYZ
          .map((upper, i) =>
            Math.min(upper - input!.lowerBoundXYZ[i], [128, 128, 64][i]),
          )
          .join(", ");
      }
    } catch (error) {
      this.setStatus(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    } finally {
      input?.dispose();
    }
  }

  private setStatus(
    message: string,
    level: WatershedSession["statusLevel"] = "info",
  ) {
    this.status = message;
    this.statusLevel = level;
  }

  private invalidate(message: string) {
    const job = this.pending;
    this.pending = undefined;
    job?.abort.abort();
    job?.release();
    this.setStatus(message);
    this.changed.dispatch();
  }

  cancel() {
    if (!this.alive || !this.busy) return;
    this.invalidate(
      "Cancelled; results discarded. Already-started bounded WASM work may finish in the worker.",
    );
  }

  reset() {
    this.selectSource(undefined);
    this.invalidate("Viewer reset; select an affinity image layer.");
    for (const dispose of this.resultDisposers) dispose();
  }

  async run() {
    if (!this.alive || this.busy) return;
    let input: PreparedAffinityInput | undefined;
    let job: Job | undefined;
    try {
      const source = this.source;
      const image = source?.layer;
      if (source === undefined || !(image instanceof ImageUserLayer))
        throw new Error("Select an affinity image layer");
      input = this.dependencies.prepareInput(
        image,
        integer(this.scaleIndex, "Source scale index", 0),
      );
      input.assertValid();
      this.rememberMetadata(input);
      const lower = triple(this.lowerXYZ, "ROI lower X Y Z");
      const shape = triple(this.shapeXYZ, "ROI size X Y Z", 1);
      const channels = triple(this.channelsXYZ, "Channels for −X −Y −Z", 0);
      if (shape.reduce((a, b) => a * b, 1) > MAX_WATERSHED_VOXELS)
        throw new Error(
          `ROI exceeds ${MAX_WATERSHED_VOXELS} voxels (2**21 maximum)`,
        );
      if (
        lower.some(
          (x, i) =>
            x < input!.lowerBoundXYZ[i] ||
            x + shape[i] > input!.upperBoundXYZ[i],
        )
      )
        throw new Error(
          "ROI must be fully inside the selected scale bounds; no padding",
        );
      if (new Set(channels).size !== 3)
        throw new Error("Select three distinct affinity channels");
      if (channels.some((channel) => channel >= input!.channelCount))
        throw new Error(
          `Channel indices must be less than ${input.channelCount}`,
        );
      const options: WatershedOptions = {
        highThreshold: threshold(this.highThreshold, "High threshold"),
        lowThreshold: threshold(this.lowThreshold, "Low threshold"),
        sizeThreshold: integer(this.sizeThreshold, "Size threshold", 0),
        dustThreshold: integer(this.dustThreshold, "Dust threshold", 0),
      };
      validateWatershedOptions(options);
      const abort = new AbortController();
      const snapshot = input;
      let removeInvalidation = () => {};
      job = {
        input,
        abort,
        release: disposableOnce(() => {
          removeInvalidation();
          snapshot.dispose();
        }),
      };
      this.pending = job;
      const invalidate = () => {
        if (this.pending === job)
          this.invalidate(
            "Source data or transform changed; result discarded.",
          );
      };
      input.signal.addEventListener("abort", invalidate, { once: true });
      removeInvalidation = () =>
        snapshot.signal.removeEventListener("abort", invalidate);
      if (input.signal.aborted) {
        invalidate();
        return;
      }
      this.setStatus("Computing one bounded ROI in WASM…");
      this.changed.dispatch();
      if (!this.alive || this.pending !== job) return;
      const result = await this.dependencies.compute(
        input,
        lower,
        shape,
        channels,
        options,
        abort.signal,
      );
      if (!this.alive || this.pending !== job) return;
      abort.signal.throwIfAborted();
      input.assertValid();
      const publication = this.dependencies.publish(
        this.viewer.chunkManager,
        result,
      );
      const release = disposableOnce(publication);
      let layer: ManagedUserLayer | undefined;
      let published = false;
      try {
        if (!this.alive || this.pending !== job) return;
        layer = makeLayer(
          this.viewer.layerSpecification,
          this.viewer.layerManager.getUniqueLayerName(
            `${source.name} watershed`,
          ),
          {
            type: "segmentation",
            source: publication.url,
            // With an empty selection, show every nonzero label in the ROI.
            ignoreNullVisibleSet: true,
            selectedAlpha: 0.5,
          },
        );
        await waitForWatershedLayer(layer, abort.signal);
        if (!this.alive || this.pending !== job) return;
        input.assertValid();
        this.viewer.layerSpecification.add(layer.addRef());
        // Reuse current source-group membership, never split/rewrite a layout.
        for (const subset of this.viewer.layerSpecification.subsets) {
          if (
            subset.layerManager.has(source) &&
            !subset.layerManager.has(layer)
          )
            subset.add(layer.addRef());
        }
        if (!this.alive || this.pending !== job) return;
        input.assertValid();
        const releaseResult = disposableOnce(() => {
          this.resultDisposers.delete(releaseResult);
          release();
        });
        this.resultDisposers.add(releaseResult);
        layer.registerDisposer(releaseResult);
        published = true;
        this.setStatus(
          `Completed: ${layer.name}. Session-local snapshot; not shareable or recomputed from URL state.`,
        );
      } finally {
        if (!published) {
          if (layer !== undefined) deleteLayer(layer);
          release();
        }
        layer?.dispose();
      }
    } catch (error) {
      if (this.alive && (job === undefined || this.pending === job))
        this.setStatus(
          `Watershed failed: ${error instanceof Error ? error.message : error}`,
          "error",
        );
    } finally {
      if (job !== undefined) {
        if (this.pending === job) this.pending = undefined;
        job.release();
      } else input?.dispose();
      if (this.alive) this.changed.dispatch();
    }
  }

  disposed() {
    this.alive = false;
    this.reset();
    this.dialog?.dispose();
    super.disposed();
  }
}

/** Failed sources can be ready too; require an activated segmentation volume. */
export function waitForWatershedLayer(
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
      const segmentation = layer.layer;
      if (!(segmentation instanceof SegmentationUserLayer)) {
        finish(new Error("Result is not a segmentation layer"));
        return;
      }
      for (const source of segmentation.dataSources) {
        const state = source.loadState;
        if (state?.error !== undefined) {
          finish(state.error);
          return;
        }
      }
      if (layer.isReady())
        finish(
          segmentation.displayState.hasVolume.value &&
            segmentation.renderLayers.length !== 0
            ? undefined
            : new Error("Result segmentation data failed to activate"),
        );
    };
    disposers.push(
      layer.readyStateChanged.add(check),
      layer.layerChanged.add(check),
    );
    if (layer.layer !== null)
      disposers.push(layer.layer.dataSourcesChanged.add(check));
    signal.addEventListener("abort", check, { once: true });
    disposers.push(() => signal.removeEventListener("abort", check));
    check();
  });
}

/** Closing the view does not cancel a job or dispose completed snapshots. */
export class WatershedDialog extends FramedDialog {
  constructor(readonly session: WatershedSession) {
    super("WASM Watershed", "Close");
    this.content.style.cssText =
      "display:flex;flex-direction:column;max-height:95vh;max-width:calc(100vw - 2rem)";
    this.body.style.cssText =
      "display:flex;flex-direction:column;gap:8px;max-width:600px;overflow:auto;min-height:0;white-space:normal";
    this.header.style.flexShrink = this.footer.style.flexShrink = "0";
    const text = (value: string) => {
      const element = document.createElement("div");
      element.textContent = value;
      this.body.append(element);
      return element;
    };
    text(
      "Affinities connect each voxel towards its negative axes (−X, −Y, −Z). Integer values are normalized by their data type maximum; floating-point values are unchanged. Non-native transforms are rejected.",
    );
    text(
      `Compute one ROI as a SINGLE volume: no tiled stitching, resampling or padding. Maximum ${MAX_WATERSHED_VOXELS} (2**21) voxels. Coordinates are selected-scale native voxel indices in X Y Z order, not viewer coordinates.`,
    );
    text(
      "Results are session-local snapshots, not shareable and not recomputed on a restored URL. Closing this dialog keeps the job and results. Cancel aborts chunk reads and discards results; bounded already-started WASM work may finish in the worker.",
    );
    const license = text(
      "Algorithm license: GNU General Public License v3 or later (GPL v3+). ",
    );
    for (const [title, url] of [
      ["License", ABISS_WATERSHED_LICENSE_URL],
      [
        "Corresponding source and build instructions",
        ABISS_WATERSHED_SOURCE_URL,
      ],
    ]) {
      const link = document.createElement("a");
      link.textContent = title;
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener";
      license.append(link, " ");
    }
    const row = (title: string, control: HTMLElement) => {
      const label = document.createElement("label");
      control.setAttribute("aria-label", title);
      label.append(title, " ", control);
      this.body.append(label);
    };
    const source = document.createElement("select");
    row("Affinity image source", source);
    let identities: ManagedUserLayer[] = [];
    source.addEventListener("change", () =>
      session.selectSource(identities[Number(source.value)]),
    );
    const fields: Array<{
      input: HTMLInputElement;
      key:
        | "scaleIndex"
        | "lowerXYZ"
        | "shapeXYZ"
        | "channelsXYZ"
        | keyof WatershedOptions;
    }> = [];
    const field = (
      title: string,
      key: (typeof fields)[number]["key"],
      numeric = false,
    ) => {
      const input = document.createElement("input");
      input.type = numeric ? "number" : "text";
      if (numeric) {
        input.min = "0";
        input.step =
          key === "highThreshold" || key === "lowThreshold" ? "any" : "1";
      }
      if (key === "highThreshold" || key === "lowThreshold") input.max = "1";
      row(title, input);
      input.addEventListener("input", () => {
        if (key === "scaleIndex") session.selectScale(input.value);
        else session[key] = input.value;
      });
      fields.push({ input, key });
    };
    field("Source scale index", "scaleIndex", true);
    const metadata = text("");
    metadata.setAttribute("aria-label", "Selected scale bounds and voxel size");
    field("ROI lower X Y Z", "lowerXYZ");
    field("ROI size X Y Z", "shapeXYZ");
    field("Channels for −X −Y −Z", "channelsXYZ");
    field("High threshold", "highThreshold", true);
    field("Low threshold", "lowThreshold", true);
    field("Size threshold", "sizeThreshold", true);
    field("Dust threshold", "dustThreshold", true);
    const status = text("");
    status.setAttribute("role", "status");
    status.style.cssText = "font-weight:bold;overflow-wrap:anywhere";
    const run = document.createElement("button");
    run.textContent = "Run watershed";
    run.addEventListener("click", () => void session.run());
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => session.cancel());
    this.footer.prepend(run, cancel);
    const update = () => {
      identities = session.sources;
      source.replaceChildren(new Option("Select image layer…", "-1"));
      identities.forEach((layer, i) =>
        source.add(new Option(layer.name, String(i))),
      );
      source.value = String(
        session.source === undefined ? -1 : identities.indexOf(session.source),
      );
      source.disabled = session.busy;
      for (const { input, key } of fields) {
        if (input.value !== session[key]) input.value = session[key];
        input.disabled = session.busy;
      }
      const m = session.metadata;
      metadata.textContent =
        m === undefined
          ? "Selected scale metadata unavailable."
          : `Native bounds [${m.lowerBoundXYZ.join(", ")}] to [${m.upperBoundXYZ.join(", ")}) X Y Z; ${m.channelCount} channels. Voxel size X Y Z: ${m.spacingXYZ.map((x, i) => `${x} ${m.unitsXYZ[i] || "unitless"}`).join(", ")}.`;
      status.textContent = session.status;
      status.dataset.severity = session.statusLevel;
      status.style.color =
        session.statusLevel === "error" ? "#b71c1c" : "inherit";
      run.disabled = session.busy || session.source === undefined;
      cancel.disabled = !session.busy;
    };
    this.registerDisposer(session.changed.add(update));
    this.registerDisposer(() => {
      if (session.dialog === this) session.dialog = undefined;
    });
    update();
  }
}

export function bindWatershed(viewer: Viewer): WatershedSession {
  const session = viewer.registerDisposer(new WatershedSession(viewer));
  viewer.registerDisposer(
    viewer.commandRegistry.register(
      new ActionCommand(
        "open-watershed",
        "WASM Watershed",
        "Segment one bounded native affinity ROI locally with WASM watershed (GPL v3+).",
      ),
    ),
  );
  viewer.bindAction("open-watershed", () => session.open());
  return session;
}
