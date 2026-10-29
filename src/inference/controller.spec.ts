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

import { afterEach, describe, expect, it, vi } from "vitest";
import { OnnxInferenceController } from "#src/inference/controller.js";
import * as geometry from "#src/inference/geometry.js";
import { getRetainedOutputShape } from "#src/inference/geometry.js";
import type { PreparedInferenceInput } from "#src/inference/input.js";
import type {
  InferenceWorkerRequest,
  InferenceWorkerResponse,
  ModelMetadata,
} from "#src/inference/model.js";
import { makeModelGeometry } from "#src/inference/model.js";

class FakeWorker {
  constructor(
    readonly modelShapes?: Pick<ModelMetadata, "inputShape" | "outputShape">,
  ) {}
  onmessage: ((event: { data: InferenceWorkerResponse }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  terminated = false;
  loads = 0;
  requestedProviders: string[] = [];
  loadRequests: Extract<InferenceWorkerRequest, { kind: "load" }>[] = [];
  metadata!: ModelMetadata;
  runs = 0;
  patchOriginBias = false;
  outputFailure: "error" | "short" | "nan" | "infinity" | undefined;
  hold = false;
  held: (() => void) | undefined;
  postMessage(message: InferenceWorkerRequest, transfer: Transferable[]) {
    const request = structuredClone(message, { transfer });
    const respond = () => {
      if (request.kind === "load") {
        ++this.loads;
        this.requestedProviders.push(request.provider);
        this.loadRequests.push(request);
        this.metadata = {
          inputNames: ["input"],
          outputNames: ["output"],
          inputShape: [1, 1, 20, 80, 80],
          outputShape: [1, 4, 20, 80, 80],
          ...this.modelShapes,
          initMs: 1,
          threads: 1,
          requestedProvider: request.provider,
          ...(request.precision === undefined
            ? {}
            : {
                requestedPrecision: request.precision,
                actualPrecision:
                  request.provider === "webgpu" ? request.precision : "float32",
              }),
          ...(request.compatibilityFixes === undefined
            ? {}
            : { compatibilityFixes: request.compatibilityFixes }),
          actualProvider: request.provider === "webgpu" ? "webgpu" : "wasm",
        };
        this.onmessage?.({
          data: {
            id: request.id,
            kind: "loaded",
            metadata: this.metadata,
          },
        });
      } else {
        ++this.runs;
        if (this.outputFailure === "error") {
          this.onmessage?.({
            data: {
              id: request.id,
              kind: "error",
              message: "execution failed",
            },
          });
          return;
        }
        let output = new Float32Array(4 * 16 * 60 * 60);
        for (let c = 0; c < 4; ++c) {
          let target = c * 16 * 60 * 60;
          for (let z = 2; z < 18; ++z)
            for (let y = 10; y < 70; ++y)
              for (let x = 10; x < 70; ++x) {
                output[target++] =
                  request.input[(z * 80 + y) * 80 + x] +
                  c * 1e6 +
                  (this.patchOriginBias ? request.input[0] * (c + 1) : 0);
              }
        }
        if (this.modelShapes !== undefined) {
          const voxels = getRetainedOutputShape(request.geometry).reduce(
            (a, b) => a * b,
            1,
          );
          output = new Float32Array(voxels * request.geometry.outputChannels);
          for (let c = 0; c < request.geometry.outputChannels; ++c)
            output.fill(
              c + 1 + (this.patchOriginBias ? request.input[0] * (c + 1) : 0),
              c * voxels,
              (c + 1) * voxels,
            );
        }
        if (this.outputFailure === "short") output = output.slice(1);
        if (this.outputFailure === "nan") output[output.length - 1] = NaN;
        if (this.outputFailure === "infinity")
          output[output.length - 1] = Infinity;
        this.onmessage?.({
          data: {
            id: request.id,
            kind: "output",
            output,
            runMs: 1,
            metadata: structuredClone(this.metadata),
          },
        });
      }
    };
    if (this.hold && request.kind === "run") this.held = respond;
    else queueMicrotask(respond);
  }
  terminate() {
    this.terminated = true;
  }
}

function input() {
  let valid = true;
  const patches: Float32Array[] = [];
  const origins: number[][] = [];
  const source = {
    originZYX: [0, 0, 0],
    shapeZYX: [100, 240, 240],
    spacingZYX: [40, 16, 16],
    axisNamesZYX: ["z", "y", "x"],
    unitsZYX: ["m", "m", "m"],
    isValid: () => valid,
    assertValid() {
      if (!valid) throw new Error("changed");
    },
    validitySnapshot: {} as PreparedInferenceInput["validitySnapshot"],
    dispose() {
      valid = false;
    },
    async readPatch(
      origin: readonly number[],
      shape: readonly number[],
      signal: AbortSignal,
    ) {
      signal.throwIfAborted();
      const result = new Float32Array(shape[0] * shape[1] * shape[2]);
      let i = 0;
      for (let z = 0; z < shape[0]; ++z)
        for (let y = 0; y < shape[1]; ++y)
          for (let x = 0; x < shape[2]; ++x) {
            result[i++] =
              (origin[0] + z) * 10000 + (origin[1] + y) * 100 + origin[2] + x;
          }
      patches.push(result);
      origins.push([...origin]);
      return result;
    },
  } satisfies PreparedInferenceInput;
  return { source, patches, origins };
}

function setup(
  patchCacheBudget?: number,
  modelShapes?: Pick<ModelMetadata, "inputShape" | "outputShape">,
) {
  const workers: FakeWorker[] = [];
  const controller = new OnnxInferenceController(() => {
    const worker = new FakeWorker(modelShapes);
    workers.push(worker);
    return worker as unknown as Worker;
  }, patchCacheBudget);
  const file = {
    name: "local.onnx",
    size: 1,
    arrayBuffer: async () => new ArrayBuffer(1),
  } as File;
  return { controller, workers, file };
}

// Analytic raw Wu bump oracle. For this <2-stride retained shape, all
// contributors at a voxel share the same translated normalization denominator.
function referenceBump(z: number, y: number, x: number, shape = [16, 60, 60]) {
  const bump = (p: number[]) =>
    Math.exp(
      p.reduce((sum, v, axis) => {
        const u = (2 * (v + 1)) / (shape[axis] + 1) - 1;
        return sum - 1 / (1 - u * u);
      }, 0),
    );
  const minimum = bump([0, 0, 0]);
  return (
    1 +
    ((bump([z, y, x]) - minimum) * 999999) /
      (bump(shape.map((size) => Math.floor((size - 1) / 2))) - minimum)
  );
}

const options = {
  originZYX: [2, 10, 10],
  shapeZYX: [17, 61, 61],
};

describe("OnnxInferenceController", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reuses a Wu mask independently of predictions, source and worker lifecycle", async () => {
    const generate = vi.spyOn(geometry, "makeWuPatchMask");
    const blend = vi.spyOn(geometry, "blendCroppedTile");
    const modelShapes = {
      inputShape: [1, 1, 8, 16, 16],
      outputShape: [1, 3, 8, 16, 16],
    };
    const { controller, workers, file } = setup(0, modelShapes);
    await controller.loadModel(file);
    let { source } = input();
    source.shapeZYX = [24, 48, 48];
    const roi = {
      originZYX: [5, 10, 10],
      shapeZYX: [1, 1, 1],
    };
    await controller.run(source, { ...roi, overlap: false });
    expect(generate).not.toHaveBeenCalled();
    expect(blend).not.toHaveBeenCalled();
    await controller.run(source, roi);
    expect(generate).toHaveBeenCalledExactlyOnceWith([6, 12, 12], [4, 8, 8]);
    const mask = generate.mock.results[0].value as Float32Array;
    const original = mask.slice();
    // A separate live-style ROI still executes predictions with a zero budget.
    const runs = workers[0].runs;
    await controller.run(source, { ...roi, originZYX: [6, 11, 11] });
    expect(workers[0].runs).toBeGreaterThan(runs);
    source = input().source;
    source.shapeZYX = [28, 56, 56];
    source.spacingZYX = [80, 32, 32];
    await controller.run(source, roi);
    const blendedTiles = blend.mock.calls.length;
    await controller.run(source, { ...roi, overlap: false });
    expect(blend).toHaveBeenCalledTimes(blendedTiles);
    await controller.run(source, roi);
    controller.cancel();
    await controller.run(source, roi);
    // Channels, provider and precision do not affect the spatial mask either.
    modelShapes.outputShape = [1, 1, 8, 16, 16];
    await controller.loadModel(file, "webgpu", false, "float16");
    await controller.run(source, roi);
    workers.at(-1)!.outputFailure = "error";
    await expect(controller.run(source, roi)).rejects.toThrow(
      "execution failed",
    );
    workers.at(-1)!.outputFailure = undefined;
    await controller.run(source, roi);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(controller["patchCacheBytes"]).toBe(0);
    expect(mask).toEqual(original); // Neither transferred nor modified by runs.
    controller.dispose();
    expect(controller["wuMaskCache"]).toBeUndefined();
  });

