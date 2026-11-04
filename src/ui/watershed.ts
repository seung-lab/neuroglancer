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

import { publishLiveWatershed } from "#src/datasource/watershed/frontend.js";
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
  validateWatershedOptions,
  type WatershedOptions,
} from "#src/watershed/base.js";
import {
  prepareAffinityInput,
  type PreparedAffinityInput,
} from "#src/watershed/input.js";
import { LiveWatershed } from "#src/watershed/live.js";
import { watchWatershedViewport } from "#src/watershed/viewport.js";

export interface WatershedDependencies {
  prepareInput: typeof prepareAffinityInput;
  createLive(
    input: PreparedAffinityInput,
    channelsXYZ: readonly number[],
    options: WatershedOptions,
    onError: (error: unknown) => void,
  ): LiveWatershed;
  publish: typeof publishLiveWatershed;
  watchViewport: typeof watchWatershedViewport;
}

const defaultDependencies: WatershedDependencies = {
  prepareInput: prepareAffinityInput,
  createLive: (...args) => new LiveWatershed(...args),
  publish: publishLiveWatershed,
  watchViewport: watchWatershedViewport,
};

type InputMetadata = Pick<
  PreparedAffinityInput,
  "lowerBoundXYZ" | "upperBoundXYZ" | "channelCount" | "spacingXYZ" | "unitsXYZ"
>;

type LiveLayer = {
  check(): void;
  release(): void;
};

function integer(text: string, name: string, minimum = 0) {
  const value = text.trim() === "" ? NaN : Number(text);
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new Error(`${name} must be an integer ≥ ${minimum}`);
  return value;
}

function channels(text: string) {
  const parts = text.trim().split(/[\s,]+/);
  if (parts.length !== 3)
    throw new Error("Channels for −X −Y −Z must contain three integers");
  return parts.map((part) => integer(part, "Channels for −X −Y −Z"));
}

