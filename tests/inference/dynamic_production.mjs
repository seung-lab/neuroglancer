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
 * Dynamic NCDHW / output spacing / C1 production browser regression.
 * Run with Node 24 AFTER the main agent has rebuilt the production assets:
 *   CHROME=/usr/bin/google-chrome node tests/inference/dynamic_production.mjs
 * Never builds, deploys, or modifies application files. Default: deterministic
 * CPU/WASM, headless Chrome/SwiftShader (no hardware GPU required).
 * MODEL=/tmp/neuroglancer-model6280000.onnx serves that file unchanged instead;
 * this mode checks finite C1 output, geometry and exact fresh-context replay,
 * NOT the deterministic fixture's numerical formula or a separate CPU oracle.
 * PROVIDER=cpu|auto|webgpu, HEADFUL=1, LAUNCH_OPTIONS='{"...":...}' optional.
 * OVERLAP defaults to 1 for this test, not the UI; explicitly select blending.
 * OVERLAP=0 selects no overlap/blending through the actual UI toggle.
 * The inline fixture checks every displayed voxel against raw direct patch
 * values with OVERLAP=0. Overlap-on checks raw values in the first display tile
 * (one source context), and finite values elsewhere; it is not a blend oracle.
 * Live inference, fresh-context replay and demand after a pan are always tested.
 * LARGE=1 uses the full img_jxl spatial extent with generated source chunks,
 * verifying tiled inference without a whole-volume allocation.
 *
 * Inline ONNX (198 bytes, IR 10/opset 13):
 *   image [1,1,16,128,128] -> Concat(image,image,image, axis=2)
 *         -> prediction [1,1,48,128,128].
 * Concat repeats whole Z blocks, NOT each individual slice. Generated with
 * onnx.helper.make_model/make_graph/make_node; no Python or new npm dependency
 * is needed to run this persistent test. The source oracle is independent of
 * app geometry code, inference modules, and worker output.
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
const timeout = Number(process.env.TIMEOUT || 120000);
const provider = process.env.PROVIDER || "cpu";
const compatibilityFixes = process.env.COMPATIBILITY_FIXES === "1";
assert(["cpu", "auto", "webgpu"].includes(provider));
const deterministic = !process.env.MODEL;
const modelBytes = process.env.MODEL
  ? await fs.readFile(process.env.MODEL)
  : Buffer.from(
      "CAoSH25ldXJvZ2xhbmNlci1keW5hbWljLXByb2R1Y3Rpb246mgEKNgoFaW1hZ2UKBWltYWdlCgVpbWFnZRIKcHJlZGljdGlvbiIGQ29uY2F0KgsKBGF4aXMYAqABAhINZHluYW1pYy1jMS16M1olCgVpbWFnZRIcChoIARIWCgIIAQoCCAEKAggQCgMIgAEKAwiAAWIqCgpwcmVkaWN0aW9uEhwKGggBEhYKAggBCgIIAQoCCDAKAwiAAQoDCIABQgQKABAN",
      "base64",
    );
const sha256 = createHash("sha256").update(modelBytes).digest("hex");
const modelPath = "/models/dynamic.onnx";
const sourceName = "dynamic raw";
const resultName = `${sourceName} inference`;
const origin = [10, 20, 30]; // All source and published datasource vectors: XYZ.
const large = process.env.LARGE === "1";
const overlap = process.env.OVERLAP !== "0";
const size = large ? [327680, 327680, 9949] : [256, 256, 32];
// Independent XYZ lattice arithmetic, not imported app geometry. Each context
// must fit inside the source; live floors the retained union to display tiles.
const inputStrideXYZ = overlap ? [64, 64, 8] : [96, 96, 12];
const outputStrideXYZ = overlap ? [64, 64, 24] : [96, 96, 36];
const contextCountsXYZ = size.map(
  (n, i) => Math.floor((n - [128, 128, 16][i]) / inputStrideXYZ[i]) + 1,
);
const liveBoundsXYZ = contextCountsXYZ.map((count, i) => {
  const span = (count - 1) * outputStrideXYZ[i] + [96, 96, 36][i];
  const display = [60, 60, 16][i];
  return Math.floor(span / display) * display;
});
if (!large && !overlap) assert.deepEqual(liveBoundsXYZ, [180, 180, 64]);
const inputSpacing = [16e-9, 16e-9, 45e-9];
const outputSpacing = [16e-9, 16e-9, 15e-9];
// Centered voxel CENTERS: raw origin Z = ((16-1)*45-(48-1)*15)/2
// = -15 nm = -1 output voxel. Crop is [6,16,16] ZYX, so the
// first retained global Z is 3*sourceZ - 1 + 6, not 3*sourceZ + 6.
const outputOrigin = [26, 36, 95];
const inputElements = 16 * 128 * 128;
const retainedElements = 36 * 96 * 96;
const requests = [];
const serverErrors = [];