  it("replaces its single Wu mask entry when either retained shape or output stride changes", async () => {
    const generate = vi.spyOn(geometry, "makeWuPatchMask");
    const { controller, file } = setup(0, {
      inputShape: [1, 1, 8, 16, 16],
      outputShape: [1, 3, 8, 16, 16],
    });
    const metadata = await controller.loadModel(file);
    const { source } = input();
    source.shapeZYX = [24, 48, 48];
    const initial = makeModelGeometry(metadata, [40, 16, 16]);
    const changedStride = {
      ...initial,
      outputSpacing: [80, 16, 16] as const,
    };
    const changedShape = { ...initial, cropBefore: [2, 2, 2] as const };
    const roi = {
      originZYX: [5, 10, 10],
      shapeZYX: [1, 1, 1],
    };
    const cases = [
      [initial, [6, 12, 12], [4, 8, 8]],
      [changedStride, [6, 12, 12], [2, 8, 8]],
      [changedShape, [5, 12, 12], [4, 8, 8]],
      [initial, [6, 12, 12], [4, 8, 8]],
    ] as const;
    for (const [index, [geometry, shape, stride]] of cases.entries()) {
      await controller.run(source, { ...roi, geometry });
      expect(generate).toHaveBeenCalledTimes(index + 1);
      expect(generate).toHaveBeenLastCalledWith(shape, stride);
      await controller.run(source, {
        ...roi,
        geometry: structuredClone(geometry),
      });
      expect(generate).toHaveBeenCalledTimes(index + 1);
    }
    controller.dispose();
  });

  it("matches freshly generated masks exactly for contextual channel predictions across adjacent ROIs", async () => {
    const generate = vi.spyOn(geometry, "makeWuPatchMask");
    const modelShapes = {
      inputShape: [1, 1, 8, 16, 16],
      outputShape: [1, 3, 8, 16, 16],
    };
    const cached = setup(0, modelShapes);
    await cached.controller.loadModel(cached.file);
    cached.workers[0].patchOriginBias = true;
    const { source } = input();
    source.shapeZYX = [24, 48, 48];
    for (const [index, z] of [5, 7].entries()) {
      const roi = {
        originZYX: [z, 10, 10],
        shapeZYX: [2, 3, 3],
      };
      const actual = await cached.controller.run(source, roi);
      expect(generate).toHaveBeenCalledTimes(index + 1);
      // A new controller guarantees regeneration, unlike prediction budget=0.
      const fresh = setup(0, modelShapes);
      await fresh.controller.loadModel(fresh.file);
      fresh.workers[0].patchOriginBias = true;
      const expected = await fresh.controller.run(source, roi);
      expect(generate).toHaveBeenCalledTimes(index + 2);
      expect(actual.channels).toBe(3);
      expect(actual.data).toEqual(expected.data);
      expect(new Set(actual.data.subarray(0, 18)).size).toBeGreaterThan(1);
      expect(actual.data[18]).not.toBe(actual.data[0]);
      expect(actual.provenance).toMatchObject({
        completedTiles: index === 0 ? 8 : 4,
      });
      fresh.controller.dispose();
    }
    cached.controller.dispose();
  });

