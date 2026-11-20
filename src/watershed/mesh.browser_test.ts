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

import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChunkState } from "#src/chunk_manager/base.js";
import { WatershedMeshSource } from "#src/datasource/watershed/frontend.js";
import { ImageUserLayer } from "#src/layer/image/index.js";
import { makeLayer, type ManagedUserLayer } from "#src/layer/index.js";
import { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import {
  MeshLayer,
  MeshSource,
  type FragmentChunk,
} from "#src/mesh/frontend.js";
import { PerspectivePanel } from "#src/perspective_view/panel.js";
import type { UncompressedVolumeChunk } from "#src/sliceview/uncompressed_chunk_format.js";
import { SliceViewVolumeRenderLayer } from "#src/sliceview/volume/renderlayer.js";
import { makeMinimalViewer } from "#src/ui/minimal_viewer.js";
import { bindWatershed } from "#src/ui/watershed.js";
import * as matrix from "#src/util/matrix.js";
import type { Viewer } from "#src/viewer.js";
import type { WatershedRecipe } from "#src/watershed/recipe.js";
import { mswFixture } from "#tests/fixtures/msw_browser.js";

const server = mswFixture();
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  vi.restoreAllMocks();
});

const shape = [5, 3, 3];
const offset = [10, 20, -3];
const spacing = [1e-8, 2e-8, 3e-8];
const splitLabels = Array.from({ length: 45 }, (_, i) => (i % 5 < 2 ? 1n : 2n));

/** Real GL, worker/chunk RPC, affinity reads, native watershed and native mesh. */
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
  cleanup.push(dispose);
  viewer.layout.restoreState("4panel");
  viewer.dataContext.chunkManager.chunkQueueManager.enablePrefetch.value = false;
  expect(viewer.display.gl).toBeInstanceOf(WebGL2RenderingContext);
  expect(viewer.dataContext.worker).toBeInstanceOf(Worker);
  return { viewer, dispose };
}

function position(viewer: Viewer, xyz: number[]) {
  const global = viewer.coordinateSpace.value;
  viewer.position.value = Float32Array.from(global.names, (name, d) => {
    const axis = ["x", "y", "z"].indexOf(name);
    return axis === -1
      ? 0
      : ((offset[axis] + xyz[axis]) * spacing[axis]) / global.scales[d];
  });
  viewer.crossSectionScale.value = 2;
}

const workerPostMessage = Worker.prototype.postMessage;

/** Observe only: all messages and computations still run normally. */
function observeJobs(viewer: Viewer) {
  const watershed: unknown[] = [];
  const mesh: unknown[] = [];
  const snapshots: number[] = [];
  vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
    this: Worker,
    ...args
  ) {
    const message = args[0];
    if (message?.t === "abissWatershed") watershed.push(message);
    // Snapshot grants, unlike denied manifest probes, let the backend extract
    // an actual mesh. Inspect before postMessage transfers/detaches the labels.
    if (
      this === viewer.dataContext.worker &&
      message?.functionName === "rpc.promise.response" &&
      message.value?.labels instanceof Uint32Array &&
      typeof message.value.generation === "number"
    ) {
      snapshots.push(message.id);
    }
    return Reflect.apply(workerPostMessage, this, args);
  });
  const onMessage = (event: MessageEvent) => {
    if (event.data?.functionName === "watershed/mesh") mesh.push(event.data);
  };
  viewer.dataContext.worker.addEventListener("message", onMessage);
  cleanup.push(() =>
    viewer.dataContext.worker.removeEventListener("message", onMessage),
  );
  return { watershed, mesh, snapshots };
}

/** Frame and real worker round trips, rather than a wall-clock sleep. */
async function settle(viewer: Viewer) {
  for (let i = 0; i < 3; ++i) {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    await viewer.chunkManager.chunkQueueManager.getStatistics();
  }
}

