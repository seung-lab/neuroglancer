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

/* global window, document, CustomEvent, fetch */

/**
 * Production browser integration smoke. Run after `npm run build`:
 * CHROME=/usr/bin/google-chrome node tests/inference/live_production.mjs
 * BUNDLED_MODEL=1 checks the default external HTTPS model without overriding
 * its URL or intercepting downloads (the historical smoke-mode name is retained).
 * Opening the dialog stays idle; clicking Load model URL starts the download.
 * MODEL=/absolute/path/nooverseg.onnx optionally serves a real model over HTTP
 * and loads its URL (finite output/navigation, not numerical reference accuracy).
 * REFERENCE_MODEL=/absolute/path/nooverseg.onnx additionally compares the first
 * displayed blended chunk to CPU execution of every contributing input patch.
 * Asserts the UI overlap default is off, then explicitly enables blending.
 * SCREENSHOT=/tmp/inference.png saves the adjacent source/result views.
 * PROVIDER=cpu|auto|webgpu (default cpu). LAUNCH_OPTIONS is optional JSON
 * Playwright launch overrides for a separately configured hardware GPU browser.
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../../", import.meta.url));
const bundled = process.env.BUNDLED_MODEL === "1";
const defaultModelUrl =
  "https://storage.googleapis.com/zetta-research-kisuk/hammerschmith_mouse_mec/DeepEM/experiments/260225-MEC-finetune-v1-mec+cutout1-8nm-updown2x-no-overseg-x0/models/aff3_mye1/model300000.onnx";
const deterministic = !bundled && !process.env.MODEL;
const provider = process.env.PROVIDER || (bundled ? "auto" : "cpu");
assert(["auto", "webgpu", "cpu"].includes(provider));
const model = bundled
  ? "model300000.onnx"
  : process.env.MODEL || path.join(root, "testdata/inference/concat.onnx");
// Only same-origin requests reach the local HTTP server. Observe the external
// model independently via Playwright, without routing or mocking its download.
const requests = [];
const modelPath = "/models/custom.onnx";
const origin = [-31, 53, 107],
  size = [800, 440, 84];
// Independent fixture oracle in native XYZ (worker tensors are ZYX). Input
// contexts are source-anchored, not live-chunk-anchored, and are never padded.
const inputShape = [80, 80, 20],
  inputStride = [40, 40, 10],
  crop = [10, 10, 2],
  liveShape = [60, 60, 16];
/** Literal Chunkflow patch_mask.py oracle, independent of app geometry/masks.
 * Work in ZYX with X contiguous; simulate the reference's full 3×3×3 addition
 * rather than sharing the app's periodic-normalization implementation. */
