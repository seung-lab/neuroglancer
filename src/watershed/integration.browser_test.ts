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
import { publishLiveInference } from "#src/datasource/inference/frontend.js";
import type { OnnxInferenceController } from "#src/inference/controller.js";
import { prepareInferenceInput } from "#src/inference/input.js";
import { LiveInference } from "#src/inference/live.js";
import { makeModelGeometry } from "#src/inference/model.js";
import { ImageUserLayer } from "#src/layer/image/index.js";
import type { ManagedUserLayer } from "#src/layer/index.js";
import { deleteLayer, makeLayer } from "#src/layer/index.js";
import { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import type { ChunkChannelAccessParameters } from "#src/render_coordinate_transform.js";
import { UncompressedVolumeChunk } from "#src/sliceview/uncompressed_chunk_format.js";
import { DataType, VolumeType } from "#src/sliceview/volume/base.js";
import type { VolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import { SliceViewVolumeRenderLayer } from "#src/sliceview/volume/renderlayer.js";
import { makeMinimalViewer } from "#src/ui/minimal_viewer.js";
import { bindWatershed, type WatershedSession } from "#src/ui/watershed.js";
import * as matrix from "#src/util/matrix.js";
import type { Viewer } from "#src/viewer.js";
import { mswFixture } from "#tests/fixtures/msw_browser.js";

const server = mswFixture();
const cleanup: Array<() => void> = [];
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
  cleanup.push(() => {
    viewer.dispose();
    viewer.display.dispose();
    target.remove();
  });
  viewer.layout.restoreState("xy");
  viewer.dataContext.chunkManager.chunkQueueManager.enablePrefetch.value = false;
  expect(viewer.display.gl).toBeInstanceOf(WebGL2RenderingContext);
  expect(viewer.dataContext.worker).toBeInstanceOf(Worker);
  return viewer;
}

async function addImage(viewer: Viewer, url: string) {
  const layer = makeLayer(viewer.layerSpecification, "affinities", {
    type: "image",
    source: url,
    // Explicit native requests below isolate demand from viewport prefetch.
    visible: false,
    shader: "void main() { emitGrayscale(toNormalized(getDataValue(0))); }",
  });
  viewer.layerSpecification.add(layer);
  await expect.poll(() => layer.isReady(), { timeout: 30_000 }).toBe(true);
  expect(layer.layer).toBeInstanceOf(ImageUserLayer);
  const image = layer.layer as ImageUserLayer;
  expect(image.dataSources.map((s) => s.loadState?.error)).toEqual([undefined]);
  expect(
    image.renderLayers.filter((r) => r instanceof SliceViewVolumeRenderLayer),
  ).toHaveLength(1);
  return layer;
}

/** Invoke the registered command and drive its real no-ROI form. */
function openWatershed(viewer: Viewer, source: ManagedUserLayer) {
  const session = bindWatershed(viewer);
  viewer.commandRegistry.get("open-watershed")!.invoke({
    dispatchTarget: viewer.element,
  });
  expect(session.dialog).toBeDefined();
  const body = session.dialog!.body;
  expect(body.querySelector('input[aria-label*="ROI"]')).toBeNull();
  expect(body.querySelector('input[aria-label="ROI lower X Y Z"]')).toBeNull();
  expect(body.querySelector('input[aria-label="ROI size X Y Z"]')).toBeNull();
  const select = body.querySelector("select")!;
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

function configure(session: WatershedSession, channels = [0, 1, 2]) {
  fill(session, "Channels for −X −Y −Z", channels.join(", "));
  configureThresholds(session);
}

function configureThresholds(session: WatershedSession) {
  fill(session, "High threshold", "1");
  fill(session, "Low threshold", "0");
  fill(session, "Size threshold", "0");
  fill(session, "Dust threshold", "0");
}

async function addFromDialog(session: WatershedSession) {
  const { viewer } = session;
  const previous = new Set(viewer.layerManager.managedLayers);
  // Observe, rather than replace, layer creation. Hide synchronously on attach,
  // before the slice view can demand data: publication must be metadata-only.
  const hideNewLayer = viewer.layerManager.layersChanged.add(() => {
    for (const layer of viewer.layerManager.managedLayers)
      if (!previous.has(layer) && layer.layer instanceof SegmentationUserLayer)
        layer.setVisible(false);
  });
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
    expect(session.statusLevel, session.status).toBe("info");
    const result = findResult()!;
    await expect.poll(() => result.isReady()).toBe(true);
    expect(result.visible).toBe(false);
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

function outputSource(
  result: ManagedUserLayer,
  shapeXYZ: number[],
  offsetXYZ: number[],
  spacingXYZ: number[],
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
  expect(dataSource.canonicalUrl).toMatch(/^watershed:\/\/[a-f0-9]+$/);
  const { modelTransform } = dataSource;
  expect([...modelTransform.inputSpace.bounds.lowerBounds]).toEqual([0, 0, 0]);
  expect([...modelTransform.inputSpace.bounds.upperBounds]).toEqual(shapeXYZ);
  expect(modelTransform.outputSpace.names).toEqual(["x", "y", "z"]);
  expect(modelTransform.outputSpace.units).toEqual(["m", "m", "m"]);
  expect([...modelTransform.outputSpace.scales]).toEqual(spacingXYZ);
  const transform = matrix.createIdentity(Float64Array, 4);
  transform.set(offsetXYZ, 12);
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
  expect([...chunkSource.spec.upperVoxelBound]).toEqual(shapeXYZ);
  expect([...chunkSource.spec.chunkDataSize]).toEqual([64, 64, 32]);
  expect(chunkSource.spec.dataType).toBe(DataType.UINT64);

  // Viewer coordinates deliberately need not use the native voxel spacing.
  const worldPosition = (xyz: number[]) => {
    const global = result.manager.root.coordinateSpace.value;
    return Float32Array.from(global.names, (name, d) => {
      const axis = ["x", "y", "z"].indexOf(name);
      return axis === -1
        ? 0
        : ((offsetXYZ[axis] + xyz[axis]) * spacingXYZ[axis]) / global.scales[d];
    });
  };
  return { volume, chunkSource, renderLayer, worldPosition };
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

/** Fetch via real chunk RPC; read the actual UINT64 chunk, not fixture labels. */
async function readTile(
  source: VolumeChunkSource,
  gridX: number,
  signal = new AbortController().signal,
) {
  const tile = await source.fetchChunk(
    Float32Array.of(gridX, 0, 0),
    (chunk) => {
      const volumeChunk = chunk as UncompressedVolumeChunk;
      const size = [...volumeChunk.chunkDataSize];
      const labels: Array<number | bigint> = [];
      for (let z = 0; z < size[2]; ++z)
        for (let y = 0; y < size[1]; ++y)
          for (let x = 0; x < size[0]; ++x)
            labels.push(volumeChunk.getValueAt(Uint32Array.of(x, y, z)));
      // Assertions stay outside the callback: a throwing requester could leave
      // fetchChunk waiting forever instead of reporting the failed assertion.
      return {
        uncompressed: chunk instanceof UncompressedVolumeChunk,
        uint64: volumeChunk.data instanceof BigUint64Array,
        grid: [...volumeChunk.chunkGridPosition],
        size,
        labels,
        firstViaSource: source.getValueAt(
          Float32Array.of(gridX * 64, 0, 0),
          scalarAccess,
        ),
      };
    },
    { signal },
  );
  expect(tile.uncompressed).toBe(true);
  expect(tile.uint64).toBe(true);
  expect(tile.grid).toEqual([gridX, 0, 0]);
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

async function settleView() {
  // Let both viewport priority updates and their worker messages settle.
  for (let i = 0; i < 2; ++i)
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
}

function observeWatershedWorker() {
  // A call-through spy on the real async worker protocol, not fake compute.
  const messages = vi.spyOn(Worker.prototype, "postMessage");
  return () =>
    messages.mock.calls
      .filter(([message]) => message?.t === "abissWatershed")
      .map(([message]) => [...message.args[1]] as number[]);
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
async function liveFixture(viewer: Viewer, gateX?: number) {
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
  // A per-voxel identity geometry keeps the fixture small, with the actual
  // published inference chunks still 60x60x16 (crossing watershed's x=64).
  const geometry = makeModelGeometry(
    { inputShape: [1, 1, 1, 1, 1], outputShape: [1, 4, 1, 1, 1] },
    [input.spacingZYX[0], input.spacingZYX[1], input.spacingZYX[2]],
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  cleanup.push(release);
  let gated = false;
  let lateReturned = false;
  let active: AbortController | undefined;
  const signals: AbortSignal[] = [];
  const run = vi.fn<OnnxInferenceController["run"]>(async (source, options) => {
    const abort = (active = new AbortController());
    signals.push(abort.signal);
    // This awaited native read is essential to the three-tier scheduling test.
    const patch = await source.readPatch(
      options.originZYX,
      options.shapeZYX,
      abort.signal,
    );
    if (!gated && options.originZYX[2] - source.originZYX[2] === gateX) {
      gated = true;
      await gate; // Deliberately return late even after controller.cancel().
      lateReturned = true;
    }
    const data = new Float32Array(patch.length * 4).fill(1);
    data.set(patch); // Real normalized raw values become the -X affinities.
    active = undefined;
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
  const image = await addImage(viewer, publication.url);
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
    release,
    get gated() {
      return gated;
    },
    get lateReturned() {
      return lateReturned;
    },
    origins: () =>
      run.mock.calls.map(([, options]) =>
        options.originZYX.map((n, d) => n - input.originZYX[d]),
      ),
  };
}

describe("live watershed integration (real WebGL, chunk RPC and WASM workers)", () => {
  it("publishes lazily with native UINT64 placement, preserves cache on default-subsource toggles and recomputes identical labels after eviction", async () => {
    const jobs = observeWatershedWorker();
    const wasmRequests: string[] = [];
    (await server()).use(
      http.get(/abiss_watershed\.wasm(?:\?|$)/, ({ request }) => {
        wasmRequests.push(request.url);
        return passthrough();
      }),
    );
    const native = await precomputed(
      "https://watershed-integration.invalid/static",
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
    const session = openWatershed(viewer, image);
    expect(session.metadata?.upperBoundXYZ).toEqual([148, 5, 4]);
    configure(session, [2, 0, 3]);
    const result = await addFromDialog(session);
    const output = outputSource(
      result,
      [148, 5, 4],
      [10, 20, -3],
      [1e-8, 2e-8, 3e-8],
    );
    // Frames have passed after publication, yet neither source nor WASM ran.
    await settleView();
    expect(native.chunks).toEqual([]);
    expect(jobs()).toEqual([]);

    viewer.position.value = output.worldPosition([16.5, 2.5, 1.5]);
    const first = await readTile(output.chunkSource, 0);
    expect(first.size).toEqual([64, 5, 4]);
    expect(first.labels).toEqual(
      expectedTile(first.size, (x) => (x < 32 ? 1n : 33n)),
    );
    expect(jobs()).toEqual([[72, 5, 4]]); // Eight-voxel halo, clipped at the domain.
    expect(native.chunks).toEqual([
      "10-42_20-25_-3-1",
      "42-74_20-25_-3-1",
      "74-106_20-25_-3-1",
    ]);
    const firstCached = output.chunkSource.chunks.get("0,0,0");

    viewer.position.value = output.worldPosition([80.5, 2.5, 1.5]);
    const second = await readTile(output.chunkSource, 1);
    expect(second.size).toEqual([64, 5, 4]);
    expect(second.labels).toEqual(
      expectedTile(second.size, (x) => (x < 32 ? 131073n : 131105n)),
    );
    // Even connected neighbors x=63/64 have disjoint, stable block namespaces:
    // no accidental cross-block merges and no claim of global stitching.
    expect(first.labels[63]).not.toBe(second.labels[0]);
    expect(jobs()).toEqual([
      [72, 5, 4],
      [80, 5, 4],
    ]);
    const fetches = native.chunks.length;
    viewer.position.value = output.worldPosition([16.5, 2.5, 1.5]);
    expect((await readTile(output.chunkSource, 0)).labels).toEqual(
      first.labels,
    );
    expect(output.chunkSource.chunks.get("0,0,0")).toBe(firstCached);
    await settleView();
    expect(native.chunks).toHaveLength(fetches);
    expect(jobs()).toHaveLength(2);

    viewer.position.value = output.worldPosition([130.5, 2.5, 1.5]);
    const edge = await readTile(output.chunkSource, 2);
    expect(edge.size).toEqual([20, 5, 4]);
    expect(edge.labels).toEqual(
      expectedTile(edge.size, (x) => (x < 8 ? 262145n : 0n)),
    );
    expect(jobs()).toEqual([
      [72, 5, 4],
      [80, 5, 4],
      [28, 5, 4],
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
    expect(wasmRequests.length).toBeGreaterThan(0);
    expect(native.chunks).toHaveLength(5);

    // Match the Data sources tab's checkbox setter: disabling default selection
    // changes serialization metadata, NOT the currently enabled subsource flags.
    const source = (image.layer as ImageUserLayer).dataSources[0].loadState;
    if (source === undefined || source.error !== undefined)
      throw new Error("Affinity datasource did not load successfully");
    expect(source.enableDefaultSubsources).toBe(true);
    const enabledBefore = source.subsources.map((s) => s.enabled);
    const cachedBefore = new Map(output.chunkSource.chunks);
    expect(cachedBefore.size).toBe(3);
    const fetchesBeforeToggle = native.chunks.length;
    source.enableDefaultSubsources = false;
    source.enabledSubsourcesChanged.dispatch();
    await settleView();
    expect(source.enableDefaultSubsources).toBe(false);
    expect(source.subsources.map((s) => s.enabled)).toEqual(enabledBefore);
    expect(viewer.layerManager.has(result)).toBe(true);
    expect(session.statusLevel, session.status).toBe("info");
    expectPublicationActive(output);
    expect(output.chunkSource.chunks.size).toBe(cachedBefore.size);
    for (const [key, chunk] of cachedBefore)
      expect(output.chunkSource.chunks.get(key)).toBe(chunk);
    expect((await readTile(output.chunkSource, 0)).labels).toEqual(
      first.labels,
    );
    expect(native.chunks).toHaveLength(fetchesBeforeToggle);
    expect(jobs()).toHaveLength(3);

    // Evict the actual frontend/backend output cache, not the publication.
    // With the layer hidden, only the explicit requests below can recompute it.
    const nativeFetchesBeforeEviction = native.chunks.length;
    output.chunkSource.invalidateCache();
    await expect.poll(() => output.chunkSource.chunks.size).toBe(0);
    expectPublicationActive(output);
    for (const [gridX, before] of [first, second, edge].entries()) {
      const recomputed = await readTile(output.chunkSource, gridX);
      expect(recomputed.size).toEqual(before.size);
      expect(recomputed.labels).toEqual(before.labels);
    }
    // Three more real WASM jobs prove there is no private output cache; exact
    // bigint equality includes disjoint block namespaces and edge background.
    expect(jobs()).toEqual([
      [72, 5, 4],
      [80, 5, 4],
      [28, 5, 4],
      [72, 5, 4],
      [80, 5, 4],
      [28, 5, 4],
    ]);
    expect(output.chunkSource.chunks.size).toBe(3);
    // Invalidating only output must leave the independent native input cache.
    expect(native.chunks).toHaveLength(nativeFetchesBeforeEviction);
    expect(result.isReady()).toBe(true);
    expect(session.statusLevel, session.status).toBe("info");

    // Exercise the displayed layer's global transform and real GPU upload too.
    viewer.crossSectionScale.value = 0.01;
    result.setVisible(true);
    await expect
      .poll(() => output.renderLayer.visibleSourcesList.length)
      .toBeGreaterThan(0);
    await expect
      .poll(() => output.chunkSource.chunks.get("2,0,0")?.state)
      .toBe(ChunkState.GPU_MEMORY);
    expect(
      output.renderLayer.getValueAt(output.worldPosition([130.5, 2.5, 1.5])),
    ).toBe(262145n);
    expect(
      output.renderLayer.getValueAt(output.worldPosition([140.5, 2.5, 1.5])),
    ).toBe(0n);
    expect(
      output.renderLayer.getValueAt(output.worldPosition([148.5, 2.5, 1.5])),
    ).toBeNull();
    expect(
      output.renderLayer.getValueAt(output.worldPosition([-0.5, 2.5, 1.5])),
    ).toBeNull();
    expect(jobs()).toHaveLength(6);
    deleteLayer(result);
    expect(() => output.volume.getSources(sourceOptions)).toThrow(
      /unavailable/,
    );
    expect(viewer.layerManager.managedLayers).toEqual([image]);
  }, 90_000);

  it("schedules tier2 → tier1 → tier0 with download itemLimit=1, reuses cached tiles and reacts to ONNX revocation with its image retained", async () => {
    const jobs = observeWatershedWorker();
    const viewer = makeViewer();
    const capacity =
      viewer.dataContext.chunkManager.chunkQueueManager.capacities.download;
    capacity.itemLimit.value = 1;
    expect(capacity.itemLimit.value).toBe(1);
    const f = await liveFixture(viewer);
    const result = await addFromDialog(f.session);
    const output = outputSource(
      result,
      [180, 60, 16],
      [4, 6, -2],
      [1e-8, 2e-8, 3e-8],
    );
    await settleView();
    expect(f.native.chunks).toEqual([]);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.readPatch).not.toHaveBeenCalled();
    expect(jobs()).toEqual([]);

    viewer.position.value = output.worldPosition([32.5, 20.5, 8.5]);
    const first = await readTile(output.chunkSource, 0);
    expect(first.size).toEqual([64, 60, 16]);
    expect(first.labels).toEqual(
      expectedTile(first.size, (x) => (x < 60 ? 1n : 61n)),
    );
    expect(f.origins()).toEqual([
      [0, 0, 0],
      [0, 0, 60],
    ]);
    expect(f.readPatch).toHaveBeenCalledTimes(2);
    expect(f.native.chunks).toHaveLength(4);
    expect(jobs()).toEqual([[72, 60, 16]]);

    viewer.crossSectionScale.value = 0.01;
    result.setVisible(true);
    await expect
      .poll(() => output.chunkSource.chunks.get("0,0,0")?.state)
      .toBe(ChunkState.GPU_MEMORY);
    viewer.position.value = output.worldPosition([96.5, 20.5, 8.5]);
    // No explicit fetch for this tile: navigation itself must demand it.
    await expect
      .poll(() => output.chunkSource.chunks.get("1,0,0")?.state, {
        timeout: 60_000,
      })
      .toBe(ChunkState.GPU_MEMORY);
    const second = await readTile(output.chunkSource, 1);
    expect(second.labels).toEqual(
      expectedTile(second.size, (x) => (x < 56 ? 131073n : 131129n)),
    );
    expect(f.origins()).toEqual([
      [0, 0, 0],
      [0, 0, 60],
      [0, 0, 120],
    ]);
    expect(f.readPatch).toHaveBeenCalledTimes(3);
    expect(f.native.chunks).toHaveLength(6);
    expect(jobs()).toEqual([
      [72, 60, 16],
      [80, 60, 16],
    ]);
    expect(f.cancel).not.toHaveBeenCalled();
    expect(
      output.renderLayer.getValueAt(output.worldPosition([64.5, 20.5, 8.5])),
    ).toBe(131073n);

    viewer.position.value = output.worldPosition([32.5, 20.5, 8.5]);
    expect((await readTile(output.chunkSource, 0)).labels).toEqual(
      first.labels,
    );
    await settleView();
    expect(f.run).toHaveBeenCalledTimes(3);
    expect(f.native.chunks).toHaveLength(6);
    expect(jobs()).toHaveLength(2);
    expect(output.chunkSource.chunks.size).toBe(2);
    expectPublicationActive(output);

    const affinityImage = f.image.layer as ImageUserLayer;
    const affinityRenderLayer = affinityImage.renderLayers.find(
      (r): r is SliceViewVolumeRenderLayer =>
        r instanceof SliceViewVolumeRenderLayer,
    )!;
    const affinitySources = affinityRenderLayer.multiscaleSource.getSources({
      ...sourceOptions,
      discreteValues: false,
      modelChannelDimensionIndices: [3],
    });
    cleanup.push(() => {
      for (const alternatives of affinitySources)
        for (const { chunkSource } of alternatives) chunkSource.dispose();
    });
    expect(affinitySources[0][0].chunkSource.chunks.size).toBe(3);

    // Restore/replacement can revoke ONNX without deleting its image layer.
    // No isValid/assertValid/readTile calls after this point may drive cleanup:
    // real publication disposal must signal the prepared affinity input itself.
    f.publication.dispose();
    await expect
      .poll(() => viewer.layerManager.has(result), { timeout: 5_000 })
      .toBe(false);
    expect(viewer.layerManager.managedLayers).toEqual([f.raw, f.image]);
    expect(f.image.layer).toBe(affinityImage);
    expect(f.session.statusLevel, f.session.status).toBe("error");
    expect(f.session.status).toMatch(/Watershed stopped/);
    expect(() => output.volume.getSources(sourceOptions)).toThrow(
      /unavailable/,
    );
    await expect
      .poll(() => output.chunkSource.chunks.size, { timeout: 5_000 })
      .toBe(0);
    expect(f.run).toHaveBeenCalledTimes(3);
    expect(f.native.chunks).toHaveLength(6);
    expect(jobs()).toHaveLength(2);
  }, 90_000);

  it("cancels offscreen demand through both RPC tiers and discards an inference result returned late", async () => {
    const jobs = observeWatershedWorker();
    const viewer = makeViewer();
    viewer.dataContext.chunkManager.chunkQueueManager.capacities.download.itemLimit.value = 1;
    const f = await liveFixture(viewer, 120);
    const result = await addFromDialog(f.session);
    const output = outputSource(
      result,
      [180, 60, 16],
      [4, 6, -2],
      [1e-8, 2e-8, 3e-8],
    );
    viewer.position.value = output.worldPosition([96.5, 20.5, 8.5]);
    viewer.crossSectionScale.value = 0.01;
    result.setVisible(true);
    await expect.poll(() => f.gated, { timeout: 60_000 }).toBe(true);
    expect(f.native.chunks).toHaveLength(6); // Even the gated run read real raw data.
    expect(f.signals[2].aborted).toBe(false);
    viewer.position.value = output.worldPosition([32.5, 20.5, 8.5]);
    // Only navigation removes demand: no test-owned AbortController or mock RPC.
    await expect.poll(() => f.signals[2].aborted).toBe(true);
    expect(f.cancel).toHaveBeenCalledTimes(1);
    f.release();
    await expect.poll(() => f.lateReturned).toBe(true);
    await expect
      .poll(() => output.chunkSource.chunks.get("0,0,0")?.state, {
        timeout: 60_000,
      })
      .toBe(ChunkState.GPU_MEMORY);
    expect(output.chunkSource.chunks.has("1,0,0")).toBe(false);
    expect(jobs()).toEqual([[72, 60, 16]]);

    const first = await readTile(output.chunkSource, 0);
    expect(first.labels).toEqual(
      expectedTile(first.size, (x) => (x < 60 ? 1n : 61n)),
    );
    expect(f.run).toHaveBeenCalledTimes(3); // Earlier inference tiles stayed cached.
    viewer.position.value = output.worldPosition([96.5, 20.5, 8.5]);
    await expect
      .poll(() => output.chunkSource.chunks.get("1,0,0")?.state, {
        timeout: 60_000,
      })
      .toBe(ChunkState.GPU_MEMORY);
    const retried = await readTile(output.chunkSource, 1);
    expect(retried.labels).toEqual(
      expectedTile(retried.size, (x) => (x < 56 ? 131073n : 131129n)),
    );
    expect(f.origins()).toEqual([
      [0, 0, 0],
      [0, 0, 60],
      [0, 0, 120],
      [0, 0, 120],
    ]);
    expect(f.native.chunks).toHaveLength(6); // Native cache survived cancellation.
    expect(jobs()).toEqual([
      [72, 60, 16],
      [80, 60, 16],
    ]);
    expect(f.session.statusLevel, f.session.status).toBe("info");
  }, 90_000);

  it("deleting a layer aborts active dependencies, expires its URL and cannot commit late work or kill the shared source", async () => {
    const jobs = observeWatershedWorker();
    const viewer = makeViewer();
    const f = await liveFixture(viewer, 0);
    const result = await addFromDialog(f.session);
    const output = outputSource(
      result,
      [180, 60, 16],
      [4, 6, -2],
      [1e-8, 2e-8, 3e-8],
    );
    viewer.position.value = output.worldPosition([32.5, 20.5, 8.5]);
    viewer.crossSectionScale.value = 0.01;
    result.setVisible(true);
    await expect.poll(() => f.gated, { timeout: 60_000 }).toBe(true);
    expect(f.native.chunks).toHaveLength(2);
    deleteLayer(result);
    expect(() => output.volume.getSources(sourceOptions)).toThrow(
      /unavailable/,
    );
    await expect.poll(() => f.signals[0].aborted).toBe(true);
    f.release();
    await expect.poll(() => f.lateReturned).toBe(true);
    expect(output.chunkSource.chunks.size).toBe(0);
    expect(jobs()).toEqual([]);
    expect(viewer.layerManager.managedLayers).toEqual([f.raw, f.image]);
    expect(f.input.isValid()).toBe(true);

    // Reuse the same real source with a new publication after deletion.
    const replacement = await addFromDialog(f.session);
    const next = outputSource(
      replacement,
      [180, 60, 16],
      [4, 6, -2],
      [1e-8, 2e-8, 3e-8],
    );
    const first = await readTile(next.chunkSource, 0);
    expect(first.labels).toEqual(
      expectedTile(first.size, (x) => (x < 60 ? 1n : 61n)),
    );
    expect(f.origins()).toEqual([
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 60],
    ]);
    expect(jobs()).toEqual([[72, 60, 16]]);
    expect(f.session.statusLevel, f.session.status).toBe("info");
  }, 90_000);

  it("automatically duplicates native scalar probabilities and demands aligned UINT64 tiles as the viewer navigates, without an ROI", async () => {
    const jobs = observeWatershedWorker();
    const native = await precomputed(
      "https://watershed-integration.invalid/scalar-probabilities",
      [148, 5, 4],
      [10, 20, -3],
      [32, 5, 4],
      1,
      (x) => ((x >= 30 && x < 34) || (x >= 94 && x < 98) || x >= 136 ? 0 : 255),
    );
    const viewer = makeViewer();
    viewer.coordinateSpace.restoreState({
      x: [5e-9, "m"],
      y: [10e-9, "m"],
      z: [15e-9, "m"],
    });
    const image = await addImage(viewer, native.url);
    const imageRenderLayer = (image.layer as ImageUserLayer).renderLayers.find(
      (r): r is SliceViewVolumeRenderLayer =>
        r instanceof SliceViewVolumeRenderLayer,
    )!;
    expect(imageRenderLayer.multiscaleSource.rank).toBe(3);
    const session = openWatershed(viewer, image);
    expect(field(session, "Channels for −X −Y −Z").value).toBe("0, 0, 0");
    expect(field(session, "Use last channel as mask").checked).toBe(false);
    expect(field(session, "Use last channel as mask").disabled).toBe(true);
    // Leave the automatic channel mapping untouched; edit only algorithm knobs.
    configureThresholds(session);
    const result = await addFromDialog(session);
    const output = outputSource(
      result,
      [148, 5, 4],
      [10, 20, -3],
      [1e-8, 2e-8, 3e-8],
    );
    await settleView();
    expect(native.chunks).toEqual([]);
    expect(jobs()).toEqual([]);

    viewer.position.value = output.worldPosition([16.5, 2.5, 1.5]);
    const first = await readTile(output.chunkSource, 0);
    expect(first.size).toEqual([64, 5, 4]);
    // Probabilities are duplicated to all three negative-axis affinities, not
    // post-masked: x=33 has zero probability but connects to positive x=34.
    // The other three zero columns are background and split positive regions.
    expect(first.labels).toEqual(
      expectedTile(first.size, (x) => (x < 30 ? 1n : x < 33 ? 0n : 34n)),
    );
    expect(jobs()).toEqual([[72, 5, 4]]);
    expect(native.chunks).toEqual([
      "10-42_20-25_-3-1",
      "42-74_20-25_-3-1",
      "74-106_20-25_-3-1",
    ]);
    expect(output.chunkSource.chunks.has("1,0,0")).toBe(false);

    viewer.crossSectionScale.value = 0.01;
    result.setVisible(true);
    await expect
      .poll(() => output.chunkSource.chunks.get("0,0,0")?.state)
      .toBe(ChunkState.GPU_MEMORY);
    expect(
      output.renderLayer.getValueAt(output.worldPosition([30.5, 2.5, 1.5])),
    ).toBe(0n);
    expect(
      output.renderLayer.getValueAt(output.worldPosition([33.5, 2.5, 1.5])),
    ).toBe(34n);

    viewer.position.value = output.worldPosition([110.5, 2.5, 1.5]);
    // Only navigation, not a test-owned fetch, demands this new tile.
    await expect
      .poll(() => output.chunkSource.chunks.get("1,0,0")?.state, {
        timeout: 60_000,
      })
      .toBe(ChunkState.GPU_MEMORY);
    const second = await readTile(output.chunkSource, 1);
    expect(second.size).toEqual([64, 5, 4]);
    expect(second.labels).toEqual(
      expectedTile(second.size, (x) =>
        x < 30 ? 131073n : x < 33 ? 0n : 131106n,
      ),
    );
    expect(jobs()).toEqual([
      [72, 5, 4],
      [80, 5, 4],
    ]);
    expect(native.chunks).toEqual([
      "10-42_20-25_-3-1",
      "42-74_20-25_-3-1",
      "74-106_20-25_-3-1",
      "106-138_20-25_-3-1",
      "138-158_20-25_-3-1",
    ]);
    expect(
      output.renderLayer.getValueAt(output.worldPosition([98.5, 2.5, 1.5])),
    ).toBe(131106n);

    viewer.position.value = output.worldPosition([140.5, 2.5, 1.5]);
    await expect
      .poll(() => output.chunkSource.chunks.get("2,0,0")?.state, {
        timeout: 60_000,
      })
      .toBe(ChunkState.GPU_MEMORY);
    const edge = await readTile(output.chunkSource, 2);
    expect(edge.size).toEqual([20, 5, 4]);
    expect(edge.labels).toEqual(
      expectedTile(edge.size, (x) => (x < 8 ? 262145n : 0n)),
    );
    expect(
      output.renderLayer.getValueAt(output.worldPosition([135.5, 2.5, 1.5])),
    ).toBe(262145n);
    expect(
      output.renderLayer.getValueAt(output.worldPosition([136.5, 2.5, 1.5])),
    ).toBe(0n);
    expect(
      output.renderLayer.getValueAt(output.worldPosition([148.5, 2.5, 1.5])),
    ).toBeNull();
    expect(
      output.renderLayer.getValueAt(output.worldPosition([-0.5, 2.5, 1.5])),
    ).toBeNull();
    expect(jobs()).toEqual([
      [72, 5, 4],
      [80, 5, 4],
      [28, 5, 4],
    ]);
    expect(native.chunks).toHaveLength(5);
    expect(session.statusLevel, session.status).toBe("info");
  }, 90_000);

  it("uses the real mask controls to split normalized UINT8 affinities before WASM, while default-off layers stay connected", async () => {
    const jobs = observeWatershedWorker();
    const native = await precomputed(
      "https://watershed-integration.invalid/masked-affinities",
      [148, 5, 4],
      [10, 20, -3],
      [32, 5, 4],
      4,
      (x, _y, _z, c) =>
        c !== 3 || x >= 136 ? 255 : x === 32 || x === 96 ? 77 : 76,
    );
    const viewer = makeViewer();
    viewer.coordinateSpace.restoreState({
      x: [5e-9, "m"],
      y: [10e-9, "m"],
      z: [15e-9, "m"],
    });
    const image = await addImage(viewer, native.url);
    const session = openWatershed(viewer, image);
    configure(session);
    const useMask = field(session, "Use last channel as mask");
    const maskThreshold = field(session, "Mask threshold");
    expect(useMask.type).toBe("checkbox");
    expect(useMask.checked).toBe(false);
    expect(maskThreshold.type).toBe("number");
    expect(maskThreshold.value).toBe("0.3");
    expect(maskThreshold.disabled).toBe(true);
    const unmasked = await addFromDialog(session);
    const off = outputSource(
      unmasked,
      [148, 5, 4],
      [10, 20, -3],
      [1e-8, 2e-8, 3e-8],
    );
    expect(useMask.disabled).toBe(false);
    useMask.click();
    expect(useMask.checked).toBe(true);
    fill(session, "Mask threshold", "0.3");
    const masked = await addFromDialog(session);
    const on = outputSource(
      masked,
      [148, 5, 4],
      [10, 20, -3],
      [1e-8, 2e-8, 3e-8],
    );
    await settleView();
    expect(native.chunks).toEqual([]);
    expect(jobs()).toEqual([]);

    viewer.position.value = on.worldPosition([16.5, 2.5, 1.5]);
    // The previous layer retains its default-off options after the form changes.
    const offFirst = await readTile(off.chunkSource, 0);
    expect(offFirst.labels).toEqual(expectedTile(offFirst.size, () => 1n));
    const first = await readTile(on.chunkSource, 0);
    expect(first.size).toEqual([64, 5, 4]);
    // 76/255 < .3 stays connected; 77/255 > .3 becomes background. Both
    // endpoints of each incident edge must be gated: x=33 must not reconnect
    // masked x=32. Merely zeroing output would leave both sides with ID 1.
    expect(first.labels).toEqual(
      expectedTile(first.size, (x) => (x < 32 ? 1n : x === 32 ? 0n : 34n)),
    );
    expect(jobs()).toEqual([
      [72, 5, 4],
      [72, 5, 4],
    ]);
    expect(native.chunks).toEqual([
      "10-42_20-25_-3-1",
      "42-74_20-25_-3-1",
      "74-106_20-25_-3-1",
    ]);
    expect(on.chunkSource.chunks.has("1,0,0")).toBe(false);

    viewer.crossSectionScale.value = 0.01;
    masked.setVisible(true);
    await expect
      .poll(() => on.chunkSource.chunks.get("0,0,0")?.state)
      .toBe(ChunkState.GPU_MEMORY);
    expect(on.renderLayer.getValueAt(on.worldPosition([31.5, 2.5, 1.5]))).toBe(
      1n,
    );
    expect(on.renderLayer.getValueAt(on.worldPosition([32.5, 2.5, 1.5]))).toBe(
      0n,
    );
    expect(on.renderLayer.getValueAt(on.worldPosition([33.5, 2.5, 1.5]))).toBe(
      34n,
    );

    viewer.position.value = on.worldPosition([110.5, 2.5, 1.5]);
    await expect
      .poll(() => on.chunkSource.chunks.get("1,0,0")?.state, {
        timeout: 60_000,
      })
      .toBe(ChunkState.GPU_MEMORY);
    const second = await readTile(on.chunkSource, 1);
    expect(second.labels).toEqual(
      expectedTile(second.size, (x) =>
        x < 32 ? 131073n : x === 32 ? 0n : 131106n,
      ),
    );
    expect(native.chunks).toHaveLength(5);

    viewer.position.value = on.worldPosition([140.5, 2.5, 1.5]);
    await expect
      .poll(() => on.chunkSource.chunks.get("2,0,0")?.state, {
        timeout: 60_000,
      })
      .toBe(ChunkState.GPU_MEMORY);
    const edge = await readTile(on.chunkSource, 2);
    expect(edge.size).toEqual([20, 5, 4]);
    expect(edge.labels).toEqual(
      expectedTile(edge.size, (x) => (x < 8 ? 262145n : 0n)),
    );
    expect(on.renderLayer.getValueAt(on.worldPosition([135.5, 2.5, 1.5]))).toBe(
      262145n,
    );
    expect(on.renderLayer.getValueAt(on.worldPosition([136.5, 2.5, 1.5]))).toBe(
      0n,
    );
    // Even a mask value of 255 is ignored in the default-off publication.
    const offEdge = await readTile(off.chunkSource, 2);
    expect(offEdge.labels).toEqual(expectedTile(offEdge.size, () => 262145n));
    expect(jobs()).toEqual([
      [72, 5, 4],
      [72, 5, 4],
      [80, 5, 4],
      [28, 5, 4],
      [28, 5, 4],
    ]);
    expect(native.chunks).toHaveLength(5);
    expect(unmasked.visible).toBe(false);
    expect(session.statusLevel, session.status).toBe("info");
  }, 90_000);
});
