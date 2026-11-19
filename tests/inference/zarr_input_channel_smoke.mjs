// Local end-to-end smoke. Requires a local viewer build, Chrome and network
// access to the two public URLs below. No request routing or source mocks.
// npm run build -- --output /tmp/ng-channel-client
// DIST=/tmp/ng-channel-client node tests/inference/zarr_input_channel_smoke.mjs
// CASE=baseline|real|fixture runs only the specified case (baseline: old build).
// CHROME overrides /usr/bin/google-chrome. CPU/FP32, hardware GPU not required.
/* global window, document, CustomEvent, structuredClone */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";
import { chromium } from "playwright";
import { httpContentType } from "./http_content_type.mjs";

const dist = path.resolve(process.env.DIST || "dist/client");
const selectedCase = process.env.CASE || "all";
assert(["all", "baseline", "real", "fixture"].includes(selectedCase));
const realSource =
  "https://c10s.pni.princeton.edu/panluminate-fixation-demo/20min_PFA_pan-488.ims.zarr/|zarr3:";
const realModel =
  "https://storage.googleapis.com/princeton-eric-medial-entorhinal-cortex-scratch-central1/liconn1.onnx";
const position = [1178.494384765625, Number("816.5186157226562"), 596];
const scene = {
  dimensions: {
    x: [1.55e-7, "m"],
    y: [1.55e-7, "m"],
    z: [4.0000000000000003e-7, "m"],
  },
  position,
  layout: "4panel-alt",
  crossSectionScale: 0.025, // limit CPU work around the requested voxel
  prefetch: false,
  concurrentDownloads: 3,
  layers: [
    {
      type: "image",
      name: "pan-488",
      source: realSource,
      localDimensions: { "c'": [1, ""] },
      localPosition: [0],
      shaderControls: { normalized: { range: [356, 3025], window: [0, 3698] } },
    },
  ],
};