function makeChunkflowWuMask(patchSize, stride) {
  const [nz, ny, nx] = patchSize;
  const [sz, sy, sx] = stride;
  const bump = new Float64Array(nz * ny * nx);
  let min = Infinity,
    max = -Infinity;
  for (let z = 0; z < nz; ++z)
    for (let y = 0; y < ny; ++y)
      for (let x = 0; x < nx; ++x) {
        const xv = ((x + 1) / (nx + 1)) * 2 - 1;
        const yv = ((y + 1) / (ny + 1)) * 2 - 1;
        const zv = ((z + 1) / (nz + 1)) * 2 - 1;
        const value = Math.exp(
          -1 / (1 - xv * xv) + -1 / (1 - yv * yv) + -1 / (1 - zv * zv),
        );
        bump[(z * ny + y) * nx + x] = value;
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
  // np.interp(bump, (bump.min(), bump.max()), (1, 1e6)).
  const slope = (1e6 - 1) / (max - min);
  for (let i = 0; i < bump.length; ++i)
    bump[i] = bump[i] === max ? 1e6 : 1 + (bump[i] - min) * slope;
  const by = ny + 2 * sy,
    bx = nx + 2 * sx;
  const base = new Float64Array((nz + 2 * sz) * by * bx);
  for (let oz = 0; oz < 3; ++oz)
    for (let oy = 0; oy < 3; ++oy)
      for (let ox = 0; ox < 3; ++ox)
        for (let z = 0; z < nz; ++z)
          for (let y = 0; y < ny; ++y)
            for (let x = 0; x < nx; ++x)
              base[((oz * sz + z) * by + oy * sy + y) * bx + ox * sx + x] +=
                bump[(z * ny + y) * nx + x];
  const mask = new Float32Array(bump.length);
  for (let z = 0; z < nz; ++z)
    for (let y = 0; y < ny; ++y)
      for (let x = 0; x < nx; ++x) {
        const i = (z * ny + y) * nx + x;
        mask[i] = bump[i] / base[((sz + z) * by + sy + y) * bx + sx + x];
      }
  assert(mask.every((w) => Number.isFinite(w) && w > 0 && w <= 1));
  assert(mask[0] < 0.001, "wu corners must not be uniform weights");
  assert.equal(mask[((nz / 2) * ny + ny / 2) * nx + nx / 2], 1);
  return mask;
}
const wuMask = makeChunkflowWuMask(
  [...liveShape].reverse(),
  [...inputStride].reverse(),
);
const contextCounts = size.map(
  (n, axis) => Math.floor((n - inputShape[axis]) / inputStride[axis]) + 1,
);
const outputOrigin = origin.map((n, axis) => n + crop[axis]);
const liveFullShape = contextCounts.map(
  (n, axis) =>
    Math.floor(
      ((n - 1) * inputStride[axis] + liveShape[axis]) / liveShape[axis],
    ) * liveShape[axis],
);
assert.deepEqual(outputOrigin, [-21, 63, 109]);
assert.deepEqual(liveFullShape, [780, 420, 64]);
const contributors = (key) => {
  const grid = key.split(",").map(Number);
  assert.equal(grid.length, 4);
  assert.equal(grid[3], 0);
  const axes = origin.map((start, axis) => {
    assert(Number.isInteger(grid[axis]) && grid[axis] >= 0);
    assert((grid[axis] + 1) * liveShape[axis] <= liveFullShape[axis]);
    const lo = outputOrigin[axis] + grid[axis] * liveShape[axis];
    return Array.from(
      { length: contextCounts[axis] },
      (_, i) => start + i * inputStride[axis],
    ).filter(
      (p) =>
        p + crop[axis] < lo + liveShape[axis] &&
        p + crop[axis] + liveShape[axis] > lo,
    );
  });
  // The controller traverses Z, Y, X, including contexts whose retained crops
  // extend beyond the requested chunk or the published full-chunk bounds.
  const patches = axes[2].flatMap((z) =>
    axes[1].flatMap((y) => axes[0].map((x) => [x, y, z])),
  );
  assert(patches.length > 0 && patches.length <= 27);
  return patches;
};
const contributorRuns = (keys) =>
  keys.reduce((sum, key) => sum + contributors(key).length, 0);
const patchKeys = (keys) =>
  new Set(keys.flatMap((key) => contributors(key).map((p) => p.join(","))));
// Four float32 channels per retained crop, not full model output tensors.
const patchBytes = liveShape.reduce((a, b) => a * b, 4 * 4);
const patchCacheBudget = 128 * 1024 * 1024;
// Edge and interior fixtures guard the oracle itself, independently of the UI.
assert.equal(contributors("0,0,0,0").length, 8);
assert.equal(contributors("2,2,2,0").length, 27);
assert.equal(contributors("12,6,3,0").length, 12);
let delay = 0;
const server = http.createServer(async (req, res) => {
  try {
    requests.push({ method: req.method, url: req.url });
    const p = new URL(req.url, "http://localhost").pathname;
    if (p === modelPath && !bundled) {
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Cache-Control", "no-store");
      res.end(await fs.readFile(model));
      return;
    }
    if (p === "/reference.onnx" && process.env.REFERENCE_MODEL) {
      res.end(await fs.readFile(process.env.REFERENCE_MODEL));
      return;
    }
    if (p === "/source/info") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          type: "image",
          data_type: "uint8",
          num_channels: 1,
          scales: [
            {
              key: "native",
              size,
              resolution: [16, 16, 40],
              voxel_offset: origin,
              chunk_sizes: [[32, 32, 16]],
              encoding: "raw",
            },
          ],
        }),
      );
      return;
    }
    const m =
      /^\/source\/native\/(-?\d+)-(-?\d+)_(-?\d+)-(-?\d+)_(-?\d+)-(-?\d+)$/.exec(
        p,
      );
    if (m) {
      const [x0, x1, y0, y1, z0, z1] = m.slice(1).map(Number);
      const out = Buffer.alloc((x1 - x0) * (y1 - y0) * (z1 - z0));
      let i = 0;
      for (let z = z0; z < z1; ++z)
        for (let y = y0; y < y1; ++y)
          for (let x = x0; x < x1; ++x)
            out[i++] = (((x * 3 + y * 5 + z * 7) % 251) + 251) % 251;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      res.end(out);
      return;
    }
    assert(p.startsWith("/app/"));
    const rel = p === "/app/" ? "index.html" : p.slice(5);
    assert(!rel.includes(".."));
    const f = path.join(root, "dist/client", rel);
    const mime = {
      ".js": "text/javascript",
      ".mjs": "text/javascript",
      ".wasm": "application/wasm",
      ".html": "text/html",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".json": "application/json",
    };
    res.setHeader(
      "Content-Type",
      mime[path.extname(f)] || "application/octet-stream",
    );
    res.end(await fs.readFile(f));
  } catch (error) {
    res.statusCode = 404;
    res.end(String(error));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({
    ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}),
    headless: true,
    args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
    ...JSON.parse(process.env.LAUNCH_OPTIONS || "{}"),
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 1000 },
  });
  const externalModelRequests = [];
  page.on("request", (request) => {
    if (request.url() === defaultModelUrl) externalModelRequests.push(request);
  });
  const assertDefaultModelRequests = () => {
    assert.equal(
      externalModelRequests.length,
      1,
      "default model fetched exactly once across provider/worker reloads and lifecycle",
    );
    assert.equal(externalModelRequests[0].method(), "GET");
    assert(
      !requests.some((x) => x.url.startsWith("/app/models/")),
      "no shipped model assets requested",
    );
  };
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (/Error retrieving chunk|Inference failed/.test(message.text()))
      errors.push(message.text());
  });
  await page.addInitScript(() => {
    const Original = window.Worker;
    window.inferenceReference = { Worker: Original };
    window.probe = {
      runs: 0,
      loads: 0,
      outputs: 0,
      terminations: 0,
      active: 0,
      maxActive: 0,
      outputsAtLastTermination: 0,
    };
    window.Worker = class extends Original {
      constructor(...args) {
        super(...args);
        this.inference = false;
        this.pendingRuns = new Set();
        this.workerUrl = args[0];
        this.addEventListener("message", ({ data }) => {
          if (data.metadata) window.probe.metadata = data.metadata;
          if (
            (data.kind === "output" || data.kind === "error") &&
            this.pendingRuns.delete(data.id)
          ) {
            if (data.kind === "output") ++window.probe.outputs;
            --window.probe.active;
          }
        });
      }
      postMessage(data, ...args) {
        if (data.kind === "load") {
          this.inference = true;
          ++window.probe.loads;
          window.inferenceReference.workerUrl = this.workerUrl;
        }
        if (this.inference && data.kind === "run") {
          // Geometry is small and invariant; do not retain transferred tensors.
          window.inferenceReference.geometry ??= data.geometry;
          ++window.probe.runs;
          ++window.probe.active;
          this.pendingRuns.add(data.id);
          window.probe.maxActive = Math.max(
            window.probe.maxActive,
            window.probe.active,
          );
        }
        return super.postMessage(data, ...args);
      }
      terminate() {
        if (this.inference) {
          ++window.probe.terminations;
          window.probe.outputsAtLastTermination = window.probe.outputs;
        }
        window.probe.active -= this.pendingRuns.size;
        this.pendingRuns.clear();
        return super.terminate();
      }
    };
  });
  const status = page.locator("[role=status]");
  const position = async (p) =>
    page.evaluate((p) => {
      window.viewer.position.value = Float32Array.from(p);
    }, p);
  const probe = () => page.evaluate(() => ({ ...window.probe }));
  const cachedKeys = () =>
    page.evaluate(() => [...window.liveSource.chunks.keys()]);
  const assertDemand = async (
    current,
    before = { runs: 0, outputs: 0 },
    keysBefore = [],
    retainedOutputs,
  ) => {
    const keys = await cachedKeys();
    assert(
      keysBefore.every((key) => keys.includes(key)),
      "chunks stay cached",
    );
    const added = keys.filter((key) => !keysBefore.includes(key));
    const needed = patchKeys(added);
    const previous = patchKeys(keysBefore);
    const runs = current.runs - before.runs;
    assert.equal(
      current.outputs - before.outputs,
      runs,
      "settled, uncanceled demand completes every worker run",
    );
    assert(
      runs <= contributorRuns(added),
      "only contributors of newly demanded chunks may execute, never a volume scan",
    );
    if (retainedOutputs === undefined) {
      const fresh = [...needed].filter((key) => !previous.has(key)).length;
      assert(runs >= fresh, "every previously unseen context must execute");
      // In these cold-start / uninterrupted intervals, all successful contexts
      // remain reusable when the entire union fits the cropped-patch budget.
      const union = new Set([...previous, ...needed]);
      if (union.size * patchBytes <= patchCacheBudget)
        assert.equal(runs, fresh, "shared cropped predictions are reused");
    } else {
      // Cancellation clears patches, but idle Stop/Start retains them. Neither
      // partial successful predictions nor an earlier publication's patch cache
      // can be reconstructed from this publication's chunk keys. At most this
      // many outputs since the last termination can remain cached.
      assert(
        runs >= Math.max(0, needed.size - retainedOutputs),
        "demand executes contexts not covered by retained successful predictions",
      );
    }
    return keys;
  };
  // Wait for the requested visible tiles, including reads before worker.run.
  const settle = async () => {
    // Allow the worker demand/progress round-trip after navigation. Frontend
    // source.chunks alone omits downloads that have not arrived yet.
    await page.waitForTimeout(500);
    await page.waitForFunction(
      () => {
        const layer = window.viewer.layerManager.managedLayers[1]?.layer;
        const render = layer?.renderLayers[0];
        const stats = render?.layerChunkProgressInfo;
        if (
          !stats?.numVisibleChunksNeeded ||
          stats.numVisibleChunksAvailable !== stats.numVisibleChunksNeeded
        )
          return false;
        const source = render?.visibleSources?.keys().next().value;
        if (!source || source.chunks.size === 0) return false;
        window.liveSource = source;
        return (
          window.probe.active === 0 &&
          [...source.chunks.values()].every((c) => c.data?.length)
        );
      },
      {},
      { timeout: 120000 },
    );
    // Chunk requests and browser rendering cross multiple event loops.
    let last = -1;
    for (let n = 0; n < 120; ++n) {
      await page.waitForTimeout(250);
      const p = await probe();
      assert.equal(p.maxActive, 1, "no concurrent runs or queued worker FIFO");
      if (p.runs === last && p.active === 0) return;
      last = p.runs;
    }
    throw new Error("Live inference did not settle");
  };
  const verifyChunks = async () => {
    const result = await page.evaluate(
      ({ deterministic }) => {
        let count = 0;
        for (const [key, chunk] of window.liveSource.chunks) {
          const grid = key.split(",").map(Number);
          if (
            grid[3] !== 0 ||
            String([...chunk.chunkDataSize]) !== "60,60,16,4"
          )
            throw new Error("tile grid/shape");
          const data = chunk.data;
          if (data?.length !== 4 * 16 * 60 * 60)
            throw new Error("incomplete tile");
          let i = 0;
          for (let c = 0; c < 4; ++c)
            for (let z = 0; z < 16; ++z)
              for (let y = 0; y < 60; ++y)
                for (let x = 0; x < 60; ++x) {
                  const value = data[i++];
                  if (!Number.isFinite(value))
                    throw new Error("nonfinite output");
                  if (deterministic) {
                    // Global output centers: native origin + crop + fixed tile stride.
                    const gx = -21 + grid[0] * 60 + x,
                      gy = 63 + grid[1] * 60 + y,
                      gz = 109 + grid[2] * 16 + z;
                    const expected =
                      (((gx * 3 + gy * 5 + gz * 7) % 251) + 251) % 251;
                    // Identical context predictions survive wu weighting up to
                    // floating-point roundoff, not necessarily bit-for-bit. This
                    // fixture checks placement/channels, not distinct-context
                    // blend semantics (covered by core/golden tests and below).
                    const tolerance = 1e-5 + Math.abs(expected) * 1e-7;
                    if (Math.abs(value - expected) > tolerance)
                      throw new Error(
                        `channel ${c} tile ${key}: ${value} != ${expected} (tol ${tolerance})`,
                      );
                  }
                }
          ++count;
        }
        return count;
      },
      { deterministic },
    );
    assert(result > 0);
    return result;
  };
  await page.goto(base + "/app/");
  await page.waitForFunction(() => window.viewer?.state);
  await page.evaluate(
    (url) =>
      window.viewer.state.restoreState({
        dimensions: { x: [16e-9, "m"], y: [16e-9, "m"], z: [40e-9, "m"] },
        position: [-1, 83, 117],
        crossSectionScale: 0.2,
        concurrentDownloads: 1,
        prefetch: false,
        layout: "xy",
        layers: [
          {
            type: "image",
            name: "raw",
            source: "precomputed://" + url + "/source",
          },
        ],
      }),
    base,
  );
  await page.waitForFunction(() =>
    window.viewer.layerManager.managedLayers[0]?.isReady(),
  );
  assert(
    !requests.some((x) => /onnx|inference_worker|\/models\//.test(x.url)),
    "runtime must be lazy",
  );
  assert.equal(
    externalModelRequests.length,
    0,
    "external model must not be fetched before opening inference",
  );
  await page.evaluate(() =>
    window.viewer.element.dispatchEvent(
      new CustomEvent("action:open-onnx-inference", { bubbles: true }),
    ),
  );
  const waitForModel = () =>
    page.waitForFunction(
      () =>
        document
          .querySelector("[role=status]")
          ?.textContent?.includes("Model ready"),
      {},
      { timeout: 120000 },
    );
  assert.equal(await page.locator('input[type="file"]').count(), 0);
  assert.equal(await page.getByLabel("Local model (.onnx)").count(), 0);
  const modelUrl = page.getByLabel("Model URL (.onnx)");
  assert.equal(await modelUrl.count(), 1);
  assert.equal(
    await modelUrl.evaluate((element) => element.tagName),
    "TEXTAREA",
  );
  assert.equal(await modelUrl.inputValue(), defaultModelUrl);
  const overlapToggle = page.getByLabel("Overlap and blend output patches", {
    exact: true,
  });
  assert.equal(await overlapToggle.isChecked(), false, "overlap defaults off");
  // Observe the idle dialog before any explicit load action in either mode.
  await page.waitForTimeout(500);
  assert.equal(
    externalModelRequests.length,
    0,
    "opening the dialog must not fetch the default model",
  );
  assert(
    !requests.some((x) => /onnx|inference_worker|\/models\//.test(x.url)),
    "opening the dialog must not fetch model or runtime assets",
  );
  assert.equal(
    await page.evaluate(() => window.probe.loads),
    0,
    "opening the dialog must not send a worker model load",
  );
  let initialLoads = 1;
  if (bundled) {
    await page
      .getByRole("button", { name: "Load model URL", exact: true })
      .click();
    await waitForModel();
    assertDefaultModelRequests();
    const response = await externalModelRequests[0].response();
    assert(response?.ok(), "real external model GET must succeed");
    assert.equal(
      await response.finished(),
      null,
      "external download completed",
    );
    // The prefilled URL is also the retry/reuse action for the verified default.
    // Reloading it must reuse downloaded bytes, not issue another external GET.
    await page
      .getByRole("button", { name: "Load model URL", exact: true })
      .click();
    await waitForModel();
    ++initialLoads;
    assertDefaultModelRequests();
    if (provider !== "auto") {
      await page
        .getByLabel("Execution provider", { exact: true })
        .selectOption(provider);
      await waitForModel();
      ++initialLoads;
      assertDefaultModelRequests();
    }
  } else {
    await page
      .getByLabel("Execution provider", { exact: true })
      .selectOption(provider);
    await modelUrl.fill(base + modelPath);
    await page
      .getByRole("button", { name: "Load model URL", exact: true })
      .click();
    await waitForModel();
    assert.equal(await modelUrl.inputValue(), base + modelPath);
  }
  if (
    process.env.COMPATIBILITY_FIXES === "1" ||
    process.env.EXPECT_PREPARATION === "1"
  ) {
    await page
      .getByLabel("Apply legacy JSEP padding fixes", { exact: true })
      .check();
    await waitForModel();
    ++initialLoads;
  }
  // Keep the independent half-input-stride/Wu oracle unchanged despite the UI
  // default: this lifecycle deliberately exercises overlapping contributors.
  await overlapToggle.setChecked(true);
  assert.equal(await overlapToggle.isChecked(), true);
  await page.getByLabel("Image source").selectOption("0");
  await page.getByLabel("Input scale X Y Z", { exact: true }).selectOption("0");
  const start = async () => {
    await page.getByLabel("I verified").check();
    await page.getByRole("button", { name: "Start live", exact: true }).click();
    await page.waitForFunction(
      () =>
        /^Live:|Inference failed/.test(
          document.querySelector("[role=status]")?.textContent || "",
        ),
      {},
      { timeout: 120000 },
    );
    assert.match(await status.textContent(), /^Live:/);
  };
  await start();
  await settle();
  const first = await probe();
  assert.equal(first.loads, initialLoads);
  assert.equal(first.metadata.requestedProvider, provider);
  if (provider !== "auto")
    assert.equal(
      first.metadata.actualProvider,
      provider === "cpu" ? "wasm" : "webgpu",
    );
  const providerStatus = await page
    .getByLabel("Execution provider status", { exact: true })
    .textContent();
  assert(providerStatus.includes(`Requested: ${provider}`));
  if (first.metadata.fallbackReason)
    assert(providerStatus.includes(first.metadata.fallbackReason));
  if (first.metadata.preparation)
    assert(
      providerStatus.includes(
        `Browser preparation: ${first.metadata.preparation}`,
      ),
    );
  if (process.env.EXPECT_PREPARATION === "1")
    assert.equal(first.metadata.preparation, "nooverseg-jsep");
  const firstCount = await verifyChunks();
  const firstKeys = await assertDemand(first);
  assert(
    firstCount <= 9,
    "visible demand must stay bounded, not scan the volume",
  );
  assert(first.runs > firstCount, "overlapping contributors must actually run");
  assert(
    first.runs < contributorRuns(firstKeys),
    "neighboring display chunks must reuse at least one cropped prediction",
  );
  assert(
    first.runs < contextCounts.reduce((a, b) => a * b, 1),
    "must not eagerly execute every source context",
  );
  console.log("Initial tiles verified", first);
  if (process.env.REFERENCE_MODEL) {
    // Recreate exact raw float32 inputs from the served fixture rather than
    // guessing patch origins from periodic uint8 data or retaining first-run
    // tensors (a single worker crop is NOT a displayed blended chunk).
    const key = firstKeys[0];
    const grid = key.split(",").map(Number);
    const comparison = await page.evaluate(
      async ({
        key,
        patches,
        chunkOrigin,
        inputShape,
        liveShape,
        crop,
        wuMask,
      }) => {
        const reference = window.inferenceReference;
        const displayed = window.liveSource.chunks.get(key)?.data;
        const volume = liveShape.reduce((a, b) => a * b, 1);
        if (!reference.geometry || displayed?.length !== 4 * volume)
          throw new Error("No complete displayed blended chunk");
        const worker = new reference.Worker(reference.workerUrl);
        let id = 0;
        const request = (data) =>
          new Promise((resolve, reject) => {
            const timer = window.setTimeout(
              () => reject(new Error("CPU reference timed out")),
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
          const loaded = await request({
            kind: "load",
            provider: "cpu",
            model: await (await fetch("/reference.onnx")).arrayBuffer(),
          });
          if (loaded.kind !== "loaded") throw new Error(loaded.message);
          // Independent wu weighted-sum/weight-sum oracle, including actual
          // available weights at source boundaries. Keep one input/output patch
          // at a time (at most 27 executions), not whole-volume tensors.
          const sums = new Float64Array(4 * volume);
          const weights = new Float64Array(volume);
          if (wuMask.length !== volume)
            throw new Error("CPU reference wu mask shape mismatch");
          const [nx, ny, nz] = liveShape;
          const [ix, iy, iz] = inputShape;
          for (const patchOrigin of patches) {
            const input = new Float32Array(ix * iy * iz);
            let i = 0;
            for (let z = 0; z < iz; ++z)
              for (let y = 0; y < iy; ++y)
                for (let x = 0; x < ix; ++x) {
                  const raw =
                    ((((patchOrigin[0] + x) * 3 +
                      (patchOrigin[1] + y) * 5 +
                      (patchOrigin[2] + z) * 7) %
                      251) +
                      251) %
                    251;
                  input[i++] = raw;
                }
            const result = await request({
              kind: "run",
              input,
              geometry: reference.geometry,
            });
            if (result.kind !== "output" || result.output.length !== 4 * volume)
              throw new Error(result.message || "Reference output mismatch");
            const start = patchOrigin.map((n, axis) => n + crop[axis]);
            for (let z = 0; z < nz; ++z)
              for (let y = 0; y < ny; ++y)
                for (let x = 0; x < nx; ++x) {
                  const px = chunkOrigin[0] + x - start[0];
                  const py = chunkOrigin[1] + y - start[1];
                  const pz = chunkOrigin[2] + z - start[2];
                  if (
                    px < 0 ||
                    px >= nx ||
                    py < 0 ||
                    py >= ny ||
                    pz < 0 ||
                    pz >= nz
                  )
                    continue;
                  const dst = (z * ny + y) * nx + x;
                  const src = (pz * ny + py) * nx + px;
                  const weight = wuMask[src];
                  weights[dst] += weight;
                  for (let c = 0; c < 4; ++c)
                    sums[c * volume + dst] +=
                      result.output[c * volume + src] * weight;
                }
          }
          if (weights.some((n) => n === 0))
            throw new Error("CPU reference left uncovered voxels");
          let maxAbs = 0,
            sumAbs = 0;
          for (let i = 0; i < sums.length; ++i) {
            const diff = Math.abs(sums[i] / weights[i % volume] - displayed[i]);
            maxAbs = Math.max(maxAbs, diff);
            sumAbs += diff;
          }
          return {
            key,
            patches: patches.length,
            maxAbs,
            meanAbs: sumAbs / sums.length,
            elements: sums.length,
          };
        } finally {
          worker.terminate();
        }
      },
      {
        key,
        patches: contributors(key),
        chunkOrigin: outputOrigin.map(
          (n, axis) => n + grid[axis] * liveShape[axis],
        ),
        inputShape,
        liveShape,
        crop,
        wuMask: Array.from(wuMask),
      },
    );
    assert(Number.isFinite(comparison.maxAbs) && comparison.maxAbs <= 0.01);
    assert(Number.isFinite(comparison.meanAbs) && comparison.meanAbs <= 0.001);
    console.log(
      "Displayed wu-blended chunk vs independent Chunkflow-mask original CPU reference",
      comparison,
    );
  }
  if (process.env.SCREENSHOT) {
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.screenshot({ path: process.env.SCREENSHOT });
    await page.evaluate(() =>
      window.viewer.element.dispatchEvent(
        new CustomEvent("action:open-onnx-inference", { bubbles: true }),
      ),
    );
  }
  const state = await page.evaluate(() => window.viewer.state.toJSON());
  assert.equal(state.layout.type, "row");
  assert.deepEqual(state.position, [-1, 83, 117]);
  await position([479, 263, 149]);
  await page.waitForFunction((n) => window.probe.runs > n, first.runs, {
    timeout: 120000,
  });
  await settle();
  const panned = await probe();
  assert.equal(panned.loads, initialLoads, "session reused");
  await verifyChunks();
  const pannedKeys = await assertDemand(panned, first, firstKeys);
  const panAddedKeys = pannedKeys.filter((key) => !firstKeys.includes(key));
  console.log("Pan demand", {
    initialKeys: firstKeys,
    addedKeys: panAddedKeys,
    addedChunks: panAddedKeys.length,
    contributorsPerChunk: panAddedKeys.map((key) => ({
      key,
      runs: contributors(key).length,
    })),
    addedRuns: panned.runs - first.runs,
  });
  // This 1280×1000 fixture's interior XY viewport requests a 3×4 chunk
  // rectangle (X=7..9, Y=1..4, Z=2). The initial view is clipped at the source
  // edges and only requests 2×2; a nine-chunk cap incorrectly rejects the pan.
  // Twelve remains a small demand bound versus 13×7×4 full-volume chunks;
  // assertDemand above also bounds runs to the newly demanded contributors.
  assert(
    panAddedKeys.length <= 12,
    "pan demand stays bounded to the XY viewport",
  );
  assert(panned.runs > first.runs);
  console.log("Pan tiles verified", panned);
  await position([-1, 83, 117]);
  await page.waitForTimeout(1000);
  assert.equal(
    (await probe()).runs,
    panned.runs,
    "return pan reuses cached chunks",
  );
  await page.evaluate(() => {
    window.viewer.crossSectionScale.value *= 0.8;
  });
  await page.waitForTimeout(1000);
  assert.equal(
    (await probe()).runs,
    panned.runs,
    "zoom in cannot retile/resample cached region",
  );
  assert(firstKeys.every((key) => key.endsWith(",0")));
  await verifyChunks();

  // Slow previously unseen native reads, then abandon the request. The single
  // download slot must not deadlock, and canceled work must not cache failures.
  delay = 1000;
  const oldRequests = requests.length;
  // Stay inside the full-chunk Z domain [109, 173), not the unpublished tail.
  await position([659, 413, 165]);
  await page.waitForFunction(() => window.viewer.position.value[0] === 659);
  for (let n = 0; requests.length === oldRequests && n < 50; ++n)
    await page.waitForTimeout(20);
  await page.waitForTimeout(300);
  await position([209, 163, 133]);
  delay = 0;
  await page.waitForFunction(
    (n) => window.probe.terminations > n,
    panned.terminations,
    { timeout: 30000 },
  );
  await settle();
  await verifyChunks();
  // The canceled interval can include partial contributor runs and reuse of
  // successful predictions. Require all previously unseen contexts to complete,
  // not one execution per contributor per chunk (which would forbid reuse).
  const afterCancel = await probe();
  const afterCancelKeys = await cachedKeys();
  assert(pannedKeys.every((key) => afterCancelKeys.includes(key)));
  const cancelNeeded = patchKeys(
    afterCancelKeys.filter((key) => !pannedKeys.includes(key)),
  );
  const beforeCancelPatches = patchKeys(pannedKeys);
  assert(
    afterCancel.outputs - panned.outputs >=
      [...cancelNeeded].filter((key) => !beforeCancelPatches.has(key)).length,
    "completed chunks include successful predictions for every new context",
  );
  assert(afterCancel.loads > panned.loads, "cancellation reloads the worker");
  const retainedAfterCancel =
    afterCancel.outputs - afterCancel.outputsAtLastTermination;
  assert(
    retainedAfterCancel > 0,
    "new demand succeeds after worker cancellation",
  );
  // Re-request the abandoned tile: cancellation must not have cached FAILED.
  await position([659, 413, 165]);
  await settle();
  await verifyChunks();
  const retried = await probe();
  await assertDemand(
    retried,
    afterCancel,
    afterCancelKeys,
    retainedAfterCancel,
  );
  assert(retried.runs > afterCancel.runs, "abandoned demand is retried");
  if (bundled) assertDefaultModelRequests();
  console.log("Canceled tiles successfully retried", retried);
  await page.getByRole("button", { name: "Stop live", exact: true }).click();
  await page.waitForFunction(
    () => window.viewer.layerManager.managedLayers.length === 1,
  );
  await page.waitForTimeout(500);
  assert.match(await status.textContent(), /stopped/);
  const stopped = await probe();
  await position([479, 263, 149]);
  await page.waitForTimeout(500);
  assert.equal(
    (await probe()).runs,
    stopped.runs,
    "Stop removes all result-group memberships",
  );

  // Normal Start/Stop can be repeated, and deleting the normal managed layer
  // must release the live session even when its adjacent panel retained it.
  const restartBefore = await probe();
  await start();
  await settle();
  await verifyChunks();
  // Idle Stop removed the displayed chunks, not the controller's predictions:
  // the same prepared input and geometry namespace can still reuse them.
  await assertDemand(
    await probe(),
    restartBefore,
    [],
    restartBefore.outputs - restartBefore.outputsAtLastTermination,
  );
  await page.evaluate(() => {
    const layer = window.viewer.layerManager.managedLayers[1];
    for (const manager of layer.containers) manager.removeManagedLayer(layer);
  });
  await page.waitForFunction(() =>
    document
      .querySelector("[role=status]")
      ?.textContent?.includes("Live result deleted"),
  );
  await page.waitForTimeout(500);
  assert.equal(
    await page.getByRole("button", { name: "Stop live", exact: true }).count(),
    0,
  );
  // Stop with a patch read pending, then invalidate the overlap settings.
  // No response from the previous publication may enter the new image cache.
  delay = 1000;
  await position([89, 383, 165]);
  await start();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Stop live", exact: true }).click();
  delay = 0;
  assert.equal(await overlapToggle.isChecked(), true);
  await overlapToggle.setChecked(false);
  assert.equal(await overlapToggle.isChecked(), false);
  assert.equal(await page.getByLabel("I verified").isChecked(), false);
  // Restore overlap for the independent contributor oracle below. Each setting
  // change must dispose the prior live namespace, even when toggled back.
  await overlapToggle.setChecked(true);
  assert.equal(await overlapToggle.isChecked(), true);
  const replacementBefore = await probe();
  await start();
  await settle();
  await verifyChunks();
  // Invalidated geometry must miss every old patch, even if idle Stop retained
  // the worker. Do not grant the same-namespace restart's retained-output credit.
  await assertDemand(await probe(), replacementBefore);
  console.log("Active stop/settings replacement verified", await probe());
  await page.getByLabel("Image source").selectOption("-1");
  await page.waitForFunction(
    () => window.viewer.layerManager.managedLayers.length === 1,
  );
  assert.equal(await page.getByLabel("I verified").isChecked(), false);
  await page.getByLabel("Image source").selectOption("0");
  await page.getByLabel("Input scale X Y Z", { exact: true }).selectOption("0");
  const sourceRestartBefore = await probe();
  await start();
  await settle();
  await verifyChunks();
  // Reselecting the source creates a new prepared input: require cold misses,
  // despite identical raw voxel values on the replacement input.
  await assertDemand(await probe(), sourceRestartBefore);
  await page.evaluate(() => window.viewer.state.reset());
  await page.waitForFunction(
    () => window.viewer.layerManager.managedLayers.length === 0,
  );
  await page.waitForTimeout(500);
  assert.equal(
    await page.getByRole("button", { name: "Stop live", exact: true }).count(),
    0,
  );
  assert(
    requests.every((x) => x.method === "GET"),
    "model and source bytes are only downloaded, never uploaded",
  );
  assert.equal(await page.locator('input[type="file"]').count(), 0);
  if (bundled) {
    assertDefaultModelRequests();
    assert(!requests.some((x) => x.url === modelPath));
  } else {
    assert.equal(
      requests.filter((x) => x.url === modelPath).length,
      1,
      "custom URL bytes fetched once across worker reloads and lifecycle",
    );
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        model: path.basename(model),
        bundled,
        provider,
        first,
        panned,
        final: await probe(),
        checked:
          "physical placement/all channels, source-global wu-blended overlapping contributors per chunk, cropped-patch reuse, lazy bounded demand, no concurrent worker FIFO, one-slot dependencies, cache, zoom, pan cancellation/retry, active stop/settings replacement, start/stop/delete/source/reset",
      },
      null,
      2,
    ),
  );
} catch (error) {
  // Print before teardown too, in case a browser/process failure delays close.
  console.error(error);
  throw error;
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
