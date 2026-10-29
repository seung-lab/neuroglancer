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

/* global window, document, location, CustomEvent */

/**
 * Reproducible inference sharing against the real production app/worker.
 * Run AFTER the recipe runtime/UI have been built with `npm run build`:
 *   CHROME=/usr/bin/google-chrome node tests/inference/share_production.mjs
 * HEADFUL=1 and LAUNCH_OPTIONS='{"...":...}' configure the browser as in the
 * other production smokes. PROVIDER=cpu|auto|webgpu defaults to deterministic CPU.
 *
 * A custom model URL is loaded and published through the real inference UI,
 * then its copied /app/#!JSON URL is opened in an isolated browser context.
 * Hand-constructed recipe restores also enter through ordinary URLs. No inference
 * module, session registry, or publish function is accessed. The Worker observer
 * forwards unmodified messages and only counts actual computation.
 * concat.onnx repeats the input into four channels; the oracle below is the
 * independently generated native XYZ uint8 source, not another inference run.
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dist = path.join(root, "dist/client");
const provider = process.env.PROVIDER || "cpu";
assert(["cpu", "auto", "webgpu"].includes(provider));
const timeout = 120000;
const resultName = "shared inference";
const origin = [-31, 53, 107];
const size = [800, 440, 84];
const spacing = [16e-9, 16e-9, 40e-9];
const liveOrigin = [-21, 63, 109];
const liveSize = [780, 420, 64];
const shader =
  "#uicontrol int channel slider(min=0, max=3, step=1, default=0)\nvoid main() { emitGrayscale(getDataValue(channel)); }";
const modelBytes = await fs.readFile(
  path.join(root, "testdata/inference/concat.onnx"),
);
const sha256 = createHash("sha256").update(modelBytes).digest("hex");

// Do not accidentally exercise an old session-only build, and never build here.
let hasRecipeBuild = false;
for (const file of await fs.readdir(dist)) {
  if (!file.endsWith(".js")) continue;
  if (
    (await fs.readFile(path.join(dist, file), "utf8")).includes(
      "inference://recipe",
    )
  ) {
    hasRecipeBuild = true;
    break;
  }
}
assert(
  hasRecipeBuild,
  "Production assets do not contain inference recipes; run npm run build after the runtime/UI changes",
);

const requests = [];
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost").pathname;
    requests.push({ method: req.method, url });
    res.setHeader("Cache-Control", "no-store");
    if (url === "/models/concat.onnx") {
      res.setHeader("Content-Type", "application/octet-stream");
      res.end(modelBytes);
      return;
    }
    if (url === "/models/missing.onnx") {
      res.statusCode = 404;
      res.end("Missing fixture model");
      return;
    }
    if (url === "/source/info" || url === "/replacement/info") {
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
    const match =
      /^\/(source|replacement)\/native\/(-?\d+)-(-?\d+)_(-?\d+)-(-?\d+)_(-?\d+)-(-?\d+)$/.exec(
        url,
      );
    if (match) {
      const [x0, x1, y0, y1, z0, z1] = match.slice(2).map(Number);
      assert(
        [x0, y0, z0].every((v, i) => v >= origin[i]) &&
          [x1, y1, z1].every((v, i) => v <= origin[i] + size[i]),
        "source requests stay inside the unpadded fixture",
      );
      const out = Buffer.alloc((x1 - x0) * (y1 - y0) * (z1 - z0));
      let i = 0;
      for (let z = z0; z < z1; ++z)
        for (let y = y0; y < y1; ++y)
          for (let x = x0; x < x1; ++x)
            out[i++] =
              match[1] === "replacement"
                ? 255
                : (((x * 3 + y * 5 + z * 7) % 251) + 251) % 251;
      res.end(out);
      return;
    }
    assert(url.startsWith("/app/") && !url.includes(".."));
    const file = path.join(dist, url === "/app/" ? "index.html" : url.slice(5));
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
      mime[path.extname(file)] || "application/octet-stream",
    );
    res.end(await fs.readFile(file));
  } catch (error) {
    res.statusCode = 404;
    res.end(String(error));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const modelGets = () =>
  requests.filter((r) => r.method === "GET" && r.url === "/models/concat.onnx")
    .length;
const sourceGets = () =>
  requests.filter((r) => r.url.startsWith("/source/native/")).length;
const recipe = {
  version: 1,
  profile: "nooverseg-ncdhw-native-grid-v1",
  source: {
    name: "original input",
    source: [{ url: `precomputed://${base}/source` }],
  },
  model: {
    kind: "url",
    name: "concat.onnx",
    urls: [`${base}/models/concat.onnx`],
    size: modelBytes.length,
    sha256,
  },
  provider,
  mode: "live",
  spacingZYX: [...spacing].reverse(),
};
const makeState = (recipe) => ({
  dimensions: {
    x: [spacing[0], "m"],
    y: [spacing[1], "m"],
    z: [spacing[2], "m"],
  },
  position: [-1, 83, 117],
  crossSectionScale: 0.2,
  concurrentDownloads: 1,
  prefetch: false,
  layout: "xy",
  layers: [
    // Same NAME as the original, but different DATA. Looking up the source by
    // layer name instead of reconstructing its snapshot produces wrong values.
    {
      type: "image",
      name: recipe.source?.name || "original input",
      source: `precomputed://${base}/replacement`,
      visible: false,
    },
    {
      type: "image",
      name: resultName,
      source: { url: "inference://recipe", state: recipe },
      shader,
      shaderControls: { channel: 2 },
      channelDimensions: { "c^": [1, ""] },
      opacity: 0.65,
    },
  ],
});
const stateUrl = (state) =>
  `${base}/app/#!${encodeURIComponent(JSON.stringify(state))}`;
const resultLayer = (state) => {
  const layer = state.layers.find((layer) => layer.name === resultName);
  assert(layer, "serialized result layer exists");
  return layer;
};
const recipeSource = (layer) => {
  const sources = Array.isArray(layer.source) ? layer.source : [layer.source];
  assert.equal(sources.length, 1);
  assert.equal(sources[0].url, "inference://recipe");
  return sources[0];
};
function verifyRecipeJson(state, expected) {
  const json = JSON.stringify(state);
  assert.deepEqual(json.match(/inference:\/\/[^"\s]+/g), [
    "inference://recipe",
  ]);
  assert(!/"(?:sessionId|resultId)"\s*:/i.test(json), "no session identifiers");
  assert(!json.includes("blob:"), "no context-local blob URLs");
  const layer = resultLayer(state);
  assert.deepEqual(recipeSource(layer).state, expected);
  return layer;
}
function verifyJson(state, expected) {
  const layer = verifyRecipeJson(state, expected);
  assert.equal(layer.shader, shader);
  assert.equal(layer.shaderControls.channel, 2);
  assert.deepEqual(layer.channelDimensions, { "c^": [1, ""] });
  assert.equal(layer.opacity, 0.65);
}

let browser;
const contexts = new Set();
try {
  const headful = process.env.HEADFUL === "1";
  browser = await chromium.launch({
    ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}),
    headless: !headful,
    args: [
      "--no-sandbox",
      ...(headful
        ? [
            "--enable-unsafe-webgpu",
            ...(process.env.WAYLAND_DISPLAY
              ? ["--ozone-platform=wayland"]
              : []),
          ]
        : ["--enable-unsafe-swiftshader"]),
    ],
    ...JSON.parse(process.env.LAUNCH_OPTIONS || "{}"),
  });
  const open = async (url, holdInput = false) => {
    const context = await browser.newContext({
      viewport: { width: 1000, height: 800 },
    });
    contexts.add(context);
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    let firstInput;
    if (holdInput) {
      firstInput = page.waitForRequest("**/source/native/**");
      await page.route("**/source/native/**", () => {});
    }
    const errors = [];
    page.on("pageerror", (error) => {
      errors.push(error.stack || String(error));
      console.error("PAGE_ERROR", error.stack || String(error));
    });
    // This must be installed before navigation, not after waiting for viewer:
    // the hash should start inference during main's initial restoration.
    await page.addInitScript(() => {
      const Original = window.Worker;
      window.shareProbe = {
        loads: 0,
        runs: 0,
        outputs: 0,
        active: 0,
        terminations: 0,
      };
      window.Worker = class extends Original {
        constructor(...args) {
          super(...args);
          this.inference = false;
          this.pendingRuns = new Set();
          this.addEventListener("message", ({ data }) => {
            if (data.metadata) window.shareProbe.metadata = data.metadata;
            if (
              (data.kind === "output" || data.kind === "error") &&
              this.pendingRuns.delete(data.id)
            ) {
              --window.shareProbe.active;
              if (data.kind === "output") ++window.shareProbe.outputs;
            }
          });
        }
        postMessage(data, ...args) {
          if (data.kind === "load") {
            this.inference = true;
            ++window.shareProbe.loads;
          }
          if (this.inference && data.kind === "run") {
            ++window.shareProbe.runs;
            ++window.shareProbe.active;
            this.pendingRuns.add(data.id);
          }
          return super.postMessage(data, ...args);
        }
        terminate() {
          if (this.inference) ++window.shareProbe.terminations;
          window.shareProbe.active -= this.pendingRuns.size;
          this.pendingRuns.clear();
          return super.terminate();
        }
      };
    });
    await page.goto(url);
    await page.waitForFunction(() => window.viewer?.state);
    return { context, page, errors, firstInput };
  };
  const probe = (page) => page.evaluate(() => ({ ...window.shareProbe }));
  const position = (page, p) =>
    page.evaluate((p) => {
      window.viewer.position.value = Float32Array.from(p);
    }, p);
  const settle = async (page) => {
    await page.waitForFunction(
      (name) => {
        const layer = window.viewer.layerManager.managedLayers.find(
          (layer) => layer.name === name,
        )?.layer;
        const render = layer?.renderLayers[0];
        const progress = render?.layerChunkProgressInfo;
        const source = render?.visibleSources?.keys().next().value;
        return (
          progress?.numVisibleChunksNeeded > 0 &&
          progress.numVisibleChunksAvailable ===
            progress.numVisibleChunksNeeded &&
          source?.chunks.size > 0 &&
          [...source.chunks.values()].every((chunk) => chunk.data?.length) &&
          window.shareProbe.active === 0 &&
          window.shareProbe.outputs > 0
        );
      },
      resultName,
      { timeout },
    );
    let previous = -1;
    for (let n = 0; n < 120; ++n) {
      await page.waitForTimeout(250);
      const current = await probe(page);
      if (current.runs === previous && current.active === 0) return current;
      previous = current.runs;
    }
    throw new Error("Shared inference did not settle");
  };
  const verifyOutput = async (page, recipe) => {
    assert.equal(recipe.mode, "live");
    assert.equal("preprocessing" in recipe, false);
    const outputOrigin = liveOrigin;
    const outputSize = liveSize;
    const result = await page.evaluate(
      ({ name, outputOrigin, outputSize }) => {
        const check = (condition, message) => {
          if (!condition) throw new Error(message);
        };
        const layer = window.viewer.layerManager.managedLayers.find(
          (layer) => layer.name === name,
        ).layer;
        const source = layer.renderLayers[0].visibleSources.keys().next().value;
        const { spec } = source;
        check(
          String([...spec.upperVoxelBound]) === String([...outputSize, 4]),
          "output bounds/channels",
        );
        const keys = [];
        let elements = 0;
        for (const [key, chunk] of source.chunks) {
          const grid = key.split(",").map(Number);
          const [nx, ny, nz, nc] = chunk.chunkDataSize;
          check(
            grid.length === 4 && grid[3] === 0 && nc === 4,
            "all-channel chunk grid",
          );
          check(String([nx, ny, nz]) === "60,60,16", "fixed live grid");
          check(
            chunk.data?.length === nx * ny * nz * 4,
            "complete output data",
          );
          let i = 0;
          for (let c = 0; c < 4; ++c)
            for (let z = 0; z < nz; ++z)
              for (let y = 0; y < ny; ++y)
                for (let x = 0; x < nx; ++x) {
                  const gx =
                    outputOrigin[0] + grid[0] * spec.chunkDataSize[0] + x;
                  const gy =
                    outputOrigin[1] + grid[1] * spec.chunkDataSize[1] + y;
                  const gz =
                    outputOrigin[2] + grid[2] * spec.chunkDataSize[2] + z;
                  const raw = (((gx * 3 + gy * 5 + gz * 7) % 251) + 251) % 251;
                  const expected = raw;
                  const actual = chunk.data[i++];
                  check(
                    Number.isFinite(actual) &&
                      Math.abs(actual - expected) <=
                        1e-5 + Math.abs(expected) * 1e-7,
                    `channel ${c} chunk ${key} XYZ ${gx},${gy},${gz}: ${actual} != ${expected}`,
                  );
                }
          elements += i;
          keys.push(key);
        }
        check(elements > 0, "actual output values verified");
        const transform =
          layer.dataSources[0].loadState.dataSource.modelTransform;
        return {
          keys,
          elements,
          names: transform.inputSpace.names,
          units: transform.inputSpace.units,
          scales: [...transform.inputSpace.scales],
          transform: [...transform.transform],
          channels: layer.channelSpace.value.numChannels,
        };
      },
      {
        name: resultName,
        outputOrigin,
        outputSize,
      },
    );
    assert.deepEqual(result.names, ["x", "y", "z", "c^"]);
    assert.deepEqual(result.units, ["m", "m", "m", ""]);
    result.scales.forEach((v, i) => {
      const expected = i === 3 ? 1 : spacing[i];
      assert(Math.abs(v - expected) <= Math.abs(expected) * 1e-12);
    });
    const transform = Array.from({ length: 25 }, (_, i) =>
      i % 6 === 0 ? 1 : 0,
    );
    transform.splice(20, 3, ...outputOrigin);
    assert.deepEqual(
      result.transform,
      transform,
      "native physical origin, no resampling",
    );
    assert.equal(result.channels, 4);
    return result;
  };
  const snapshot = (page) =>
    page.evaluate(() =>
      JSON.parse(JSON.stringify(window.viewer.state.toJSON())),
    );
  const copiedUrl = async (page, expected, verify = verifyJson) => {
    // Trigger a non-default navigation change so this also checks the app's
    // live URL binding rather than merely reading back the incoming fragment.
    const state = await snapshot(page);
    verify(state, expected);
    await page.waitForFunction(
      ({ position, name, expected }) => {
        try {
          const written = JSON.parse(
            decodeURIComponent(location.hash.slice(2)),
          );
          const layer = written.layers?.find((layer) => layer.name === name);
          const source = Array.isArray(layer?.source)
            ? layer.source[0]
            : layer?.source;
          return (
            JSON.stringify(written.position) === JSON.stringify(position) &&
            source?.url === "inference://recipe" &&
            JSON.stringify(source.state) === JSON.stringify(expected)
          );
        } catch {
          return false;
        }
      },
      {
        position: state.position,
        name: resultName,
        expected: recipeSource(resultLayer(state)).state,
      },
      { timeout: 10000 },
    );
    const url = page.url();
    assert(url.startsWith(`${base}/app/#!`));
    verify(
      JSON.parse(decodeURIComponent(new URL(url).hash.slice(2))),
      expected,
    );
    return url;
  };
  const remove = (page, name) =>
    page.evaluate((name) => {
      const layer = window.viewer.layerManager.managedLayers.find(
        (layer) => layer.name === name,
      );
      for (const manager of layer.containers) manager.removeManagedLayer(layer);
    }, name);
  const assertStopped = async (page, before) => {
    await page.waitForFunction(
      (n) =>
        window.shareProbe.terminations > n && window.shareProbe.active === 0,
      before.terminations,
      { timeout: 30000 },
    );
    const stopped = await probe(page);
    await position(page, [659, 313, 149]);
    await page.waitForTimeout(750);
    assert.equal(
      (await probe(page)).runs,
      stopped.runs,
      "disposed result cannot compute new demand",
    );
    assert.equal(
      (await probe(page)).loads,
      stopped.loads,
      "disposed result cannot reload its model",
    );
  };

  // Cover the producer, not only the recipe decoder: start with a plain image
  // and publish through the same URL controls and confirmation as a user.
  const uiRecipe = {
    ...recipe,
    version: 2,
    profile: "ncdhw-centered-v2",
    precision: "float32",
    compatibilityFixes: false,
    inputScaleIndex: 0,
    overlap: true,
    outputSpacingZYX: [...recipe.spacingZYX],
    source: { name: "shared", source: `precomputed://${base}/source` },
  };
  const uiGets = modelGets();
  const created = await open(
    stateUrl({
      ...makeState(recipe),
      layers: [
        {
          type: "image",
          name: uiRecipe.source.name,
          source: `precomputed://${base}/source`,
        },
      ],
    }),
  );
  await created.page.waitForFunction(() =>
    window.viewer.layerManager.managedLayers[0]?.isReady(),
  );
  assert.equal((await probe(created.page)).loads, 0, "runtime starts lazily");
  assert.equal(modelGets(), uiGets, "no custom model fetch before opening UI");
  await created.page.evaluate(() =>
    window.viewer.element.dispatchEvent(
      new CustomEvent("action:open-onnx-inference", { bubbles: true }),
    ),
  );
  assert.equal(await created.page.locator('input[type="file"]').count(), 0);
  assert.equal(await created.page.getByLabel("Local model (.onnx)").count(), 0);
  await created.page
    .getByLabel("Execution provider", { exact: true })
    .selectOption(provider);
  await created.page
    .getByLabel("Model URL (.onnx)")
    .fill(uiRecipe.model.urls[0]);
  await created.page
    .getByRole("button", { name: "Load model URL", exact: true })
    .click();
  await created.page.waitForFunction(() =>
    document
      .querySelector("[role=status]")
      ?.textContent?.includes("Model ready"),
  );
  const overlapToggle = created.page.getByLabel(
    "Overlap and blend output patches",
    {
      exact: true,
    },
  );
  assert.equal(await overlapToggle.isChecked(), false, "overlap defaults off");
  await overlapToggle.setChecked(uiRecipe.overlap);
  assert.equal(await overlapToggle.isChecked(), uiRecipe.overlap);
  await created.page.getByLabel("Image source").selectOption("0");
  await created.page
    .getByLabel("Input scale X Y Z", { exact: true })
    .selectOption("0");
  assert.equal(
    await created.page
      .getByLabel("Input scale X Y Z", { exact: true })
      .inputValue(),
    "0",
  );
  await created.page.getByLabel("I verified").check();
  await created.page
    .getByRole("button", { name: "Start live", exact: true })
    .click();
  await created.page.waitForFunction(() =>
    /^Live:|Inference failed/.test(
      document.querySelector("[role=status]")?.textContent || "",
    ),
  );
  assert.match(
    await created.page.locator("[role=status]").textContent(),
    /^Live:/,
  );
  await created.page
    .getByRole("button", { name: "Close", exact: true })
    .click();
  const createdProbe = await settle(created.page);
  assert.equal(createdProbe.loads, 1, "UI loaded the real worker exactly once");
  assert.equal(modelGets() - uiGets, 1, "UI downloaded the custom URL once");
  assert.equal(createdProbe.metadata.requestedProvider, provider);
  await verifyOutput(created.page, uiRecipe);
  verifyRecipeJson(await snapshot(created.page), uiRecipe);
  await position(created.page, [0, 83, 117]);
  await settle(created.page);
  const createdUrl = await copiedUrl(created.page, uiRecipe, verifyRecipeJson);
  assert.deepEqual(created.errors, []);
  // Destroy the producer's entire context before restoring the copied URL: no
  // registry entry, cached model bytes, or local session can supply the result.
  await created.context.close();
  contexts.delete(created.context);

  const uiFreshGets = modelGets();
  const uiFreshReads = sourceGets();
  const recreated = await open(createdUrl);
  const recreatedProbe = await settle(recreated.page);
  assert.equal(
    recreatedProbe.loads,
    1,
    "UI recipe reconstructs a fresh worker",
  );
  assert.equal(recreatedProbe.metadata.requestedProvider, provider);
  assert.equal(
    modelGets() - uiFreshGets,
    1,
    "UI recipe re-fetches custom model",
  );
  assert(sourceGets() > uiFreshReads, "UI recipe re-reads its input source");
  await verifyOutput(recreated.page, uiRecipe);
  verifyRecipeJson(await snapshot(recreated.page), uiRecipe);
  assert.deepEqual(recreated.errors, []);
  await recreated.context.close();
  contexts.delete(recreated.context);
  console.log(
    "UI custom model URL -> copied recipe -> isolated numerical output verified",
  );

  const getsBefore = modelGets();
  const first = await open(stateUrl(makeState(recipe)));
  const initial = await settle(first.page);
  assert.equal(initial.loads, 1);
  assert.equal(
    modelGets() - getsBefore,
    1,
    "first URL restore fetches the model",
  );
  assert.equal(initial.metadata.requestedProvider, provider);
  if (provider !== "auto")
    assert.equal(
      initial.metadata.actualProvider,
      provider === "cpu" ? "wasm" : "webgpu",
    );
  const firstOutput = await verifyOutput(first.page, recipe);
  assert(
    initial.runs < 19 * 10 * 7,
    "live restore does not eagerly scan the source",
  );
  // Make the URL binding write a fresh state, retaining non-default settings.
  await position(first.page, [0, 83, 117]);
  await settle(first.page);
  const url = await copiedUrl(first.page, recipe);
  await first.page.evaluate(() => window.viewer.state.reset());
  await assertStopped(first.page, initial);
  assert.deepEqual(first.errors, []);
  await first.context.close();
  contexts.delete(first.context);

  const freshGets = modelGets();
  const freshReads = sourceGets();
  const second = await open(url);
  const restored = await settle(second.page);
  assert.equal(
    restored.loads,
    1,
    "fresh context reconstructs a real worker session",
  );
  assert.equal(
    modelGets() - freshGets,
    1,
    "fresh context re-fetches model bytes",
  );
  assert(
    sourceGets() > freshReads,
    "fresh context re-reads serialized input source",
  );
  await verifyOutput(second.page, recipe);
  verifyJson(await snapshot(second.page), recipe);
  // Deleting the unrelated replacement must not invalidate the recipe's input.
  await remove(second.page, recipe.source.name);
  const beforePan = await probe(second.page);
  await position(second.page, [479, 263, 149]);
  await second.page.waitForFunction(
    (n) => window.shareProbe.runs > n,
    beforePan.runs,
    { timeout },
  );
  const panned = await settle(second.page);
  const pannedOutput = await verifyOutput(second.page, recipe);
  assert(
    pannedOutput.keys.some((key) => !firstOutput.keys.includes(key)),
    "pan computes previously unseen native chunks",
  );
  assert(panned.runs > restored.runs);
  verifyJson(await snapshot(second.page), recipe);
  await remove(second.page, resultName);
  await assertStopped(second.page, panned);
  assert.deepEqual(second.errors, []);
  await second.context.close();
  contexts.delete(second.context);
  console.log(
    "Fresh-context URL live inference, pan, placement, shader/settings, reset/deletion verified",
  );

  // Retire a hidden source while fetchChunk still awaits its first download.
  // This exercises shared-object ownership across cancellation, not just a
  // completed result's teardown.
  for (const change of ["delete", "reset"]) {
    const pending = await open(stateUrl(makeState(recipe)), true);
    await pending.firstInput;
    const waiting = await probe(pending.page);
    assert.equal(waiting.loads, 1);
    assert.equal(waiting.runs, 0, "source read is still held before inference");
    if (change === "delete") await remove(pending.page, resultName);
    else await pending.page.evaluate(() => window.viewer.state.reset());
    await assertStopped(pending.page, waiting);
    assert.deepEqual(pending.errors, []);
    await pending.context.close();
    contexts.delete(pending.context);
  }
  console.log("Deletion/reset during held input downloads verified");

  // Failures must be actionable layer errors, not unhandled exceptions, stale
  // session fallbacks, silent black images, or execution of unverified bytes.
  const rejects = async (label, invalidRecipe, expected, fetches = 0) => {
    const gets = modelGets();
    const test = await open(stateUrl(makeState(invalidRecipe)));
    await test.page.waitForFunction(
      ({ name, pattern }) => {
        const layer = window.viewer.layerManager.managedLayers.find(
          (layer) => layer.name === name,
        )?.layer;
        if (!layer) return false;
        const errors = [
          ...[...layer.messages].map((message) => message.message),
          ...layer.dataSources.map(
            (source) => source.loadState?.error?.message || "",
          ),
        ].join("\n");
        return new RegExp(pattern, "i").test(errors);
      },
      { name: resultName, pattern: expected.source },
      { timeout: 30000 },
    );
    await test.page.waitForTimeout(250);
    const current = await probe(test.page);
    assert.equal(current.loads, 0, `${label}: unverified model never loaded`);
    assert.equal(current.runs, 0, `${label}: no inference`);
    assert.equal(modelGets() - gets, fetches, `${label}: model fetch count`);
    assert.deepEqual(test.errors, [], `${label}: handled layer error`);
    await test.context.close();
    contexts.delete(test.context);
  };
  await rejects(
    "removed explicit ROI mode",
    { ...recipe, mode: "roi" },
    /Invalid inference recipe mode: expected "live"/,
  );
  await rejects(
    "removed affine preprocessing",
    { ...recipe, preprocessing: { scale: 0.5, offset: -3 } },
    /Invalid inference recipe \.preprocessing: expected a supported field/,
  );
  await rejects(
    "legacy local model recipe needs a shareable model URL",
    {
      ...recipe,
      model: { kind: "local", name: "concat.onnx", size: modelBytes.length },
    },
    /local model.*not included.*load a model URL/i,
  );
  const missingSource = { ...recipe };
  delete missingSource.source;
  await rejects(
    "missing source snapshot",
    missingSource,
    /(?:invalid.*source|source.*(?:expected|required|missing))/,
  );
  await rejects(
    "model HTTP error",
    {
      ...recipe,
      model: { ...recipe.model, urls: [`${base}/models/missing.onnx`] },
    },
    /HTTP 404/,
  );
  await rejects(
    "model hash mismatch",
    { ...recipe, model: { ...recipe.model, sha256: "0".repeat(64) } },
    /SHA-256.*mismatch/,
    1,
  );
  await rejects(
    "model size mismatch",
    { ...recipe, model: { ...recipe.model, size: modelBytes.length + 1 } },
    /(?:expected.*model bytes|model.*size|size.*mismatch)/,
    1,
  );
  console.log("Local/malformed/missing model and integrity failures verified");
  console.log("Production inference sharing smoke passed");
} finally {
  await Promise.all([...contexts].map((context) => context.close()));
  await browser?.close();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
