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

import { describe, expect, it } from "vitest";
import { OnnxInferenceController } from "#src/inference/controller.js";
import type { PreparedInferenceInput } from "#src/inference/input.js";
import type {
  InferenceWorkerRequest,
  InferenceWorkerResponse,
} from "#src/inference/model.js";
import { makeModelGeometry } from "#src/inference/model.js";

/**
 * Weight-free IR 7/opset 13 fixtures: Concat(volume:0, volume:0 + 1e6), axis=1.
 * Input [N,1,8,16,16], output [N,2,8,16,16]. The symbolic fixtures declare
 * N="batch" on both tensors; the last also declares output ZYX as
 * "depth", "height", "width", which the graph can infer from the static input.
 * Generated with onnx.helper and embedded to avoid adding binary fixtures.
 */
const batchModels = [
  {
    name: "fixed N=2",
    batchSize: 2,
    tileCount: 3,
    base64:
      "CAcSEW5ldXJvZ2xhbmNlci10ZXN0OuoBCiAKCHZvbHVtZTowCgZvZmZzZXQSB3NoaWZ0ZWQiA0FkZAo9Cgh2b2x1bWU6MAoHc2hpZnRlZBITcHJlZGljdGlvbi9jaGFubmVscyIGQ29uY2F0KgsKBGF4aXMYAaABAhIaZGV0ZXJtaW5pc3RpYy1iYXRjaC1jb25jYXQqEBABIgQAJHRJQgZvZmZzZXRaJgoIdm9sdW1lOjASGgoYCAESFAoCCAIKAggBCgIICAoCCBAKAggQYjEKE3ByZWRpY3Rpb24vY2hhbm5lbHMSGgoYCAESFAoCCAIKAggCCgIICAoCCBAKAggQQgQKABAN",
  },
  {
    name: "fixed N=3",
    batchSize: 3,
    tileCount: 4,
    base64:
      "CAcSEW5ldXJvZ2xhbmNlci10ZXN0OuoBCiAKCHZvbHVtZTowCgZvZmZzZXQSB3NoaWZ0ZWQiA0FkZAo9Cgh2b2x1bWU6MAoHc2hpZnRlZBITcHJlZGljdGlvbi9jaGFubmVscyIGQ29uY2F0KgsKBGF4aXMYAaABAhIaZGV0ZXJtaW5pc3RpYy1iYXRjaC1jb25jYXQqEBABIgQAJHRJQgZvZmZzZXRaJgoIdm9sdW1lOjASGgoYCAESFAoCCAMKAggBCgIICAoCCBAKAggQYjEKE3ByZWRpY3Rpb24vY2hhbm5lbHMSGgoYCAESFAoCCAMKAggCCgIICAoCCBAKAggQQgQKABAN",
  },
  {
    name: "symbolic batch specialized to N=1",
    batchSize: 1,
    tileCount: 3,
    base64:
      "CAcSEW5ldXJvZ2xhbmNlci10ZXN0OvQBCiAKCHZvbHVtZTowCgZvZmZzZXQSB3NoaWZ0ZWQiA0FkZAo9Cgh2b2x1bWU6MAoHc2hpZnRlZBITcHJlZGljdGlvbi9jaGFubmVscyIGQ29uY2F0KgsKBGF4aXMYAaABAhIaZGV0ZXJtaW5pc3RpYy1iYXRjaC1jb25jYXQqEBABIgQAJHRJQgZvZmZzZXRaKwoIdm9sdW1lOjASHwodCAESGQoHEgViYXRjaAoCCAEKAggICgIIEAoCCBBiNgoTcHJlZGljdGlvbi9jaGFubmVscxIfCh0IARIZCgcSBWJhdGNoCgIIAgoCCAgKAggQCgIIEEIECgAQDQ==",
  },
  {
    name: "symbolic batch and output ZYX specialized to N=1",
    batchSize: 1,
    tileCount: 3,
    base64:
      "CAcSEW5ldXJvZ2xhbmNlci10ZXN0OoQCCiAKCHZvbHVtZTowCgZvZmZzZXQSB3NoaWZ0ZWQiA0FkZAo9Cgh2b2x1bWU6MAoHc2hpZnRlZBITcHJlZGljdGlvbi9jaGFubmVscyIGQ29uY2F0KgsKBGF4aXMYAaABAhIaZGV0ZXJtaW5pc3RpYy1iYXRjaC1jb25jYXQqEBABIgQAJHRJQgZvZmZzZXRaKwoIdm9sdW1lOjASHwodCAESGQoHEgViYXRjaAoCCAEKAggICgIIEAoCCBBiRgoTcHJlZGljdGlvbi9jaGFubmVscxIvCi0IARIpCgcSBWJhdGNoCgIIAgoHEgVkZXB0aAoIEgZoZWlnaHQKBxIFd2lkdGhCBAoAEA0=",
  },
];

