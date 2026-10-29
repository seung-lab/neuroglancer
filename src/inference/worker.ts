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

import * as ort from "onnxruntime-web/webgpu";
import { cropNcdhwOutput } from "#src/inference/geometry.js";
import type {
  InferenceWorkerRequest,
  InferenceWorkerResponse,
} from "#src/inference/model.js";
import { validateModelGeometry } from "#src/inference/model.js";
import { ProviderSession } from "#src/inference/provider.js";

// Pin the native Asyncify pair to the installed ORT version for GPU and CPU.
// Fetch it independently of App Engine, only when this lazy worker is loaded.
// The onnxruntime-web-use-extern-wasm condition avoids embedding another factory.
const runtimeBase = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/";
ort.env.wasm.wasmPaths = {
  mjs: `${runtimeBase}ort-wasm-simd-threaded.asyncify.mjs`,
  wasm: `${runtimeBase}ort-wasm-simd-threaded.asyncify.wasm`,
};
// Isolated viewers can use a capped CPU pool; relaxed-header pages stay at one.
ort.env.wasm.numThreads = globalThis.crossOriginIsolated
  ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1))
  : 1;
ort.env.wasm.proxy = false;
const session = new ProviderSession(
  (model, options) => ort.InferenceSession.create(model, options),
  ort.env.wasm.numThreads!,
);

function reply(
  response: InferenceWorkerResponse,
  transfer: Transferable[] = [],
) {
  postMessage(response, { transfer });
}

async function handle(request: InferenceWorkerRequest) {
  const { id } = request;
  try {
    if (request.kind === "load") {
      const metadata = await session.load(
        request.model,
        request.provider,
        request.compatibilityFixes,
        request.precision,
      );
      reply({ id, kind: "loaded", metadata });
    } else {
      const metadata = session.metadata;
      if (metadata === undefined)
        throw new Error("Load a model before running inference");
      validateModelGeometry(metadata, request.geometry);
      if (
        !(request.input instanceof Float32Array) ||
        request.input.length !== metadata.inputShape.reduce((a, b) => a * b, 1)
      ) {
        throw new Error(
          "Input length/type does not match model NCDHW metadata",
        );
      }
      const tensor = new ort.Tensor("float32", request.input, [
        ...metadata.inputShape,
      ]);
      const start = performance.now();
      let outputs: ort.InferenceSession.ReturnType | undefined;
      try {
        outputs = await session.run({ [metadata.inputNames[0]]: tensor });
        // Auto may have replaced the GPU session with a validated CPU session.
        const current = session.metadata!;
        validateModelGeometry(current, request.geometry);
        const raw = outputs[current.outputNames[0]];
        if (
          raw === undefined ||
          raw.type !== "float32" ||
          !(raw.data instanceof Float32Array) ||
          raw.dims.length !== current.outputShape.length ||
          raw.dims.some((x, i) => x !== current.outputShape[i]) ||
          raw.data.length !== current.outputShape.reduce((a, b) => a * b, 1)
        ) {
          throw new Error("Runtime output does not match model NCDHW metadata");
        }
        for (const value of raw.data) {
          if (!Number.isFinite(value))
            throw new Error(
              "Model produced non-finite output; no result published",
            );
        }
        const output = cropNcdhwOutput(raw.data, request.geometry);
        reply(
          {
            id,
            kind: "output",
            output,
            runMs: performance.now() - start,
            metadata: session.metadata!,
          },
          [output.buffer],
        );
      } finally {
        tensor.dispose();
        if (outputs !== undefined)
          for (const output of Object.values(outputs)) output.dispose();
      }
    }
  } catch (error) {
    reply({
      id,
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
      metadata: session.metadata,
    });
  }
}

// Requests are serialized even when callers accidentally post concurrently.
let pending = Promise.resolve();
self.onmessage = (event: MessageEvent<InferenceWorkerRequest>) => {
  pending = pending.then(() => handle(event.data));
};
