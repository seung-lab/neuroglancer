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

/** Real WASM + real dedicated worker, no mocked inference runtime. */
describe("browser inference worker", () => {
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