function threshold(text: string, name: string) {
  const value = text.trim() === "" ? NaN : Number(text);
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new Error(`${name} must be a number between 0 and 1`);
  return value;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Viewer-owned drafts; each created layer has an independent live lifetime. */
export class WatershedSession extends RefCounted {
  readonly changed = new NullarySignal();
  dialog: WatershedDialog | undefined;
  source: ManagedUserLayer | undefined;
  metadata: InputMetadata | undefined;
  scaleIndex = "0";
  useLastChannelAsMask = false;
  maskThreshold = "0.3";
  highThreshold = String(DEFAULT_WATERSHED_OPTIONS.highThreshold);
  lowThreshold = String(DEFAULT_WATERSHED_OPTIONS.lowThreshold);
  sizeThreshold = String(DEFAULT_WATERSHED_OPTIONS.sizeThreshold);
  dustThreshold = String(DEFAULT_WATERSHED_OPTIONS.dustThreshold);
  status = "Select a ready affinity image layer, then add a watershed layer.";
  statusLevel: "info" | "error" = "info";
  private alive = true;
  private pending: LiveLayer | undefined;
  private sourceDisposers: Array<() => void> = [];
  private liveLayers = new Set<LiveLayer>();
  private metadataError: string | undefined;
  private channelMapping = "0, 1, 2";
  private automaticChannels = true;
  private mappingChannelCount: number | undefined;

  get channelsXYZ() {
    return this.channelMapping;
  }

  set channelsXYZ(value: string) {
    this.channelMapping = value;
    // Even an explicitly entered default/repeated mapping is a user choice.
    this.automaticChannels = false;
  }

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
          this.inspectSource();
          this.changed.dispatch();
        }
      }),
    );
    this.registerDisposer(viewer.resetInitiated.add(() => this.reset()));
    this.registerDisposer(viewer.state.stateReset.add(() => this.reset()));
  }

  /** Only layer activation is pending; viewport computation never blocks Add. */
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
    for (const layer of this.liveLayers) layer.check();
    this.changed.dispatch();
  }

  selectSource(source: ManagedUserLayer | undefined) {
    if (source === this.source) return;
    for (const dispose of this.sourceDisposers.splice(0)) dispose();
    // Changing the draft must not cancel layers already using another source.
    this.source = source;
    this.metadata = undefined;
    this.metadataError = undefined;
    this.scaleIndex = "0";
    // Manager notifications may already have reported a live source failure.
    // Clearing that source must not replace the error with a neutral prompt.
    if (source !== undefined || this.statusLevel !== "error")
      this.setStatus(
        "Select a ready affinity image layer, then add a watershed layer.",
      );
    const image = source?.layer;
    if (source !== undefined && image instanceof ImageUserLayer) {
      this.sourceDisposers.push(
        source.layerChanged.add(() => {
          if (source.layer !== image) this.selectSource(undefined);
          else this.refreshSources();
        }),
        image.dataSourcesChanged.add(() => {
          this.metadata = undefined;
          // Signal visits newly added handlers during the current dispatch.
          // Inspect only after existing prepared inputs have been invalidated.
          queueMicrotask(() => {
            if (this.alive && this.source === source && !this.busy) {
              this.inspectSource();
              this.changed.dispatch();
            }
          });
        }),
      );
      this.inspectSource();
    }
    this.changed.dispatch();
  }

  selectScale(text: string) {
    if (text === this.scaleIndex) return;
    this.scaleIndex = text;
    this.metadata = undefined;
    this.inspectSource();
    this.changed.dispatch();
  }

  private updateChannelDraft(channelCount: number) {
    // Retain the last known count across temporary metadata unavailability.
    // Harmless notifications must not reset a custom (even unfinished) draft.
    if (channelCount !== this.mappingChannelCount) {
      let reset = this.automaticChannels;
      if (!reset) {
        try {
          reset = channels(this.channelsXYZ).some(
            (c) =>
              c >= channelCount ||
              (this.useLastChannelAsMask &&
                channelCount >= 4 &&
                c === channelCount - 1),
          );
        } catch {
          reset = true;
        }
      }
      if (reset) {
        this.channelMapping = channelCount >= 3 ? "0, 1, 2" : "0, 0, 0";
        this.automaticChannels = true;
      }
      this.mappingChannelCount = channelCount;
    }
    if (channelCount < 4) this.useLastChannelAsMask = false;
  }

  private rememberMetadata(input: PreparedAffinityInput) {
    // The draft retains values only, never source chunk references.
    this.metadata = {
      lowerBoundXYZ: [...input.lowerBoundXYZ],
      upperBoundXYZ: [...input.upperBoundXYZ],
      spacingXYZ: [...input.spacingXYZ],
      unitsXYZ: [...input.unitsXYZ],
      channelCount: input.channelCount,
    };
  }

  private inspectSource() {
    const image = this.source?.layer;
    if (!(image instanceof ImageUserLayer)) return;
    let input: PreparedAffinityInput | undefined;
    try {
      input = this.dependencies.prepareInput(
        image,
        integer(this.scaleIndex, "Source scale index"),
      );
      input.assertValid();
      this.updateChannelDraft(input.channelCount);
      this.rememberMetadata(input);
      // A successful draft inspection must not hide a live layer's failure.
      if (this.status === this.metadataError)
        this.setStatus("Ready to add a live watershed layer.");
      this.metadataError = undefined;
    } catch (error) {
      this.metadataError = `Affinity source unavailable: ${errorMessage(error)}`;
      this.setStatus(this.metadataError, "error");
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

  reset() {
    this.selectSource(undefined);
    for (const layer of this.liveLayers) layer.release();
    this.setStatus("Viewer reset; select an affinity image layer.");
    this.changed.dispatch();
  }

  /** Publish a volume whose shared result follows the visible slice bounds. */
  async addLayer() {
    if (!this.alive || this.busy) return;
    let input: PreparedAffinityInput | undefined;
    let live: LiveWatershed | undefined;
    let publication: ReturnType<WatershedDependencies["publish"]> | undefined;
    let layer: ManagedUserLayer | undefined;
    let entry: LiveLayer | undefined;
    let attached = false;
    let activated = false;
    let released = false;
    const abort = new AbortController();
    const removers: Array<() => void> = [];
    const release = disposableOnce(() => {
      released = true;
      if (entry !== undefined) this.liveLayers.delete(entry);
      if (this.pending === entry) this.pending = undefined;
      for (const remove of removers.splice(0)) remove();
      abort.abort();
      if (layer !== undefined) {
        layer.unregisterDisposer(release);
        // Do not leave cached labels looking valid after source invalidation.
        deleteLayer(layer);
      }
      // Each successful ownership transfer replaces the caller's disposer.
      if (publication !== undefined) publication.dispose();
      else if (live !== undefined) live.dispose();
      else input?.dispose();
    });
    try {
      const source = this.source;
      const image = source?.layer;
      if (source === undefined || !(image instanceof ImageUserLayer))
        throw new Error("Select an affinity image layer");
      input = this.dependencies.prepareInput(
        image,
        integer(this.scaleIndex, "Source scale index"),
      );
      input.assertValid();
      this.rememberMetadata(input);
      const channelsXYZ = channels(this.channelsXYZ);
      if (channelsXYZ.some((channel) => channel >= input!.channelCount))
        throw new Error(
          `Channel indices must be less than ${input.channelCount}`,
        );
      if (this.useLastChannelAsMask) {
        if (input.channelCount < 4)
          throw new Error("Masking requires at least four source channels");
        if (channelsXYZ.includes(input.channelCount - 1))
          throw new Error(
            "The last source channel is reserved for the mask; select other affinity channels",
          );
      }
      const options: WatershedOptions = {
        highThreshold: threshold(this.highThreshold, "High threshold"),
        lowThreshold: threshold(this.lowThreshold, "Low threshold"),
        sizeThreshold: integer(this.sizeThreshold, "Size threshold"),
        dustThreshold: integer(this.dustThreshold, "Dust threshold"),
        ...(this.useLastChannelAsMask
          ? { maskThreshold: threshold(this.maskThreshold, "Mask threshold") }
          : {}),
      };
      validateWatershedOptions(options);
      // Buffer synchronous errors until ownership has safely transferred.
      const startupErrors: unknown[] = [];
      let reportError = (error: unknown) => {
        startupErrors.push(error);
      };
      // Retain geometry access after ownership transfers to the live layer.
      const preparedInput = input;
      live = this.dependencies.createLive(
        preparedInput,
        channelsXYZ,
        options,
        (error) => reportError(error),
      );
      input = undefined;
      if (startupErrors.length !== 0) throw startupErrors[0];
      publication = this.dependencies.publish(this.viewer.chunkManager, live);
      if (startupErrors.length !== 0) throw startupErrors[0];
      const stop = (error: unknown) => {
        if (released) return;
        release();
        if (!this.alive) return;
        this.setStatus(
          `Watershed stopped (${layer?.name ?? source.name}): ${errorMessage(error)}`,
          "error",
        );
        this.changed.dispatch();
      };
      entry = {
        release,
        check: () => {
          if (released) return;
          if (
            attached &&
            layer !== undefined &&
            !this.viewer.layerManager.has(layer)
          ) {
            release();
            return;
          }
          if (!this.viewer.layerManager.has(source) || source.layer !== image) {
            stop(
              new Error(
                "Affinity source deleted or replaced; live layer removed.",
              ),
            );
            return;
          }
          try {
            live!.assertValid();
            if (live!.signal.aborted)
              throw new Error(
                "Affinity source invalidated; live layer removed.",
              );
          } catch (error) {
            stop(error);
          }
        },
      };
      this.liveLayers.add(entry);
      this.pending = entry;
      reportError = stop;
      const invalidated = () =>
        stop(new Error("Affinity source invalidated; live layer removed."));
      live.signal.addEventListener("abort", invalidated, { once: true });
      removers.push(
        () => live!.signal.removeEventListener("abort", invalidated),
        source.layerChanged.add(entry.check),
        image.dataSourcesChanged.add(entry.check),
      );
      entry.check();
      if (released) return;
      this.setStatus("Adding live watershed layer…");
      this.changed.dispatch();
      if (released) return;
      layer = makeLayer(
        this.viewer.layerSpecification,
        this.viewer.layerManager.getUniqueLayerName(`${source.name} watershed`),
        {
          type: "segmentation",
          source: publication.url,
          // With an empty selection, show every nonzero label.
          ignoreNullVisibleSet: true,
          selectedAlpha: 0.5,
        },
      );
      layer.registerDisposer(release);
      await waitForWatershedLayer(layer, abort.signal);
      entry.check();
      if (released) return;
      attached = true;
      this.viewer.layerSpecification.add(layer.addRef());
      if (released) return;
      // Reuse current source-group membership, never split/rewrite a layout.
      for (const subset of this.viewer.layerSpecification.subsets) {
        if (subset.layerManager.has(source) && !subset.layerManager.has(layer))
          subset.add(layer.addRef());
        if (released) return;
      }
      entry.check();
      if (released) return;
      this.setStatus(
        `Added live layer: ${layer.name}. One shared result follows all visible slice views as you navigate. Labels may change; session-local URL, not shareable.`,
      );
      // Constructor/publication/activation errors remain fatal. Once viewport
      // tracking starts, computation failures may recover on the next box.
      const reportComputeError = (error: unknown) => {
        if (released) return;
        entry!.check();
        if (released || !this.alive) return;
        this.setStatus(
          `Watershed error (${layer!.name}): ${errorMessage(error)}. Navigate to retry; for an oversized region, zoom in or add a layer at a coarser native scale.`,
          "error",
        );
        this.changed.dispatch();
      };
      reportError = reportComputeError;
      const unwatch = this.dependencies.watchViewport(
        this.viewer,
        preparedInput,
        layer,
        (region) => {
          if (released) return;
          entry!.check();
          if (released) return;
          live!.setRegion(region?.lowerXYZ, region?.shapeXYZ);
        },
        (error) => {
          if (released) return;
          entry!.check();
          if (released) return;
          // Bad viewport geometry must not leave the previous labels visible.
          live!.setRegion();
          reportComputeError(error);
        },
      );
      // Initial callbacks may synchronously reset/delete the layer.
      if (released) {
        unwatch();
        return;
      }
      removers.push(unwatch);
      entry.check();
      if (released) return;
      activated = true;
    } catch (error) {
      if (this.alive && !released)
        this.setStatus(`Watershed failed: ${errorMessage(error)}`, "error");
    } finally {
      if (!activated) release();
      if (this.pending === entry) this.pending = undefined;
      layer?.dispose();
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

/** Closing the dialog never stops pending activation or created live layers. */
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
      "Add a segmentation with one shared result over the XYZ bounding box enclosing all visible slice views. As you navigate, a new box is computed after a 150 ms debounce, with an 8-voxel halo per face clipped to source bounds. UINT64 labels are fetched and rendered in chunks, not computed per display chunk; labels may change across navigation. This is not equivalent to whole-volume watershed.",
    );
    text(
      "The computation is limited to 2**21 (2,097,152) voxels INCLUDING the halo. Oversized views report an error: zoom in or add a layer at a coarser native scale. Computation is never silently split. Hiding the output or removing all relevant slice views clears its result.",
    );
    text(
      "Affinities connect each voxel towards its negative axes (−X, −Y, −Z). Integer values are normalized by their data type maximum; floating-point values are unchanged. Non-native transforms and mutable Python volume sources are rejected.",
    );
    text(
      "Closing this dialog keeps created layers active. Deleting an output or its affinity source stops its work. Affinity data/transform changes and viewer reset also release dependent layers. Selecting another source here keeps existing layers active. URLs are session-local, not shareable or restored from saved state.",
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
    const row = (
      title: string,
      control: HTMLElement,
      parent: HTMLElement = this.body,
    ) => {
      const label = document.createElement("label");
      control.setAttribute("aria-label", title);
      label.append(title, " ", control);
      parent.append(label);
    };
    const source = document.createElement("select");
    row("Affinity image source", source);
    let identities: ManagedUserLayer[] = [];
    source.addEventListener("change", () =>
      session.selectSource(identities[Number(source.value)]),
    );
    const fields: Array<{
      input: HTMLInputElement;
      key: "scaleIndex" | "channelsXYZ" | keyof WatershedOptions;
    }> = [];
    const field = (
      title: string,
      key: (typeof fields)[number]["key"],
      numeric = false,
      parent: HTMLElement = this.body,
    ) => {
      const input = document.createElement("input");
      input.type = numeric ? "number" : "text";
      const probability =
        key === "highThreshold" ||
        key === "lowThreshold" ||
        key === "maskThreshold";
      if (numeric) {
        input.min = "0";
        input.step = probability ? "any" : "1";
      }
      if (probability) input.max = "1";
      row(title, input, parent);
      input.addEventListener("input", () => {
        if (key === "scaleIndex") session.selectScale(input.value);
        else session[key] = input.value;
      });
      fields.push({ input, key });
    };
    field("Source scale index", "scaleIndex", true);
    const metadata = text("");
    metadata.setAttribute("aria-label", "Selected scale bounds and voxel size");
    const advanced = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Advanced: channels and thresholds";
    advanced.append(summary);
    this.body.append(advanced);
    field("Channels for −X −Y −Z", "channelsXYZ", false, advanced);
    const channelHelp = document.createElement("div");
    channelHelp.textContent =
      "Repeated channel indices are allowed and copied literally, not converted to neighbor-minimum affinities. Defaults: 0, 0, 0 for fewer than three channels; 0, 1, 2 otherwise.";
    advanced.append(channelHelp);
    const useMask = document.createElement("input");
    useMask.type = "checkbox";
    row("Use last channel as mask", useMask, advanced);
    useMask.addEventListener("change", () => {
      session.useLastChannelAsMask = useMask.checked;
      session.changed.dispatch();
    });
    field("Mask threshold", "maskThreshold", true, advanced);
    const maskHelp = document.createElement("div");
    maskHelp.textContent =
      "Values below threshold are kept; edges touching a masked voxel are zeroed. Mask values use normalized units in [0, 1]. Requires at least four channels; the last channel cannot also be an affinity.";
    advanced.append(maskHelp);
    field("High threshold", "highThreshold", true, advanced);
    field("Low threshold", "lowThreshold", true, advanced);
    field("Size threshold", "sizeThreshold", true, advanced);
    field("Dust threshold", "dustThreshold", true, advanced);
    const status = text("");
    status.setAttribute("role", "status");
    status.style.cssText = "font-weight:bold;overflow-wrap:anywhere";
    const add = document.createElement("button");
    add.textContent = "Add watershed layer";
    add.addEventListener("click", () => void session.addLayer());
    this.footer.prepend(add);
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
      const m = session.metadata;
      const maskAvailable = m !== undefined && m.channelCount >= 4;
      useMask.checked = session.useLastChannelAsMask;
      useMask.disabled = session.busy || !maskAvailable;
      for (const { input, key } of fields) {
        if (input.value !== session[key]) input.value = session[key];
        input.disabled =
          session.busy ||
          (key === "maskThreshold" &&
            (!maskAvailable || !session.useLastChannelAsMask));
      }
      metadata.textContent =
        m === undefined
          ? "Selected scale metadata unavailable."
          : `Native bounds [${m.lowerBoundXYZ.join(", ")}] to [${m.upperBoundXYZ.join(", ")}) X Y Z; ${m.channelCount} channels. Voxel size X Y Z: ${m.spacingXYZ.map((x, i) => `${x} ${m.unitsXYZ[i] || "unitless"}`).join(", ")}.`;
      status.textContent = session.status;
      status.dataset.severity = session.statusLevel;
      status.style.color =
        session.statusLevel === "error" ? "#b71c1c" : "inherit";
      add.disabled =
        session.busy || session.source === undefined || m === undefined;
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
        "Add viewport-driven affinity watershed segmentation locally with WASM (GPL v3+).",
      ),
    ),
  );
  viewer.bindAction("open-watershed", () => session.open());
  return session;
}