// Same CZYX OME layout as the real data, but two distinct channels packed in
// each chunk. The displayed local position stays at zero throughout inference.
const axes = [
  { name: "c", type: "channel" },
  ...["z", "y", "x"].map((name) => ({
    name,
    type: "space",
    unit: "millimeter",
  })),
];
function fixture(pathname) {
  if (pathname === "/test.zarr/zarr.json")
    return JSON.stringify({
      zarr_format: 3,
      node_type: "group",
      attributes: {
        ome: {
          version: "0.5",
          multiscales: [
            {
              name: "fixture",
              axes,
              datasets: [
                {
                  path: "s0",
                  coordinateTransformations: [
                    { type: "scale", scale: [1, 0.0004, 0.000155, 0.000155] },
                    // Integer voxel-corner grid: isolates input channel packing
                    // from the real-source half-voxel placement check.
                    {
                      type: "translation",
                      translation: [0.5, 0.0002, 0.0000775, 0.0000775],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    });
  if (pathname === "/test.zarr/s0/zarr.json")
    return JSON.stringify({
      zarr_format: 3,
      node_type: "array",
      shape: [2, 64, 240, 240],
      data_type: "uint16",
      chunk_grid: {
        name: "regular",
        configuration: { chunk_shape: [2, 16, 60, 60] },
      },
      chunk_key_encoding: {
        name: "default",
        configuration: { separator: "/" },
      },
      fill_value: 0,
      codecs: [{ name: "bytes", configuration: { endian: "little" } }],
      dimension_names: ["c", "z", "y", "x"],
      attributes: {},
    });
  const key = /^\/test\.zarr\/s0\/c\/0\/([0-3])\/([0-3])\/([0-3])$/.exec(
    pathname,
  );
  if (!key) return undefined;
  const [gz, gy, gx] = key.slice(1).map(Number);
  const bytes = Buffer.alloc(2 * 16 * 60 * 60 * 2); // c0 = 0
  let i = 16 * 60 * 60 * 2;
  for (let z = gz * 16; z < (gz + 1) * 16; ++z)
    for (let y = gy * 60; y < (gy + 1) * 60; ++y)
      for (let x = gx * 60; x < (gx + 1) * 60; ++x) {
        bytes.writeUInt16LE(32768 + 13 * x + 7 * y + 3 * z, i);
        i += 2;
      }
  return bytes;
}
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    res.setHeader(
      "Content-Type",
      httpContentType(pathname === "/" ? "index.html" : pathname),
    );
    if (pathname === "/concat.onnx")
      return res.end(
        await fs.readFile(
          new URL("../../testdata/inference/concat.onnx", import.meta.url),
        ),
      );
    if (pathname.startsWith("/test.zarr/")) {
      const body = fixture(pathname);
      if (body === undefined) res.writeHead(404);
      return res.end(body);
    }
    const file = path.resolve(
      dist,
      "." + (pathname === "/" ? "/index.html" : pathname),
    );
    assert(file.startsWith(dist + path.sep));
    res.end(await fs.readFile(file));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
const errors = [];
let browser, page, context, base;
async function open(state) {
  await context?.close();
  context = await browser.newContext({ viewport: { width: 960, height: 760 } });
  page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.error("Page error:", e.message);
  });
  page.on("console", (m) => {
    if (/error|failed/i.test(m.text()) && !/404/.test(m.text()))
      console.error("Browser:", m.text());
  });
  page.on("requestfailed", (r) => {
    if (r.failure()?.errorText !== "net::ERR_ABORTED")
      console.error("Request failed:", r.url(), r.failure());
  });
  await page.goto(`${base}#!${encodeURIComponent(JSON.stringify(state))}`, {
    waitUntil: "domcontentloaded",
  });
}
// Read ordinary published frontend chunk data, not worker messages or a screenshot.
function chunkAt({ p, fixtureData }) {
  const layer = window.viewer?.layerManager?.managedLayers[1]?.layer;
  const render = layer?.renderLayers[0];
  if (!render) return false;
  const dims = [60, 60, 16];
  // These fixed-shape models preserve native spacing and use 1/8 border crops.
  const origin = fixtureData ? [10, 10, 2] : [16, 16, 16];
  const transform =
    layer.dataSources[0].loadState.dataSource.modelTransform.transform;
  const displayOrigin = Array.from(transform.slice(20, 23));
  for (let i = 0; i < 3; ++i) {
    const expected = origin[i] - (fixtureData ? 0 : 0.5);
    if (Math.abs(displayOrigin[i] - expected) > 1e-6)
      throw Error(
        `Wrong published XYZ translation: ${displayOrigin}, expected ${expected} at ${i}`,
      );
  }
  const voxel = p.map((v, i) => origin[i] + Math.floor(v - displayOrigin[i]));
  const g = voxel.map((v, i) => Math.floor((v - origin[i]) / dims[i]));
  const key = [...g, 0].join(",");
  for (const source of render.visibleSources.keys()) {
    const ch = source.chunks.get(key);
    if (!ch?.data?.length) continue;
    const [nx, ny, nz, nc] = ch.chunkDataSize;
    if (nx !== 60 || ny !== 60 || nz !== 16 || nc !== (fixtureData ? 4 : 3))
      throw Error(`Unexpected chunk size ${ch.chunkDataSize}`);
    const lo = g.map((v, i) => origin[i] + v * dims[i]);
    const [x, y, z] = voxel.map((v, i) => v - lo[i]);
    const n = nx * ny * nz;
    const sample = [],
      range = [];
    if (ch.data.length !== n * nc) throw Error("Incomplete published chunk");
    for (let c = 0; c < nc; ++c) {
      let min = Infinity,
        max = -Infinity;
      sample.push(ch.data[c * n + (z * ny + y) * nx + x]);
      for (let i = 0; i < n; ++i) {
        const v = ch.data[c * n + i];
        if (!Number.isFinite(v)) throw Error("Non-finite published value");
        min = Math.min(min, v);
        max = Math.max(max, v);
        if (fixtureData) {
          const expected = Math.fround(
            (32768 +
              13 * (lo[0] + (i % nx)) +
              7 * (lo[1] + (Math.floor(i / nx) % ny)) +
              3 * (lo[2] + Math.floor(i / (ny * nx)))) /
              65535,
          );
          if (v !== expected)
            throw Error(
              `Selected c1 mismatch ${key}[${c},${i}]: ${v} != ${expected}`,
            );
        }
      }
      range.push([min, max]);
    }
    return {
      key,
      elements: n * nc,
      displayOrigin,
      voxelXYZ: voxel,
      sample,
      range,
    };
  }
  return false;
}
async function verifyChunk(p, fixtureData) {
  const result = await (
    await page.waitForFunction(
      chunkAt,
      { p, fixtureData },
      { timeout: 240000, polling: 250 },
    )
  ).jsonValue();
  console.log("Published prediction", JSON.stringify(result));
  if (!fixtureData) {
    // Independent CPU ORT reference: native s0 patch origin ZYX 576,768,1152;
    // uint16 / 65535, no overlap, read raw output at ZYX 20,49,26.
    assert.deepEqual(result.voxelXYZ, [1178, 817, 596]);
    const ref = [0.9120388031005859, 0.8610775470733643, 0.899411678314209];
    result.sample.forEach((v, c) =>
      assert(
        Math.abs(v - ref[c]) < 0.001,
        `c${c} mismatch at requested voxel: ${v} != ${ref[c]}`,
      ),
    );
  }
}
async function run(fixtureData, baseline = false) {
  const state = structuredClone(scene),
    layer = state.layers[0];
  const model = fixtureData ? `${base}concat.onnx` : realModel;
  if (fixtureData) {
    state.position = [119, 97, 37];
    state.layout = "xy";
    layer.source = `${base}test.zarr/|zarr3:`;
    layer.name = "two-channel fixture";
  }
  await open(state);
  await page.waitForFunction(() => {
    const r =
      window.viewer?.layerManager.managedLayers[0]?.layer?.renderLayers[0];
    if (r)
      for (const s of r.visibleSources.keys())
        for (const ch of s.chunks.values()) if (ch.data?.length) return true;
    return false;
  });
  const initial = await snapshot();
  console.log("Loaded source", JSON.stringify(initial));
  assert.deepEqual(initial.position, state.position);
  assert.equal(initial.layout, state.layout);
  assert.deepEqual(initial.dimensions, state.dimensions);
  assert.deepEqual(initial.layers[0].shaderControls, layer.shaderControls);
  assert.deepEqual(initial.layers[0].localDimensions, layer.localDimensions);
  assert.deepEqual(initial.layers[0].localPosition, [0]);
  await page.evaluate(() =>
    window.viewer.element.dispatchEvent(
      new CustomEvent("action:open-onnx-inference", { bubbles: true }),
    ),
  );
  await page.getByLabel("Image source").selectOption("0");
  const status = page.locator("[role=status]");
  console.log("Source status:", await status.textContent());
  if (!baseline) assert.doesNotMatch(await status.textContent(), /Unsupported/);
  if (baseline) {
    assert.match(await status.textContent(), /only rank-3 volumes/);
    assert(await page.getByRole("button", { name: "Start live" }).isDisabled());
    return;
  }
  const field = page.locator('input[type=number][aria-label="Input channel"]');
  assert.equal(await field.inputValue(), "0");
  assert.equal(await field.getAttribute("min"), "0");
  assert.equal(await field.getAttribute("max"), fixtureData ? "1" : "0");
  if (fixtureData) {
    await field.fill("1");
    await field.press("Tab");
    assert.equal(await field.inputValue(), "1");
  }
  await page
    .getByLabel("Execution provider", { exact: true })
    .selectOption("cpu");
  await page.getByLabel("Model URL (.onnx)").fill(model);
  await page
    .getByRole("button", { name: "Load model URL", exact: true })
    .click();
  await page.waitForFunction(() => {
    const el = document.querySelector("[role=status]");
    return (
      /Model ready/.test(el?.textContent) || el?.dataset.severity === "error"
    );
  });
  assert.match(await status.textContent(), /Model ready/);
  console.log(
    "Geometry:",
    await page.getByLabel("Model geometry", { exact: true }).textContent(),
  );
  await page.getByLabel("I verified").check();
  const start = page.getByRole("button", { name: "Start live", exact: true });
  assert(
    await start.isEnabled(),
    "valid source and model must enable Start live",
  );
  await start.click();
  await page.waitForFunction(() => {
    const el = document.querySelector("[role=status]");
    return /^Live:/.test(el?.textContent) || el?.dataset.severity === "error";
  });
  assert.match(await status.textContent(), /^Live:/);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const saved = await snapshot();
  const src = [saved.layers[1].source].flat()[0];
  assert.equal(src.url, "inference://recipe");
  const recipe = src.state;
  assert.equal(recipe.inputChannel, fixtureData ? 1 : 0);
  assert.deepEqual(recipe.model.urls, [model]);
  assert.equal(recipe.source.source, layer.source);
  assert.deepEqual(saved.layers[0].localPosition, [0]);
  if (!fixtureData)
    assert.equal(
      recipe.model.sha256,
      "7463b11aead6a0095792f8dffda6f4d326d38322d3d93dacdc93a5bf22fbfb2e",
    );
  console.log("Published recipe", JSON.stringify(recipe));
  await verifyChunk(state.position, fixtureData);
  await open(saved);
  await verifyChunk(state.position, fixtureData);
  console.log(`Restored c${recipe.inputChannel} recipe in a fresh context`);
}
function snapshot() {
  return page.evaluate(() =>
    JSON.parse(JSON.stringify(window.viewer.state.toJSON())),
  );
}
try {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({
    executablePath: process.env.CHROME || "/usr/bin/google-chrome",
    headless: true,
    args: ["--enable-unsafe-swiftshader"],
  });
  if (selectedCase !== "fixture") await run(false, selectedCase === "baseline");
  if (["all", "fixture"].includes(selectedCase)) await run(true);
  assert.deepEqual(errors, []);
  console.log(`PASS ${selectedCase}`);
} catch (e) {
  console.error(
    "Viewer diagnostics:",
    await page?.locator("body").innerText({ timeout: 3000 }).catch(String),
  );
  throw e;
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
