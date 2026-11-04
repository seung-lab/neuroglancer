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

import "#src/util/polyfills.js";
import "#src/datasource/precomputed/register_default.js";
import "#src/kvstore/http/register_frontend.js";

import { http, HttpResponse, passthrough } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChunkState } from "#src/chunk_manager/base.js";
import {
  makeInferenceRecipeSource,
  publishLiveInference,
} from "#src/datasource/inference/frontend.js";
import type { OnnxInferenceController } from "#src/inference/controller.js";
import { prepareInferenceInput } from "#src/inference/input.js";
import { LiveInference } from "#src/inference/live.js";
import { makeModelGeometry, type ModelMetadata } from "#src/inference/model.js";
import type { InferenceRecipe } from "#src/inference/recipe.js";
import { installInferenceRecipeContext } from "#src/inference/restore.js";
import { ImageUserLayer } from "#src/layer/image/index.js";
import type { ManagedUserLayer } from "#src/layer/index.js";
import { deleteLayer, makeLayer } from "#src/layer/index.js";
import { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import type { ChunkChannelAccessParameters } from "#src/render_coordinate_transform.js";
import { SliceViewPanel } from "#src/sliceview/panel.js";
import { UncompressedVolumeChunk } from "#src/sliceview/uncompressed_chunk_format.js";
import { DataType, VolumeType } from "#src/sliceview/volume/base.js";
import type { VolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import { SliceViewVolumeRenderLayer } from "#src/sliceview/volume/renderlayer.js";
import { makeMinimalViewer } from "#src/ui/minimal_viewer.js";
import { bindWatershed, type WatershedSession } from "#src/ui/watershed.js";
import { vec3 } from "#src/util/geom.js";
import * as matrix from "#src/util/matrix.js";
import type { Viewer } from "#src/viewer.js";
import type { WatershedRecipe } from "#src/watershed/recipe.js";
import { mswFixture } from "#tests/fixtures/msw_browser.js";

const server = mswFixture();
const cleanup: Array<() => void> = [];
const disposeViewers = new WeakMap<Viewer, () => void>();
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  vi.restoreAllMocks();
});

/** No fake GL, chunk manager/RPC, datasource, input reader or watershed. */
function makeViewer() {
  const target = document.createElement("div");
  target.style.cssText = "position:fixed;inset:0;width:640px;height:480px";
  document.body.append(target);
  const viewer = makeMinimalViewer({
    target,
    showLayerDialog: false,
    resetStateWhenEmpty: false,
    showUIControls: false,
  });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    viewer.dispose();
    viewer.display.dispose();
    target.remove();
  };
  disposeViewers.set(viewer, dispose);
  cleanup.push(dispose);
  viewer.layout.restoreState("xy");
  viewer.dataContext.chunkManager.chunkQueueManager.enablePrefetch.value = false;
  expect(viewer.display.gl).toBeInstanceOf(WebGL2RenderingContext);
  expect(viewer.dataContext.worker).toBeInstanceOf(Worker);
  return viewer;
}

async function addImage(
  viewer: Viewer,
  url: string | { url: string; state: InferenceRecipe },
) {
  const layer = makeLayer(viewer.layerSpecification, "affinities", {
    type: "image",
    source: url,
    // Only the derived segmentation is displayed; source reads remain real.
    visible: false,
    shader: "void main() { emitGrayscale(toNormalized(getDataValue(0))); }",
  });
  viewer.layerSpecification.add(layer);
  await expect.poll(() => layer.isReady(), { timeout: 30_000 }).toBe(true);
  expect(layer.layer).toBeInstanceOf(ImageUserLayer);
  expect(
    (layer.layer as ImageUserLayer).dataSources.map((s) => s.loadState?.error),
  ).toEqual([undefined]);
  return layer;
}

/** Invoke the registered command and drive its real no-ROI form. */
function openWatershed(viewer: Viewer, source: ManagedUserLayer) {
  const session = bindWatershed(viewer);
  viewer.commandRegistry.get("open-watershed")!.invoke({
    dispatchTarget: viewer.element,
  });
  expect(session.dialog).toBeDefined();
  expect(
    session.dialog!.body.querySelector('input[aria-label*="ROI"]'),
  ).toBeNull();
  const select = session.dialog!.body.querySelector("select")!;
  select.value = String(session.sources.indexOf(source));
  select.dispatchEvent(new Event("change", { bubbles: true }));
  expect(session.source).toBe(source);
  expect(session.statusLevel, session.status).toBe("info");
  return session;
}

function field(session: WatershedSession, label: string) {
  const input = session.dialog!.body.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  );
  expect(input, label).not.toBeNull();
  return input!;
}