  it("directly stitches source-anchored full retained patches, clips every ROI face and isolates overlap caches", async () => {
    const { controller, workers, file } = setup();
    await controller.loadModel(file);
    workers[0].patchOriginBias = true;
    const { source, origins } = input();
    source.originZYX = [-7, 101, 203];
    source.shapeZYX = [53, 201, 261];
    const roi = {
      originZYX: [-4, 112, 214],
      shapeZYX: [30, 61, 61],
      overlap: false,
    };
    const result = await controller.run(source, roi);
    expect(origins).toHaveLength(8);
    expect(origins[0]).toEqual([-7, 101, 203]);
    expect(origins[7]).toEqual([9, 161, 263]);
    expect(result.provenance).toMatchObject({
      blending: { method: "none", inputStrideZYX: [16, 60, 60] },
    });
    let i = 0;
    for (let c = 0; c < 4; ++c)
      for (let z = -4; z < 26; ++z)
        for (let y = 112; y < 173; ++y)
          for (let x = 214; x < 275; ++x) {
            const iz = -7 + Math.floor((z + 5) / 16) * 16;
            const iy = 101 + Math.floor((y - 111) / 60) * 60;
            const ix = 203 + Math.floor((x - 213) / 60) * 60;
            const bias = iz * 10000 + iy * 100 + ix;
            const expected = Math.fround(
              z * 10000 + y * 100 + x + c * 1e6 + bias * (c + 1),
            );
            if (result.data[i++] !== expected)
              throw new Error(`Direct controller mismatch at ${[c, z, y, x]}`);
          }
    const rerun = await controller.run(source, roi);
    expect(rerun.data).toEqual(result.data);
    expect(workers[0].runs).toBe(8);
    const small = { ...roi, originZYX: [8, 156, 258], shapeZYX: [1, 1, 1] };
    const direct = await controller.run(source, small);
    expect(workers[0].runs).toBe(8);
    const blended = await controller.run(source, { ...small, overlap: true });
    expect(blended.data[0]).not.toBe(direct.data[0]);
    const blendedRuns = workers[0].runs;
    expect(blendedRuns).toBeGreaterThan(8);
    await controller.run(source, small);
    expect(workers[0].runs).toBe(blendedRuns + 1);
    for (const origin of origins)
      expect(
        origin.every(
          (v, axis) =>
            v >= source.originZYX[axis] &&
            v + [20, 80, 80][axis] <=
              source.originZYX[axis] + source.shapeZYX[axis],
        ),
      ).toBe(true);
    controller.dispose();
  });

  it("rejects fractional direct native stride before any patch read", async () => {
    const { controller, file } = setup();
    const metadata = await controller.loadModel(file);
    const { source, origins } = input();
    const geometry = {
      ...makeModelGeometry(metadata, [40, 16, 16]),
      outputSpacing: [40.4, 16, 16] as const,
    };
    await expect(
      controller.run(source, { ...options, geometry, overlap: false }),
    ).rejects.toThrow("Fractional");
    expect(origins).toHaveLength(0);
    controller.dispose();
  });

  it.each(["nan", "infinity"] as const)(
    "rejects %s predictions in direct stitching",
    async (failure) => {
      const { controller, workers, file } = setup();
      await controller.loadModel(file);
      workers[0].outputFailure = failure;
      await expect(
        controller.run(input().source, { ...options, overlap: false }),
      ).rejects.toThrow("finite");
      controller.dispose();
    },
  );
  it.each([1, 3])(
    "infers the 16x128x128 to 48x128x128 C=%i model and reloads before planning",
    async (channels) => {
      const { controller, workers, file } = setup(undefined, {
        inputShape: [1, 1, 16, 128, 128],
        outputShape: [1, channels, 48, 128, 128],
      });
      await controller.loadModel(file);
      const { source, origins } = input();
      source.originZYX = [3, 7, 11];
      source.shapeZYX = [40, 256, 256];
      source.spacingZYX = [45, 16, 16];
      source.unitsZYX = ["nm", "nm", "nm"];
      const roi = {
        originZYX: [14, 23, 27],
        shapeZYX: [16, 60, 60],
      };
      for (let run = 0; run < 2; ++run) {
        const result = await controller.run(source, roi);
        expect(result.channels).toBe(channels);
        expect(result.spacingZYX).toEqual([15, 16, 16]);
        expect(result.originZYX).toEqual([14, 23, 27]);
        expect(
          result.originZYX.map((x, i) => x * result.spacingZYX[i]),
        ).toEqual([210, 368, 432]);
        expect(result.data).toHaveLength(channels * 16 * 60 * 60);
        for (let c = 0; c < channels; ++c)
          expect(
            result.data
              .subarray(c * 16 * 60 * 60, (c + 1) * 16 * 60 * 60)
              .every((x) => x === c + 1),
          ).toBe(true);
        expect(result.provenance).toMatchObject({
          geometry: {
            inputShape: [16, 128, 128],
            rawOutputShape: [48, 128, 128],
            outputSpacing: [15, 16, 16],
            rawOutputOrigin: [-15, 0, 0],
            cropBefore: [6, 16, 16],
            cropAfter: [6, 16, 16],
            outputChannels: channels,
          },
          blending: {
            method: "wu",
            inputStrideZYX: [8, 64, 64],
            retainedOutputShapeZYX: [36, 96, 96],
          },
        });
        controller.cancel();
      }
      expect(origins).toEqual([
        [3, 7, 11],
        [3, 7, 11],
      ]);
      expect(workers.map((w) => w.runs)).toEqual([1, 1]);
      controller.dispose();
    },
  );

  it.each([1, 3])(
    "preserves Wu blending across changing overlaps on the inferred C=%i grid",
    async (channels) => {
      const { controller, workers, file } = setup(undefined, {
        inputShape: [1, 1, 16, 128, 128],
        outputShape: [1, channels, 48, 128, 128],
      });
      await controller.loadModel(file);
      workers[0].patchOriginBias = true;
      const { source } = input();
      source.shapeZYX = [40, 256, 256];
      source.spacingZYX = [45, 16, 16];
      const result = await controller.run(source, {
        originZYX: [30, 82, 82],
        shapeZYX: [13, 13, 13],
      });
      expect(workers[0].runs).toBe(8);
      let i = 0;
      for (let c = 0; c < channels; ++c)
        for (let z = 30; z < 43; ++z)
          for (let y = 82; y < 95; ++y)
            for (let x = 82; x < 95; ++x) {
              let sum = 0,
                weight = 0;
              for (const iz of [0, 8])
                for (const iy of [0, 64])
                  for (const ix of [0, 64]) {
                    const local = [
                      z - (iz * 3 + 5),
                      y - (iy + 16),
                      x - (ix + 16),
                    ];
                    if (
                      local.some((v, axis) => v < 0 || v >= [36, 96, 96][axis])
                    )
                      continue;
                    const w = referenceBump(
                      local[0],
                      local[1],
                      local[2],
                      [36, 96, 96],
                    );
                    const bias = iz * 10000 + iy * 100 + ix;
                    sum += w * Math.fround((c + 1) * (1 + bias));
                    weight += w;
                  }
              expect(Math.abs(result.data[i++] - sum / weight)).toBeLessThan(1);
            }
      controller.dispose();
    },
  );

