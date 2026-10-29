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

/* global window, Worker, fetch */

/**
 * Real production-worker provider smoke, served beneath /app/.
 * Run after npm run build:
 *   CHROME=/usr/bin/google-chrome node tests/inference/provider_production.mjs
 * This checks unavailable-GPU Auto fallback by default. To require hardware:
 *   HEADFUL=1 CHROME=/usr/bin/google-chrome node tests/inference/provider_production.mjs
 * On Linux set WAYLAND_DISPLAY/XDG_RUNTIME_DIR for a working desktop session.
 * MODEL=/absolute/path/nooverseg.onnx checks automatic in-worker preparation of
 * the original model: strict/Auto WebGPU match the original CPU reference.
 * PREPARED_MODEL=/absolute/path/nooverseg-jsep.onnx additionally checks the
 * prepared model against MODEL on two inputs (MODEL is required). Hardware runs
 * require strict/Auto GPU execution; no-GPU runs check visible CPU fallback.
 * ISOLATED=1 deliberately serves strict COOP/COEP headers as a regression
 * fixture; ISOLATED=0 uses auth-compatible headers. Both must use one WASM thread.
 * Numerical bounds below are regression checks, not training-accuracy validation.
 */
import assert from "node:assert/strict";
import console from "node:console";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dist = path.join(root, "dist/client");
const headful = process.env.HEADFUL === "1";
assert(
  !process.env.PREPARED_MODEL || process.env.MODEL,
  "PREPARED_MODEL requires the original MODEL reference",
);
const requests = [];
let workerFile;
for (const file of await fs.readdir(dist)) {
  if (!file.endsWith(".js")) continue;
  if (
    (await fs.readFile(path.join(dist, file), "utf8")).includes(
      "Input length/type does not match model NCDHW metadata",
    )
  ) {
    assert.equal(workerFile, undefined, "ambiguous inference worker bundle");
    workerFile = file;
  }
}
assert(workerFile, "build the production client first");
const server = http.createServer(async (req, res) => {
  try {
    if (process.env.ISOLATED === "1") {
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    } else {
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
      res.setHeader("Cross-Origin-Embedder-Policy", "unsafe-none");
    }
    const url = new URL(req.url, "http://localhost").pathname;
    requests.push(url);
    if (url === "/") {
      res.setHeader("Content-Type", "text/html");
      res.end("<html>Production inference provider smoke</html>");
      return;
    }
    let file;
    if (url === "/concat.onnx")
      file = path.join(root, "testdata/inference/concat.onnx");
    else if (url === "/model.onnx" && process.env.MODEL)
      file = process.env.MODEL;
    else if (url === "/prepared.onnx" && process.env.PREPARED_MODEL)
      file = process.env.PREPARED_MODEL;
    else {
      assert(url.startsWith("/app/") && !url.includes(".."));
      file = path.join(dist, url.slice(5));
    }
    res.setHeader(
      "Content-Type",
      file.endsWith(".wasm")
        ? "application/wasm"
        : /\.[cm]?js$/.test(file)
          ? "text/javascript"
          : "application/octet-stream",
    );
    res.end(await fs.readFile(file));
  } catch (error) {
    res.statusCode = 404;
    res.end(String(error));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({
    ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}),
    headless: !headful,
    ignoreDefaultArgs: ["--enable-unsafe-swiftshader"],
    args: headful
      ? [
          "--no-sandbox",
          "--enable-unsafe-webgpu",
          ...(process.env.WAYLAND_DISPLAY ? ["--ozone-platform=wayland"] : []),
        ]
      : ["--no-sandbox", "--disable-gpu", "--disable-features=WebGPU"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(
    async ({ workerFile, headful, realModel, preparedModel, isolated }) => {
      const check = (value, message) => {
        if (!value) throw new Error(message);
      };
      check(
        window.crossOriginIsolated === isolated,
        "unexpected cross-origin isolation",
      );
      const geometry = {
        inputShape: [20, 80, 80],
        inputSpacing: [40, 16, 16],
        rawOutputShape: [20, 80, 80],
        outputSpacing: [40, 16, 16],
        rawOutputOrigin: [0, 0, 0],
        cropBefore: [2, 10, 10],
        cropAfter: [2, 10, 10],
        outputChannels: 4,
      };
      const runCase = async (model, provider, varied = false) => {
        // Webpack emits this entry as a classic worker (as in the built controller).
        const worker = new Worker(`/app/${workerFile}`);
        let id = 0;
        const request = (data) =>
          new Promise((resolve, reject) => {
            const timer = window.setTimeout(
              () => reject(new Error("Inference worker timed out")),
              120000,
            );
            worker.onerror = (event) => {
              window.clearTimeout(timer);
              reject(new Error(event.message));
            };
            worker.onmessage = ({ data }) => {
              window.clearTimeout(timer);
              resolve(data);
            };
            worker.postMessage({ ...data, id: ++id });
          });
        try {
          const load = await request({
            kind: "load",
            provider,
            model: await (await fetch(model)).arrayBuffer(),
          });
          if (load.kind === "error") return { load, runs: [] };
          check(load.kind === "loaded", "missing load response");
          check(
            load.metadata?.threads === 1,
            "WASM must stay single-threaded even when isolated",
          );
          const runs = [];
          for (let i = 0; i < 2; ++i) {
            const response = await request({
              kind: "run",
              input: Float32Array.from({ length: 20 * 80 * 80 }, (_, j) =>
                varied && i === 1
                  ? 0.5 + 0.25 * Math.sin(j * 0.01) + 0.25 * Math.cos(j * 0.001)
                  : (j % 1024) / 1024,
              ),
              geometry,
            });
            runs.push(response);
            if (response.kind === "error") break;
            check(response.kind === "output", "missing output response");
            check(response.metadata?.threads === 1, "wrong WASM thread count");
            check(
              response.output.length === 4 * 16 * 60 * 60,
              "wrong crop size",
            );
            check(response.output.every(Number.isFinite), "non-finite output");
          }
          return { load, runs };
        } finally {
          worker.terminate();
        }
      };
      const cpu = await runCase("/concat.onnx", "cpu");
      check(cpu.runs.length === 2, "CPU inference failed");
      const expected = cpu.runs[0].output;
      let i = 0;
      for (let c = 0; c < 4; ++c)
        for (let z = 2; z < 18; ++z)
          for (let y = 10; y < 70; ++y)
            for (let x = 10; x < 70; ++x)
              check(
                expected[i++] === (((z * 80 + y) * 80 + x) % 1024) / 1024,
                "CPU crop/axis values differ from reference",
              );
      const strict = await runCase("/concat.onnx", "webgpu");
      const auto = await runCase("/concat.onnx", "auto");
      const compare = (test, reference) => {
        check(
          test.runs.length === 2,
          `Session was not reused: ${JSON.stringify(test.runs.map(({ kind, message, metadata }) => ({ kind, message, metadata })))}`,
        );
        for (const run of test.runs) {
          check(run.kind === "output", `Inference failed: ${run.message}`);
          check(
            run.output.length === reference.length,
            "output length mismatch",
          );
          check(
            run.output.every((v, i) => v === reference[i]),
            "output mismatch",
          );
        }
      };
      if (headful) {
        check(
          strict.load.metadata?.actualProvider === "webgpu",
          "strict GPU load failed",
        );
        compare(strict, expected);
        check(
          [...strict.runs, ...auto.runs].every(
            (run) => run.metadata?.actualProvider === "webgpu",
          ),
          "fixture execution did not remain on GPU",
        );
        check(
          auto.load.metadata?.actualProvider === "webgpu",
          "Auto did not select GPU",
        );
      } else {
        check(strict.load.kind === "error", "strict GPU silently fell back");
        check(
          auto.load.metadata?.actualProvider === "wasm",
          "Auto did not fall back",
        );
        check(
          auto.load.metadata?.fallbackReason,
          "missing CPU fallback reason",
        );
      }
      compare(auto, expected);
      const compareModel = (
        candidate,
        reference,
        actualProvider,
        tolerance,
      ) => {
        check(
          reference.runs.length === 2 && candidate.runs.length === 2,
          "real-model session was not reused",
        );
        return candidate.runs.map((run, index) => {
          check(run.kind === "output", `Real model failed: ${run.message}`);
          check(
            run.metadata?.actualProvider === actualProvider,
            "unexpected real-model provider",
          );
          const expected = reference.runs[index].output;
          check(expected?.length === run.output.length, "model shape mismatch");
          let maxAbs = 0,
            sumAbs = 0;
          for (let i = 0; i < expected.length; ++i) {
            const diff = Math.abs(expected[i] - run.output[i]);
            maxAbs = Math.max(maxAbs, diff);
            sumAbs += diff;
          }
          const meanAbs = sumAbs / expected.length;
          check(
            maxAbs <= tolerance.max && meanAbs <= tolerance.mean,
            `Model regression: max ${maxAbs}, mean ${meanAbs}`,
          );
          return { maxAbs, meanAbs, runMs: run.runMs, metadata: run.metadata };
        });
      };
      let real, reference;
      if (realModel) {
        reference = await runCase("/model.onnx", "cpu", true);
        check(reference.runs[0]?.kind === "output", "real model CPU failed");
        check(!reference.load.metadata.preparation, "CPU changed the model");
        const automatic = await runCase("/model.onnx", "auto", true);
        const strict = await runCase("/model.onnx", "webgpu", true);
        const actual = headful ? "webgpu" : "wasm";
        const tolerance = headful
          ? { max: 0.01, mean: 0.001 }
          : { max: 0, mean: 0 };
        const auto = compareModel(automatic, reference, actual, tolerance);
        if (headful) {
          compareModel(strict, reference, "webgpu", tolerance);
          check(
            [...automatic.runs, ...strict.runs].every(
              (run) =>
                run.metadata.preparation === "nooverseg-jsep" &&
                !run.metadata.fallbackReason,
            ),
            "original model was not automatically prepared on GPU",
          );
        } else {
          check(strict.load.kind === "error", "strict GPU silently fell back");
          check(
            auto.every(
              (run) => run.metadata.fallbackReason && !run.metadata.preparation,
            ),
            "missing original-CPU fallback metadata",
          );
        }
        real = {
          auto,
          strict: strict.runs.map(({ metadata, runMs }) => ({
            metadata,
            runMs,
          })),
        };
      }
      let prepared;
      if (preparedModel) {
        const rewrittenCpu = await runCase("/prepared.onnx", "cpu", true);
        const rewrittenStrict = await runCase("/prepared.onnx", "webgpu", true);
        const rewrittenAuto = await runCase("/prepared.onnx", "auto", true);
        const comparePrepared = (candidate, actualProvider, tolerance) =>
          compareModel(candidate, reference, actualProvider, tolerance);
        check(
          !rewrittenAuto.load.metadata?.preparation &&
            !rewrittenCpu.load.metadata?.preparation,
          "already prepared file was rewritten again",
        );
        const cpu = comparePrepared(rewrittenCpu, "wasm", { max: 0, mean: 0 });
        let strict, auto;
        if (headful) {
          // Explicit bounds for these synthetic inputs, not semantic accuracy.
          const tolerance = { max: 0.01, mean: 0.001 };
          strict = comparePrepared(rewrittenStrict, "webgpu", tolerance);
          auto = comparePrepared(rewrittenAuto, "webgpu", tolerance);
          check(
            [...strict, ...auto].every((run) => !run.metadata.fallbackReason),
            "prepared GPU silently fell back",
          );
        } else {
          check(
            rewrittenStrict.load.kind === "error",
            "prepared strict GPU silently fell back",
          );
          auto = comparePrepared(rewrittenAuto, "wasm", { max: 0, mean: 0 });
          check(
            auto.every((run) => run.metadata.fallbackReason),
            "prepared CPU fallback reason missing",
          );
          strict = rewrittenStrict.load.message;
        }
        prepared = {
          referenceRunMs: reference.runs.map((run) => run.runMs),
          cpu,
          strict,
          auto,
        };
      }
      return {
        hardwareRequired: headful,
        crossOriginIsolated: window.crossOriginIsolated,
        cpu: cpu.load.metadata,
        strict: strict.load.metadata || strict.load.message,
        auto: auto.runs[0].metadata,
        realModel: real,
        preparedModel: prepared,
      };
    },
    {
      workerFile,
      headful,
      realModel: Boolean(process.env.MODEL),
      preparedModel: Boolean(process.env.PREPARED_MODEL),
      isolated: process.env.ISOLATED === "1",
    },
  );
  assert.deepEqual(errors, []);
  const wasmRequests = requests.filter((url) => url.endsWith(".wasm"));
  assert(wasmRequests.length > 0, "no WASM asset request observed");
  assert(wasmRequests.every((url) => url.startsWith("/app/")));
  console.log(JSON.stringify({ result, wasmRequests }, null, 2));
  console.log(
    "PASS: production provider selection, crop values, session reuse and fallback",
  );
} finally {
  await browser?.close();
  server.close();
}