function fill(session: WatershedSession, label: string, value: string) {
  const input = field(session, label);
  expect(input.disabled).toBe(false);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function configureThresholds(session: WatershedSession) {
  fill(session, "High threshold", "1");
  fill(session, "Low threshold", "0");
  fill(session, "Size threshold", "0");
  fill(session, "Dust threshold", "0");
}

function configure(session: WatershedSession, channels = [0, 1, 2]) {
  fill(session, "Channels for −X −Y −Z", channels.join(", "));
  configureThresholds(session);
}

async function addFromDialog(
  session: WatershedSession,
  hidden = false,
  expectedStatus: "info" | "error" = "info",
) {
  const { viewer } = session;
  const previous = new Set(viewer.layerManager.managedLayers);
  // Default visibility is part of the contract. Only the explicit hidden-layer
  // test suppresses visibility synchronously before attachment can demand data.
  const hideNewLayer = hidden
    ? viewer.layerManager.layersChanged.add(() => {
        for (const layer of viewer.layerManager.managedLayers)
          if (
            !previous.has(layer) &&
            layer.layer instanceof SegmentationUserLayer
          )
            layer.setVisible(false);
      })
    : () => {};
  try {
    const button = Array.from(
      session.dialog!.footer.querySelectorAll("button"),
    ).find((b) => b.textContent === "Add watershed layer")!;
    expect(button.disabled).toBe(false);
    button.click();
    const findResult = () =>
      viewer.layerManager.managedLayers.find(
        (layer) =>
          !previous.has(layer) && layer.layer instanceof SegmentationUserLayer,
      );
    await expect.poll(findResult, { timeout: 60_000 }).toBeDefined();
    await expect.poll(() => session.busy).toBe(false);
    await expect
      .poll(() => session.statusLevel, { message: session.status })
      .toBe(expectedStatus);
    const result = findResult()!;
    await expect.poll(() => result.isReady()).toBe(true);
    expect(result.visible).toBe(!hidden);
    return result;
  } finally {
    hideNewLayer();
  }
}

const scalarAccess: ChunkChannelAccessParameters = {
  channelSpaceShape: new Uint32Array(0),
  chunkChannelDimensionIndices: [],
  chunkChannelCoordinates: new Uint32Array(0),
  numChannels: 1,
};
const sourceOptions = {
  discreteValues: true,
  displayRank: 3,
  modelChannelDimensionIndices: [],
  multiscaleToViewTransform: matrix.createIdentity(Float32Array, 3),
};
const spacing = [1e-8, 2e-8, 3e-8];

function worldPosition(
  viewer: {
    readonly coordinateSpace: Pick<Viewer["coordinateSpace"], "value">;
  },
  xyz: number[],
  offset: number[],
) {
  const global = viewer.coordinateSpace.value;
  return Float32Array.from(global.names, (name, d) => {
    const axis = ["x", "y", "z"].indexOf(name);
    return axis === -1
      ? 0
      : ((offset[axis] + xyz[axis]) * spacing[axis]) / global.scales[d];
  });
}

function positionViewer(
  viewer: Viewer,
  xyz: number[],
  offset: number[],
  scale = 2,
) {
  viewer.position.value = worldPosition(viewer, xyz, offset);
  viewer.crossSectionScale.value = scale;
}

function outputSource(
  result: ManagedUserLayer,
  shape: number[],
  offset: number[],
) {
  const segmentation = result.layer as SegmentationUserLayer;
  expect(segmentation.displayState.hasVolume.value).toBe(true);
  const renderLayer = segmentation.renderLayers.find(
    (r): r is SliceViewVolumeRenderLayer =>
      r instanceof SliceViewVolumeRenderLayer,
  )!;
  const volume = renderLayer.multiscaleSource;
  expect(volume.rank).toBe(3);
  expect(volume.volumeType).toBe(VolumeType.SEGMENTATION);
  expect(volume.dataType).toBe(DataType.UINT64);
  const loadState = segmentation.dataSources[0].loadState;
  if (loadState === undefined || loadState.error !== undefined)
    throw new Error("Segmentation datasource did not load successfully");
  const { dataSource } = loadState;
  expect(dataSource.canonicalUrl).toBe("watershed://recipe");
  const { modelTransform } = dataSource;
  expect([...modelTransform.inputSpace.bounds.lowerBounds]).toEqual([0, 0, 0]);
  expect([...modelTransform.inputSpace.bounds.upperBounds]).toEqual(shape);
  expect(modelTransform.outputSpace.names).toEqual(["x", "y", "z"]);
  expect(modelTransform.outputSpace.units).toEqual(["m", "m", "m"]);
  expect([...modelTransform.outputSpace.scales]).toEqual(spacing);
  const transform = matrix.createIdentity(Float64Array, 4);
  transform.set(offset, 12);
  expect(modelTransform.transform).toEqual(transform);
  const sources = volume.getSources(sourceOptions);
  cleanup.push(() => {
    for (const alternatives of sources)
      for (const { chunkSource } of alternatives) chunkSource.dispose();
  });
  const { chunkSource, chunkToMultiscaleTransform } = sources[0][0];
  expect(chunkToMultiscaleTransform).toEqual(
    matrix.createIdentity(Float32Array, 4),
  );
  expect([...chunkSource.spec.baseVoxelOffset]).toEqual([0, 0, 0]);
  expect([...chunkSource.spec.upperVoxelBound]).toEqual(shape);
  expect([...chunkSource.spec.chunkDataSize]).toEqual([64, 64, 32]);
  expect(chunkSource.spec.dataType).toBe(DataType.UINT64);
  return {
    volume,
    chunkSource,
    renderLayer,
    worldPosition: (xyz: number[]) =>
      worldPosition(result.manager.root, xyz, offset),
  };
}

function expectPublicationActive(output: ReturnType<typeof outputSource>) {
  const sources = output.volume.getSources(sourceOptions);
  try {
    expect(sources[0][0].chunkSource).toBe(output.chunkSource);
  } finally {
    for (const alternatives of sources)
      for (const { chunkSource } of alternatives) chunkSource.dispose();
  }
}

/** Fetch via real chunk RPC; read every actual UINT64 value, not fixture labels. */
async function readTile(source: VolumeChunkSource, grid: number | number[]) {
  const gridXYZ = typeof grid === "number" ? [grid, 0, 0] : grid;
  const tile = await source.fetchChunk(
    Float32Array.from(gridXYZ),
    (chunk) => {
      const volumeChunk = chunk as UncompressedVolumeChunk;
      const size = [...volumeChunk.chunkDataSize];
      const labels: Array<number | bigint> = [];
      for (let z = 0; z < size[2]; ++z)
        for (let y = 0; y < size[1]; ++y)
          for (let x = 0; x < size[0]; ++x)
            labels.push(volumeChunk.getValueAt(Uint32Array.of(x, y, z)));
      // Assertions stay outside the callback: a throwing requester can otherwise
      // leave fetchChunk waiting rather than report the assertion failure.
      return {
        uncompressed: chunk instanceof UncompressedVolumeChunk,
        uint64: volumeChunk.data instanceof BigUint64Array,
        grid: [...volumeChunk.chunkGridPosition],
        size,
        labels,
        firstViaSource: source.getValueAt(
          Float32Array.from(gridXYZ, (n, d) => n * [64, 64, 32][d]),
          scalarAccess,
        ),
      };
    },
    { signal: new AbortController().signal },
  );
  expect(tile.uncompressed).toBe(true);
  expect(tile.uint64).toBe(true);
  expect(tile.grid).toEqual(gridXYZ);
  expect(typeof tile.labels[0]).toBe("bigint");
  expect(tile.firstViaSource).toBe(tile.labels[0]);
  return tile;
}

function expectedTile(
  size: number[],
  labelAtX: (x: number) => bigint,
): bigint[] {
  return Array.from({ length: size.reduce((a, b) => a * b, 1) }, (_, i) =>
    labelAtX(i % size[0]),
  );
}

/** A GPU_MEMORY chunk can still contain pending zeros. Wait for real labels and
 * publication-driven invalidation, without manually invalidating the cache. */
async function awaitTile(
  source: VolumeChunkSource,
  grid: number | number[],
  first: bigint,
) {
  await expect
    .poll(async () => (await readTile(source, grid)).labels[0], {
      timeout: 60_000,
    })
    .toBe(first);
  return readTile(source, grid);
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function settleView() {
  for (let i = 0; i < 2; ++i)
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
}

/** Call through to the real computation worker. Optionally hold delivery of its
 * first replies, never replacing the native computation or its returned data. */
function observeWatershedWorker(holdReplies = 0, observeInference = false) {
  const jobs: Array<{ shape: number[]; release?: () => void }> = [];
  const inferenceRuns: Array<{
    input: Float32Array;
    output?: Float32Array;
    metadata?: ModelMetadata;
    error?: string;
  }> = [];
  const sequence: string[] = [];
  const original = Worker.prototype.postMessage;
  vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
    this: Worker,
    ...args
  ) {
    const [message] = args;
    if (observeInference && message?.kind === "run") {
      const run: (typeof inferenceRuns)[number] = {
        input: message.input.slice(),
      };
      inferenceRuns.push(run);
      const worker = this;
      const listener = (event: MessageEvent) => {
        if (event.data?.id !== message.id) return;
        worker.removeEventListener("message", listener);
        if (event.data.kind === "output") {
          run.output = event.data.output.slice();
          run.metadata = event.data.metadata;
          sequence.push("inference-output");
        } else {
          run.error = event.data.message;
        }
      };
      worker.addEventListener("message", listener);
      cleanup.push(() => worker.removeEventListener("message", listener));
    }
    if (message?.t === "abissWatershed") {
      sequence.push("watershed");
      const index = jobs.length;
      const job: (typeof jobs)[number] = { shape: [...message.args[1]] };
      jobs.push(job);
      if (index < holdReplies) {
        const worker = this;
        const onmessage = worker.onmessage;
        const intercept = (event: MessageEvent) => {
          if (event.data?.id !== message.id) {
            onmessage?.call(worker, event);
            return;
          }
          worker.onmessage = onmessage;
          let released = false;
          job.release = () => {
            if (released) return;
            released = true;
            onmessage?.call(worker, event);
          };
        };
        // Worker EventTarget dispatches handlers in registration order, so a
        // later capture listener cannot prevent its earlier onmessage handler.
        worker.onmessage = intercept;
        cleanup.push(() => {
          if (worker.onmessage === intercept) worker.onmessage = onmessage;
          job.release?.();
        });
      }
    }
    return Reflect.apply(original, this, args);
  });
  return {
    inferenceRuns,
    sequence,
    shapes: () => jobs.map((job) => job.shape),
    hasReply: (index: number) => jobs[index]?.release !== undefined,
    release: (index: number) => {
      expect(jobs[index]?.release).toBeDefined();
      jobs[index].release!();
    },
  };
}

