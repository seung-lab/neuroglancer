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

import { describe, expect, it, vi } from "vitest";
import { OnnxInferenceController } from "#src/inference/controller.js";
import { getRetainedOutputShape } from "#src/inference/geometry.js";
import type { PreparedInferenceInput } from "#src/inference/input.js";
import { LiveInference, makeLiveInferenceInfo } from "#src/inference/live.js";
import type {
  InferenceWorkerRequest,
  InferenceWorkerResponse,
  ModelMetadata,
} from "#src/inference/model.js";
import { makeModelGeometry } from "#src/inference/model.js";

/** Deterministic worker double, with the real controller's reads/transfers/crop stitching. */
class TileWorker {
  constructor(private readonly dynamicChannels?: number) {}
  onmessage: ((event: { data: InferenceWorkerResponse }) => void) | null = null;
  onerror = null;
  hold = false;
  contextBias = false;
  held: (() => void) | undefined;
  terminated = false;
  metadata!: ModelMetadata;
  postMessage(message: InferenceWorkerRequest, transfer: Transferable[]) {
    const request = structuredClone(message, { transfer });
    const respond = () => {
      if (request.kind === "load") {
        this.metadata = {
          inputNames: ["input"],
          outputNames: ["output"],
          inputShape:
            this.dynamicChannels === undefined
              ? [1, 1, 20, 80, 80]
              : [1, 1, 16, 128, 128],
          outputShape:
            this.dynamicChannels === undefined
              ? [1, 4, 20, 80, 80]
              : [1, this.dynamicChannels, 48, 128, 128],
          initMs: 0,
          threads: 1,
          requestedProvider: request.provider,
          actualProvider: "wasm",
        };
        this.onmessage?.({
          data: {
            id: request.id,
            kind: "loaded",
            metadata: this.metadata,
          },
        });
      } else {
        let output = new Float32Array(4 * 16 * 60 * 60);
        const bias = this.contextBias ? request.input[0] : 0;
        let i = 0;
        for (let c = 0; c < 4; ++c)
          for (let z = 2; z < 18; ++z)
            for (let y = 10; y < 70; ++y)
              for (let x = 10; x < 70; ++x)
                output[i++] =
                  request.input[(z * 80 + y) * 80 + x] +
                  c * 1e6 +
                  bias * (c + 1);
        if (this.dynamicChannels !== undefined) {
          const voxels = getRetainedOutputShape(request.geometry).reduce(
            (a, b) => a * b,
            1,
          );
          output = new Float32Array(voxels * this.dynamicChannels);
          for (let c = 0; c < this.dynamicChannels; ++c)
            output.fill(c + 1, c * voxels, (c + 1) * voxels);
        }
        this.onmessage?.({
          data: {
            id: request.id,
            kind: "output",
            output,
            runMs: 0,
            metadata: this.metadata,
          },
        });
      }
    };
    if (request.kind === "run" && this.hold) this.held = respond;
    else queueMicrotask(respond);
  }
  terminate() {
    this.terminated = true;
  }
}
async function fixture(dynamicChannels?: number, overlap = true) {
  const invalidation = new AbortController();
  const source: PreparedInferenceInput = {
    originZYX: [-7, 101, 203],
    shapeZYX: [53, 201, 261],
    spacingZYX:
      dynamicChannels === undefined ? [40e-9, 16e-9, 16e-9] : [45, 16, 16],
    axisNamesZYX: ["z", "y", "x"],
    unitsZYX:
      dynamicChannels === undefined ? ["m", "m", "m"] : ["nm", "nm", "nm"],
    validitySnapshot: {} as PreparedInferenceInput["validitySnapshot"],
    signal: invalidation.signal,
    isValid: () => !invalidation.signal.aborted,
    assertValid: () => invalidation.signal.throwIfAborted(),
    dispose: () => invalidation.abort(),
    readPatch: vi.fn(async (origin, shape, signal) => {
      signal.throwIfAborted();
      const data = new Float32Array(shape[0] * shape[1] * shape[2]);
      let i = 0;
      for (let z = 0; z < shape[0]; ++z)
        for (let y = 0; y < shape[1]; ++y)
          for (let x = 0; x < shape[2]; ++x)
            data[i++] =
              (origin[0] + z) * 10000 + (origin[1] + y) * 100 + origin[2] + x;
      return data;
    }),
  };
  const workers: TileWorker[] = [];
  const controller = new OnnxInferenceController(() => {
    const worker = new TileWorker(dynamicChannels);
    workers.push(worker);
    return worker as unknown as Worker;
  });
  const metadata = await controller.loadModel(
    {
      name: "local.onnx",
      size: 1,
      arrayBuffer: async () => new ArrayBuffer(1),
    } as File,
    "cpu",
  );
  const onError = vi.fn();
  const geometry =
    dynamicChannels === undefined
      ? undefined
      : makeModelGeometry(metadata, [45, 16, 16], [15, 16, 16]);
  const live = new LiveInference(
    controller,
    source,
    onError,
    geometry,
    overlap,
  );
  return { source, controller, workers, live, onError, geometry };
}
const signal = () => new AbortController().signal;