// Fail clearly on a stale build, but never invoke a build from this harness.
let dynamicBuild = false;
for (const file of await fs.readdir(dist)) {
  if (
    file.endsWith(".js") &&
    (await fs.readFile(path.join(dist, file), "utf8")).includes(
      "ncdhw-centered-v2",
    )
  ) {
    dynamicBuild = true;
    break;
  }
}
assert(
  dynamicBuild,
  "Production assets lack ncdhw-centered-v2; ask the main agent to rebuild before running this test",
);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost").pathname;
    requests.push({ method: req.method, url });
    res.setHeader("Cache-Control", "no-store");
    if (url === modelPath) {
      res.setHeader("Content-Type", "application/octet-stream");
      res.end(modelBytes);
      return;
    }
    if (url === "/source/info") {
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
              resolution: [16, 16, 45],
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
      /^\/source\/native\/(-?\d+)-(-?\d+)_(-?\d+)-(-?\d+)_(-?\d+)-(-?\d+)$/.exec(
        url,
      );
    if (match) {
      const [x0, x1, y0, y1, z0, z1] = match.slice(1).map(Number);
      assert(
        [x0, y0, z0].every((v, i) => v >= origin[i]) &&
          [x1, y1, z1].every((v, i) => v <= origin[i] + size[i]),
        "only unpadded in-bounds source chunks may be requested",
      );
      const out = Buffer.alloc((x1 - x0) * (y1 - y0) * (z1 - z0));
      let i = 0;
      for (let z = z0; z < z1; ++z)
        for (let y = y0; y < y1; ++y)
          for (let x = x0; x < x1; ++x)
            out[i++] = (((x * 3 + y * 5 + z * 7) % 251) + 251) % 251;
      res.end(out);
      return;
    }
    // Same-origin /app/ mapping preserves production worker and ORT WASM URLs.
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
    serverErrors.push(`${req.url}: ${String(error)}`);
    res.statusCode = 404;
    res.end(String(error));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const gets = (prefix) =>
  requests.filter((r) => r.method === "GET" && r.url.startsWith(prefix)).length;
const plainState = () => ({
  dimensions: {
    x: [inputSpacing[0], "m"],
    y: [inputSpacing[1], "m"],
    z: [inputSpacing[2], "m"],
  },
  // Global source coordinates: physical Z is inside the first output tile.
  position: [30, 40, 32],
  crossSectionScale: 0.02,
  concurrentDownloads: 4,
  prefetch: false,
  layout: "xy",
  layers: [
    { type: "image", name: sourceName, source: `precomputed://${base}/source` },
  ],
});
const stateUrl = (state) =>
  `${base}/app/#!${encodeURIComponent(JSON.stringify(state))}`;
const snapshot = (page) =>
  page.evaluate(() => JSON.parse(JSON.stringify(window.viewer.state.toJSON())));
const resultSource = (state) => {
  const layer = state.layers.find((layer) => layer.name === resultName);
  assert(layer, "result image layer is serialized");
  const sources = Array.isArray(layer.source) ? layer.source : [layer.source];
  assert.equal(sources.length, 1);
  assert.equal(sources[0].url, "inference://recipe");
  assert(
    !layer.shader.includes("slider"),
    "C1 shader has no four-channel slider",
  );
  assert.match(layer.shader, /getDataValue\(0\)/);
  return sources[0];
};
const closeContext = async (context) => {
  await context.close();
  contexts.delete(context);
};
let browser;
const contexts = new Set();
try {
  browser = await chromium.launch({
    ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}),
    headless: process.env.HEADFUL !== "1",
    args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
    ...JSON.parse(process.env.LAUNCH_OPTIONS || "{}"),
  });
  const open = async (url) => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 1000 },
    });
    contexts.add(context);
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.stack || String(error)));
    page.on("console", (message) => {
      if (/Error retrieving chunk|Inference failed/.test(message.text()))
        errors.push(message.text());
    });
    // Observe only: no imported inference modules, intercepted model responses,
    // replaced sessions, retained full tensors, or direct publication calls.
    await page.addInitScript(() => {
      const Original = window.Worker;
      window.dynamicProbe = {
        loads: 0,
        runs: 0,
        outputs: 0,
        active: 0,
        maxActive: 0,
        inputLengths: [],
        outputLengths: [],
        inputHashes: [],
        errors: [],
      };
      window.Worker = class extends Original {
        constructor(...args) {
          super(...args);
          this.inference = false;
          this.pending = new Map();
          this.addEventListener("message", ({ data }) => {
            const p = window.dynamicProbe;
            if (data.metadata) p.metadata = data.metadata;
            if (this.inference && data.kind === "error")
              p.errors.push(data.message);
            if (
              (data.kind === "output" || data.kind === "error") &&
              this.pending.has(data.id)
            ) {
              const hash = this.pending.get(data.id);
              this.pending.delete(data.id);
              --p.active;
              if (data.kind === "output") {
                ++p.outputs;
                p.outputLengths.push(data.output.length);
                p.inputHashes.push(hash);
              }
            }
          });
        }
        postMessage(data, ...args) {
          const p = window.dynamicProbe;
          if (data.kind === "load") {
            this.inference = true;
            ++p.loads;
          }
          if (this.inference && data.kind === "run") {
            ++p.runs;
            ++p.active;
            p.maxActive = Math.max(p.maxActive, p.active);
            p.inputLengths.push(data.input.length);
            p.geometry = data.geometry;
            // Observe a compact fingerprint before transfer; never keep input
            // tensors or change worker requests. Completed hashes reveal duplicate
            // full-context runs when neighboring display tiles should reuse cache.
            let hash = 2166136261;
            const words = new Uint32Array(
              data.input.buffer,
              data.input.byteOffset,
              data.input.length,
            );
            for (const word of words) {
              hash = Math.imul(hash ^ word, 16777619);
              hash ^= hash >>> 16;
            }
            this.pending.set(data.id, hash >>> 0);
          }
          return super.postMessage(data, ...args);
        }
        terminate() {
          window.dynamicProbe.active -= this.pending.size;
          this.pending.clear();
          return super.terminate();
        }
      };
    });
    await page.goto(url);
    await page.waitForFunction(() => window.viewer?.state);
    return { context, page, errors };
  };
  const probe = (page) => page.evaluate(() => ({ ...window.dynamicProbe }));
  const setupUi = async (page) => {
    await page.waitForFunction(() =>
      window.viewer.layerManager.managedLayers[0]?.isReady(),
    );
    assert.equal((await probe(page)).loads, 0, "inference initializes lazily");
    await page.evaluate(() =>
      window.viewer.element.dispatchEvent(
        new CustomEvent("action:open-onnx-inference", { bubbles: true }),
      ),
    );
    await page
      .getByLabel("Execution provider", { exact: true })
      .selectOption(provider);
    await page.getByLabel("Model URL (.onnx)").fill(base + modelPath);
    await page
      .getByRole("button", { name: "Load model URL", exact: true })
      .click();
    await page.waitForFunction(() =>
      /Model ready|Could not|failed/i.test(
        document.querySelector("[role=status]")?.textContent || "",
      ),
    );
    assert.match(
      await page.locator("[role=status]").textContent(),
      /Model ready/,
    );
    const toggle = page.getByLabel("Apply legacy JSEP padding fixes", {
      exact: true,
    });
    assert.equal(
      await toggle.isChecked(),
      false,
      "new configurations are opt-in",
    );
    const analysis = page.getByLabel("Model compatibility analysis", {
      exact: true,
    });
    assert(
      (await analysis.textContent()).startsWith(
        "Padding workarounds for the older JavaScript WebGPU backend. Not required for the default model on the tested native runtime. ",
      ),
    );
    assert.doesNotMatch(await analysis.textContent(), /Recommendation:/);
    if (compatibilityFixes) {
      assert.match(
        await analysis.textContent(),
        /Legacy JSEP padding fixes are disabled\./,
      );
      await toggle.check();
      await page.waitForFunction(() =>
        document
          .querySelector("[role=status]")
          ?.textContent?.includes("Model ready"),
      );
      assert.equal(await toggle.isChecked(), true);
      assert.match(
        await analysis.textContent(),
        /Legacy JSEP padding fixes enabled\. CPU uses the original model\./,
      );
    }
    const overlapToggle = page.getByLabel("Overlap and blend output patches", {
      exact: true,
    });
    assert.equal(
      await overlapToggle.isChecked(),
      false,
      "overlap defaults off",
    );
    await overlapToggle.setChecked(overlap);
    assert.equal(await overlapToggle.isChecked(), overlap);
    await page.getByLabel("Image source").selectOption("0");
    const p = await probe(page);
    assert.deepEqual(p.metadata.inputShape, [1, 1, 16, 128, 128]);
    assert.deepEqual(p.metadata.outputShape, [1, 1, 48, 128, 128]);
    if (deterministic) {
      assert.deepEqual(p.metadata.inputNames, ["image"]);
      assert.deepEqual(p.metadata.outputNames, ["prediction"]);
    }
    assert.equal(p.metadata.requestedProvider, provider);
    assert.equal(p.metadata.compatibilityFixes, compatibilityFixes);
    if (compatibilityFixes && provider !== "cpu")
      assert.equal(p.metadata.preparation, "model6280000-jsep");
    if (provider === "cpu") assert.equal(p.metadata.actualProvider, "wasm");
    const geometry = await page
      .getByLabel("Model geometry", { exact: true })
      .textContent();
    assert.match(geometry, /input 16×128×128/);
    assert.match(geometry, /raw output 48×128×128/);
    assert.match(geometry, /1 channels/);
    assert.match(geometry, /retains 36×96×96/);
    const currentSpacing = (
      await page.getByLabel("Current input voxel size X Y Z").textContent()
    ).match(
      /^Current input voxel size X Y Z: (\S+) m, (\S+) m, (\S+) m; axes: x, y, z\.$/,
    );
    assert(currentSpacing, "current input readout uses XYZ units and axes");
    currentSpacing
      .slice(1)
      .forEach((v, i) => assert(Math.abs(Number(v) - inputSpacing[i]) < 1e-20));
    const inputScale = page.getByLabel("Input scale X Y Z", { exact: true });
    assert.equal(
      await inputScale.inputValue(),
      "0",
      "finest scale defaults on",
    );
    await inputScale.selectOption("0");
    const outputField = page.getByLabel("Output voxel size X Y Z");
    const prefill = (await outputField.inputValue())
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    assert.equal(prefill.length, 3);
    prefill.forEach((v, i) => assert(Math.abs(v - inputSpacing[i]) < 1e-20));
    // Assert the XYZ suggestion BEFORE editing; recipe/geometry arrays stay ZYX.
    await outputField.fill("16e-9 16e-9 15e-9");
    const confirmedGeometry = await page
      .getByLabel("Model geometry", { exact: true })
      .textContent();
    assert.match(
      confirmedGeometry,
      new RegExp(
        `input stride ${[...inputStrideXYZ].reverse().join(", ")}(?:;|$)`,
      ),
    );
    assert.match(
      confirmedGeometry,
      new RegExp(
        `output stride ${[...outputStrideXYZ].reverse().join(", ")}(?:;|$)`,
      ),
    );
    assert.match(
      confirmedGeometry,
      overlap ? /wu overlap\/blending enabled/ : /no overlap or blending/,
    );
    await page.getByLabel("I verified").check();
    await page
      .getByRole("button", {
        name: "Start live",
        exact: true,
      })
      .click();
    await page.waitForFunction(() =>
      /^(Live:|Inference failed)/.test(
        document.querySelector("[role=status]")?.textContent || "",
      ),
    );
    assert.match(await page.locator("[role=status]").textContent(), /^Live:/);
    assert.match(
      await page.locator("[role=status]").textContent(),
      /1 (raw output )?channels/,
    );
  };
  const settle = async (page) => {
    await page.waitForFunction(
      (name) => {
        const layer = window.viewer.layerManager.managedLayers.find(
          (l) => l.name === name,
        )?.layer;
        const render = layer?.renderLayers[0];
        const progress = render?.layerChunkProgressInfo;
        const source = render?.visibleSources?.keys().next().value;
        return (
          progress?.numVisibleChunksNeeded > 0 &&
          progress.numVisibleChunksAvailable ===
            progress.numVisibleChunksNeeded &&
          source?.chunks.size > 0 &&
          [...source.chunks.values()].every((c) => c.data?.length) &&
          window.dynamicProbe.active === 0 &&
          window.dynamicProbe.outputs > 0
        );
      },
      resultName,
      { timeout },
    );
    let last = -1;
    for (let i = 0; i < 120; ++i) {
      await page.waitForTimeout(250);
      const p = await probe(page);
      if (p.runs === last && p.active === 0) return p;
      last = p.runs;
    }
    throw new Error("Dynamic inference did not settle");
  };
  const demandAllLive = async (page) => {
    if (large) return;
    const { originalPosition, targets } = await page.evaluate(
      ({ name, outputOrigin, outputSpacing }) => {
        const viewer = window.viewer;
        const layer = viewer.layerManager.managedLayers.find(
          (l) => l.name === name,
        ).layer;
        const source = layer.renderLayers[0].visibleSources.keys().next().value;
        const originalPosition = [...viewer.position.value];
        const { names, scales } = viewer.coordinateSpace.value;
        const shape = [...source.spec.upperVoxelBound].slice(0, 3);
        const chunkShape = [...source.spec.chunkDataSize].slice(0, 3);
        const counts = shape.map((n, i) => Math.ceil(n / chunkShape[i]));
        const targets = [];
        for (let z = 0; z < counts[2]; ++z)
          for (let y = 0; y < counts[1]; ++y)
            for (let x = 0; x < counts[0]; ++x) {
              const grid = [x, y, z];
              const position = [...originalPosition];
              for (let i = 0; i < 3; ++i) {
                const axis = names.indexOf(["x", "y", "z"][i]);
                if (axis === -1) throw new Error("Missing global spatial axis");
                const start = grid[i] * chunkShape[i];
                const center =
                  (start + Math.min(start + chunkShape[i], shape[i])) / 2;
                // Global navigation uses its own voxel sizes: output Z * 15 nm
                // is source/navigation Z * 45 nm, not the same voxel index.
                position[axis] =
                  ((outputOrigin[i] + center) * outputSpacing[i]) /
                  scales[axis];
              }
              targets.push({ key: [...grid, 0].join(","), position });
            }
        return { originalPosition, targets };
      },
      { name: resultName, outputOrigin, outputSpacing },
    );
    try {
      for (const target of targets) {
        await page.evaluate((position) => {
          window.viewer.position.value = Float32Array.from(position);
        }, target.position);
        await page.waitForFunction(
          ({ name, key }) => {
            const render = window.viewer.layerManager.managedLayers.find(
              (l) => l.name === name,
            )?.layer?.renderLayers[0];
            const source = render?.visibleSources?.keys().next().value;
            const progress = render?.layerChunkProgressInfo;
            return (
              source?.chunks.get(key)?.data?.length > 0 &&
              progress?.numVisibleChunksNeeded > 0 &&
              progress.numVisibleChunksAvailable ===
                progress.numVisibleChunksNeeded
            );
          },
          { name: resultName, key: target.key },
          { timeout },
        );
      }
      assert.equal(
        await page.evaluate(
          ({ name, keys }) => {
            const layer = window.viewer.layerManager.managedLayers.find(
              (l) => l.name === name,
            ).layer;
            const source = layer.renderLayers[0].visibleSources
              .keys()
              .next().value;
            return keys.filter(
              (key) => source.chunks.get(key)?.data?.length > 0,
            ).length;
          },
          { name: resultName, keys: targets.map((target) => target.key) },
        ),
        targets.length,
        "all live display chunks remain cached for all-voxel verification",
      );
      const p = await settle(page);
      checkProbe(p);
      assert(
        p.runs <= contextCountsXYZ.reduce((a, b) => a * b, 1),
        "full live display traversal never reruns cached source contexts",
      );
    } finally {
      await page.evaluate((position) => {
        window.viewer.position.value = Float32Array.from(position);
      }, originalPosition);
    }
  };
  const checkProbe = (p) => {
    assert.deepEqual(p.errors, []);
    assert.equal(p.maxActive, 1, "worker runs are serial, not an eager FIFO");
    assert.equal(p.outputs, p.runs);
    if (!overlap && deterministic)
      assert.equal(
        new Set(p.inputHashes).size,
        p.outputs,
        "cached neighboring tiles never rerun an identical full input patch",
      );

    assert(
      p.inputLengths.every((n) => n === inputElements),
      "full input contexts only",
    );
    assert(
      p.outputLengths.every((n) => n === retainedElements),
      "worker transfers cropped C1 only, no raw tensor/four-channel padding",
    );
    assert.deepEqual(p.geometry.inputShape, [16, 128, 128]);
    assert.deepEqual(p.geometry.rawOutputShape, [48, 128, 128]);
    assert.deepEqual(p.geometry.cropBefore, [6, 16, 16]);
    assert.deepEqual(p.geometry.cropAfter, [6, 16, 16]);
    assert.equal(p.geometry.outputChannels, 1);
    assert(Math.abs(p.geometry.rawOutputOrigin[0] + 15e-9) < 1e-20);
    assert.equal(p.geometry.rawOutputOrigin[1], 0);
    assert.equal(p.geometry.rawOutputOrigin[2], 0);
  };
  const verifyOutput = async (page) => {
    const result = await page.evaluate(
      ({ name, outputOrigin, deterministic, overlap, liveBoundsXYZ }) => {
        const check = (condition, message) => {
          if (!condition) throw new Error(message);
        };
        const layer = window.viewer.layerManager.managedLayers.find(
          (l) => l.name === name,
        ).layer;
        const source = layer.renderLayers[0].visibleSources.keys().next().value;
        const { spec } = source;
        check(
          String([...spec.upperVoxelBound]) === String([...liveBoundsXYZ, 1]),
          `dynamic XYZ bounds and C1: ${[...spec.upperVoxelBound]}`,
        );
        check(
          String([...spec.lowerVoxelBound]) === "0,0,0,0",
          "local voxel lower bounds",
        );
        let elements = 0;
        let oracleElements = 0;
        const samples = [];
        const keys = [];
        // Navigation demand order may differ after restoration; replay compares
        // samples in canonical storage-chunk order, not Map insertion order.
        for (const [key, chunk] of [...source.chunks].sort(([a], [b]) =>
          a.localeCompare(b),
        )) {
          const grid = key.split(",").map(Number);
          const [nx, ny, nz, nc] = chunk.chunkDataSize;
          check(
            grid.length === 4 && grid[3] === 0 && nc === 1,
            "C1 chunk grid, no four-channel padding",
          );
          check(chunk.data?.length === nx * ny * nz, "exact C1 buffer length");
          check(
            String([nx, ny, nz]) === "60,60,16",
            "fixed display chunk independent of model context",
          );
          let i = 0;
          for (let z = 0; z < nz; ++z)
            for (let y = 0; y < ny; ++y)
              for (let x = 0; x < nx; ++x) {
                const actual = chunk.data[i++];
                check(Number.isFinite(actual), "finite output");
                // The first live tile lies wholly before the next overlapping
                // context starts (XYZ stride 64,64,24). Its values therefore have
                // an independent raw oracle even with blending enabled.
                if (
                  deterministic &&
                  (!overlap || grid.slice(0, 3).every((n) => n === 0))
                ) {
                  const gx =
                    outputOrigin[0] + grid[0] * spec.chunkDataSize[0] + x;
                  const gy =
                    outputOrigin[1] + grid[1] * spec.chunkDataSize[1] + y;
                  const gz =
                    outputOrigin[2] + grid[2] * spec.chunkDataSize[2] + z;
                  // The lattice is anchored at retained global XYZ [26,36,95],
                  // not at the display tile. Direct retained patches advance
                  // 36 output Z / 12 input Z. Concat repeats whole local blocks,
                  // so crop-local Z wraps modulo 16 inside each context.
                  // In XY the physical grids are 1:1, hence source X/Y = gx/gy.
                  const dz = gz - 95;
                  const sourceZ =
                    30 + Math.floor(dz / 36) * 12 + ((6 + (dz % 36)) % 16);
                  const raw =
                    (((gx * 3 + gy * 5 + sourceZ * 7) % 251) + 251) % 251;
                  const expected = raw;
                  ++oracleElements;
                  check(
                    Math.abs(actual - expected) <=
                      1e-5 + Math.abs(expected) * 1e-7,
                    `XYZ ${gx},${gy},${gz}: ${actual} != ${expected}`,
                  );
                }
                samples.push(actual);
              }
          elements += i;
          keys.push(key);
        }
        check(elements > 0, "actual output data checked");
        const transform =
          layer.dataSources[0].loadState.dataSource.modelTransform;
        return {
          keys,
          elements,
          oracleElements,
          samples,
          channels: layer.channelSpace.value.numChannels,
          names: transform.inputSpace.names,
          units: transform.inputSpace.units,
          scales: [...transform.inputSpace.scales],
          transform: [...transform.transform],
        };
      },
      { name: resultName, outputOrigin, deterministic, overlap, liveBoundsXYZ },
    );
    assert.equal(result.channels, 1);
    assert.deepEqual(result.names, ["x", "y", "z", "c^"]);
    assert.deepEqual(result.units, ["m", "m", "m", ""]);
    result.scales.forEach((v, i) =>
      assert(Math.abs(v - [...outputSpacing, 1][i]) <= Math.abs(v) * 1e-12),
    );
    const transform = Array.from({ length: 25 }, (_, i) =>
      i % 6 === 0 ? 1 : 0,
    );
    transform.splice(20, 3, ...outputOrigin);
    assert.deepEqual(
      result.transform,
      transform,
      "exact global OUTPUT voxel origin, not source-index origin",
    );
    // Explicit physical placement check, particularly unequal Z spacing.
    outputOrigin.forEach((n, i) =>
      assert(
        Math.abs(
          result.transform[20 + i] * result.scales[i] - n * outputSpacing[i],
        ) < 1e-18,
      ),
    );

    return result;
  };

  const created = await open(stateUrl(plainState()));
  await setupUi(created.page);
  const firstProbe = await settle(created.page);
  checkProbe(firstProbe);
  if (process.env.EXPECT_CPU_FALLBACK === "1") {
    assert.equal(firstProbe.metadata.actualProvider, "wasm");
    assert.match(firstProbe.metadata.fallbackReason, /WebGPU.*failed/i);
  }
  if (provider === "webgpu")
    assert.equal(firstProbe.metadata.actualProvider, "webgpu");
  await demandAllLive(created.page);
  const first = await verifyOutput(created.page);
  if (deterministic)
    assert(
      first.oracleElements >= 60 * 60 * 16,
      "raw numeric oracle checks at least one full live display tile",
    );
  const recipe = resultSource(await snapshot(created.page)).state;
  assert.equal(recipe.version, 2);
  assert.equal(recipe.profile, "ncdhw-centered-v2");
  assert.equal(recipe.inputScaleIndex, 0);
  assert.deepEqual(recipe.outputSpacingZYX, [...outputSpacing].reverse());
  recipe.spacingZYX.forEach((v, i) =>
    assert(Math.abs(v - [...inputSpacing].reverse()[i]) < 1e-20),
  );
  assert.equal(recipe.mode, "live");
  assert.equal(recipe.provider, provider);
  assert.equal(recipe.compatibilityFixes, compatibilityFixes);
  assert.equal(
    recipe.overlap,
    overlap,
    "recipe explicitly serializes the toggle",
  );
  assert.equal("roi" in recipe, false);
  assert.equal("preprocessing" in recipe, false);
  assert.equal(recipe.model.kind, "url");
  assert.deepEqual(recipe.model.urls, [base + modelPath]);
  assert.equal(recipe.model.size, modelBytes.length);
  assert.equal(recipe.model.sha256, sha256);
  assert.equal(recipe.source.name, sourceName);
  assert(
    JSON.stringify(recipe.source.source).includes(
      `precomputed://${base}/source`,
    ),
  );

  // Check the real live URL before constructing a result-only replay. Removing
  // the producer's selected source in the UI intentionally stops live inference
  // and removes its linked result, so it cannot produce a result-only URL.
  await created.page.waitForFunction(
    ({ resultName, recipe, position }) => {
      try {
        const state = JSON.parse(decodeURIComponent(location.hash.slice(2)));
        const layer = state.layers?.find((l) => l.name === resultName);
        const source = Array.isArray(layer?.source)
          ? layer.source[0]
          : layer?.source;
        return (
          source?.url === "inference://recipe" &&
          JSON.stringify(source.state) === JSON.stringify(recipe) &&
          JSON.stringify(state.position) === JSON.stringify(position)
        );
      } catch {
        return false;
      }
    },
    { resultName, recipe, position: (await snapshot(created.page)).position },
  );
  const copiedState = JSON.parse(
    decodeURIComponent(new URL(created.page.url()).hash.slice(2)),
  );
  assert.deepEqual(resultSource(copiedState).state, recipe);
  assert(copiedState.layers.some((l) => l.name === sourceName));
  // Restoration must reconstruct the recipe's source snapshot, not resolve a
  // visible layer by name. Only the replay input is edited, not the live viewer.
  copiedState.layers = copiedState.layers.filter((l) => l.name === resultName);
  const copiedUrl = stateUrl(copiedState);
  assert.equal(
    copiedState.layers.length,
    1,
    "only the result layer is needed in the copied state",
  );
  assert(
    !/"(?:sessionId|resultId)"\s*:|blob:|inference:\/\/(?!recipe)/.test(
      JSON.stringify(copiedState),
    ),
    "recipe has no ephemeral session/blob references",
  );
  assert.deepEqual(created.errors, []);
  await closeContext(created.context);

  const modelGetsBefore = gets(modelPath);
  const sourceGetsBefore = gets("/source/native/");
  const restored = await open(copiedUrl); // Fresh cookies/cache/JS heap, origin context already closed.
  checkProbe(await settle(restored.page));
  await demandAllLive(restored.page);
  const replay = await verifyOutput(restored.page);
  assert.deepEqual(
    replay.samples,
    first.samples,
    "fresh-context CPU replay has identical values in all C1 voxels",
  );
  assert.deepEqual(replay.transform, first.transform);
  assert.deepEqual(replay.scales, first.scales);
  assert.deepEqual(resultSource(await snapshot(restored.page)).state, recipe);
  assert(
    gets(modelPath) > modelGetsBefore,
    "isolated context fetched model over HTTP again",
  );
  assert(
    gets("/source/native/") > sourceGetsBefore,
    "isolated context actually reread source and recomputed output",
  );
  assert.deepEqual(restored.errors, []);
  await closeContext(restored.context);

  {
    const live = await open(stateUrl(plainState()));
    await setupUi(live.page);
    const before = await settle(live.page);
    checkProbe(before);
    const firstLive = await verifyOutput(live.page);
    assert.equal(
      resultSource(await snapshot(live.page)).state.overlap,
      overlap,
    );
    await live.page.evaluate(() => {
      window.viewer.position.value = Float32Array.from([150, 40, 32]);
    });
    await live.page.waitForFunction(
      ({ name, oldKeys }) => {
        const render = window.viewer.layerManager.managedLayers.find(
          (l) => l.name === name,
        )?.layer?.renderLayers[0];
        const source = render?.visibleSources?.keys().next().value;
        return (
          source &&
          [...source.chunks].some(
            ([key, chunk]) => !oldKeys.includes(key) && chunk.data?.length,
          )
        );
      },
      { name: resultName, oldKeys: firstLive.keys },
      { timeout: 30000 },
    );
    const after = await settle(live.page);
    checkProbe(after);
    const panned = await verifyOutput(live.page);
    assert(
      after.runs > before.runs,
      "pan triggers new visible-context inference",
    );
    assert(
      panned.keys.some((key) => !firstLive.keys.includes(key)),
      `pan publishes a new fixed display chunk: before=${before.runs} runs, keys=${firstLive.keys.join(";")}; after=${after.runs} runs, keys=${panned.keys.join(";")}`,
    );
    if (!overlap && deterministic) {
      const keys = new Set(panned.keys);
      assert(
        panned.keys.some((key) => {
          const grid = key.split(",").map(Number);
          ++grid[0];
          return keys.has(grid.join(","));
        }),
        "direct numerical oracle checked neighboring X display tiles across a seam",
      );
    }
    assert(
      after.runs <= (large || overlap ? 27 : 8),
      "live work stays bounded; small no-overlap source has only 2×2×2 contexts",
    );
    assert.deepEqual(live.errors, []);
    await closeContext(live.context);
  }
  // Favicon probes are browser-dependent, not inference/runtime asset failures.
  assert.deepEqual(
    serverErrors.filter((error) => !error.startsWith("/favicon.ico:")),
    [],
  );
  console.log("PASS dynamic production", {
    model: deterministic ? "inline Concat Z×3" : process.env.MODEL,
    provider,
    compatibilityFixes,
    overlap,
    initialLivePatches: firstProbe.runs,
    liveBoundsXYZ,
    actualProvider: firstProbe.metadata.actualProvider,
    fallbackReason: firstProbe.metadata.fallbackReason,
    input: [1, 1, 16, 128, 128],
    output: [1, 1, 48, 128, 128],
    retainedZYX: [36, 96, 96],
    outputSpacingZYX: [...outputSpacing].reverse(),
    liveElements: first.elements,
    oracleElements: first.oracleElements,
    inputPatchBytes: inputElements * 4,
    croppedPatchBytes: retainedElements * 4,
    recipeVersion: recipe.version,
    freshContextReplay: true,
    live: true,
    large,
  });
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