function coordinateData(
  originZYX: readonly number[],
  shapeZYX: readonly number[],
  channels = 1,
) {
  const [nz, ny, nx] = shapeZYX;
  const voxels = nz * ny * nx;
  return Float32Array.from({ length: channels * voxels }, (_, i) => {
    const z = originZYX[0] + (Math.floor(i / (ny * nx)) % nz);
    const y = originZYX[1] + (Math.floor(i / nx) % ny);
    const x = originZYX[2] + (i % nx);
    return z * 10000 + y * 100 + x + Math.floor(i / voxels) * 1e6;
  });
}

function coordinateInput(shapeZYX: number[]) {
  const origins: number[][] = [];
  const input: PreparedInferenceInput = {
    originZYX: [-7, 101, 203],
    shapeZYX,
    spacingZYX: [40, 16, 10],
    axisNamesZYX: ["z", "y", "x"],
    unitsZYX: ["m", "m", "m"],
    validitySnapshot: {} as PreparedInferenceInput["validitySnapshot"],
    isValid: () => true,
    assertValid() {},
    dispose() {},
    async readPatch(origin, shape, signal) {
      signal.throwIfAborted();
      expect(shape).toEqual([8, 16, 16]);
      for (let axis = 0; axis < 3; ++axis) {
        expect(origin[axis]).toBeGreaterThanOrEqual(input.originZYX[axis]);
        expect(origin[axis] + shape[axis]).toBeLessThanOrEqual(
          input.originZYX[axis] + input.shapeZYX[axis],
        );
      }
      origins.push([...origin]);
      return coordinateData(origin, shape);
    },
  };
  return { input, origins };
}

function observedController() {
  let runs = 0;
  const controller = new OnnxInferenceController(() => {
    const worker = new Worker(
      new URL("../inference_worker.bundle.js", import.meta.url),
      { type: "module" },
    );
    // Observe successful executions without mocking the worker or WASM runtime.
    worker.addEventListener(
      "message",
      ({ data }: MessageEvent<InferenceWorkerResponse>) => {
        if (data.kind === "output") ++runs;
      },
    );
    return worker;
  });
  return {
    controller,
    get runs() {
      return runs;
    },
  };
}