// Independent raw bump oracle: translated denominators cancel between these
// contributors (retained shape is smaller than twice the output stride).
function referenceBump(z: number, y: number, x: number) {
  const bump = (p: number[]) =>
    Math.exp(
      p.reduce((sum, v, axis) => {
        const u = (2 * (v + 1)) / ([16, 60, 60][axis] + 1) - 1;
        return sum - 1 / (1 - u * u);
      }, 0),
    );
  const minimum = bump([0, 0, 0]);
  return (
    1 + ((bump([z, y, x]) - minimum) * 999999) / (bump([7, 29, 29]) - minimum)
  );
}

describe("live globally anchored inference", () => {
  it("directly publishes exact context-dependent values at adjacent and final source-anchored chunks", async () => {
    const { source, controller, workers, live } = await fixture(
      undefined,
      false,
    );
    workers[0].contextBias = true;
    expect(live.info.originZYX).toEqual([-5, 111, 213]);
    expect(live.info.shapeZYX).toEqual([48, 180, 240]);
    expect(JSON.parse(live.info.provenanceJson)).toMatchObject({
      blending: { method: "none", inputStrideZYX: [16, 60, 60] },
    });
    for (const grid of [
      [0, 0, 0],
      [0, 0, 1],
      [2, 2, 3],
    ] as const) {
      const data = await live.readTile(grid, signal());
      const origin = grid.map(
        (v, axis) => source.originZYX[axis] + v * [16, 60, 60][axis],
      );
      expect(vi.mocked(source.readPatch).mock.lastCall![0]).toEqual(origin);
      const bias = origin[0] * 10000 + origin[1] * 100 + origin[2];
      let i = 0;
      for (let c = 0; c < 4; ++c)
        for (let z = 0; z < 16; ++z)
          for (let y = 0; y < 60; ++y)
            for (let x = 0; x < 60; ++x) {
              const value =
                (origin[0] + z + 2) * 10000 +
                (origin[1] + y + 10) * 100 +
                origin[2] +
                x +
                10 +
                c * 1e6 +
                bias * (c + 1);
              if (data[i++] !== Math.fround(value))
                throw new Error(
                  `Live direct mismatch at ${[...grid, c, z, y, x]}`,
                );
            }
      expect(
        origin.every(
          (v, axis) =>
            v >= source.originZYX[axis] &&
            v + [20, 80, 80][axis] <=
              source.originZYX[axis] + source.shapeZYX[axis],
        ),
      ).toBe(true);
    }
    expect(source.readPatch).toHaveBeenCalledTimes(3);
    await live.readTile([0, 0, 0], signal());
    expect(source.readPatch).toHaveBeenCalledTimes(3);
    live.dispose();
    controller.dispose();
  });
  it("streams a bounded tile from the full img_jxl extent without sizing a whole-volume tensor", async () => {
    const { source, controller, live, geometry } = await fixture(1);
    live.dispose();
    const largeSource = {
      ...source,
      originZYX: [0, 0, 0],
      shapeZYX: [9949, 327680, 327680],
    };
    const largeLive = new LiveInference(
      controller,
      largeSource,
      undefined,
      geometry,
    );
    try {
      expect(largeLive.info.shapeZYX).toEqual([29808, 327600, 327600]);
      expect(largeLive.info.originZYX).toEqual([5, 16, 16]);
      expect(
        largeLive.info.shapeZYX.reduce((a, b) => a * b, 4),
      ).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
      expect(largeLive.info.byteLength).toBeLessThan(4096);
      expect(source.readPatch).not.toHaveBeenCalled();
      const data = await largeLive.readTile([500, 2000, 3000], signal());
      expect(data).toHaveLength(16 * 60 * 60);
      expect(data.every((x) => x === 1)).toBe(true);
      expect(source.readPatch).toHaveBeenCalled();
      expect(
        vi
          .mocked(source.readPatch)
          .mock.calls.every(([, shape]) => shape.join() === "16,128,128"),
      ).toBe(true);
    } finally {
      largeLive.dispose();
      controller.dispose();
    }
  });
  it.each(
    [1, 3].flatMap((channels) =>
      [true, false].map((overlap) => ({ channels, overlap })),
    ),
  )(
    "publishes C=$channels overlap=$overlap geometry but keeps 16x60x60 display chunks and forwards it to every run",
    async ({ channels, overlap }) => {
      const { source, controller, live, geometry } = await fixture(
        channels,
        overlap,
      );
      const run = vi.spyOn(controller, "run");
      expect(live.info.channels).toBe(channels);
      expect(live.info.originZYX).toEqual([-16, 117, 219]);
      expect(live.info.spacingZYX).toEqual([15, 16, 16]);
      expect(live.info.shapeZYX).toEqual(
        overlap ? [128, 120, 180] : [144, 60, 180],
      );
      expect(
        live.info.originZYX.map((x, i) => x * live.info.spacingZYX[i]),
      ).toEqual([-240, 1872, 3504]);
      expect(JSON.parse(live.info.provenanceJson)).toMatchObject({
        geometry,
        blending: {
          method: overlap ? "wu" : "none",
          inputStrideZYX: overlap ? [8, 64, 64] : [12, 96, 96],
          retainedOutputShapeZYX: [36, 96, 96],
        },
      });
      const data = await live.readTile([1, 0, 1], signal());
      expect(data).toHaveLength(16 * 60 * 60 * channels);
      for (let c = 0; c < channels; ++c)
        expect(
          data
            .subarray(c * 16 * 60 * 60, (c + 1) * 16 * 60 * 60)
            .every((x) => x === c + 1),
        ).toBe(true);
      expect(run.mock.calls[0][1]).toMatchObject({
        geometry,
        overlap,
        originZYX: [0, 117, 279],
        shapeZYX: [16, 60, 60],
      });
      expect(
        vi
          .mocked(source.readPatch)
          .mock.calls.every(([, shape]) => shape.join() === "16,128,128"),
      ).toBe(true);
      expect(() =>
        makeLiveInferenceInfo(
          { ...source, spacingZYX: [40, 16, 16] },
          geometry,
        ),
      ).toThrow("spacing must match");
      live.dispose();
      controller.dispose();
    },
  );
  it("publishes metadata only and reads contributing full contexts; fixed physical origins and all channels", async () => {
    const { source, controller, live } = await fixture();
    expect(source.readPatch).not.toHaveBeenCalled();
    expect(live.info.shapeZYX).toEqual([32, 180, 180]);
    expect(JSON.parse(live.info.provenanceJson).blending).toEqual({
      method: "wu",
      inputStrideZYX: [10, 40, 40],
      retainedOutputShapeZYX: [16, 60, 60],
    });
    expect(live.info.originZYX).toEqual([-5, 111, 213]);
    expect(live.info.spacingZYX).toEqual([40e-9, 16e-9, 16e-9]);
    expect(live.info.byteLength).toBeLessThan(4096);
    const [a, duplicate] = await Promise.all([
      live.readTile([1, 2, 2], signal()),
      live.readTile([1, 2, 2], signal()),
    ]);
    expect(a).toBe(duplicate);
    expect(source.readPatch).toHaveBeenCalledTimes(18);
    expect(source.readPatch).toHaveBeenLastCalledWith(
      [23, 221, 363],
      [20, 80, 80],
      expect.any(AbortSignal),
    );
    let i = 0;
    for (let c = 0; c < 4; ++c)
      for (let z = 11; z < 27; ++z)
        for (let y = 231; y < 291; ++y)
          for (let x = 333; x < 393; ++x)
            expect(a[i++]).toBe(z * 10000 + y * 100 + x + c * 1e6);
    await live.readTile([0, 0, 0], signal());
    expect(source.readPatch).toHaveBeenLastCalledWith(
      [3, 141, 243],
      [20, 80, 80],
      expect.any(AbortSignal),
    );
    expect(source.readPatch).toHaveBeenCalledTimes(26);
    // Live has no private result cache; the controller reuses bounded cropped patches.
    expect(await live.readTile([1, 2, 2], signal())).toEqual(a);
    expect(source.readPatch).toHaveBeenCalledTimes(26);
    expect(source.readPatch).toHaveBeenLastCalledWith(
      [3, 141, 243],
      [20, 80, 80],
      expect.any(AbortSignal),
    );
    await expect(live.readTile([2, 0, 0], signal())).rejects.toThrow(
      "valid domain",
    );
    live.dispose();
    controller.dispose();
  });

  it("matches a combined ROI across adjacent live chunks with every globally anchored context contribution", async () => {
    const { source, controller, workers, live } = await fixture();
    workers[0].contextBias = true;
    const left = await live.readTile([1, 2, 1], signal());
    const right = await live.readTile([1, 2, 2], signal());
    // Published high bounds are [27,291,393], but valid retained crops reach
    // [41,291,433]. Those contexts must still contribute to the boundary.
    expect(source.readPatch).toHaveBeenCalledWith(
      [23, 221, 363],
      [20, 80, 80],
      expect.any(AbortSignal),
    );
    const combined = await controller.run(source, {
      originZYX: [11, 231, 273],
      shapeZYX: [16, 60, 120],
    });
    const concatenated = new Float32Array(4 * 16 * 60 * 120);
    for (let c = 0; c < 4; ++c)
      for (let z = 0; z < 16; ++z)
        for (let y = 0; y < 60; ++y) {
          const row = (c * 16 + z) * 60 + y;
          concatenated.set(left.subarray(row * 60, (row + 1) * 60), row * 120);
          concatenated.set(
            right.subarray(row * 60, (row + 1) * 60),
            row * 120 + 60,
          );
        }
    expect(concatenated).toEqual(combined.data);
    // Independent Wu-weighted oracle across every voxel/channel, including
    // clipped dataset edges and contexts beyond the published live domain.
    let i = 0;
    for (let c = 0; c < 4; ++c)
      for (let z = 11; z < 27; ++z)
        for (let y = 231; y < 291; ++y)
          for (let x = 333; x < 393; ++x) {
            let totalWeight = 0;
            let weightedBias = 0;
            for (let iz = -7; iz <= 26; iz += 10)
              for (let iy = 101; iy <= 222; iy += 40)
                for (let ix = 203; ix <= 384; ix += 40) {
                  const p = [z - iz - 2, y - iy - 10, x - ix - 10];
                  if (!p.every((v, axis) => v >= 0 && v < [16, 60, 60][axis]))
                    continue;
                  const weight = referenceBump(p[0], p[1], p[2]);
                  weightedBias += weight * (iz * 10000 + iy * 100 + ix);
                  totalWeight += weight;
                }
            const expected =
              z * 10000 +
              y * 100 +
              x +
              c * 1e6 +
              (weightedBias / totalWeight) * (c + 1);
            // Float32 online means round after each contributing context.
            expect(Math.abs(right[i++] - expected)).toBeLessThan(1);
          }
    live.dispose();
    controller.dispose();
  });

  it.each([true, false])(
    "drops obsolete queued requests, deduplicates consumers, and never submits a worker FIFO (overlap=%s)",
    async (overlap) => {
      const { source, controller, workers, live, onError } = await fixture(
        undefined,
        overlap,
      );
      workers[0].hold = true;
      const keep = new AbortController(),
        drop = new AbortController();
      const active = live.readTile([0, 0, 0], keep.signal);
      const duplicate = live.readTile([0, 0, 0], signal());
      const obsolete = live.readTile([0, 0, 1], drop.signal);
      const canceled = expect(obsolete).rejects.toThrow("gone");
      drop.abort(new Error("gone"));
      keep.abort(new Error("only this subscriber"));
      const activeCanceled = expect(active).rejects.toThrow(
        "only this subscriber",
      );
      await vi.waitFor(() => expect(workers[0].held).toBeTypeOf("function"));
      expect(source.readPatch).toHaveBeenCalledTimes(1);
      workers[0].hold = false;
      workers[0].held!();
      await Promise.all([duplicate, canceled, activeCanceled]);
      expect(source.readPatch).toHaveBeenCalledTimes(overlap ? 8 : 1);
      expect(workers[0].terminated).toBe(false);
      expect(onError).not.toHaveBeenCalled();
      live.dispose();
      controller.dispose();
    },
  );

  it.each([true, false])(
    "aborts an active read and allows the same tile to be requested again without a cached failure (overlap=%s)",
    async (overlap) => {
      const { source, controller, live, onError } = await fixture(
        undefined,
        overlap,
      );
      source.readPatch = vi.fn(
        (_origin, _shape, signal) =>
          new Promise<Float32Array>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      );
      const abort = new AbortController();
      const first = live.readTile([0, 0, 0], abort.signal);
      const rejected = expect(first).rejects.toThrow("obsolete");
      const readSignal = vi.mocked(source.readPatch).mock.calls[0][2];
      abort.abort(new Error("obsolete"));
      expect(readSignal.aborted).toBe(true);
      await rejected;
      source.readPatch = vi.fn(async () => new Float32Array(20 * 80 * 80));
      const next = await live.readTile([0, 0, 0], signal());
      expect(next.length).toBe(4 * 16 * 60 * 60);
      expect(onError).not.toHaveBeenCalled();
      live.dispose();
      controller.dispose();
    },
  );

  it.each([true, false])(
    "source invalidation rejects queued and active work and ignores late worker output (overlap=%s)",
    async (overlap) => {
      const { source, controller, workers, live, onError } = await fixture(
        undefined,
        overlap,
      );
      workers[0].hold = true;
      const a = live.readTile([0, 0, 0], signal()),
        b = live.readTile([0, 0, 1], signal());
      const rejected = [
        expect(a).rejects.toThrow("stopped"),
        expect(b).rejects.toThrow("stopped"),
      ];
      await vi.waitFor(() => expect(workers[0].held).toBeTypeOf("function"));
      source.dispose();
      workers[0].held!();
      await Promise.all(rejected);
      expect(workers[0].terminated).toBe(true);
      expect(source.readPatch).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledTimes(1);
      await expect(live.readTile([0, 0, 0], signal())).rejects.toThrow(
        "stopped",
      );
      live.dispose();
      controller.dispose();
    },
  );

  it("bounds queued work for a huge virtual domain and reports exhaustion visibly", async () => {
    const { source, controller, live: previous, onError } = await fixture();
    previous.dispose();
    source.shapeZYX[2] = 16_000_000;
    source.readPatch = vi.fn(
      (_origin, _shape, signal) =>
        new Promise<Float32Array>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const live = new LiveInference(controller, source, onError);
    expect(live.info.byteLength).toBeLessThan(4096);
    const jobs = Array.from({ length: 128 }, (_, x) =>
      live.readTile([0, 0, x], signal()),
    );
    const settled = Promise.allSettled(jobs);
    await expect(live.readTile([0, 0, 128], signal())).rejects.toThrow(
      "Too many pending",
    );
    expect(onError).toHaveBeenCalledOnce();
    expect(source.readPatch).toHaveBeenCalledOnce();
    live.dispose();
    expect((await settled).every((x) => x.status === "rejected")).toBe(true);
    controller.dispose();
  });

  it("reports real model/read failures and rejects small domains", async () => {
    const { source, controller, live, onError } = await fixture();
    source.readPatch = vi.fn(async () => {
      throw new Error("read failure");
    });
    await expect(live.readTile([0, 0, 0], signal())).rejects.toThrow(
      "read failure",
    );
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "read failure" }),
    );
    expect(() =>
      makeLiveInferenceInfo({ ...source, shapeZYX: [19, 80, 80] }),
    ).toThrow("smaller");
    live.dispose();
    controller.dispose();
  });
});