async function fixture(
  name: string,
  {
    shapeXYZ = shape,
    splitX = 2,
    center = [2.5, 1.5, 1.5],
    scale = 2,
    hidden = false,
  } = {},
) {
  const base = `https://watershed-mesh.invalid/${name}`;
  const chunks: string[] = [];
  (await server()).use(
    http.get(`${base}/info`, () =>
      HttpResponse.json({
        "@type": "neuroglancer_multiscale_volume",
        type: "image",
        data_type: "float32",
        num_channels: 3,
        scales: [
          {
            key: "raw",
            resolution: [10, 20, 30],
            voxel_offset: offset,
            size: shapeXYZ,
            chunk_sizes: [shapeXYZ],
            encoding: "raw",
          },
        ],
      }),
    ),
    http.get(`${base}/raw/:chunk`, ({ params }) => {
      chunks.push(String(params.chunk));
      // Planar CZYX, X fastest. Only the 1/2 basin contact is weak.
      const voxels = shapeXYZ.reduce((a, b) => a * b);
      const data = new Float32Array(3 * voxels).fill(1);
      for (let i = 0; i < voxels; ++i) {
        const x = i % shapeXYZ[0];
        data[i] = x === 0 ? 0 : x === splitX ? 0.25 : 1;
      }
      return new HttpResponse(data.buffer, {
        headers: { "Content-Type": "application/octet-stream" },
      });
    }),
  );
  const { viewer, dispose } = makeViewer();
  const jobs = observeJobs(viewer);
  const image = makeLayer(viewer.layerSpecification, "affinities", {
    type: "image",
    source: `precomputed://${base}`,
    visible: false,
    shader: "void main() { emitGrayscale(toNormalized(getDataValue(0))); }",
  });
  viewer.layerSpecification.add(image);
  await expect.poll(() => image.isReady(), { timeout: 30_000 }).toBe(true);
  expect(image.layer).toBeInstanceOf(ImageUserLayer);
  position(viewer, center);
  viewer.crossSectionScale.value = scale;
  const session = bindWatershed(viewer);
  session.selectSource(image);
  session.highThreshold = "1";
  session.lowThreshold = "0";
  session.sizeThreshold = "0";
  session.dustThreshold = "0";
  const prepareInput = vi.spyOn(session.dependencies, "prepareInput");
  const createLive = vi.spyOn(session.dependencies, "createLive");
  // Hide synchronously at attachment, before a viewport can demand computation.
  const removeHide = viewer.layerManager.layersChanged.add(() => {
    if (!hidden) return;
    for (const layer of viewer.layerManager.managedLayers)
      if (layer.layer instanceof SegmentationUserLayer) layer.visible = false;
  });
  try {
    await session.addLayer();
  } finally {
    removeHide();
  }
  expect(session.statusLevel, session.status).toBe("info");
  const result = viewer.layerManager.managedLayers.find(
    (layer) => layer.layer instanceof SegmentationUserLayer,
  )!;
  expect(result).toBeDefined();
  await expect.poll(() => result.isReady(), { timeout: 30_000 }).toBe(true);
  expect(result.visible).toBe(!hidden);
  const live = createLive.mock.results.at(-1)!.value;
  return {
    viewer,
    dispose,
    image,
    result,
    live,
    jobs,
    chunks,
    prepareInput,
    createLive,
  };
}

function output(result: ManagedUserLayer) {
  const segmentation = result.layer as SegmentationUserLayer;
  const loadState = segmentation.dataSources[0].loadState;
  if (loadState === undefined || loadState.error !== undefined)
    throw new Error("Watershed datasource did not load successfully");
  const dataSource = loadState.dataSource;
  expect(dataSource.subsources.map((s) => s.id)).toEqual(["default", "meshes"]);
  const volume = dataSource.subsources[0].subsource.volume!;
  const mesh = dataSource.subsources[1].subsource.mesh!;
  expect(mesh).toBeInstanceOf(MeshSource);
  expect(mesh).toBeInstanceOf(WatershedMeshSource);
  const meshSource = mesh as WatershedMeshSource;
  const volumeLayer = segmentation.renderLayers.find(
    (layer): layer is SliceViewVolumeRenderLayer =>
      layer instanceof SliceViewVolumeRenderLayer,
  )!;
  const meshLayer = segmentation.renderLayers.find(
    (layer): layer is MeshLayer => layer instanceof MeshLayer,
  )!;
  expect(volumeLayer.multiscaleSource).toBe(volume);
  expect(meshLayer).toBeInstanceOf(MeshLayer);
  expect(meshLayer.source).toBe(meshSource);
  const sources = volume.getSources({
    discreteValues: true,
    displayRank: 3,
    modelChannelDimensionIndices: [],
    multiscaleToViewTransform: matrix.createIdentity(Float32Array, 3),
  });
  cleanup.push(() => {
    for (const alternatives of sources)
      for (const { chunkSource } of alternatives) chunkSource.dispose();
  });
  const chunkSource = sources[0][0].chunkSource;
  const group = segmentation.displayState.segmentationGroupState.value;
  return {
    segmentation,
    dataSource,
    volume,
    volumeLayer,
    meshSource,
    meshLayer,
    chunkSource,
    group,
  };
}