  it("invalidates cross-ROI predictions on output spacing, crop and alignment changes", async () => {
    const { controller, workers, file } = setup(undefined, {
      inputShape: [1, 1, 16, 128, 128],
      outputShape: [1, 1, 48, 128, 128],
    });
    const metadata = await controller.loadModel(file);
    const { source } = input();
    source.shapeZYX = [64, 320, 320];
    source.spacingZYX = [45, 16, 16];
    const initial = makeModelGeometry(metadata, [45, 16, 16]);
    const a = {
      originZYX: [30, 50, 50],
      shapeZYX: [1, 1, 1],
    };
    const b = { ...a, originZYX: [31, 51, 51] };
    const geometries = [
      initial,
      { ...initial, cropBefore: [7, 17, 17] as const },
      { ...initial, rawOutputOrigin: [0, 0, 0] as const },
      {
        ...initial,
        outputSpacing: [30, 16, 16] as const,
        rawOutputOrigin: [0, 0, 0] as const,
      },
      initial,
    ];
    for (const geometry of geometries) {
      const before = workers[0].runs;
      let total = 0;
      await controller.run(source, { ...a, geometry }, (_, n) => (total = n));
      expect(workers[0].runs - before).toBe(total);
      await controller.run(source, { ...b, geometry });
      expect(workers[0].runs - before).toBe(total);
    }
    controller.dispose();
  });

  it("rejects custom geometry incompatible with metadata or source spacing before reads", async () => {
    const { controller, file } = setup();
    const metadata = await controller.loadModel(file);
    const { source, origins } = input();
    const geometry = makeModelGeometry(metadata, [40, 16, 16]);
    for (const override of [
      { outputChannels: 1 },
      { inputShape: [16, 80, 80] as const },
      { rawOutputShape: [21, 80, 80] as const },
      { inputSpacing: [45, 16, 16] as const },
    ]) {
      await expect(
        controller.run(source, {
          ...options,
          geometry: { ...geometry, ...override },
        }),
      ).rejects.toThrow(/match/);
    }
    expect(origins).toEqual([]);
    controller.dispose();
  });
  it("reuses unique cropped contexts across adjacent chunks and reruns without changing per-channel Wu results", async () => {
    const cached = setup();
    const reference = setup(0);
    const { source, origins } = input();
    const independent = input();
    for (const fixture of [cached, reference]) {
      await fixture.controller.loadModel(fixture.file);
      fixture.workers[0].patchOriginBias = true;
    }
    const chunks = [12, 22].map((z) => ({
      ...options,
      originZYX: [z, 50, 50],
      shapeZYX: [10, 5, 5],
    }));
    const expected = [];
    for (const chunk of chunks) {
      const progress: number[][] = [];
      const actual = await cached.controller.run(source, chunk, (n, total) =>
        progress.push([n, total]),
      );
      const uncached = await reference.controller.run(
        independent.source,
        chunk,
      );
      expect(actual.data).toEqual(uncached.data);
      expected.push(uncached.data);
      const total = 8;
      expect(actual.provenance).toMatchObject({ completedTiles: total });
      expect(progress).toEqual(
        Array.from({ length: total + 1 }, (_, n) => [n, total]),
      );
      // Result buffers must neither alias nor mutate the cached predictions.
      actual.data.fill(-123);
    }
    const unique = new Set(independent.origins.map((origin) => origin.join()));
    expect(unique.size).toBe(12);
    expect(origins).toHaveLength(unique.size);
    expect(new Set(origins.map((origin) => origin.join()))).toEqual(unique);
    expect(cached.workers[0].runs).toBe(unique.size);
    expect(reference.workers[0].runs).toBe(16);
    for (const [index, chunk] of chunks.entries()) {
      const progress: number[] = [];
      const again = await cached.controller.run(source, chunk, (n) =>
        progress.push(n),
      );
      expect(again.data).toEqual(expected[index]);
      expect(again.provenance).toMatchObject({ completedTiles: 8 });
      expect(progress).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    }
    expect(origins).toHaveLength(unique.size);
    expect(cached.workers[0].runs).toBe(unique.size);
    cached.controller.dispose();
    reference.controller.dispose();
  });

  it("invalidates on input identity, mutable source fields, snapshot changes", async () => {
    const { controller, workers, file } = setup();
    await controller.loadModel(file);
    let { source } = input();
    const roi = { ...options, shapeZYX: [1, 1, 1] };
    const runFresh = async () => {
      const before = workers[0].runs;
      let total = 0;
      const result = await controller.run(source, roi, (_, n) => (total = n));
      expect(result.provenance).toMatchObject({ completedTiles: total });
      expect(workers[0].runs - before).toBe(total);
      await controller.run(source, roi);
      expect(workers[0].runs - before).toBe(total);
    };
    await runFresh();
    source = input().source;
    await runFresh();
    source.shapeZYX[0] += 1;
    await runFresh();
    source.spacingZYX[0] *= 2;
    await runFresh();
    source.originZYX[0] = -10;
    await runFresh();
    const transform = [1, 0, 0, 1];
    source.validitySnapshot = {
      ...source.validitySnapshot,
      chunkToMultiscaleTransform: transform,
    };
    await runFresh();
    transform[0] = 2;
    await runFresh();
    // Switching back must not resurrect an older namespace.
    transform[0] = 1;
    await runFresh();
    source.dispose();
    const before = workers[0].runs;
    await expect(controller.run(source, roi)).rejects.toThrow("source changed");
    expect(workers[0].runs).toBe(before);
    controller.dispose();
  });