/** Independent oracle for these axis-aligned, actual panel rectangles. NDC z=0
 * is the selected slice, NOT the perspective camera near/far frustum. */
function visibleHaloShape(viewer: Viewer, shape: number[], offset: number[]) {
  return visibleHaloBox(viewer, shape, offset).shape;
}

function visibleHaloBox(viewer: Viewer, shape: number[], offset: number[]) {
  const lower = [Infinity, Infinity, Infinity];
  const upper = [-Infinity, -Infinity, -Infinity];
  const global = viewer.coordinateSpace.value;
  const panels = [...viewer.display.panels].filter(
    (panel): panel is SliceViewPanel =>
      panel instanceof SliceViewPanel &&
      panel.renderViewport.width > 0 &&
      panel.renderViewport.height > 0,
  );
  expect(panels.length).toBeGreaterThan(0);
  for (const panel of panels) {
    const p = panel.sliceView.projectionParameters.value;
    for (const x of [-1, 1])
      for (const y of [-1, 1]) {
        const point = vec3.transformMat4(
          vec3.create(),
          [x, y, 0],
          p.invViewProjectionMat,
        );
        for (let axis = 0; axis < 3; ++axis) {
          const d = global.names.indexOf(["x", "y", "z"][axis]);
          const displayAxis =
            p.displayDimensionRenderInfo.displayDimensionIndices.indexOf(d);
          const native =
            (point[displayAxis] * global.scales[d]) / spacing[axis] -
            offset[axis];
          const rounded = Math.round(native);
          const n = Math.abs(native - rounded) < 1e-4 ? rounded : native;
          lower[axis] = Math.min(lower[axis], n);
          upper[axis] = Math.max(upper[axis], n);
        }
      }
  }
  const origin = lower.map((n) => Math.max(0, Math.floor(n) - 8));
  return {
    origin,
    shape: lower.map((n, d) => {
      const lo = Math.max(0, Math.floor(n));
      const hi = Math.min(shape[d], Math.max(lo + 1, Math.ceil(upper[d])));
      return Math.min(shape[d], hi + 8) - origin[d];
    }),
  };
}

async function precomputed(
  base: string,
  shape: number[],
  offset: number[],
  chunkShape: number[],
  channels: number,
  value: (x: number, y: number, z: number, channel: number) => number,
) {
  const chunks: string[] = [];
  (await server()).use(
    http.get(`${base}/info`, () =>
      HttpResponse.json({
        "@type": "neuroglancer_multiscale_volume",
        type: "image",
        data_type: "uint8",
        num_channels: channels,
        scales: [
          {
            key: "raw",
            resolution: [10, 20, 30],
            voxel_offset: offset,
            size: shape,
            chunk_sizes: [chunkShape],
            encoding: "raw",
          },
        ],
      }),
    ),
    http.get(`${base}/raw/:chunk`, ({ params }) => {
      const key = String(params.chunk);
      chunks.push(key);
      const bounds = /^(-?\d+)-(-?\d+)_(-?\d+)-(-?\d+)_(-?\d+)-(-?\d+)$/.exec(
        key,
      )!;
      const [x0, x1, y0, y1, z0, z1] = bounds.slice(1).map(Number);
      const data = new Uint8Array((x1 - x0) * (y1 - y0) * (z1 - z0) * channels);
      let i = 0;
      for (let c = 0; c < channels; ++c)
        for (let z = z0; z < z1; ++z)
          for (let y = y0; y < y1; ++y)
            for (let x = x0; x < x1; ++x)
              data[i++] = value(x - offset[0], y - offset[1], z - offset[2], c);
      return new HttpResponse(data.buffer, {
        headers: { "Content-Type": "application/octet-stream" },
      });
    }),
  );
  return { url: `precomputed://${base}`, chunks };
}

/** Only ONNX evaluation is deterministic. Every run MUST await the real native
 * PreparedInferenceInput.readPatch -> VolumeChunkSource -> HTTP dependency. */
async function liveFixture(viewer: Viewer, gateXs: readonly number[] = []) {
  const native = await precomputed(
    "https://watershed-integration.invalid/native",
    [180, 60, 16],
    [4, 6, -2],
    [30, 60, 16],
    1,
    (x) => (x === 60 || x === 120 ? 0 : 255),
  );
  const raw = await addImage(viewer, native.url);
  const input = prepareInferenceInput(raw.layer as ImageUserLayer);
  cleanup.push(() => input.dispose());
  const readPatch = vi.spyOn(input, "readPatch");
  const geometry = makeModelGeometry(
    { inputShape: [1, 1, 1, 1, 1], outputShape: [1, 4, 1, 1, 1] },
    [input.spacingZYX[0], input.spacingZYX[1], input.spacingZYX[2]],
  );
  const gates = new Map(gateXs.map((x) => [x, Promise.withResolvers<void>()]));
  cleanup.push(() => {
    for (const gate of gates.values()) gate.resolve();
  });
  const gated: number[] = [];
  const completed: number[] = [];
  let active: AbortController | undefined;
  const signals: AbortSignal[] = [];
  const run = vi.fn<OnnxInferenceController["run"]>(async (source, options) => {
    const abort = (active = new AbortController());
    signals.push(abort.signal);
    const patch = await source.readPatch(
      options.originZYX,
      options.shapeZYX,
      abort.signal,
    );
    const x = options.originZYX[2] - source.originZYX[2];
    const gate = gates.get(x);
    if (gate !== undefined && !gated.includes(x)) {
      gated.push(x);
      await gate.promise; // Deliberately return late even after controller.cancel().
    }
    const data = new Float32Array(patch.length * 4).fill(1);
    data.set(patch);
    active = undefined;
    completed.push(x);
    return {
      data,
      channels: 4,
      shapeZYX: options.shapeZYX,
      originZYX: options.originZYX,
      spacingZYX: source.spacingZYX,
      axisNamesZYX: source.axisNamesZYX,
      unitsZYX: source.unitsZYX,
      provenance: { fixture: "deterministic-native-identity-affinities" },
    };
  });
  const cancel = vi.fn(() => active?.abort());
  cleanup.push(cancel);
  const live = new LiveInference(
    { run, cancel },
    input,
    undefined,
    geometry,
    false,
  );
  const publication = await publishLiveInference(viewer.chunkManager, live);
  cleanup.push(() => publication.dispose());
  const image = await addImage(
    viewer,
    makeInferenceRecipeSource(publication, {
      version: 2,
      profile: "ncdhw-centered-v2",
      source: { name: raw.name, source: raw.layer!.toJSON().source },
      model: { kind: "local", name: "deterministic-gated.onnx", size: 1 },
      provider: "cpu",
      mode: "live",
      inputScaleIndex: 0,
      spacingZYX: [3e-8, 2e-8, 1e-8],
      outputSpacingZYX: [3e-8, 2e-8, 1e-8],
      overlap: false,
    }),
  );
  const session = openWatershed(viewer, image);
  configure(session);
  return {
    native,
    raw,
    input,
    readPatch,
    run,
    cancel,
    signals,
    image,
    publication,
    session,
    gated,
    completed,
    release: (x: number) => {
      expect(gates.has(x)).toBe(true);
      gates.get(x)!.resolve();
    },
    origins: () =>
      run.mock.calls.map(([, options]) =>
        options.originZYX.map((n, d) => n - input.originZYX[d]),
      ),
  };
}

interface SavedViewerState {
  layers: Array<{
    name: string;
    source: { url: string; state?: unknown };
  }>;
}

