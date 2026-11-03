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
import { publishLiveInference } from "#src/datasource/inference/frontend.js";
import type { OnnxInferenceController } from "#src/inference/controller.js";
import type { PreparedInferenceInput } from "#src/inference/input.js";
import { LiveInference } from "#src/inference/live.js";
import { makeModelGeometry } from "#src/inference/model.js";
import { ImageUserLayer } from "#src/layer/image/index.js";
import type { ManagedUserLayer } from "#src/layer/index.js";
import { deleteLayer, makeLayer } from "#src/layer/index.js";
import { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import type { ChunkChannelAccessParameters } from "#src/render_coordinate_transform.js";
import { UncompressedVolumeChunk } from "#src/sliceview/uncompressed_chunk_format.js";
import { DataType, VolumeType } from "#src/sliceview/volume/base.js";
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

/** No fake GL, chunk manager/RPC, datasource, input reader or computation. */
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
  expect(viewer.display.gl).toBeInstanceOf(WebGL2RenderingContext);
  expect(viewer.dataContext.worker).toBeInstanceOf(Worker);
  return viewer;
}

async function addImage(viewer: Viewer, url: string) {
  const layer = makeLayer(viewer.layerSpecification, "affinities", {
    type: "image",
    source: url,
    // Do not let viewport demand prefetch the live tiles under test.
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

/** Invoke the registered command and drive its real form, not injected deps. */
function openWatershed(viewer: Viewer, source: ManagedUserLayer) {
  const session = bindWatershed(viewer);
  viewer.commandRegistry.get("open-watershed")!.invoke({
    dispatchTarget: viewer.element,
  });
  expect(session.dialog).toBeDefined();
  const select = session.dialog!.body.querySelector("select")!;
  select.value = String(session.sources.indexOf(source));
  select.dispatchEvent(new Event("change", { bubbles: true }));
  expect(session.source).toBe(source);
  expect(session.statusLevel, session.status).toBe("info");
  return session;
}

function fill(session: WatershedSession, label: string, value: string) {
  const input = session.dialog!.body.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  )!;
  expect(input.disabled).toBe(false);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function click(session: WatershedSession, title: string) {
  const button = Array.from(
    session.dialog!.footer.querySelectorAll("button"),
  ).find((button) => button.textContent === title)!;
  expect(button.disabled).toBe(false);
  button.click();
}

function setRoi(
  session: WatershedSession,
  lower: number[],
  channels: number[],
) {
  fill(session, "ROI lower X Y Z", lower.join(", "));
  fill(session, "ROI size X Y Z", "4, 3, 2");
  fill(session, "Channels for −X −Y −Z", channels.join(", "));
  fill(session, "High threshold", "1");
  fill(session, "Low threshold", "0");
  fill(session, "Size threshold", "0");
  fill(session, "Dust threshold", "0");
}

async function runFromDialog(session: WatershedSession) {
  click(session, "Run watershed");
  // A cold browser must also compile/load both real worker module graphs.
  await expect.poll(() => session.busy, { timeout: 60_000 }).toBe(false);
  expect(session.statusLevel, session.status).toBe("info");
  expect(session.status).toContain("Completed:");
  const result = session.viewer.layerManager.managedLayers.find(
    (layer) => layer.layer instanceof SegmentationUserLayer,
  )!;
  expect(result).toBeDefined();
  expect(result.isReady()).toBe(true);
  return result;
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

/** Download the published segmentation through the actual chunk worker. */
async function checkResult(
  result: ManagedUserLayer,
  offsetXYZ: number[],
  spacingXYZ: number[],
) {
  const segmentation = result.layer as SegmentationUserLayer;
  expect(segmentation.displayState.hasVolume.value).toBe(true);
  const renderLayer = segmentation.renderLayers.find(
    (r): r is SliceViewVolumeRenderLayer =>
      r instanceof SliceViewVolumeRenderLayer,
  )!;
  expect(renderLayer).toBeDefined();
  const volume = renderLayer.multiscaleSource;
  expect(volume.rank).toBe(3);
  expect(volume.volumeType).toBe(VolumeType.SEGMENTATION);
  expect(volume.dataType).toBe(DataType.UINT32);
  const loadState = segmentation.dataSources[0].loadState;
  if (loadState === undefined || loadState.error !== undefined) {
    throw new Error("Segmentation datasource did not load successfully");
  }
  const { dataSource } = loadState;
  expect(dataSource.canonicalUrl).toMatch(/^watershed:\/\/[a-f0-9]+$/);
  const { modelTransform } = dataSource;
  expect([...modelTransform.inputSpace.bounds.lowerBounds]).toEqual([0, 0, 0]);
  expect([...modelTransform.inputSpace.bounds.upperBounds]).toEqual([4, 3, 2]);
  expect(modelTransform.outputSpace.names).toEqual(["x", "y", "z"]);
  expect(modelTransform.outputSpace.units).toEqual(["m", "m", "m"]);
  expect([...modelTransform.outputSpace.scales]).toEqual(spacingXYZ);
  const expectedTransform = matrix.createIdentity(Float64Array, 4);
  expectedTransform.set(offsetXYZ, 12);
  expect(modelTransform.transform).toEqual(expectedTransform);

  const sources = volume.getSources(sourceOptions);
  try {
    const { chunkSource, chunkToMultiscaleTransform } = sources[0][0];
    expect(chunkToMultiscaleTransform).toEqual(
      matrix.createIdentity(Float32Array, 4),
    );
    expect([...chunkSource.spec.baseVoxelOffset]).toEqual([0, 0, 0]);
    const labels = await chunkSource.fetchChunk(
      Float32Array.of(0, 0, 0),
      (chunk) => {
        expect(chunk).toBeInstanceOf(UncompressedVolumeChunk);
        expect((chunk as UncompressedVolumeChunk).data).toBeInstanceOf(
          Uint32Array,
        );
        const values: number[] = [];
        for (let z = 0; z < 2; ++z)
          for (let y = 0; y < 3; ++y)
            for (let x = 0; x < 4; ++x)
              values.push(
                chunkSource.getValueAt(Float32Array.of(x, y, z), scalarAccess),
              );
        return values;
      },
      { signal: new AbortController().signal },
    );
    const [left, right] = [labels[0], labels[2]];
    expect(left).toBeGreaterThan(0);
    expect(right).toBeGreaterThan(0);
    expect(left).not.toBe(right);
    // All voxels, not just one sample, are two coherent components at x=2.
    expect(labels).toEqual(
      Array.from({ length: 24 }, (_, i) => (i % 4 < 2 ? left : right)),
    );

    // Also sample through the displayed layer's global-to-chunk transform.
    // Viewer coordinates need not use the output's native voxel spacing.
    const global = result.manager.root.coordinateSpace.value;
    const worldPosition = (xyz: number[]) =>
      Float32Array.from(global.names, (name, d) => {
        const axis = ["x", "y", "z"].indexOf(name);
        return axis === -1
          ? 0
          : ((offsetXYZ[axis] + xyz[axis]) * spacingXYZ[axis]) /
              global.scales[d];
      });
    await expect
      .poll(() => renderLayer.visibleSourcesList.length)
      .toBeGreaterThan(0);
    for (let z = 0; z < 2; ++z)
      for (let y = 0; y < 3; ++y)
        for (let x = 0; x < 4; ++x)
          expect(
            renderLayer.getValueAt(worldPosition([x + 0.5, y + 0.5, z + 0.5])),
          ).toBe(labels[(z * 3 + y) * 4 + x]);
    expect(renderLayer.getValueAt(worldPosition([-0.5, 0.5, 0.5]))).toBeNull();
    expect(renderLayer.getValueAt(worldPosition([4.5, 0.5, 0.5]))).toBeNull();
    return { volume, labels };
  } finally {
    for (const alternatives of sources)
      for (const { chunkSource } of alternatives) chunkSource.dispose();
  }
}

describe("watershed browser integration (real WebGL and workers)", () => {
  it("segments a static HTTP precomputed affinity ROI with native offsets and uint8 channel mapping", async () => {
    const base = "https://watershed-integration.invalid/affinities";
    const chunks: string[] = [];
    const wasmRequests: string[] = [];
    (await server()).use(
      http.get(/abiss_watershed\.wasm(?:\?|$)/, ({ request }) => {
        wasmRequests.push(request.url);
        return passthrough();
      }),
      http.get(`${base}/info`, () =>
        HttpResponse.json({
          "@type": "neuroglancer_multiscale_volume",
          type: "image",
          data_type: "uint8",
          num_channels: 4,
          scales: [
            {
              key: "raw",
              resolution: [10, 20, 30],
              voxel_offset: [10, 20, -3],
              size: [6, 5, 4],
              chunk_sizes: [[3, 3, 2]],
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
        const data = new Uint8Array((x1 - x0) * (y1 - y0) * (z1 - z0) * 4);
        let i = 0;
        for (let c = 0; c < 4; ++c)
          for (let z = z0; z < z1; ++z)
            for (let y = y0; y < y1; ++y)
              for (let x = x0; x < x1; ++x)
                data[i++] = c === 2 && x === 13 ? 0 : 255;
        return new HttpResponse(data.buffer, {
          headers: { "Content-Type": "application/octet-stream" },
        });
      }),
    );
    const viewer = makeViewer();
    viewer.coordinateSpace.restoreState({
      x: [5e-9, "m"],
      y: [10e-9, "m"],
      z: [15e-9, "m"],
    });
    const image = await addImage(viewer, `precomputed://${base}`);
    const session = openWatershed(viewer, image);
    expect(session.metadata?.lowerBoundXYZ).toEqual([0, 0, 0]);
    expect(session.metadata?.upperBoundXYZ).toEqual([6, 5, 4]);
    setRoi(session, [1, 1, 1], [2, 0, 3]);
    const result = await runFromDialog(session);
    const { volume } = await checkResult(
      result,
      [11, 21, -2],
      [1e-8, 2e-8, 3e-8],
    );
    expect(new Set(chunks)).toEqual(
      new Set([
        "10-13_20-23_-3--1",
        "13-16_20-23_-3--1",
        "10-13_23-25_-3--1",
        "13-16_23-25_-3--1",
        "10-13_20-23_-1-1",
        "13-16_20-23_-1-1",
        "10-13_23-25_-1-1",
        "13-16_23-25_-1-1",
      ]),
    );
    // The real async-computation worker fetched the checked-in native binary.
    expect(wasmRequests.length).toBeGreaterThan(0);
    deleteLayer(result);
    expect(() => volume.getSources(sourceOptions)).toThrow(
      /unavailable.*Rerun watershed/,
    );
    expect(viewer.layerManager.managedLayers).toEqual([image]);
  }, 90_000);

  it("fetches inference:// live tiles across a boundary, aligns output, and discards a cancelled late tile", async () => {
    const viewer = makeViewer();
    const geometry = makeModelGeometry(
      {
        inputShape: [1, 1, 16, 128, 128],
        outputShape: [1, 4, 48, 128, 128],
      },
      [45, 16, 16],
      [15, 16, 16],
    );
    const input = {
      originZYX: [3, 7, 11],
      shapeZYX: [40, 256, 256],
      spacingZYX: [45, 16, 16],
      axisNamesZYX: ["z", "y", "x"],
      unitsZYX: ["nm", "nm", "nm"],
      signal: new AbortController().signal,
      assertValid() {},
      dispose() {},
    } as unknown as PreparedInferenceInput;
    const run = vi.fn<OnnxInferenceController["run"]>(() => {
      throw new Error(
        "This fixture must not load or run an expensive ONNX model",
      );
    });
    const live = new LiveInference(
      { run, cancel() {} },
      input,
      undefined,
      geometry,
    );
    let releaseLate!: () => void;
    let lateReturned = false;
    const late = new Promise<void>((resolve) => {
      releaseLate = resolve;
    });
    cleanup.push(releaseLate);
    // Only model evaluation is deterministic/fake. Publication, inference://
    // lookup, chunk download and both directions of worker tile RPC are real.
    const readTile = vi
      .spyOn(live, "readTile")
      .mockImplementation(async (grid) => {
        if (grid[2] === 2) {
          await late; // Intentionally ignore cancellation to exercise late discard.
          lateReturned = true;
        }
        const data = new Float32Array(4 * 16 * 60 * 60).fill(1);
        for (let z = 0; z < 16; ++z)
          for (let y = 0; y < 60; ++y)
            for (let x = 0; x < 60; ++x)
              if (grid[2] * 60 + x === 60) data[(z * 60 + y) * 60 + x] = 0;
        return data;
      });
    const publication = await publishLiveInference(viewer.chunkManager, live);
    cleanup.push(() => publication.dispose());
    const image = await addImage(viewer, publication.url);
    const session = openWatershed(viewer, image);
    expect(session.metadata?.upperBoundXYZ).toEqual([180, 180, 96]);
    setRoi(session, [58, 1, 1], [0, 1, 2]);
    const result = await runFromDialog(session);
    const { volume } = await checkResult(
      result,
      [85, 24, 15],
      [16e-9, 16e-9, 15e-9],
    );
    expect(readTile.mock.calls.map(([grid]) => [...grid])).toEqual([
      [0, 0, 0],
      [0, 0, 1],
    ]);
    expect(run).not.toHaveBeenCalled();
    deleteLayer(result);
    expect(() => volume.getSources(sourceOptions)).toThrow(
      /unavailable.*Rerun watershed/,
    );

    setRoi(session, [118, 1, 1], [0, 1, 2]);
    click(session, "Run watershed");
    await expect.poll(() => readTile.mock.calls.length).toBe(3);
    const [grid, signal] = readTile.mock.calls[2];
    expect([...grid]).toEqual([0, 0, 2]);
    expect(signal.aborted).toBe(false);
    click(session, "Cancel");
    await expect.poll(() => signal.aborted).toBe(true);
    expect(session.busy).toBe(false);
    expect(session.status).toContain("Cancelled; results discarded");
    releaseLate();
    await expect.poll(() => lateReturned).toBe(true);
    expect(viewer.layerManager.managedLayers).toEqual([image]);
    expect(session.status).toContain("Cancelled; results discarded");
  }, 90_000);
});