/** Real WASM + real dedicated worker, no mocked inference runtime. */
describe("browser inference worker", () => {
  it.each(
    batchModels.flatMap((model) =>
      [false, true].map((overlap) => ({ ...model, overlap })),
    ),
  )(
    "runs $name over $tileCount source patches with overlap=$overlap, crops both channels and replays cached tiles",
    async ({ name, batchSize, tileCount, base64, overlap }) => {
      const model = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const observed = observedController();
      const { controller } = observed;
      try {
        const metadata = await controller.loadModel(
          new File([model], `${name}.onnx`),
          "cpu",
        );
        expect(metadata).toMatchObject({
          inputNames: ["volume:0"],
          outputNames: ["prediction/channels"],
          inputShape: [batchSize, 1, 8, 16, 16],
          outputShape: [batchSize, 2, 8, 16, 16],
          requestedProvider: "cpu",
          actualProvider: "wasm",
          threads: 1,
        });
        const strideX = overlap ? 8 : 12;
        const { input, origins } = coordinateInput([
          8,
          16,
          16 + (tileCount - 1) * strideX,
        ]);
        // One lattice row of full contexts. Trim every ROI face inside the
        // retained [6,12,12] outputs, independently of the [1,2,2] model crop.
        const roi = {
          originZYX: input.originZYX.map(
            (start, axis) => start + (axis === 0 ? 2 : 3),
          ),
          shapeZYX: [4, 8, 10 + (tileCount - 1) * strideX],
          overlap,
        };
        const expectedOrigins = Array.from({ length: tileCount }, (_, n) => [
          input.originZYX[0],
          input.originZYX[1],
          input.originZYX[2] + n * strideX,
        ]);
        const expected = coordinateData(roi.originZYX, roi.shapeZYX, 2);
        const progress: number[][] = [];
        const first = await controller.run(input, roi, (completed, total) => {
          progress.push([completed, total]);
        });
        expect(first).toMatchObject({
          originZYX: roi.originZYX,
          shapeZYX: roi.shapeZYX,
          spacingZYX: input.spacingZYX,
          channels: 2,
          provenance: {
            completedTiles: tileCount,
            geometry: {
              cropBefore: [1, 2, 2],
              cropAfter: [1, 2, 2],
              outputChannels: 2,
            },
            blending: {
              method: overlap ? "wu" : "none",
              retainedOutputShapeZYX: [6, 12, 12],
            },
          },
        });
        expect(first.data).toEqual(expected);
        expect(origins).toEqual(expectedOrigins);
        expect(progress).toEqual(
          Array.from({ length: tileCount + 1 }, (_, n) => [n, tileCount]),
        );
        // Fixed N=2 has 3 real patches; fixed N=3 has 4. Each must execute
        // exactly twice, padding the tail without extra reads or published tiles.
        const expectedRuns = Math.ceil(tileCount / batchSize);
        expect(observed.runs).toBe(expectedRuns);
        // ROI data must not alias cached per-tile predictions.
        first.data.fill(NaN);
        const replay = await controller.run(input, roi);
        expect(replay.data).toEqual(expected);
        expect(replay).toMatchObject({
          channels: 2,
          provenance: { completedTiles: tileCount },
        });
        expect(origins).toEqual(expectedOrigins);
        expect(observed.runs).toBe(expectedRuns);
      } finally {
        controller.dispose();
      }
    },
    30000,
  );
  it("runs arbitrary tensor names and a one-channel [1,1,48,128,128] supersampled output", async () => {
    // Weight-free IR 5/opset 10 Resize(volume:0, scales=[1,1,2,2,2]),
    // nearest-neighbor, input [1,1,24,64,64], output prediction/upsampled.
    // Embedded to keep this fixture local to the worker tests.
    const model = Uint8Array.from(
      atob(
        "CAUSEW5ldXJvZ2xhbmNlci10ZXN0OtABCjAKCHZvbHVtZTowCgZzY2FsZXMSFHByZWRpY3Rpb24vdXBzYW1wbGVkIgZSZXNpemUSGWRldGVybWluaXN0aWMtc3VwZXJzYW1wbGUqIwoBBRABIhQAAIA/AACAPwAAAEAAAABAAAAAQEIGc2NhbGVzWiYKCHZvbHVtZTowEhoKGAgBEhQKAggBCgIIAQoCCBgKAghACgIIQGI0ChRwcmVkaWN0aW9uL3Vwc2FtcGxlZBIcChoIARIWCgIIAQoCCAEKAggwCgMIgAEKAwiAAUIECgAQCg==",
      ),
      (c) => c.charCodeAt(0),
    );
    const worker = new Worker(
      new URL("../inference_worker.bundle.js", import.meta.url),
      {
        type: "module",
      },
    );
    const request = (message: InferenceWorkerRequest) =>
      new Promise<InferenceWorkerResponse>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<InferenceWorkerResponse>) =>
          resolve(event.data);
        worker.onerror = (event) => reject(new Error(event.message));
        worker.postMessage(message);
      });
    try {
      const loaded = await request({
        id: 1,
        kind: "load",
        model: model.buffer,
        provider: "cpu",
      });
      expect(loaded.kind).toBe("loaded");
      if (loaded.kind !== "loaded") throw new Error(JSON.stringify(loaded));
      const { metadata } = loaded;
      expect(metadata).toMatchObject({
        inputNames: ["volume:0"],
        outputNames: ["prediction/upsampled"],
        inputShape: [1, 1, 24, 64, 64],
        outputShape: [1, 1, 48, 128, 128],
        actualProvider: "wasm",
      });
      const geometry = makeModelGeometry(metadata, [40, 16, 10]);
      expect(
        await request({
          id: 2,
          kind: "run",
          input: new Float32Array(1),
          geometry,
        }),
      ).toMatchObject({
        kind: "error",
        message: expect.stringContaining("Input length"),
      });
      const input = Float32Array.from({ length: 24 * 64 * 64 }, (_, i) => i);
      expect(
        await request({
          id: 3,
          kind: "run",
          input,
          geometry: { ...geometry, outputChannels: 4 },
        }),
      ).toMatchObject({
        kind: "error",
        message: expect.stringContaining("do not match"),
      });
      for (let repetition = 0; repetition < 2; ++repetition) {
        const result = await request({
          id: 4 + repetition,
          kind: "run",
          input,
          geometry,
        });
        expect(result.kind).toBe("output");
        if (result.kind !== "output") throw new Error(JSON.stringify(result));
        expect(result.output.length).toBe(36 * 96 * 96);
        expect(
          result.output.every((value, i) => {
            const z = Math.floor(i / (96 * 96)) + 6;
            const y = (Math.floor(i / 96) % 96) + 16;
            const x = (i % 96) + 16;
            return (
              value ===
              (Math.floor(z / 2) * 64 + Math.floor(y / 2)) * 64 +
                Math.floor(x / 2)
            );
          }),
        ).toBe(true);
      }
    } finally {
      worker.terminate();
    }
  }, 30000);

  it.each([undefined, "float16"] as const)(
    "loads a local deterministic ONNX on CPU with precision=%s, crops all channels and reuses the session",
    async (precision) => {
      const bytes = await (
        await fetch(
          new URL("../../testdata/inference/concat.onnx", import.meta.url),
        )
      ).arrayBuffer();
      const controller = new OnnxInferenceController();
      try {
        const metadata = await controller.loadModel(
          new File([bytes], "concat.onnx"),
          "cpu",
          undefined,
          precision,
        );
        expect(metadata).toMatchObject({
          requestedPrecision: precision ?? "float32",
          actualPrecision: "float32",
        });
        expect(metadata.precisionFallbackReason).toBe(
          precision === "float16"
            ? "FP16 is GPU-only; CPU uses FP32"
            : undefined,
        );
        expect(metadata.requestedProvider).toBe("cpu");
        expect(metadata.actualProvider).toBe("wasm");
        expect(metadata.outputShape).toEqual([1, 4, 20, 80, 80]);
        expect(metadata.threads).toBe(1);
        const input: PreparedInferenceInput = {
          originZYX: [0, 0, 0],
          shapeZYX: [20, 80, 80],
          spacingZYX: [40, 16, 16],
          axisNamesZYX: ["z", "y", "x"],
          unitsZYX: ["m", "m", "m"],
          validitySnapshot: {} as PreparedInferenceInput["validitySnapshot"],
          isValid: () => true,
          assertValid() {},
          dispose() {},
          async readPatch() {
            return Float32Array.from({ length: 20 * 80 * 80 }, (_, i) => i);
          },
        };
        const run = () =>
          controller.run(input, {
            originZYX: [2, 10, 10],
            shapeZYX: [16, 60, 60],
          });
        const first = await run();
        const second = await run();
        expect(first.provenance).not.toHaveProperty("preprocessing");
        expect(second.data).toEqual(first.data);
        let i = 0;
        for (let c = 0; c < 4; ++c)
          for (let z = 2; z < 18; ++z)
            for (let y = 10; y < 70; ++y)
              for (let x = 10; x < 70; ++x) {
                expect(first.data[i++]).toBe((z * 80 + y) * 80 + x);
              }
      } finally {
        controller.dispose();
      }
    },
    30000,
  );
});