/** The wire format, never a retained layer/publication/provider object. */
function saveOnlyWatershed(
  viewer: Viewer,
  result: ManagedUserLayer,
  recipe: WatershedRecipe,
) {
  const saved = JSON.parse(
    JSON.stringify(viewer.state.toJSON()),
  ) as SavedViewerState;
  const layer = saved.layers.find((layer) => layer.name === result.name)!;
  expect(layer.source).toEqual({ url: "watershed://recipe", state: recipe });
  expect(JSON.stringify(saved)).not.toMatch(
    /(?:inference|watershed):\/\/[a-f0-9]{16,}/,
  );
  // The saved producer must resolve the embedded source, not a visible layer
  // name. Remove BOTH native and upstream inference images before restoring.
  saved.layers = [layer];
  return saved;
}

async function restoreOnlyWatershed(
  viewer: Viewer,
  saved: SavedViewerState,
  nestedInference = false,
) {
  if (nestedInference)
    viewer.registerDisposer(
      installInferenceRecipeContext(viewer.layerSpecification),
    );
  bindWatershed(viewer); // The normal UI context installer, no session.add().
  viewer.state.restoreState(saved);
  await expect
    .poll(
      () => {
        const layers = viewer.layerManager.managedLayers;
        expect(layers.map((layer) => layer.name)).toEqual([
          saved.layers[0].name,
        ]);
        const result = layers[0];
        for (const source of result.layer?.dataSources ?? []) {
          if (source.loadState?.error !== undefined)
            throw source.loadState.error;
        }
        return result.isReady();
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  const result = viewer.layerManager.managedLayers[0];
  expect(result.layer).toBeInstanceOf(SegmentationUserLayer);
  expect(result.visible).toBe(true);
  return result;
}

/** All actual display voxels, including pending/background zeros. */
async function expectTiles(
  source: VolumeChunkSource,
  shape: number[],
  labelAtX: (x: number) => bigint,
) {
  for (let grid = 0; grid * 64 < shape[0]; ++grid) {
    const size = [Math.min(64, shape[0] - grid * 64), shape[1], shape[2]];
    await expect
      .poll(async () => (await readTile(source, grid)).labels, {
        timeout: 60_000,
      })
      .toEqual(expectedTile(size, (x) => labelAtX(grid * 64 + x)));
  }
}

function shareableWatershedRecipeTests() {
  it.each(["affinity", "scalar", "mask"] as const)(
    "round-trips %s UI output without its visible source or original publication, then follows navigation",
    async (kind) => {
      const jobs = observeWatershedWorker();
      const shape = [148, 5, 4];
      const offset = [10, 20, -3];
      const channelsXYZ: [number, number, number] =
        kind === "scalar" ? [0, 0, 0] : kind === "mask" ? [2, 0, 1] : [2, 0, 3];
      const native = await precomputed(
        `https://watershed-integration.invalid/share-${kind}`,
        shape,
        offset,
        [32, 5, 4],
        kind === "scalar" ? 1 : 4,
        (x, _y, _z, c) => {
          if (kind === "scalar")
            return (x >= 30 && x < 34) || (x >= 94 && x < 98) || x >= 136
              ? 0
              : 255;
          if (kind === "mask")
            return c !== 3
              ? 255
              : x >= 136
                ? 255
                : x === 32 || x === 96
                  ? 77
                  : 76;
          return x >= 136 || (c === 2 && (x === 32 || x === 96)) ? 0 : 255;
        },
      );
      const label = (x: number): bigint => {
        if (kind === "scalar")
          return x < 30
            ? 1n
            : x < 33
              ? 0n
              : x < 94
                ? 2n
                : x < 97
                  ? 0n
                  : x < 136
                    ? 3n
                    : 0n;
        if (kind === "mask")
          return x < 32
            ? 1n
            : x === 32
              ? 0n
              : x < 96
                ? 2n
                : x === 96 || x >= 136
                  ? 0n
                  : 3n;
        return x < 32 ? 1n : x < 96 ? 2n : x < 136 ? 3n : 0n;
      };
      const original = makeViewer();
      if (kind === "affinity") original.layout.restoreState("4panel");
      original.coordinateSpace.restoreState({
        x: [5e-9, "m"],
        y: [10e-9, "m"],
        z: [15e-9, "m"],
      });
      const image = await addImage(original, native.url);
      positionViewer(original, [74.5, 2.5, 1.5], offset);
      const session = openWatershed(original, image);
      if (kind === "scalar") {
        expect(field(session, "Channels for −X −Y −Z").value).toBe("0, 0, 0");
        expect(field(session, "Use last channel as mask").disabled).toBe(true);
        configureThresholds(session);
      } else {
        configure(session, channelsXYZ);
        if (kind === "mask") {
          field(session, "Use last channel as mask").click();
          fill(session, "Mask threshold", "0.3");
        }
      }
      const recipe: WatershedRecipe = {
        version: 1,
        profile: "visible-slice-union-v1",
        mode: "live",
        source: { name: image.name, source: image.layer!.toJSON().source },
        inputScaleIndex: 0,
        channelsXYZ,
        options: {
          highThreshold: 1,
          lowThreshold: 0,
          sizeThreshold: 0,
          dustThreshold: 0,
          ...(kind === "mask" ? { maskThreshold: 0.3 } : {}),
        },
        spacingXYZ: [1e-8, 2e-8, 3e-8],
      };
      const result = await addFromDialog(session);
      const output = outputSource(result, shape, offset);
      await expectTiles(output.chunkSource, shape, label);
      expect(jobs.shapes()).toEqual([shape]);
      expect(native.chunks).toHaveLength(5);
      // Unsaved dialog edits must not mutate the output's captured parameters.
      fill(session, "High threshold", "0.8");
      fill(session, "Dust threshold", "7");
      const saved = saveOnlyWatershed(original, result, recipe);
      disposeViewers.get(original)!();
      expect(original.wasDisposed).toBe(true);
      expect(() => output.volume.getSources(sourceOptions)).toThrow(
        /unavailable/,
      );

      const restored = makeViewer();
      expect(restored.chunkManager).not.toBe(original.chunkManager);
      expect(restored.dataContext.worker).not.toBe(original.dataContext.worker);
      const restoredResult = await restoreOnlyWatershed(restored, saved);
      const restoredOutput = outputSource(restoredResult, shape, offset);
      await expectTiles(restoredOutput.chunkSource, shape, label);
      expect(jobs.shapes()).toEqual([shape, shape]);
      expect(native.chunks).toHaveLength(10);
      expect(visibleHaloShape(restored, shape, offset)).toEqual(shape);
      expect(
        [...restored.display.panels].filter(
          (panel) => panel instanceof SliceViewPanel,
        ),
      ).toHaveLength(kind === "affinity" ? 3 : 1);
      expect([...restored.coordinateSpace.value.scales]).toEqual([
        5e-9, 1e-8, 1.5e-8,
      ]);
      for (const x of [31, 32, 33, 63, 64, 95, 96, 97, 135, 136]) {
        await expect
          .poll(() =>
            restoredOutput.renderLayer.getValueAt(
              restoredOutput.worldPosition([x + 0.5, 2.5, 1.5]),
            ),
          )
          .toBe(label(x));
      }
      expect(saveOnlyWatershed(restored, restoredResult, recipe)).toEqual(
        saved,
      );

      // Only viewport navigation/zoom drives this new domain. There is no ROI
      // API call, display-chunk-sized fallback, or use of the disposed producer.
      positionViewer(
        restored,
        [16.5, 2.5, 1.5],
        offset,
        kind === "affinity" ? 0.16 : 0.08,
      );
      await settleView();
      const box = visibleHaloBox(restored, shape, offset);
      expect(box.origin).toEqual([0, 0, 0]);
      expect(box.shape[0]).toBeGreaterThan(34);
      expect(box.shape[0]).toBeLessThan(64);
      await expectTiles(restoredOutput.chunkSource, shape, (x) =>
        x < box.shape[0] ? label(x) : 0n,
      );
      expect(jobs.shapes()).toEqual([shape, shape, box.shape]);
      expect(restored.layerManager.managedLayers).toEqual([restoredResult]);
      expect(native.chunks).toHaveLength(10); // Native cache, not another producer.
      saveOnlyWatershed(restored, restoredResult, recipe);
    },
    120_000,
  );

  it("restores nested URL/hashed CPU concat inference and waits for all four-channel outputs before one viewport watershed", async () => {
    const jobs = observeWatershedWorker(0, true);
    const modelUrl = new URL(
      "../../testdata/inference/concat.onnx",
      import.meta.url,
    ).href;
    const modelRequests: string[] = [];
    (await server()).use(
      http.get(modelUrl, ({ request }) => {
        modelRequests.push(request.url);
        return passthrough();
      }),
    );
    const native = await precomputed(
      "https://watershed-integration.invalid/share-real-concat",
      [200, 80, 20],
      [4, 6, -2],
      [40, 80, 20],
      1,
      (x) => (x === 70 || x === 130 ? 0 : 255),
    );
    const original = makeViewer();
    original.registerDisposer(
      installInferenceRecipeContext(original.layerSpecification),
    );
    original.chunkManager.chunkQueueManager.capacities.download.itemLimit.value = 1;
    const raw = await addImage(original, native.url);
    const inferenceRecipe: InferenceRecipe = {
      version: 2,
      profile: "ncdhw-centered-v2",
      source: { name: raw.name, source: raw.layer!.toJSON().source },
      model: {
        kind: "url",
        name: "concat.onnx",
        urls: [modelUrl],
        size: 201,
        sha256:
          "ace5cc1d42fe567524e8472380616f19a0da0b9b5d04e813a618e05a4db563bd",
      },
      provider: "cpu",
      precision: "float32",
      mode: "live",
      inputScaleIndex: 0,
      spacingZYX: [3e-8, 2e-8, 1e-8],
      outputSpacingZYX: [3e-8, 2e-8, 1e-8],
      overlap: false,
    };
    const image = await addImage(original, {
      url: "inference://recipe",
      state: inferenceRecipe,
    });
    expect(jobs.inferenceRuns).toHaveLength(0);
    const shape = [180, 60, 16];
    const offset = [14, 16, 0]; // Native voxel offset plus the real model crop.
    positionViewer(original, [90.5, 30.5, 8.5], offset);
    const session = openWatershed(original, image);
    configure(session, [2, 0, 3]);
    const recipe: WatershedRecipe = {
      version: 1,
      profile: "visible-slice-union-v1",
      mode: "live",
      source: { name: image.name, source: image.layer!.toJSON().source },
      inputScaleIndex: 0,
      channelsXYZ: [2, 0, 3],
      options: {
        highThreshold: 1,
        lowThreshold: 0,
        sizeThreshold: 0,
        dustThreshold: 0,
      },
      spacingXYZ: [1e-8, 2e-8, 3e-8],
    };
    const result = await addFromDialog(session);
    const output = outputSource(result, shape, offset);
    const label = (x: number) => (x < 60 ? 1n : x < 120 ? 2n : 3n);
    await expectTiles(output.chunkSource, shape, label);
    expect(jobs.shapes()).toEqual([shape]);
    expect(jobs.inferenceRuns).toHaveLength(3);
    expect(modelRequests).toHaveLength(1);
    expect(native.chunks).toHaveLength(5);
    const saved = saveOnlyWatershed(original, result, recipe);
    disposeViewers.get(original)!();
    expect(original.wasDisposed).toBe(true);
    expect(() => output.volume.getSources(sourceOptions)).toThrow(
      /unavailable/,
    );

    const restored = makeViewer();
    restored.chunkManager.chunkQueueManager.capacities.download.itemLimit.value = 1;
    const restoredResult = await restoreOnlyWatershed(restored, saved, true);
    const restoredOutput = outputSource(restoredResult, shape, offset);
    await expectTiles(restoredOutput.chunkSource, shape, label);
    expect(jobs.shapes()).toEqual([shape, shape]);
    expect(jobs.sequence).toEqual([
      "inference-output",
      "inference-output",
      "inference-output",
      "watershed",
      "inference-output",
      "inference-output",
      "inference-output",
      "watershed",
    ]);
    expect(jobs.inferenceRuns).toHaveLength(6);
    for (const run of jobs.inferenceRuns) {
      expect(run.error).toBeUndefined();
      expect(run.metadata).toMatchObject({
        requestedProvider: "cpu",
        actualProvider: "wasm",
        inputShape: [1, 1, 20, 80, 80],
        outputShape: [1, 4, 20, 80, 80],
      });
      expect(run.output).toBeInstanceOf(Float32Array);
      expect(run.output).toHaveLength(4 * 16 * 60 * 60);
      // Independent concat/crop oracle: inspect EVERY real worker value in all
      // four planes, not controller mocks, serialized labels, or just channel 0.
      expect(
        run.output!.every((value, i) => {
          const index = i % (16 * 60 * 60);
          const z = Math.floor(index / (60 * 60)) + 2;
          const y = (Math.floor(index / 60) % 60) + 10;
          const x = (index % 60) + 10;
          return value === run.input[(z * 80 + y) * 80 + x];
        }),
      ).toBe(true);
    }
    expect(modelRequests).toHaveLength(2);
    expect(native.chunks).toHaveLength(10);
    for (const x of [59, 60, 63, 64, 119, 120, 127, 128])
      await expect
        .poll(() =>
          restoredOutput.renderLayer.getValueAt(
            restoredOutput.worldPosition([x + 0.5, 30.5, 8.5]),
          ),
        )
        .toBe(label(x));
    expect(saveOnlyWatershed(restored, restoredResult, recipe)).toEqual(saved);
    expect(restored.layerManager.managedLayers).toEqual([restoredResult]);
  }, 120_000);
}

describe("regional live watershed (real WebGL, chunk RPC and native WASM)", () => {
  it("copies zeros while hidden, then computes one shared domain with identical basin IDs across display chunks and cache eviction", async () => {
    const jobs = observeWatershedWorker();
    const wasmRequests: string[] = [];
    (await server()).use(
      http.get(/abiss_watershed\.wasm(?:\?|$)/, ({ request }) => {
        wasmRequests.push(request.url);
        return passthrough();
      }),
    );
    const native = await precomputed(
      "https://watershed-integration.invalid/regional",
      [148, 5, 4],
      [10, 20, -3],
      [32, 5, 4],
      4,
      (x, _y, _z, c) =>
        x >= 136 || (c === 2 && (x === 32 || x === 96)) ? 0 : 255,
    );
    const viewer = makeViewer();
    viewer.coordinateSpace.restoreState({
      x: [5e-9, "m"],
      y: [10e-9, "m"],
      z: [15e-9, "m"],
    });
    const image = await addImage(viewer, native.url);
    positionViewer(viewer, [74.5, 2.5, 1.5], [10, 20, -3]);
    const session = openWatershed(viewer, image);
    configure(session, [2, 0, 3]);
    const result = await addFromDialog(session, true);
    const output = outputSource(result, [148, 5, 4], [10, 20, -3]);
    for (const grid of [0, 1, 2]) {
      const pending = await readTile(output.chunkSource, grid);
      expect(pending.labels).toEqual(expectedTile(pending.size, () => 0n));
    }
    await delay(250);
    expect(native.chunks).toEqual([]);
    expect(jobs.shapes()).toEqual([]); // Reads NEVER schedule WASM, even on a miss.
    result.setVisible(true);
    const first = await awaitTile(output.chunkSource, 0, 1n);
    const second = await awaitTile(output.chunkSource, 1, 2n);
    const edge = await awaitTile(output.chunkSource, 2, 3n);
    expect(first.size).toEqual([64, 5, 4]);
    expect(edge.size).toEqual([20, 5, 4]);
    expect(first.labels).toEqual(
      expectedTile(first.size, (x) => (x < 32 ? 1n : 2n)),
    );
    expect(second.labels).toEqual(
      expectedTile(second.size, (x) => (x < 32 ? 2n : 3n)),
    );
    expect(edge.labels).toEqual(
      expectedTile(edge.size, (x) => (x < 8 ? 3n : 0n)),
    );
    expect(first.labels[63]).toBe(second.labels[0]);
    expect(second.labels[63]).toBe(edge.labels[0]);
    expect(jobs.shapes()).toEqual([[148, 5, 4]]);
    expect(visibleHaloShape(viewer, [148, 5, 4], [10, 20, -3])).toEqual([
      148, 5, 4,
    ]);
    expect(new Set(native.chunks)).toEqual(
      new Set([
        "10-42_20-25_-3-1",
        "42-74_20-25_-3-1",
        "74-106_20-25_-3-1",
        "106-138_20-25_-3-1",
        "138-158_20-25_-3-1",
      ]),
    );
    expect(native.chunks).toHaveLength(5); // Input fetching remains chunked.
    expect(wasmRequests.length).toBeGreaterThan(0);

    const source = (image.layer as ImageUserLayer).dataSources[0].loadState;
    if (source === undefined || source.error !== undefined)
      throw new Error("Affinity datasource unavailable");
    const enabled = source.subsources.map((s) => s.enabled);
    const cached = new Map(output.chunkSource.chunks);
    source.enableDefaultSubsources = false;
    source.enabledSubsourcesChanged.dispatch();
    await settleView();
    await delay(200);
    expect(source.subsources.map((s) => s.enabled)).toEqual(enabled);
    expectPublicationActive(output);
    for (const [key, chunk] of cached)
      expect(output.chunkSource.chunks.get(key)).toBe(chunk);
    expect(jobs.shapes()).toHaveLength(1);

    // Evict only display copies: a finished regional result survives and must
    // refill them without another native input read or watershed kernel.
    output.chunkSource.invalidateCache();
    for (const [grid, before] of [first, second, edge].entries())
      expect((await readTile(output.chunkSource, grid)).labels).toEqual(
        before.labels,
      );
    expect(jobs.shapes()).toEqual([[148, 5, 4]]);
    expect(native.chunks).toHaveLength(5);
    await expect
      .poll(() => output.chunkSource.chunks.get("1,0,0")?.state)
      .toBe(ChunkState.GPU_MEMORY);
    expect(
      output.renderLayer.getValueAt(output.worldPosition([63.5, 2.5, 1.5])),
    ).toBe(2n);
    expect(
      output.renderLayer.getValueAt(output.worldPosition([64.5, 2.5, 1.5])),
    ).toBe(2n);
    expect(
      output.renderLayer.getValueAt(output.worldPosition([140.5, 2.5, 1.5])),
    ).toBe(0n);
    expect(
      output.renderLayer.getValueAt(output.worldPosition([148.5, 2.5, 1.5])),
    ).toBeNull();
    expect(
      output.renderLayer.getValueAt(output.worldPosition([-0.5, 2.5, 1.5])),
    ).toBeNull();
    deleteLayer(image);
    await expect.poll(() => viewer.layerManager.has(result)).toBe(false);
    expect(session.statusLevel).toBe("error");
    expect(() => output.volume.getSources(sourceOptions)).toThrow(
      /unavailable/,
    );
    await expect.poll(() => output.chunkSource.chunks.size).toBe(0);
  }, 90_000);

  it("unions all three actual orthogonal slice rectangles into ONE domain, ignoring the 3D camera frustum", async () => {
    const jobs = observeWatershedWorker();
    const shape = [148, 50, 48],
      offset = [10, 20, -3];
    const native = await precomputed(
      "https://watershed-integration.invalid/multiview",
      shape,
      offset,
      [32, 25, 16],
      3,
      () => 255,
    );
    const viewer = makeViewer();
    viewer.layout.restoreState("4panel");
    const image = await addImage(viewer, native.url);
    positionViewer(viewer, [74.5, 25.5, 24.5], offset);
    const session = openWatershed(viewer, image);
    configure(session);
    const result = await addFromDialog(session);
    const output = outputSource(result, shape, offset);
    const first = await awaitTile(output.chunkSource, 0, 1n);
    const neighbor = await awaitTile(output.chunkSource, 1, 1n);
    const edge = await awaitTile(output.chunkSource, [2, 0, 1], 1n);
    expect(first.labels).toEqual(expectedTile(first.size, () => 1n));
    expect(neighbor.labels).toEqual(expectedTile(neighbor.size, () => 1n));
    expect(edge.size).toEqual([20, 50, 16]);
    expect(edge.labels).toEqual(expectedTile(edge.size, () => 1n));
    expect(
      [...viewer.display.panels].filter((p) => p instanceof SliceViewPanel),
    ).toHaveLength(3);
    expect(visibleHaloShape(viewer, shape, offset)).toEqual(shape);
    // XY alone plus halo would cover only 17 Z slices, not all 48. Neither
    // independent per-view kernels nor per-render-chunk kernels can pass this.
    expect(jobs.shapes()).toEqual([shape]);
    viewer.projectionScale.value *= 1000;
    await settleView();
    await delay(250);
    expect(jobs.shapes()).toEqual([shape]);
    expect(
      output.renderLayer.getValueAt(output.worldPosition([64.5, 25.5, 24.5])),
    ).toBe(1n);
    expect(native.chunks.length).toBeGreaterThan(1);
  }, 90_000);

  it("debounces navigation, clears old labels, and discards an obsolete real kernel before serially starting the latest region", async () => {
    const jobs = observeWatershedWorker(3);
    const shape = [384, 20, 16],
      offset = [4, 6, -2];
    const native = await precomputed(
      "https://watershed-integration.invalid/navigation",
      shape,
      offset,
      [32, 20, 16],
      3,
      (x, _y, _z, c) => (c === 0 && x === 256 ? 0 : 255),
    );
    const viewer = makeViewer();
    const image = await addImage(viewer, native.url);
    positionViewer(viewer, [90.5, 10.5, 8.5], offset, 0.3);
    const session = openWatershed(viewer, image);
    configure(session);
    const result = await addFromDialog(session);
    const output = outputSource(result, shape, offset);
    await expect.poll(() => jobs.hasReply(0), { timeout: 60_000 }).toBe(true);
    const initialHalo = visibleHaloShape(viewer, shape, offset);
    expect(jobs.shapes()).toEqual([initialHalo]);
    const pending = await readTile(output.chunkSource, 1);
    expect(pending.labels).toEqual(expectedTile(pending.size, () => 0n));
    // These distinct rectangles arrive less than 150 ms apart. Only the last
    // one may become a kernel; the first native reply remains physically held.
    for (const x of [180.5, 240.5, 290.5]) {
      viewer.position.value = output.worldPosition([x, 10.5, 8.5]);
      await settleView();
      await delay(25);
      expect(jobs.shapes()).toHaveLength(1);
    }
    const latestHalo = visibleHaloShape(viewer, shape, offset);
    await delay(250);
    expect(jobs.shapes()).toHaveLength(1); // Cancellation cannot free the slot.
    jobs.release(0);
    await expect.poll(() => jobs.hasReply(1), { timeout: 60_000 }).toBe(true);
    expect(jobs.shapes()).toEqual([initialHalo, latestHalo]);
    // The obsolete native result was real and has now returned, but must never
    // populate either its old display tile or the pending new domain.
    for (const grid of [1, 5]) {
      const blank = await readTile(output.chunkSource, grid);
      expect(blank.labels).toEqual(expectedTile(blank.size, () => 0n));
    }
    jobs.release(1);
    const left = await awaitTile(output.chunkSource, 3, 1n);
    const right = await awaitTile(output.chunkSource, 4, 2n);
    const edge = await awaitTile(output.chunkSource, 5, 2n);
    expect(left.labels).toEqual(expectedTile(left.size, () => 1n));
    expect(right.labels).toEqual(expectedTile(right.size, () => 2n));
    expect(edge.labels).toEqual(expectedTile(edge.size, () => 2n));
    expect(right.labels[63]).toBe(edge.labels[0]);
    const outside = await readTile(output.chunkSource, 1);
    expect(outside.labels).toEqual(expectedTile(outside.size, () => 0n));
    expect(jobs.shapes()).toHaveLength(2);

    // Repeat with a FREE kernel slot and a previously published nonzero result:
    // serialization alone must not masquerade as navigation debounce.
    for (const x of [220.5, 190.5, 150.5]) {
      viewer.position.value = output.worldPosition([x, 10.5, 8.5]);
      await settleView();
      await delay(25);
      expect(jobs.shapes()).toHaveLength(2);
    }
    const finalHalo = visibleHaloShape(viewer, shape, offset);
    await expect.poll(() => jobs.hasReply(2), { timeout: 60_000 }).toBe(true);
    expect(jobs.shapes()).toEqual([initialHalo, latestHalo, finalHalo]);
    // This was ID 2 before navigation. Await the real cache invalidation,
    // rather than manually evicting a stale display copy to make it pass.
    await expect
      .poll(async () => (await readTile(output.chunkSource, 5)).labels[0])
      .toBe(0n);
    const cleared = await readTile(output.chunkSource, 5);
    expect(cleared.labels).toEqual(expectedTile(cleared.size, () => 0n));
    const waiting = await readTile(output.chunkSource, 1);
    expect(waiting.labels).toEqual(expectedTile(waiting.size, () => 0n));
    jobs.release(2);
    const final = await awaitTile(output.chunkSource, 1, 1n);
    expect(final.labels).toEqual(expectedTile(final.size, () => 1n));
    expect(jobs.shapes()).toHaveLength(3);
    expect(session.statusLevel, session.status).toBe("info");
  }, 90_000);

  it("automatically repeats scalar probabilities over XYZ and preserves exact regional splits across a display boundary", async () => {
    const jobs = observeWatershedWorker();
    const native = await precomputed(
      "https://watershed-integration.invalid/scalar",
      [148, 5, 4],
      [10, 20, -3],
      [32, 5, 4],
      1,
      (x) => ((x >= 30 && x < 34) || (x >= 94 && x < 98) || x >= 136 ? 0 : 255),
    );
    const viewer = makeViewer();
    const image = await addImage(viewer, native.url);
    positionViewer(viewer, [74.5, 2.5, 1.5], [10, 20, -3]);
    const session = openWatershed(viewer, image);
    expect(field(session, "Channels for −X −Y −Z").value).toBe("0, 0, 0");
    expect(field(session, "Use last channel as mask").checked).toBe(false);
    expect(field(session, "Use last channel as mask").disabled).toBe(true);
    configureThresholds(session); // Do not override the automatic mapping.
    const result = await addFromDialog(session);
    const output = outputSource(result, [148, 5, 4], [10, 20, -3]);
    const label = (x: number) =>
      x < 30 ? 1n : x < 33 ? 0n : x < 94 ? 2n : x < 97 ? 0n : x < 136 ? 3n : 0n;
    for (const grid of [0, 1, 2]) {
      const tile = await awaitTile(output.chunkSource, grid, label(grid * 64));
      expect(tile.labels).toEqual(
        expectedTile(tile.size, (x) => label(grid * 64 + x)),
      );
    }
    // Zero probability is an affinity, not a post-mask: x=33 connects to x=34.
    expect(
      output.renderLayer.getValueAt(output.worldPosition([30.5, 2.5, 1.5])),
    ).toBe(0n);
    expect(
      output.renderLayer.getValueAt(output.worldPosition([33.5, 2.5, 1.5])),
    ).toBe(2n);
    expect(
      output.renderLayer.getValueAt(output.worldPosition([63.5, 2.5, 1.5])),
    ).toBe(2n);
    expect(
      output.renderLayer.getValueAt(output.worldPosition([64.5, 2.5, 1.5])),
    ).toBe(2n);
    expect(jobs.shapes()).toEqual([[148, 5, 4]]);
  }, 90_000);

  it("uses real mask controls to gate BOTH edge endpoints regionally without changing a default-off publication", async () => {
    const jobs = observeWatershedWorker();
    const native = await precomputed(
      "https://watershed-integration.invalid/mask",
      [148, 5, 4],
      [10, 20, -3],
      [32, 5, 4],
      4,
      (x, _y, _z, c) =>
        c !== 3 || x >= 136 ? 255 : x === 32 || x === 96 ? 77 : 76,
    );
    const viewer = makeViewer();
    const image = await addImage(viewer, native.url);
    positionViewer(viewer, [74.5, 2.5, 1.5], [10, 20, -3]);
    const session = openWatershed(viewer, image);
    configure(session);
    const useMask = field(session, "Use last channel as mask");
    expect(useMask.type).toBe("checkbox");
    expect(useMask.checked).toBe(false);
    expect(field(session, "Mask threshold").disabled).toBe(true);
    expect(field(session, "Mask threshold").value).toBe("0.3");
    const unmasked = await addFromDialog(session);
    const off = outputSource(unmasked, [148, 5, 4], [10, 20, -3]);
    const offFirst = await awaitTile(off.chunkSource, 0, 1n);
    expect(offFirst.labels).toEqual(expectedTile(offFirst.size, () => 1n));
    useMask.click();
    fill(session, "Mask threshold", "0.3");
    const masked = await addFromDialog(session);
    const on = outputSource(masked, [148, 5, 4], [10, 20, -3]);
    const label = (x: number) =>
      x < 32
        ? 1n
        : x === 32
          ? 0n
          : x < 96
            ? 2n
            : x === 96
              ? 0n
              : x < 136
                ? 3n
                : 0n;
    for (const grid of [0, 1, 2]) {
      const tile = await awaitTile(on.chunkSource, grid, label(grid * 64));
      expect(tile.labels).toEqual(
        expectedTile(tile.size, (x) => label(grid * 64 + x)),
      );
      const unmaskedTile = await readTile(off.chunkSource, grid);
      expect(unmaskedTile.labels).toEqual(
        expectedTile(unmaskedTile.size, () => 1n),
      );
    }
    // 76/255 < .3 stays; 77/255 > .3 is masked. Merely zeroing output
    // would leave both sides with ID 1 instead of splitting into basins 1/2/3.
    for (const [x, expected] of [
      [31, 1n],
      [32, 0n],
      [33, 2n],
      [63, 2n],
      [64, 2n],
      [96, 0n],
      [97, 3n],
    ] as const)
      expect(
        on.renderLayer.getValueAt(on.worldPosition([x + 0.5, 2.5, 1.5])),
      ).toBe(expected);
    expect(jobs.shapes()).toEqual([
      [148, 5, 4],
      [148, 5, 4],
    ]);
    expect(native.chunks).toHaveLength(5);
  }, 90_000);

  it("waits for ALL ONNX affinities before ONE viewport watershed at download itemLimit=1 and revokes on ONNX invalidation with its image retained", async () => {
    const jobs = observeWatershedWorker();
    const viewer = makeViewer();
    viewer.dataContext.chunkManager.chunkQueueManager.capacities.download.itemLimit.value = 1;
    const f = await liveFixture(viewer, [0, 120]);
    positionViewer(viewer, [90.5, 30.5, 8.5], [4, 6, -2]);
    const result = await addFromDialog(f.session);
    const output = outputSource(result, [180, 60, 16], [4, 6, -2]);
    await expect.poll(() => f.gated, { timeout: 60_000 }).toEqual([0]);
    expect(f.origins()).toEqual([[0, 0, 0]]);
    expect(f.readPatch).toHaveBeenCalledOnce();
    expect(f.native.chunks).toHaveLength(2); // Native data arrived, ONNX did not.
    expect(f.completed).toEqual([]);
    for (const grid of [0, 1, 2]) {
      const blank = await readTile(output.chunkSource, grid);
      expect(blank.labels).toEqual(expectedTile(blank.size, () => 0n));
    }
    await delay(250);
    expect(jobs.shapes()).toEqual([]);
    f.release(0);

    // Two inference regions have finished, but the last required region still
    // owns its native data behind the gate. Neither partial affinities nor the
    // pending display zeros may be submitted to the real WASM worker.
    await expect.poll(() => f.gated, { timeout: 60_000 }).toEqual([0, 120]);
    expect(f.origins()).toEqual([
      [0, 0, 0],
      [0, 0, 60],
      [0, 0, 120],
    ]);
    expect(f.readPatch).toHaveBeenCalledTimes(3);
    expect(f.native.chunks).toHaveLength(6);
    expect(f.completed).toEqual([0, 60]);
    for (const grid of [0, 1, 2]) {
      const blank = await readTile(output.chunkSource, grid);
      expect(blank.labels).toEqual(expectedTile(blank.size, () => 0n));
    }
    await delay(250);
    expect(jobs.shapes()).toEqual([]);
    f.release(120);

    for (const grid of [0, 1, 2]) {
      const tile = await awaitTile(
        output.chunkSource,
        grid,
        BigInt(Math.floor((grid * 64) / 60) + 1),
      );
      expect(tile.labels).toEqual(
        expectedTile(tile.size, (x) =>
          BigInt(Math.floor((grid * 64 + x) / 60) + 1),
        ),
      );
    }
    expect(f.origins()).toEqual([
      [0, 0, 0],
      [0, 0, 60],
      [0, 0, 120],
    ]);
    expect(f.readPatch).toHaveBeenCalledTimes(3);
    expect(f.native.chunks).toHaveLength(6);
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.completed).toEqual([0, 60, 120]);
    expect(visibleHaloShape(viewer, [180, 60, 16], [4, 6, -2])).toEqual([
      180, 60, 16,
    ]);
    expect(jobs.shapes()).toEqual([[180, 60, 16]]);
    output.chunkSource.invalidateCache();
    await awaitTile(output.chunkSource, 1, 2n);
    expect(f.run).toHaveBeenCalledTimes(3);
    expect(jobs.shapes()).toHaveLength(1);
    expectPublicationActive(output);
    const affinityImage = f.image.layer;
    f.publication.dispose(); // Revocation without deleting its source image.
    await expect.poll(() => viewer.layerManager.has(result)).toBe(false);
    expect(viewer.layerManager.managedLayers).toEqual([f.raw, f.image]);
    expect(f.image.layer).toBe(affinityImage);
    expect(f.session.statusLevel).toBe("error");
    expect(f.session.status).toMatch(/Watershed stopped/);
    expect(() => output.volume.getSources(sourceOptions)).toThrow(
      /unavailable/,
    );
    await expect.poll(() => output.chunkSource.chunks.size).toBe(0);
  }, 90_000);

  it("deleting a watershed aborts active dependencies and cannot commit late inference or kill the shared source", async () => {
    const jobs = observeWatershedWorker();
    const viewer = makeViewer();
    viewer.dataContext.chunkManager.chunkQueueManager.capacities.download.itemLimit.value = 1;
    const f = await liveFixture(viewer, [0]);
    positionViewer(viewer, [90.5, 30.5, 8.5], [4, 6, -2]);
    const result = await addFromDialog(f.session);
    const output = outputSource(result, [180, 60, 16], [4, 6, -2]);
    await expect.poll(() => f.gated, { timeout: 60_000 }).toEqual([0]);
    expect(f.native.chunks).toHaveLength(2); // Gated evaluation read real raw data.
    const blank = await readTile(output.chunkSource, 0);
    expect(blank.labels).toEqual(expectedTile(blank.size, () => 0n));
    deleteLayer(result);
    expect(() => output.volume.getSources(sourceOptions)).toThrow(
      /unavailable/,
    );
    await expect.poll(() => f.signals[0].aborted).toBe(true);
    expect(f.cancel).toHaveBeenCalled();
    f.release(0);
    await expect.poll(() => f.completed).toEqual([0]);
    await expect.poll(() => output.chunkSource.chunks.size).toBe(0);
    expect(jobs.shapes()).toEqual([]);
    expect(f.input.isValid()).toBe(true);
    const replacement = await addFromDialog(f.session);
    const next = outputSource(replacement, [180, 60, 16], [4, 6, -2]);
    const first = await awaitTile(next.chunkSource, 0, 1n);
    expect(first.labels).toEqual(
      expectedTile(first.size, (x) => (x < 60 ? 1n : 2n)),
    );
    expect(f.origins()).toEqual([
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 60],
      [0, 0, 120],
    ]);
    expect(f.native.chunks).toHaveLength(6); // Native cache survives cancellation.
    expect(jobs.shapes()).toEqual([[180, 60, 16]]);
  }, 90_000);

  it("visibly rejects a union over 2**21 voxels with ZERO split fallback calls and recovers on the next smaller view", async () => {
    const jobs = observeWatershedWorker();
    const shape = [256, 256, 128],
      offset = [0, 0, 0];
    const native = await precomputed(
      "https://watershed-integration.invalid/oversize",
      shape,
      offset,
      [32, 32, 16],
      3,
      () => 255,
    );
    const viewer = makeViewer();
    viewer.layout.restoreState("4panel");
    const image = await addImage(viewer, native.url);
    positionViewer(viewer, [128.5, 128.5, 64.5], offset, 4);
    const session = openWatershed(viewer, image);
    configure(session);
    const result = await addFromDialog(session, false, "error");
    const output = outputSource(result, shape, offset);
    await expect.poll(() => session.statusLevel).toBe("error");
    expect(session.status).toMatch(/2\*\*21|2,097,152|2097152/);
    expect(session.dialog!.body.textContent).toContain(session.status);
    expect(
      visibleHaloShape(viewer, shape, offset).reduce((a, b) => a * b, 1),
    ).toBeGreaterThan(2 ** 21);
    const blank = await readTile(output.chunkSource, 0);
    expect(blank.labels).toEqual(expectedTile(blank.size, () => 0n));
    await delay(250);
    expect(jobs.shapes()).toEqual([]);
    expect(native.chunks).toEqual([]);
    expect(viewer.layerManager.has(result)).toBe(true); // Nonfatal regional error.
    viewer.crossSectionScale.value = 0.08;
    await expect
      .poll(
        () =>
          output.renderLayer.getValueAt(
            output.worldPosition([128.5, 128.5, 64.5]),
          ),
        {
          timeout: 60_000,
        },
      )
      .toBe(1n);
    const halo = visibleHaloShape(viewer, shape, offset);
    expect(halo.reduce((a, b) => a * b, 1)).toBeLessThanOrEqual(2 ** 21);
    expect(jobs.shapes()).toEqual([halo]);
    expect(viewer.layerManager.has(result)).toBe(true);
  }, 90_000);
});

// Preserve the original suite's first-load WASM HTTP assertion before these
// additional kernels warm the shared real computation worker.
describe(
  "shareable watershed recipes (fresh real Viewer and workers)",
  shareableWatershedRecipeTests,
);