async function labels(source: ReturnType<typeof output>["chunkSource"]) {
  return source.fetchChunk(
    new Float32Array(3),
    (chunk) => {
      const tile = chunk as UncompressedVolumeChunk;
      return Array.from({ length: 45 }, (_, i) =>
        tile.getValueAt(
          Uint32Array.of(i % 5, Math.floor(i / 5) % 3, Math.floor(i / 15)),
        ),
      );
    },
    { signal: new AbortController().signal },
  );
}

function residentFragments(source: MeshSource) {
  return [...source.fragmentSource.chunks.values()].filter(
    (chunk) =>
      chunk.state === ChunkState.SYSTEM_MEMORY ||
      chunk.state === ChunkState.GPU_MEMORY,
  );
}

async function awaitMesh(source: MeshSource, id = 1n) {
  await expect
    .poll(() => source.chunks.get(String(id))?.fragmentIds.length ?? 0, {
      timeout: 60_000,
    })
    .toBeGreaterThan(0);
  const manifest = source.chunks.get(String(id))!;
  await expect
    .poll(
      () =>
        manifest.fragmentIds.every((fragmentId) => {
          const key = source.getFragmentKey(String(id), fragmentId).key;
          return (
            source.fragmentSource.chunks.get(key)?.state ===
            ChunkState.GPU_MEMORY
          );
        }),
      { timeout: 60_000 },
    )
    .toBe(true);
  return manifest.fragmentIds.map(
    (fragmentId) =>
      source.fragmentSource.chunks.get(
        source.getFragmentKey(String(id), fragmentId).key,
      )!,
  );
}

function expectCappedBounds(
  fragments: FragmentChunk[],
  lowerX: number,
  upperX: number,
) {
  const vertices = fragments.flatMap((chunk) => [
    ...chunk.meshData.vertexPositions,
  ]);
  expect(vertices.length).toBeGreaterThan(0);
  expect(vertices.length % 3).toBe(0);
  const coordinates = [0, 1, 2].map((axis) =>
    vertices.filter((_, i) => i % 3 === axis),
  );
  expect(coordinates.map((axis) => Math.min(...axis))).toEqual([lowerX, 0, 0]);
  expect(coordinates.map((axis) => Math.max(...axis))).toEqual([upperX, 3, 3]);
  for (const { meshData } of fragments) {
    expect(meshData.vertexPositions).toBeInstanceOf(Float32Array);
    expect(meshData.indices.length).toBeGreaterThan(0);
    expect(meshData.indices.length % 3).toBe(0);
    for (const index of meshData.indices)
      expect(index).toBeLessThan(meshData.vertexPositions.length / 3);
  }
  return coordinates;
}

function expectInternalPlane(fragments: FragmentChunk[], x = 2, lowerX = 0) {
  const coordinates = expectCappedBounds(fragments, lowerX, x);
  for (const axis of [1, 2]) {
    const onPlane = coordinates[axis].filter((_, i) => coordinates[0][i] === x);
    expect(Math.min(...onPlane)).toBe(0.5);
    expect(Math.max(...onPlane)).toBe(2.5);
  }
}