  it("promptly releases predictions, the input reference and abort listener on source disposal", async () => {
    const { controller, workers, file } = setup();
    await controller.loadModel(file);
    const invalidation = new AbortController();
    const add = vi.spyOn(invalidation.signal, "addEventListener");
    const remove = vi.spyOn(invalidation.signal, "removeEventListener");
    const { source: base, origins } = input();
    const source = {
      ...base,
      signal: invalidation.signal,
      dispose: () => invalidation.abort(),
    };
    const roi = { ...options, shapeZYX: [1, 1, 1] };
    await controller.run(source, roi);
    await controller.run(source, roi);
    expect(add).toHaveBeenCalledTimes(1);
    expect(controller["patchCacheBytes"]).toBeGreaterThan(0);
    source.dispose();
    expect(controller["patchCacheBytes"]).toBe(0);
    expect(controller["patchCache"].size).toBe(0);
    expect(controller["cacheInput"]).toBeUndefined();
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0][1]);
    await expect(controller.run(source, roi)).rejects.toThrow("source changed");
    expect(controller["cacheInput"]).toBeUndefined();
    expect(origins).toHaveLength(1);
    expect(workers[0].runs).toBe(1);
    controller.dispose();
  });

  it("detaches the old source abort listener on switching input and cancellation", async () => {
    const { controller, file } = setup();
    await controller.loadModel(file);
    const a = new AbortController();
    const b = new AbortController();
    const removeA = vi.spyOn(a.signal, "removeEventListener");
    const removeB = vi.spyOn(b.signal, "removeEventListener");
    const roi = { ...options, shapeZYX: [1, 1, 1] };
    await controller.run({ ...input().source, signal: a.signal }, roi);
    await controller.run({ ...input().source, signal: b.signal }, roi);
    expect(removeA).toHaveBeenCalledTimes(1);
    a.abort();
    expect(controller["patchCacheBytes"]).toBeGreaterThan(0);
    controller.cancel();
    expect(removeB).toHaveBeenCalledTimes(1);
    expect(controller["cacheInput"]).toBeUndefined();
    controller.dispose();
  });

  it("clears cached contexts on model/provider selection and cancellation", async () => {
    const { controller, workers, file } = setup();
    const { source, origins } = input();
    const roi = { ...options, shapeZYX: [1, 1, 1] };
    await controller.loadModel(file);
    await controller.run(source, roi);
    await controller.loadModel({ ...file, name: "other.onnx" } as File);
    await controller.run(source, roi);
    await controller.loadModel(file, "cpu");
    await controller.run(source, roi);
    controller.cancel();
    await controller.run(source, roi);
    expect(origins).toHaveLength(4);
    expect(workers.map((worker) => worker.runs)).toEqual([1, 1, 1, 1]);
    expect(workers[3].requestedProviders).toEqual(["cpu"]);
    controller.dispose();
    expect(controller["patchCacheBytes"]).toBe(0);
  });

  it.each([undefined, false, true])(
    "preserves compatibility policy %s on cancel/reload and records provenance",
    async (compatibilityFixes) => {
      const { controller, workers, file } = setup();
      const { source } = input();
      const roi = { ...options, shapeZYX: [1, 1, 1] };
      await controller.loadModel(file, "webgpu", compatibilityFixes);
      controller.cancel();
      const result = await controller.run(source, roi);
      for (const worker of workers) {
        expect(worker.loadRequests[0].compatibilityFixes).toBe(
          compatibilityFixes,
        );
        expect(
          Object.hasOwn(worker.loadRequests[0], "compatibilityFixes"),
        ).toBe(compatibilityFixes !== undefined);
      }
      if (compatibilityFixes === undefined)
        expect(result.provenance).not.toHaveProperty("compatibilityFixes");
      else
        expect(result.provenance).toHaveProperty(
          "compatibilityFixes",
          compatibilityFixes,
        );
      controller.dispose();
    },
  );

  it.each([undefined, "float32", "float16"] as const)(
    "preserves requested precision %s on cancellation/reload and in provenance",
    async (precision) => {
      const { controller, workers, file } = setup();
      const { source } = input();
      const roi = { ...options, shapeZYX: [1, 1, 1] };
      await controller.loadModel(file, "webgpu", false, precision);
      controller.cancel();
      const result = await controller.run(source, roi);
      for (const worker of workers) {
        expect(worker.loadRequests[0]).toMatchObject({
          provider: "webgpu",
          compatibilityFixes: false,
        });
        expect(worker.loadRequests[0].precision).toBe(precision);
        expect(Object.hasOwn(worker.loadRequests[0], "precision")).toBe(
          precision !== undefined,
        );
      }
      if (precision === undefined) {
        expect(result.provenance).not.toHaveProperty("requestedPrecision");
        expect(result.provenance).not.toHaveProperty("actualPrecision");
      } else {
        expect(result.provenance).toMatchObject({
          requestedPrecision: precision,
          actualPrecision: precision,
        });
      }
      controller.dispose();
    },
  );

  it("never reuses predictions when only the requested precision changes", async () => {
    const { controller, workers, file } = setup();
    const { source, origins } = input();
    const roi = { ...options, shapeZYX: [1, 1, 1] };
    for (const precision of [
      undefined,
      "float16",
      "float32",
      "float16",
    ] as const) {
      await controller.loadModel(file, "webgpu", false, precision);
      await controller.run(source, roi);
      await controller.run(source, roi);
    }
    expect(origins).toHaveLength(4);
    expect(workers.map((worker) => worker.runs)).toEqual([1, 1, 1, 1]);
    controller.dispose();
  });

  it("invalidates patches on precision metadata changes and records visible fallback provenance", async () => {
    const { controller, workers, file } = setup();
    const seen: ModelMetadata[] = [];
    controller.onMetadata = (metadata) => seen.push(structuredClone(metadata));
    await controller.loadModel(file, "webgpu", false, "float16");
    const { source } = input();
    const a = { ...options, shapeZYX: [1, 1, 1] };
    const b = { ...a, originZYX: [2, 10, 70] };
    await controller.run(source, a);
    await controller.run(source, a);
    expect(workers[0].runs).toBe(1);
    Object.assign(workers[0].metadata, {
      actualPrecision: "float32",
      precisionFallbackReason:
        "FP16 first execution failed: native error; using FP32 WebGPU",
    });
    const result = await controller.run(source, b);
    expect(result.provenance).toMatchObject({
      requestedPrecision: "float16",
      actualPrecision: "float32",
      precisionFallbackReason: workers[0].metadata.precisionFallbackReason,
    });
    expect(seen.at(-1)).toMatchObject({
      requestedPrecision: "float16",
      actualPrecision: "float32",
    });
    await controller.run(source, a);
    await controller.run(source, b);
    expect(workers[0].runs).toBe(3);
    // Same precision but a changed reason is also part of cache identity.
    workers[0].metadata.precisionFallbackReason =
      "FP16 conversion unsupported; using FP32 WebGPU";
    await controller.run(source, { ...a, originZYX: [2, 10, 110] });
    await controller.run(source, a);
    expect(workers[0].runs).toBe(5);
    controller.dispose();
  });

  it("never reuses cached predictions when only the requested compatibility flag changes", async () => {
    const { controller, workers, file } = setup();
    const { source, origins } = input();
    const roi = { ...options, shapeZYX: [1, 1, 1] };
    for (const enabled of [undefined, false, true, false]) {
      await controller.loadModel(file, "webgpu", enabled);
      await controller.run(source, roi);
      await controller.run(source, roi);
    }
    expect(origins).toHaveLength(4);
    expect(workers.map((worker) => worker.runs)).toEqual([1, 1, 1, 1]);
    controller.dispose();
  });

  it("invalidates on compatibility metadata changes and preserves analysis in provenance", async () => {
    const { controller, workers, file } = setup();
    await controller.loadModel(file, "webgpu", true);
    const { source } = input();
    const a = { ...options, shapeZYX: [1, 1, 1] };
    const b = { ...a, originZYX: [2, 10, 70] };
    const analysis = {
      status: "available" as const,
      model: "model6280000" as const,
      fixes: ["Verified fixes"],
      message: "Verified fixes available",
    };
    await controller.run(source, a);
    workers[0].metadata.compatibilityAnalysis = analysis;
    const result = await controller.run(source, b);
    expect(result.provenance).toMatchObject({
      compatibilityFixes: true,
      compatibilityAnalysis: analysis,
    });
    await controller.run(source, a);
    expect(workers[0].runs).toBe(3);
    workers[0].metadata.compatibilityFixes = false;
    await controller.run(source, { ...a, originZYX: [2, 10, 110] });
    await controller.run(source, a);
    expect(workers[0].runs).toBe(5);
    controller.dispose();
  });

  it("invalidates on reported fallback/preparation changes but retains normal response entries", async () => {
    const { controller, workers, file } = setup();
    await controller.loadModel(file, "webgpu");
    const { source } = input();
    const a = { ...options, shapeZYX: [1, 1, 1] };
    const b = { ...a, originZYX: [2, 10, 70] };
    await controller.run(source, a);
    await controller.run(source, b);
    await controller.run(source, a);
    expect(workers[0].runs).toBe(2);
    workers[0].metadata = {
      ...workers[0].metadata,
      actualProvider: "wasm",
      fallbackReason: "WebGPU first execution failed: device lost",
    };
    const c = { ...a, originZYX: [2, 10, 110] };
    await controller.run(source, c); // Reports fallback and clears a + b.
    await controller.run(source, a);
    await controller.run(source, c);
    expect(workers[0].runs).toBe(4);
    workers[0].metadata.preparation = "nooverseg-jsep";
    await controller.run(source, b);
    await controller.run(source, a);
    expect(workers[0].runs).toBe(6);
    controller.dispose();
  });

  it.each(["error", "short", "nan", "infinity"] as const)(
    "does not reuse %s responses or earlier contexts after a failed run",
    async (failure) => {
      const { controller, workers, file } = setup();
      await controller.loadModel(file);
      const { source, origins } = input();
      const a = { ...options, shapeZYX: [1, 1, 1] };
      const b = { ...a, originZYX: [2, 10, 70] };
      await controller.run(source, a);
      workers[0].outputFailure = failure;
      await expect(controller.run(source, b)).rejects.toThrow(
        failure === "error"
          ? "execution failed"
          : failure === "short"
            ? "buffer lengths"
            : "predictions must be finite",
      );
      workers[0].outputFailure = undefined;
      await controller.run(source, b);
      await controller.run(source, a);
      expect(workers[0].runs).toBe(4);
      expect(origins).toHaveLength(4);
      expect(workers[0].loads).toBe(1); // No reload/fallback policy change.
      controller.dispose();
    },
  );

  it("clears earlier predictions on worker failure without accepting late responses", async () => {
    const { controller, workers, file } = setup();
    await controller.loadModel(file);
    const { source, origins } = input();
    const a = { ...options, shapeZYX: [1, 1, 1] };
    await controller.run(source, a);
    workers[0].hold = true;
    const pending = controller.run(source, { ...a, originZYX: [2, 10, 70] });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const rejected = expect(pending).rejects.toThrow(
      "Inference worker failed: lost",
    );
    workers[0].onerror!({ message: "lost" });
    await rejected;
    workers[0].held!();
    await controller.run(source, a);
    expect(origins).toHaveLength(3);
    expect(workers).toHaveLength(2);
    expect(workers[1].runs).toBe(1);
    controller.dispose();
  });

  it("uses byte-bounded LRU eviction, touching hits and skipping oversized predictions", async () => {
    const bytes = 4 * 16 * 60 * 60 * Float32Array.BYTES_PER_ELEMENT;
    const budget = 2 * bytes + 17;
    const { controller, workers, file } = setup(budget);
    await controller.loadModel(file);
    const { source, origins } = input();
    const run = async (x: number) => {
      await controller.run(source, {
        ...options,
        originZYX: [2, 10, x],
        shapeZYX: [1, 1, 1],
      });
      const sum = [...controller["patchCache"].values()].reduce(
        (n, patch) => n + patch.byteLength,
        0,
      );
      expect(controller["patchCacheBytes"]).toBe(sum);
      expect(sum).toBeLessThanOrEqual(budget);
    };
    await run(10); // A
    await run(70); // B
    await run(10); // Touch A: B is now oldest.
    await run(110); // C evicts B.
    await run(10); // A remains cached.
    expect(workers[0].runs).toBe(3);
    await run(70); // B must execute again.
    expect(workers[0].runs).toBe(4);
    expect(origins.map((origin) => origin[2])).toEqual([0, 40, 80, 40]);
    expect(controller["patchCacheBytes"]).toBe(2 * bytes);
    controller.dispose();

    const tiny = setup(bytes - 1);
    await tiny.controller.loadModel(tiny.file);
    for (let i = 0; i < 2; ++i)
      await tiny.controller.run(source, { ...options, shapeZYX: [1, 1, 1] });
    expect(tiny.workers[0].runs).toBe(2);
    expect(tiny.controller["patchCacheBytes"]).toBe(0);
    tiny.controller.dispose();
  });

  it("is lazy, blends all channels and partial tiles, transfers only owned unmodified patches and reuses session", async () => {
    const { controller, workers, file } = setup();
    expect(workers).toHaveLength(0);
    await controller.loadModel(file);
    const { source, patches } = input();
    const progress: number[] = [];
    const result = await controller.run(source, options, (n) =>
      progress.push(n),
    );
    expect(progress).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(workers[0].loads).toBe(1);
    expect(workers[0].runs).toBe(8);
    expect(result.provenance).toMatchObject({
      completedTiles: 8,
      blending: {
        method: "wu",
        inputStrideZYX: [10, 40, 40],
        retainedOutputShapeZYX: [16, 60, 60],
      },
    });
    expect(result.provenance).not.toHaveProperty("preprocessing");
    expect(patches.every((p) => p.byteLength === 0)).toBe(true);
    let i = 0;
    for (let c = 0; c < 4; ++c)
      for (let z = 2; z < 19; ++z)
        for (let y = 10; y < 71; ++y)
          for (let x = 10; x < 71; ++x) {
            expect(result.data[i++]).toBe(z * 10000 + y * 100 + x + c * 1e6);
          }
    await controller.run(source, { ...options, shapeZYX: [1, 1, 1] });
    expect(workers).toHaveLength(1);
    expect(workers[0].loads).toBe(1);
    controller.dispose();
    expect(workers[0].terminated).toBe(true);
  });

  it("Wu-weights nonidentical predictions per channel across changing overlap counts and clipped edges", async () => {
    const { controller, workers, file } = setup();
    await controller.loadModel(file);
    workers[0].patchOriginBias = true;
    const { source, origins } = input();
    const progress: number[][] = [];
    const result = await controller.run(
      source,
      {
        originZYX: [12, 50, 50],
        shapeZYX: [17, 21, 21],
      },
      (completed, total) => progress.push([completed, total]),
    );
    // Includes Z contexts starting at 0, 10 and 20, even though the ROI starts at 12.
    expect(origins).toEqual(
      [0, 10, 20].flatMap((z) =>
        [0, 40].flatMap((y) => [0, 40].map((x) => [z, y, x])),
      ),
    );
    expect(progress).toEqual(
      Array.from({ length: 13 }, (_, completed) => [completed, 12]),
    );
    expect(result.provenance).toMatchObject({ completedTiles: 12 });
    let i = 0;
    for (let c = 0; c < 4; ++c)
      for (let z = 12; z < 29; ++z)
        for (let y = 50; y < 71; ++y)
          for (let x = 50; x < 71; ++x) {
            const contributors = origins.filter(
              ([iz, iy, ix]) =>
                z >= iz + 2 &&
                z < iz + 18 &&
                y >= iy + 10 &&
                y < iy + 70 &&
                x >= ix + 10 &&
                x < ix + 70,
            );
            expect(contributors.length).toBeGreaterThan(0);
            const bumps = contributors.map(([iz, iy, ix]) =>
              referenceBump(z - iz - 2, y - iy - 10, x - ix - 10),
            );
            const meanBias =
              contributors.reduce(
                (sum, [iz, iy, ix], index) =>
                  sum + bumps[index] * (iz * 10000 + iy * 100 + ix),
                0,
              ) / bumps.reduce((a, b) => a + b, 0);
            const expected =
              z * 10000 + y * 100 + x + c * 1e6 + meanBias * (c + 1);
            // At million-scale magnitudes, sequential float32 online means
            // can differ from the binary64 oracle by several ULPs.
            expect(Math.abs(result.data[i++] - expected)).toBeLessThan(1);
          }
    controller.dispose();
  });

  it("keeps the source-global anchor for a shifted tiny ROI and counts every neighboring contributor", async () => {
    const { controller, workers, file } = setup();
    await controller.loadModel(file);
    workers[0].patchOriginBias = true;
    const { source, origins } = input();
    source.originZYX = [3, 7, 11];
    const progress: number[][] = [];
    const result = await controller.run(
      source,
      {
        originZYX: [18, 62, 66],
        shapeZYX: [1, 1, 1],
      },
      (completed, total) => progress.push([completed, total]),
    );
    expect(origins).toEqual(
      [3, 13].flatMap((z) =>
        [7, 47].flatMap((y) => [11, 51].map((x) => [z, y, x])),
      ),
    );
    expect(progress).toEqual(
      Array.from({ length: 9 }, (_, completed) => [completed, 8]),
    );
    expect(workers[0].runs).toBe(8);
    expect(result.provenance).toMatchObject({ completedTiles: 8 });
    const bumps = origins.map(([z, y, x]) =>
      referenceBump(18 - z - 2, 62 - y - 10, 66 - x - 10),
    );
    const meanBias =
      origins.reduce(
        (sum, [z, y, x], i) => sum + bumps[i] * (z * 10000 + y * 100 + x),
        0,
      ) / bumps.reduce((a, b) => a + b, 0);
    for (let c = 0; c < 4; ++c) {
      expect(result.data[c]).toBeCloseTo(
        186266 + c * 1e6 + meanBias * (c + 1),
        0,
      );
    }
    controller.dispose();
  });

  it("rounds a planner-validated output stride despite physical-spacing roundoff", async () => {
    const { controller, file } = setup();
    await controller.loadModel(file);
    const { source } = input();
    const spacing = 4.4550000405405005e-7;
    expect((40 * spacing) / spacing).not.toBe(40);
    source.spacingZYX = [spacing, spacing, spacing];
    const result = await controller.run(source, {
      ...options,
      shapeZYX: [1, 1, 1],
    });
    expect([...result.data]).toEqual([21010, 1021010, 2021010, 3021010]);
    controller.dispose();
  });

  it("reports first-run fallback in metadata/provenance, then replaces the provider without stale workers", async () => {
    const { controller, workers, file } = setup();
    const seen: ModelMetadata[] = [];
    controller.onMetadata = (metadata) => seen.push(metadata);
    await controller.loadModel(file, "auto");
    workers[0].metadata = {
      ...workers[0].metadata,
      actualProvider: "wasm",
      fallbackReason: "WebGPU first execution failed: unsupported Conv3D",
    };
    const { source } = input();
    const result = await controller.run(source, {
      ...options,
      shapeZYX: [1, 1, 1],
    });
    expect(seen.at(-1)).toEqual(workers[0].metadata);
    expect(result.provenance).toMatchObject({
      requestedProvider: "auto",
      actualProvider: "wasm",
      fallbackReason: "WebGPU first execution failed: unsupported Conv3D",
    });
    await controller.loadModel(file, "cpu");
    expect(workers[0].terminated).toBe(true);
    expect(workers[1].requestedProviders).toEqual(["cpu"]);
    expect(seen.at(-1)).toMatchObject({
      requestedProvider: "cpu",
      actualProvider: "wasm",
    });
    expect(seen.at(-1)?.fallbackReason).toBeUndefined();
    controller.dispose();
  });

  it("records preparation in ROI provenance only when the executing worker reports it", async () => {
    const { controller, workers, file } = setup();
    await controller.loadModel(file, "webgpu");
    workers[0].metadata.preparation = "nooverseg-jsep";
    const { source } = input();
    const roi = { ...options, shapeZYX: [1, 1, 1] };
    const prepared = await controller.run(source, roi);
    expect(prepared.provenance).toMatchObject({
      modelName: "local.onnx",
      actualProvider: "webgpu",
      preparation: "nooverseg-jsep",
    });
    workers[0].metadata = {
      ...workers[0].metadata,
      actualProvider: "wasm",
      preparation: undefined,
      fallbackReason: "WebGPU first execution failed: device lost",
    };
    // Force a new context: a cache hit cannot observe unreported worker changes.
    const cpu = await controller.run(source, {
      ...roi,
      originZYX: [22, 10, 10],
    });
    expect(cpu.provenance).toMatchObject({
      actualProvider: "wasm",
      fallbackReason: "WebGPU first execution failed: device lost",
    });
    expect(cpu.provenance).not.toHaveProperty("preparation");
    controller.dispose();
  });

  it("rejects invalid halo, memory budget and changed source before running", async () => {
    const { controller, workers, file } = setup();
    await controller.loadModel(file);
    const { source } = input();
    await expect(
      controller.run(source, { ...options, originZYX: [0, 0, 0] }),
    ).rejects.toThrow("input bounds");
    await expect(
      controller.run(source, { ...options, shapeZYX: [97, 220, 220] }),
    ).rejects.toThrow("input bounds");
    source.dispose();
    await expect(controller.run(source, options)).rejects.toThrow(
      "source changed",
    );
    expect(workers[0].runs).toBe(0);
    controller.dispose();
  });

  it.each([NaN, Infinity, -Infinity])(
    "rejects nonfinite source values before transferring a patch (%s)",
    async (value) => {
      const { controller, workers, file } = setup();
      await controller.loadModel(file);
      const { source } = input();
      const readPatch = source.readPatch.bind(source);
      let patch!: Float32Array<ArrayBuffer>;
      vi.spyOn(source, "readPatch").mockImplementation(async (...args) => {
        patch = await readPatch(...args);
        patch[0] = value;
        return patch;
      });
      await expect(
        controller.run(source, { ...options, shapeZYX: [1, 1, 1] }),
      ).rejects.toThrow("Inference input values must be finite");
      expect(workers[0].runs).toBe(0);
      expect(patch.byteLength).toBeGreaterThan(0);
      controller.dispose();
    },
  );

  it("rejects excessive blended work and result memory before reading patches", async () => {
    const { controller, workers, file } = setup();
    await controller.loadModel(file);
    const { source, origins } = input();
    source.shapeZYX = [50000, 240, 240];
    // The left neighbor contributes too: 4097 contexts, not 4096.
    await expect(
      controller.run(source, {
        ...options,
        originZYX: [12, 10, 10],
        shapeZYX: [40951, 1, 1],
      }),
    ).rejects.toThrow("maxTiles");
    source.shapeZYX = [100, 1360, 240];
    await expect(
      controller.run(source, { ...options, shapeZYX: [96, 1300, 220] }),
    ).rejects.toThrow("session result limit");
    expect(origins).toEqual([]);
    expect(workers[0].runs).toBe(0);
    controller.dispose();
  });

  it("cancels a pending file read without locking or releasing a newer operation", async () => {
    const { controller, file } = setup();
    let finishOld!: (value: ArrayBuffer) => void;
    let finishNew!: (value: ArrayBuffer) => void;
    const oldLoad = controller.loadModel({
      ...file,
      arrayBuffer: () =>
        new Promise<ArrayBuffer>((resolve) => {
          finishOld = resolve;
        }),
    } as File);
    const canceled = expect(oldLoad).rejects.toThrow("canceled");
    controller.cancel();
    const newLoad = controller.loadModel({
      ...file,
      arrayBuffer: () =>
        new Promise<ArrayBuffer>((resolve) => {
          finishNew = resolve;
        }),
    } as File);
    // A new operation starts immediately even while the old non-abortable read waits.
    expect(finishNew).toBeTypeOf("function");
    finishOld(new ArrayBuffer(1));
    await canceled;
    // The old operation's finally must not unlock the new operation.
    await expect(controller.loadModel(file)).rejects.toThrow(
      "active inference job",
    );
    finishNew(new ArrayBuffer(1));
    expect((await newLoad).outputShape).toEqual([1, 4, 20, 80, 80]);
    controller.dispose();
  });

  it("terminates active inference, rejects stale outputs and reloads the local file only for a later explicit run", async () => {
    const { controller, workers, file } = setup();
    const seen: ModelMetadata[] = [];
    controller.onMetadata = (metadata) => seen.push(metadata);
    await controller.loadModel(file, "webgpu");
    expect(workers[0].requestedProviders).toEqual(["webgpu"]);
    workers[0].hold = true;
    const { source } = input();
    const pending = controller.run(source, { ...options, shapeZYX: [1, 1, 1] });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(workers[0].held).toBeTypeOf("function");
    const rejected = expect(pending).rejects.toThrow("canceled");
    controller.cancel();
    await rejected;
    expect(workers[0].terminated).toBe(true);
    workers[0].held!();
    expect(seen).toHaveLength(1); // canceled worker cannot report stale metadata
    const result = await controller.run(source, {
      ...options,
      shapeZYX: [1, 1, 1],
    });
    expect(result.data).toHaveLength(4);
    expect(workers).toHaveLength(2);
    expect(workers[1].loads).toBe(1);
    expect(workers[1].requestedProviders).toEqual(["webgpu"]);
    expect(seen.map((m) => m.requestedProvider)).toEqual([
      "webgpu",
      "webgpu",
      "webgpu",
    ]);
    controller.dispose();
  });
});