describe("selected live watershed meshes (real Viewer, Chrome and WASM)", () => {
  it("demands native mesh fragments in 3-D and preserves voxel geometry and contained-navigation caches", async () => {
    const { viewer, result, live, jobs, chunks } = await fixture("geometry");
    const out = output(result);
    await expect
      .poll(() => live.hasCompletedResult, { timeout: 60_000 })
      .toBe(true);
    await expect
      .poll(() => labels(out.chunkSource), { timeout: 60_000 })
      .toEqual(splitLabels);
    await settle(viewer);
    expect(jobs.watershed).toHaveLength(1);
    expect(jobs.mesh).toHaveLength(0);
    expect(jobs.snapshots).toHaveLength(0);
    expect(residentFragments(out.meshSource)).toHaveLength(0);
    expect(
      [...viewer.display.panels].some(
        (panel) => panel instanceof PerspectivePanel,
      ),
    ).toBe(true);

    // This is an explicit pick AFTER real final labels are available. No test
    // mesh RPC, manually requested fragment or synthetic mesh data is involved.
    out.group.visibleSegments.add(1n);
    const fragments = await awaitMesh(out.meshSource);
    expectInternalPlane(fragments);
    expect(jobs.mesh.length).toBeGreaterThan(0);
    expect(jobs.snapshots).toHaveLength(1);
    expect(out.meshLayer.isReady()).toBe(true);
    expect(out.dataSource.modelTransform.outputSpace.units).toEqual([
      "m",
      "m",
      "m",
    ]);
    expect([...out.dataSource.modelTransform.outputSpace.scales]).toEqual(
      spacing,
    );
    const transform = matrix.createIdentity(Float64Array, 4);
    transform.set(offset, 12);
    expect(out.dataSource.modelTransform.transform).toEqual(transform);
    // Geometry is native-grid (x=2), not translated/scaled twice. Its physical
    // interface is (source offset 10 + x 2) * 10 nm = 120 nm.
    expect(
      (offset[0] + fragments[0].meshData.vertexPositions[0]) * spacing[0],
    ).toBeCloseTo(1.2e-7, 14);

    // Include a starred-but-hidden ID: both NG selection sets must survive a
    // contained view and an identical parameter restore, not just visibility.
    out.group.selectedSegments.add(2n);
    const epoch = live.epoch;
    const counts = [
      jobs.watershed.length,
      jobs.mesh.length,
      jobs.snapshots.length,
    ];
    const cached = [...out.meshSource.fragmentSource.chunks.values()];
    position(viewer, [3, 1.5, 1.5]);
    const recipe = out.dataSource.state!.toJSON();
    out.dataSource.state!.restoreState(JSON.parse(JSON.stringify(recipe)));
    await settle(viewer);
    expect(live.epoch).toBe(epoch);
    expect([...out.group.visibleSegments]).toEqual([1n]);
    expect([...out.group.selectedSegments].sort()).toEqual([1n, 2n]);
    expect([
      jobs.watershed.length,
      jobs.mesh.length,
      jobs.snapshots.length,
    ]).toEqual(counts);
    expect([...out.meshSource.fragmentSource.chunks.values()]).toEqual(cached);
    expect(out.volumeLayer.multiscaleSource).toBe(out.volume);
    expect(chunks).toEqual(["10-15_20-23_-3-0"]);

    // A real watershed-parameter edit, unlike the identical restore above,
    // starts a new label epoch and resets visible AND starred-only IDs.
    const state = out.dataSource.state!;
    const previous = state.toJSON() as WatershedRecipe;
    state.restoreState({
      ...previous,
      options: { ...previous.options, dustThreshold: 1 },
    });
    expect(live.epoch).toBeGreaterThan(epoch);
    expect(live.hasCompletedResult).toBe(false);
    expect([...out.group.visibleSegments]).toEqual([]);
    expect([...out.group.selectedSegments]).toEqual([]);
    // The labels happen to be identical: a cached transport tile alone cannot
    // prove that this rerun has completed and a new pick can be approved.
    await expect
      .poll(() => live.hasCompletedResult, { timeout: 60_000 })
      .toBe(true);
    await expect
      .poll(() => labels(out.chunkSource), { timeout: 60_000 })
      .toEqual(splitLabels);
    await expect
      .poll(() =>
        residentFragments(out.meshSource).some((chunk) =>
          fragments.includes(chunk),
        ),
      )
      .toBe(false);
    await settle(viewer);
    expect([...out.group.visibleSegments]).toEqual([]);
    expect([...out.group.selectedSegments]).toEqual([]);
    expect(residentFragments(out.meshSource)).toHaveLength(0);
    expect(jobs.snapshots).toHaveLength(counts[2]);
    out.group.visibleSegments.add(1n);
    expect(out.meshSource.selection!.allows(1n, live.epoch)).toBe(true);
    const rerun = await awaitMesh(out.meshSource);
    expectInternalPlane(rerun);
    for (const fragment of rerun) expect(fragments).not.toContain(fragment);
    expect(jobs.watershed).toHaveLength(counts[0] + 1);
    expect(jobs.snapshots).toHaveLength(counts[2] + 1);
    expect(out.volumeLayer.multiscaleSource).toBe(out.volume);
  }, 120_000);

  it("preserves clipped native vertices and clears both selection sets on a non-contained viewport", async () => {
    const { viewer, result, live, jobs } = await fixture("clipped", {
      shapeXYZ: [133, 3, 3],
      splitX: 66,
      center: [66.5, 1.5, 1.5],
      scale: 0.08,
    });
    const out = output(result);
    await expect
      .poll(() => live.hasCompletedResult, { timeout: 60_000 })
      .toBe(true);
    const snapshot = live.getCompletedSnapshot()!;
    expect(snapshot.lowerXYZ[0]).toBeGreaterThan(0);
    expect(snapshot.shapeXYZ[0]).toBeLessThan(133);
    expect(snapshot.labels).toContain(1);
    expect(snapshot.labels).toContain(2);
    out.group.visibleSegments.add(1n);
    const fragments = await awaitMesh(out.meshSource);
    expectInternalPlane(fragments, 66, snapshot.lowerXYZ[0]);
    expect(
      (offset[0] + fragments[0].meshData.vertexPositions[0]) * spacing[0],
    ).toBeCloseTo(7.6e-7, 14);
    out.group.selectedSegments.add(2n);
    const epoch = live.epoch;
    const snapshotCount = jobs.snapshots.length;
    let observedEpoch = epoch;
    const resets: Array<{
      visible: bigint[];
      selected: bigint[];
      ready: boolean;
      snapshots: number;
    }> = [];
    cleanup.push(
      live.changed.add(() => {
        if (live.epoch === observedEpoch) return;
        observedEpoch = live.epoch;
        resets.push({
          visible: [...out.group.visibleSegments],
          selected: [...out.group.selectedSegments],
          ready: live.hasCompletedResult,
          snapshots: jobs.snapshots.length,
        });
      }),
    );
    // Expand the actual Viewer viewport beyond the old completed ROI/halo.
    // Keep the split in view so the same final numeric ID has a known surface.
    viewer.crossSectionScale.value = 2;
    await expect.poll(() => live.epoch).toBeGreaterThan(epoch);
    expect(resets.length).toBeGreaterThan(0);
    for (const reset of resets) {
      expect(reset).toEqual({
        visible: [],
        selected: [],
        ready: false,
        snapshots: snapshotCount,
      });
    }
    await expect
      .poll(() => live.hasCompletedResult, { timeout: 60_000 })
      .toBe(true);
    expect(live.getCompletedSnapshot()!.lowerXYZ[0]).toBeLessThan(
      snapshot.lowerXYZ[0],
    );
    await expect
      .poll(() =>
        residentFragments(out.meshSource).some((chunk) =>
          fragments.includes(chunk),
        ),
      )
      .toBe(false);
    await settle(viewer);
    expect([...out.group.visibleSegments]).toEqual([]);
    expect([...out.group.selectedSegments]).toEqual([]);
    expect(residentFragments(out.meshSource)).toHaveLength(0);
    expect(jobs.snapshots).toHaveLength(snapshotCount);
    out.group.visibleSegments.add(1n);
    const expanded = await awaitMesh(out.meshSource);
    expectInternalPlane(expanded, 66, live.getCompletedSnapshot()!.lowerXYZ[0]);
    for (const fragment of expanded) expect(fragments).not.toContain(fragment);
    expect(jobs.snapshots).toHaveLength(snapshotCount + 1);
  }, 120_000);

  it("keeps hidden layers idle and rejects a pick made before final labels exist", async () => {
    const { viewer, result, live, jobs } = await fixture("hidden", {
      hidden: true,
    });
    const out = output(result);
    out.group.visibleSegments.add(1n);
    out.group.selectedSegments.add(2n);
    await settle(viewer);
    expect(live.hasCompletedResult).toBe(false);
    expect(jobs.watershed).toHaveLength(0);
    expect(jobs.mesh).toHaveLength(0);
    expect(residentFragments(out.meshSource)).toHaveLength(0);

    result.setVisible(true);
    await expect
      .poll(() => labels(out.chunkSource), { timeout: 60_000 })
      .toEqual(splitLabels);
    await settle(viewer);
    // Starting the first observed live epoch clears the pre-completion pick.
    expect([...out.group.visibleSegments]).toEqual([]);
    expect([...out.group.selectedSegments]).toEqual([]);
    expect(jobs.watershed).toHaveLength(1);
    expect(jobs.snapshots).toHaveLength(0);
    expect(residentFragments(out.meshSource)).toHaveLength(0);
    out.group.visibleSegments.add(1n);
    expectInternalPlane(await awaitMesh(out.meshSource));
    expect(jobs.snapshots).toHaveLength(1);
  }, 120_000);

  it.each([false, true])(
    "restores a recipe into a fresh worker without approving saved IDs (initially hidden: %s)",
    async (hidden) => {
      const original = await fixture("restore");
      const old = output(original.result);
      await expect
        .poll(() => labels(old.chunkSource), { timeout: 60_000 })
        .toEqual(splitLabels);
      old.group.visibleSegments.add(1n);
      old.group.selectedSegments.add(2n);
      expectInternalPlane(await awaitMesh(old.meshSource));
      const saved = JSON.parse(
        JSON.stringify(original.viewer.state.toJSON()),
      ) as {
        layers: Array<{
          name: string;
          source: { url: string; state: WatershedRecipe };
          segments?: string[];
          visible?: boolean;
        }>;
      };
      const layer = saved.layers.find(
        (layer) => layer.name === original.result.name,
      )!;
      expect(layer.source.url).toBe("watershed://recipe");
      expect(layer.segments).toEqual(["1", "!2"]);
      layer.visible = !hidden;
      saved.layers = [layer]; // Restore the recipe's embedded affinity source.
      expect(JSON.stringify(saved)).not.toMatch(
        /meshData|vertexPositions|fragmentIds/,
      );
      original.dispose();
      expect(original.live.signal.aborted).toBe(true);

      const { viewer } = makeViewer();
      const jobs = observeJobs(viewer);
      expect(viewer.dataContext.worker).not.toBe(
        original.viewer.dataContext.worker,
      );
      bindWatershed(viewer);
      viewer.state.restoreState(saved);
      await expect
        .poll(
          () => {
            const result = viewer.layerManager.managedLayers[0];
            for (const source of result?.layer?.dataSources ?? []) {
              if (source.loadState?.error !== undefined)
                throw source.loadState.error;
            }
            return result?.isReady();
          },
          { timeout: 60_000 },
        )
        .toBe(true);
      expect(viewer.layerManager.managedLayers).toHaveLength(1);
      const restored = viewer.layerManager.managedLayers[0];
      const out = output(restored);
      expect(out.volume).not.toBe(old.volume);
      expect(out.meshSource).not.toBe(old.meshSource);
      if (hidden) {
        // Attachment alone does not erase saved state or approve restored IDs.
        // The first observed epoch begins only when this output becomes visible.
        expect([...out.group.visibleSegments]).toEqual([1n]);
        expect([...out.group.selectedSegments].sort()).toEqual([1n, 2n]);
        expect(
          out.meshSource.selection!.allows(
            1n,
            out.meshSource.state.value.epoch,
          ),
        ).toBe(false);
        await settle(viewer);
        expect(jobs.watershed).toHaveLength(0);
        expect(jobs.snapshots).toHaveLength(0);
        expect(residentFragments(out.meshSource)).toHaveLength(0);
        restored.setVisible(true);
      }
      await expect
        .poll(() => labels(out.chunkSource), { timeout: 60_000 })
        .toEqual(splitLabels);
      await settle(viewer);
      // This fresh output-only restore observes an initial live run, so saved
      // visible and starred IDs are reset, never implicitly approved as picks.
      expect([...out.group.visibleSegments]).toEqual([]);
      expect([...out.group.selectedSegments]).toEqual([]);
      expect(jobs.watershed).toHaveLength(1);
      expect(jobs.snapshots).toHaveLength(0);
      expect(residentFragments(out.meshSource)).toHaveLength(0);
      out.group.visibleSegments.add(1n);
      expectInternalPlane(await awaitMesh(out.meshSource));
      expect(jobs.snapshots).toHaveLength(1);
      expect(original.chunks).toHaveLength(2);
    },
    120_000,
  );

  it("clears visible and starred IDs on agglomeration reruns and directly remeshes the same final ID", async () => {
    const { viewer, image, result, live, jobs, prepareInput, createLive } =
      await fixture("rerun");
    const out = output(result);
    await expect
      .poll(() => labels(out.chunkSource), { timeout: 60_000 })
      .toEqual(splitLabels);
    out.group.visibleSegments.add(1n);
    out.group.selectedSegments.add(2n); // Starred but not visible.
    const old = await awaitMesh(out.meshSource);
    expectInternalPlane(old);
    const input = prepareInput.mock.results[0].value;
    const inputLayer = image.layer;
    const unrelated = makeLayer(viewer.layerSpecification, "unrelated", {
      type: "segmentation",
      source: [],
      segments: ["9", "!10"],
    });
    viewer.layerSpecification.add(unrelated);
    const unrelatedGroup = (unrelated.layer as SegmentationUserLayer)
      .displayState.segmentationGroupState.value;
    const expectIdentityAndUnrelatedSelection = () => {
      expect(prepareInput).toHaveBeenCalledOnce();
      expect(createLive).toHaveBeenCalledOnce();
      expect(prepareInput.mock.results[0].value).toBe(input);
      expect(createLive.mock.results[0].value).toBe(live);
      expect(image.layer).toBe(inputLayer);
      expect(input.signal.aborted).toBe(false);
      expect(live.signal.aborted).toBe(false);
      expect(out.volumeLayer.multiscaleSource).toBe(out.volume);
      expect(out.dataSource.subsources[0].subsource.volume).toBe(out.volume);
      expect(out.dataSource.subsources[1].subsource.mesh).toBe(out.meshSource);
      expect([...unrelatedGroup.visibleSegments]).toEqual([9n]);
      expect([...unrelatedGroup.selectedSegments].sort()).toEqual(
        [9n, 10n].sort(),
      );
    };
    const firstEpoch = live.epoch;
    const firstSnapshotCount = jobs.snapshots.length;
    const firstGeneration = out.meshSource.state.value.generation;
    const state = out.dataSource.state!;
    const recipe = state.toJSON() as WatershedRecipe;
    state.restoreState({
      ...recipe,
      options: { ...recipe.options, aggThreshold: 0.2 },
    });
    expect(live.epoch).toBeGreaterThan(firstEpoch);
    expect(out.meshSource.state.value.generation).toBeGreaterThan(
      firstGeneration,
    );
    expect([...out.group.visibleSegments]).toEqual([]);
    expect([...out.group.selectedSegments]).toEqual([]);
    expect(live.hasCompletedResult).toBe(false);
    expectIdentityAndUnrelatedSelection();
    await expect
      .poll(() => live.hasCompletedResult, { timeout: 60_000 })
      .toBe(true);
    await expect
      .poll(() => labels(out.chunkSource), { timeout: 60_000 })
      .toEqual(new Array(45).fill(1n));
    await expect
      .poll(() =>
        residentFragments(out.meshSource).some((chunk) => old.includes(chunk)),
      )
      .toBe(false);
    await settle(viewer);
    expect([...out.group.visibleSegments]).toEqual([]);
    expect([...out.group.selectedSegments]).toEqual([]);
    expect(residentFragments(out.meshSource)).toHaveLength(0);
    expect(jobs.snapshots).toHaveLength(firstSnapshotCount);
    expectIdentityAndUnrelatedSelection();

    // No visibility-off toggle: epoch reset made the old numeric ID pickable.
    out.group.visibleSegments.add(1n);
    const merged = await awaitMesh(out.meshSource);
    // Agglomeration leaves only the ROI exterior, not the old 1/2 interface.
    const [x, y, z] = expectCappedBounds(merged, 0, 5);
    expect(
      x.every(
        (value, i) =>
          value === 0 ||
          value === 5 ||
          y[i] === 0 ||
          y[i] === 3 ||
          z[i] === 0 ||
          z[i] === 3,
      ),
    ).toBe(true);
    for (const fragment of merged) expect(old).not.toContain(fragment);
    expect(out.meshLayer.isReady()).toBe(true);
    expect(jobs.snapshots).toHaveLength(firstSnapshotCount + 1);
    expect(jobs.watershed).toHaveLength(2);
    expect([...out.group.visibleSegments]).toEqual([1n]);
    expect([...out.group.selectedSegments]).toEqual([1n]);

    // Turning agglomeration OFF restores the original native 1/2 interface,
    // without replacing the input, producer, volume, or output mesh source.
    out.group.selectedSegments.add(2n);
    const mergedEpoch = live.epoch;
    const mergedGeneration = out.meshSource.state.value.generation;
    state.restoreState(recipe);
    expect(live.epoch).toBeGreaterThan(mergedEpoch);
    expect(out.meshSource.state.value.generation).toBeGreaterThan(
      mergedGeneration,
    );
    expect(live.hasCompletedResult).toBe(false);
    expect([...out.group.visibleSegments]).toEqual([]);
    expect([...out.group.selectedSegments]).toEqual([]);
    expectIdentityAndUnrelatedSelection();
    await expect
      .poll(() => labels(out.chunkSource), { timeout: 60_000 })
      .toEqual(splitLabels);
    await expect
      .poll(() =>
        residentFragments(out.meshSource).some((chunk) =>
          merged.includes(chunk),
        ),
      )
      .toBe(false);
    await settle(viewer);
    expect([...out.group.visibleSegments]).toEqual([]);
    expect([...out.group.selectedSegments]).toEqual([]);
    expect(residentFragments(out.meshSource)).toHaveLength(0);
    expect(jobs.snapshots).toHaveLength(firstSnapshotCount + 1);
    out.group.visibleSegments.add(1n);
    const split = await awaitMesh(out.meshSource);
    expectInternalPlane(split);
    for (const fragment of split) {
      expect(old).not.toContain(fragment);
      expect(merged).not.toContain(fragment);
    }
    expect(jobs.snapshots).toHaveLength(firstSnapshotCount + 2);
    expect(jobs.watershed).toHaveLength(3);
    expectIdentityAndUnrelatedSelection();

    // Identical parameters preserve the fresh selection and cached geometry.
    const counts = [
      jobs.watershed.length,
      jobs.mesh.length,
      jobs.snapshots.length,
    ];
    const cached = [...out.meshSource.fragmentSource.chunks.values()];
    const splitEpoch = live.epoch;
    state.restoreState(JSON.parse(JSON.stringify(recipe)));
    await settle(viewer);
    expect(live.epoch).toBe(splitEpoch);
    expect([...out.group.visibleSegments]).toEqual([1n]);
    expect([...out.group.selectedSegments]).toEqual([1n]);
    expect([
      jobs.watershed.length,
      jobs.mesh.length,
      jobs.snapshots.length,
    ]).toEqual(counts);
    expect([...out.meshSource.fragmentSource.chunks.values()]).toEqual(cached);
    expectInternalPlane(await awaitMesh(out.meshSource));

    // Completion uses the same signal as retirement, but without a new epoch
    // it must keep fresh picks approved. The publication may refresh caches.
    live.changed.dispatch();
    expect(live.epoch).toBe(splitEpoch);
    expect([...out.group.visibleSegments]).toEqual([1n]);
    expect([...out.group.selectedSegments]).toEqual([1n]);
    expect(out.meshSource.selection!.allows(1n, splitEpoch)).toBe(true);
    expectInternalPlane(await awaitMesh(out.meshSource));
    expect([...out.group.visibleSegments]).toEqual([1n]);
    expect([...out.group.selectedSegments]).toEqual([1n]);
    expectIdentityAndUnrelatedSelection();
  }, 120_000);
});
