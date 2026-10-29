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

/* global window, document, location, CustomEvent, navigator */

/**
 * Actual production UI -> dedicated worker -> native ORT smoke; NEVER builds.
 *
 *   node tests/inference/precision_production.mjs
 *   BASE_URL=https://host/app/ node tests/inference/precision_production.mjs
 *   RUNTIME_MANIFEST=/path/to/runtime-manifest.json BASE_URL=https://host/app/ \
 *   node tests/inference/precision_production.mjs
 *
 * RUNTIME_MANIFEST optionally verifies a custom native Asyncify pair from the app
 * origin or an explicit HTTPS base (CORS *), instead of the pinned CDN pair,
 * including browser-observed WASM Brotli headers.
 * Bodies are decoded: encodedSha256 requires separate raw-network verification.
 *
 * Default: GPU disabled, deterministic Conv/Concat oracle, default FP32,
 * CPU-requested FP16 and unavailable-WebGPU FP16 fallback, URL recipe replay.
 * SCALE=1 also checks a two-scale pyramid: coarse selection, automatic output
 * spacing, distinct coarse-chunk numerical oracle and fresh-context shared replay.
 * It retains all default precision cases. For the strict-header deployment:
 *   SCALE=1 ISOLATED=1 BASE_URL=https://host/app/ CHROME=/usr/bin/google-chrome \
 *   node tests/inference/precision_production.mjs
 * HARDWARE=1 additionally requires a real shader-f16 adapter (no silent skip),
 * checks unverified-model FP16 on WebGPU, and, with MODEL, compares the
 * original known model6280000 CPU FP32 / native GPU FP32 / native GPU FP16,
 * plus padding-only compatibility fixes on native GPU FP32.
 *
 * After coordinating GPU use with the main agent, on the NVIDIA host:
 *   HEADFUL=1 HARDWARE=1 CHROME=/usr/bin/google-chrome \
 *   XDG_RUNTIME_DIR=/run/user/2050 WAYLAND_DISPLAY=wayland-0 \
 *   VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/nvidia_icd.json \
 *   MODEL=/tmp/neuroglancer-model6280000.onnx \
 *   node tests/inference/precision_production.mjs
 *
 * Hardware launch includes --enable-dawn-features=vulkan_enable_f16_on_nvidia
 * and ignores Playwright's SwiftShader default argument. CHROME, TIMEOUT and
 * LAUNCH_OPTIONS (JSON) are optional; supplied args are appended, not substituted.
 * TRACE_ASSETS=1 logs served/observed runtime asset details. ISOLATED=1 uses
 * strict local COOP/COEP headers as a deliberate regression fixture; ISOLATED=0
 * uses auth-compatible headers. Isolated workers must use hardwareConcurrency
 * capped at four and floored at one WASM thread; nonisolated workers use one.
 * Both modes require correct CPU outputs and fresh-context URL replay, not just
 * thread metadata or output shapes. BASE_URL must match the requested isolation.
 * No source imports, session stubs, converted model fixtures or app changes.
 * Only model/source HTTP fixtures are fulfilled by Playwright; production JS
 * and workers come from the actual app, native Asyncify assets from pinned CDN
 * URLs (or the explicit custom runtime manifest). No production resource is
 * intercepted.
 * BASE_URL needs to be a secure context and expose window.viewer like /app/.
 * Numerical deltas are observations, NOT segmentation-equivalence assertions.
 * The production worker checks every uncropped raw value for finiteness before
 * publishing; this observer independently checks every retained/published value.
 * Default feature-absence case disables WebGPU entirely; it does not claim to
 * cover the separate GPU-present/adapter-missing-shader-f16 branch.
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
const timeout = Number(process.env.TIMEOUT || 180000);
const hardware = process.env.HARDWARE === "1";
const traceAssets = process.env.TRACE_ASSETS === "1";
const isolated = process.env.ISOLATED === "1";
const scaleSmoke = process.env.SCALE === "1";
const runtimeManifest = process.env.RUNTIME_MANIFEST
  ? JSON.parse(await fs.readFile(process.env.RUNTIME_MANIFEST, "utf8"))
  : undefined;
// By default, verify the exact, unmodified native ORT 1.31.1 pair on jsDelivr.
const nativeWasmHash =
  "ca319e9539cd0f1e291cf56074760121eaf39650f5dbf84b6e52c07f4b2944ec";
const nativeRuntimeAssets = {
  mjs: {
    url: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort-wasm-simd-threaded.asyncify.mjs",
    bytes: 53457,
    sha256: "59cf781530e1a16df2a291d78798e3ec1152467edaec402d6f9599d85047c302",
  },
  wasm: {
    url: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort-wasm-simd-threaded.asyncify.wasm",
    bytes: 28747738,
    sha256: nativeWasmHash,
  },
};
if (runtimeManifest !== undefined) {
  assert(process.env.BASE_URL, "RUNTIME_MANIFEST requires explicit BASE_URL");
  const baseUrl = new URL(process.env.BASE_URL);
  assert(
    /^https?:$/.test(baseUrl.protocol) &&
      !baseUrl.username &&
      !baseUrl.password,
    "RUNTIME_MANIFEST requires an HTTP(S) BASE_URL without credentials",
  );
  assert(runtimeManifest && typeof runtimeManifest === "object");
  assert.equal(runtimeManifest.name, "onnxruntime-web");
  assert.equal(runtimeManifest.version, "1.31.1");
  assert.equal(runtimeManifest.custom, true);
  for (const key of ["commit", "kernelCommit"])
    assert.match(runtimeManifest[key], /^[0-9a-f]{7,40}$/i);
  assert.equal(typeof runtimeManifest.base, "string");
  const base = new URL(runtimeManifest.base, baseUrl);
  assert(
    (base.origin === baseUrl.origin ||
      (base.protocol === "https:" &&
        /^https:\/\//i.test(runtimeManifest.base))) &&
      !base.username &&
      !base.password &&
      !base.search &&
      !base.hash &&
      base.pathname.endsWith("/"),
    "Runtime manifest base must be a same-origin or explicit HTTPS directory without credentials, query or hash",
  );
  assert(Array.isArray(runtimeManifest.artifacts));
  assert.equal(runtimeManifest.artifacts.length, 2);
  for (const extension of ["mjs", "wasm"]) {
    const name = `ort-wasm-simd-threaded.asyncify.${extension}`;
    const artifact = runtimeManifest.artifacts.find((a) => a?.name === name);
    assert(
      artifact,
      `Runtime manifest must contain exactly the native ${name}`,
    );
    assert.equal(typeof artifact.path, "string");
    const url = new URL(artifact.path, baseUrl);
    assert.equal(url.origin, base.origin);
    assert.equal(url.href, new URL(name, base).href);
    assert(Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0);
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
    if (extension === "wasm") {
      assert.equal(artifact.contentType, "application/wasm");
      assert.equal(artifact.contentEncoding ?? "br", "br");
    } else {
      assert.match(
        artifact.contentType,
        /^(application|text)\/(javascript|ecmascript)$/,
      );
    }
    if (artifact.contentEncoding !== undefined)
      assert(
        ["br", "gzip", "deflate", "identity"].includes(
          artifact.contentEncoding,
        ),
      );
    if (artifact.encodedBytes !== undefined)
      assert(
        Number.isSafeInteger(artifact.encodedBytes) &&
          artifact.encodedBytes > 0,
      );
    // Validate metadata only: decoded response bodies cannot attest encodedSha256.
    if (artifact.encodedSha256 !== undefined)
      assert.match(artifact.encodedSha256, /^[0-9a-f]{64}$/);
    nativeRuntimeAssets[extension] = { ...artifact, url: url.href };
  }
}
const jsepWasmHash =
  "5ab8361783822d02a57d1e97cf2514bceb451a628f2b29ae0d7b6e618201ff8f";
assert(Number.isFinite(timeout) && timeout > 0);
assert(!process.env.MODEL || hardware, "MODEL requires explicit HARDWARE=1");
const knownHash =
  "2c19eac209030e9f1d3b52d6dfaa72a509291f8644ca0e36fbe22231f2baac3c";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Tiny ONNX protobuf encoder, not an ONNX dependency/converter. IR 10/opset 13:
// Conv(image, weight=.75, bias=.25) -> Concat(conv,conv,conv, axis=2).
// Public input [1,1,16,128,128], output [1,1,48,128,128], both FLOAT.
function uint(n) {
  const bytes = [];
  do {
    bytes.push(n % 128 | (n >= 128 ? 128 : 0));
    n = Math.floor(n / 128);
  } while (n);
  return Buffer.from(bytes);
}
const join = (...parts) => Buffer.concat(parts.flat());
const int = (id, n) => join(uint(id * 8), uint(n));
const field = (id, bytes) => {
  bytes = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
  return join(uint(id * 8 + 2), uint(bytes.length), bytes);
};
const valueInfo = (name, shape) =>
  join(
    field(1, name),
    field(
      2,
      field(
        1,
        join(int(1, 1), field(2, join(shape.map((n) => field(1, int(1, n)))))),
      ),
    ),
  );
const tensor = (name, shape, value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeFloatLE(value);
  return join(
    shape.map((n) => int(1, n)),
    int(2, 1),
    field(8, name),
    field(9, bytes),
  );
};
const fixture = join(
  int(1, 10),
  field(2, "precision-production"),
  field(
    7,
    join(
      field(
        1,
        join(
          field(1, "image"),
          field(1, "weight"),
          field(1, "bias"),
          field(2, "conv"),
          field(4, "Conv"),
        ),
      ),
      field(
        1,
        join(
          field(1, "conv"),
          field(1, "conv"),
          field(1, "conv"),
          field(2, "prediction"),
          field(4, "Concat"),
          field(5, join(field(1, "axis"), int(3, 2), int(20, 2))),
        ),
      ),
      field(2, "unknown-conv-concat"),
      field(5, tensor("weight", [1, 1, 1, 1, 1], 0.75)),
      field(5, tensor("bias", [1], 0.25)),
      field(11, valueInfo("image", [1, 1, 16, 128, 128])),
      field(12, valueInfo("prediction", [1, 1, 48, 128, 128])),
    ),
  ),
  field(8, join(field(1, ""), int(2, 13))),
);
const known = process.env.MODEL
  ? await fs.readFile(process.env.MODEL)
  : undefined;
if (known)
  assert.equal(
    hash(known),
    knownHash,
    "MODEL must be the verified ORIGINAL model6280000, not JSEP/prepared/reserialized bytes",
  );
assert.notEqual(hash(fixture), knownHash);

const origin = [10, 20, 30];
const size = [128, 128, 16]; // Exactly one input context; no whole-volume inference.
const spacing = [16e-9, 16e-9, 45e-9];
const outputSpacing = [16e-9, 16e-9, 15e-9];
// Separate pyramid preserves the original one-context precision fixture. Both
// pyramid scales cover the same physical bounds; coarse still fits one context.
const scaleFactors = [2, 2, 1]; // XY-only pyramid: Z bounds/spacing unchanged.
const pyramidSize = size.map((v, i) => v * scaleFactors[i]);
const coarseOrigin = origin.map((v, i) => v / scaleFactors[i]);
const coarseSpacing = spacing.map((v, i) => v * scaleFactors[i]);
const coarseOutputSpacing = outputSpacing.map((v, i) => v * scaleFactors[i]);
const liveSize = [60, 60, 32];
const sourceName = "precision raw";
const resultName = `${sourceName} inference`;
const retainedShape = [36, 96, 96];
const retainedLength = 36 * 96 * 96;
const sourceValue = (x, y, z) => (((3 * x + 5 * y + 7 * z) % 251) + 251) % 251;
const scaleValue = (x, y, z, coarse) =>
  (sourceValue(x, y, z) + (coarse ? 113 : 0)) % 251;
const expectedValue = (x, y, z, coarse) =>
  Math.fround(Math.fround(0.75 * scaleValue(x, y, z, coarse)) + 0.25);
const report = {
  cases: [],
  comparisons: [],
  hardwareRequested: hardware,
  scaleRequested: scaleSmoke,
};
let server;
const browsers = new Set();
const contexts = new Set();
try {
  let appUrl;
  if (process.env.BASE_URL) {
    appUrl = new URL(process.env.BASE_URL);
    assert(!appUrl.hash, "BASE_URL must not contain viewer state");
  } else {
    const dist = path.join(root, "dist/client");
    await fs.access(path.join(dist, "index.html"));
    server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, "http://localhost");
        const relative =
          decodeURIComponent(url.pathname).slice(5) || "index.html";
        const file = path.resolve(dist, relative);
        assert(url.pathname.startsWith("/app/") && file.startsWith(`${dist}/`));
        const mime = {
          ".js": "text/javascript",
          ".mjs": "text/javascript",
          ".wasm": "application/wasm",
          ".html": "text/html",
          ".css": "text/css",
          ".json": "application/json",
          ".svg": "image/svg+xml",
          ".png": "image/png",
        };
        res.setHeader(
          "Content-Type",
          mime[path.extname(file)] || "application/octet-stream",
        );
        res.setHeader("Cache-Control", "no-store");
        if (isolated) {
          res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
          res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
        } else {
          res.setHeader(
            "Cross-Origin-Opener-Policy",
            "same-origin-allow-popups",
          );
          res.setHeader("Cross-Origin-Embedder-Policy", "unsafe-none");
        }
        const body = await fs.readFile(file);
        if (traceAssets && /onnxruntime|\.(mjs|wasm)$/.test(url.pathname))
          console.error("served production asset", {
            url: url.pathname,
            file,
            contentType: res.getHeader("Content-Type"),
            bytes: body.length,
            prefix: file.endsWith(".mjs")
              ? body.toString("utf8", 0, 120)
              : undefined,
          });
        res.end(body);
      } catch (error) {
        res.statusCode = 404;
        res.end(String(error));
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    appUrl = new URL(`http://127.0.0.1:${server.address().port}/app/`);
  }
  const fixtureBase = new URL("/__precision_smoke/", appUrl).href;
  const modelUrl = (real) => `${fixtureBase}${real ? "known" : "fixture"}.onnx`;
  const initialState = (c) => ({
    dimensions: Object.fromEntries(
      ["x", "y", "z"].map((n, i) => [n, [spacing[i], "m"]]),
    ),
    position: c.coarse ? [50, 60, 32] : [30, 40, 32],
    crossSectionScale: 0.02,
    layout: "xy",
    prefetch: false,
    layers: [
      {
        type: "image",
        name: sourceName,
        source: `precomputed://${fixtureBase}${c.coarse ? "pyramid" : "source"}`,
      },
    ],
  });
  const stateUrl = (state) =>
    `${appUrl.href}#!${encodeURIComponent(JSON.stringify(state))}`;
  const launch = async (gpu) => {
    const extra = JSON.parse(process.env.LAUNCH_OPTIONS || "{}");
    assert(
      extra.ignoreDefaultArgs !== true,
      "Do not drop all Chromium defaults",
    );
    const browser = await chromium.launch({
      ...extra,
      ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}),
      // Keep the known-good software WebGL viewer for GPU-disabled CPU cases.
      headless: !gpu || process.env.HEADFUL !== "1",
      args: [
        "--no-sandbox",
        ...(gpu
          ? [
              "--enable-unsafe-webgpu",
              "--enable-dawn-features=vulkan_enable_f16_on_nvidia",
              ...(process.env.WAYLAND_DISPLAY
                ? ["--ozone-platform=wayland"]
                : []),
            ]
          : ["--disable-gpu", "--disable-features=WebGPU"]),
        ...(extra.args || []),
      ],
      ignoreDefaultArgs: [
        ...new Set([
          "--enable-unsafe-swiftshader",
          ...(extra.ignoreDefaultArgs || []),
        ]),
      ],
    });
    browsers.add(browser);
    return browser;
  };
  const open = async (browser, url) => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 1000 },
      serviceWorkers: "block",
    });
    contexts.add(context);
    const requests = [],
      assets = [],
      assetInspections = [],
      errors = [];
    context.on("response", (response) => {
      const headers = response.headers();
      const asset = {
        url: response.url(),
        requestedUrl: response.request().url(),
        redirectedFrom: response.request().redirectedFrom()?.url(),
        status: response.status(),
        contentType: headers["content-type"],
        contentEncoding: headers["content-encoding"],
        vary: headers.vary,
        accessControlAllowOrigin: headers["access-control-allow-origin"],
        contentLength: Number(headers["content-length"]) || undefined,
        resourceType: response.request().resourceType(),
      };
      assets.push(asset);
      const extension = /\.(mjs|wasm)$/.exec(new URL(asset.url).pathname)?.[1];
      if (!extension) return;
      assetInspections.push(
        (async () => {
          try {
            let body;
            try {
              body = await response.body();
              asset.bodySource = "browser response";
            } catch (error) {
              // Chrome's inspector can evict bodies or reject worker targets.
              // Inspect the URL actually requested by the unmodified worker via
              // a separate GET, not the worker response's observed bytes.
              // Never fulfill/intercept production resources.
              if (
                !/Request content was evicted from inspector cache|Network\.loadNetworkResource\): Target not supported/.test(
                  String(error),
                )
              )
                throw error;
              asset.inspectionLimitation = String(error);
              const requestHeaders = {};
              for (const name of ["accept-encoding", "origin"]) {
                const value = await response.request().headerValue(name);
                if (value) requestHeaders[name] = value;
              }
              const verification = await context.request.get(asset.url, {
                headers: requestHeaders,
              });
              try {
                assert.equal(verification.url(), asset.url);
                assert.equal(verification.status(), asset.status);
                const verificationHeaders = verification.headers();
                for (const [header, field] of [
                  ["content-type", "contentType"],
                  ["access-control-allow-origin", "accessControlAllowOrigin"],
                  ["content-encoding", "contentEncoding"],
                  ["vary", "vary"],
                ])
                  assert.equal(
                    verificationHeaders[header],
                    asset[field],
                    `Verification GET ${header} must match the observed browser response`,
                  );
                if (runtimeManifest)
                  assert.equal(
                    Number(verificationHeaders["content-length"]) || undefined,
                    asset.contentLength,
                    "Verification GET Content-Length must match the observed browser response",
                  );
                body = await verification.body();
                asset.bodySource =
                  "verification GET (browser body unavailable)";
              } finally {
                await verification.dispose();
              }
            }
            // response.body() is decoded; deployed gzip/br Content-Length may
            // describe compressed bytes, so identity comes from the hash below.
            asset.bytes = body.length;
            asset.sha256 = hash(body);
            if (extension === "mjs") {
              const text = body.toString("utf8");
              asset.nativeAsyncify =
                text.includes("ort-wasm-simd-threaded.asyncify.wasm") &&
                text.includes("_OrtCreateSession");
              asset.jsep = /ort-wasm-simd-threaded\.jsep\.(mjs|wasm)/.test(
                text,
              );
            } else {
              asset.nativeAsyncify =
                asset.sha256 === nativeRuntimeAssets.wasm.sha256;
              asset.jsep = asset.sha256 === jsepWasmHash;
            }
          } catch (error) {
            asset.inspectionError = String(error);
          }
          if (traceAssets)
            console.error("inspected production response", asset);
        })(),
      );
    });
    // Same-origin deterministic data for both local builds and HTTPS deployments.
    // Never intercept a production script, worker, WASM asset or ORT response.
    await context.route(`${fixtureBase}**`, async (route) => {
      const resource = route.request().url().slice(fixtureBase.length);
      requests.push(resource);
      let body,
        contentType = "application/octet-stream";
      if (resource === "fixture.onnx") body = fixture;
      else if (resource === "known.onnx") {
        assert(known);
        body = known;
      } else if (resource === "source/info" || resource === "pyramid/info") {
        const pyramid = resource === "pyramid/info";
        contentType = "application/json";
        body = JSON.stringify({
          type: "image",
          data_type: "uint8",
          num_channels: 1,
          scales: [
            {
              key: "native",
              size: pyramid ? pyramidSize : size,
              resolution: [16, 16, 45],
              voxel_offset: origin,
              chunk_sizes: [[32, 32, 16]],
              encoding: "raw",
            },
            ...(pyramid
              ? [
                  {
                    key: "coarse",
                    size,
                    resolution: [32, 32, 45],
                    voxel_offset: coarseOrigin,
                    chunk_sizes: [[32, 32, 16]],
                    encoding: "raw",
                  },
                ]
              : []),
          ],
        });
      } else {
        const match =
          /^(source|pyramid)\/(native|coarse)\/(\d+)-(\d+)_(\d+)-(\d+)_(\d+)-(\d+)$/.exec(
            resource,
          );
        assert(match, `Unexpected fixture request: ${resource}`);
        const pyramid = match[1] === "pyramid";
        const coarse = match[2] === "coarse";
        assert(!coarse || pyramid);
        const chunkOrigin = coarse ? coarseOrigin : origin;
        const chunkSize = pyramid && !coarse ? pyramidSize : size;
        const [x0, x1, y0, y1, z0, z1] = match.slice(3).map(Number);
        assert(
          [x0, y0, z0].every((v, i) => v >= chunkOrigin[i]) &&
            [x1, y1, z1].every((v, i) => v <= chunkOrigin[i] + chunkSize[i]),
        );
        body = Buffer.alloc((x1 - x0) * (y1 - y0) * (z1 - z0));
        let n = 0;
        for (let z = z0; z < z1; ++z)
          for (let y = y0; y < y1; ++y)
            for (let x = x0; x < x1; ++x)
              body[n++] = scaleValue(x, y, z, coarse);
      }
      await route.fulfill({
        status: 200,
        contentType,
        body,
        headers: { "Cache-Control": "no-store" },
      });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    page.on("pageerror", (error) => errors.push(error.stack || String(error)));
    await page.addInitScript(() => {
      const Original = window.Worker;
      window.precisionProbe = {
        loads: [],
        inputs: [],
        outputs: [],
        errors: [],
      };
      // Observe messages without changing the data, transfers or worker/session.
      window.Worker = class extends Original {
        constructor(...args) {
          super(...args);
          this.inference = false;
          this.addEventListener("message", ({ data }) => {
            if (!this.inference) return;
            const p = window.precisionProbe;
            if (data.metadata) p.metadata = data.metadata;
            if (data.kind === "loaded") p.loadedMetadata = data.metadata;
            if (data.kind === "error") p.errors.push(data.message);
            if (data.kind === "output") {
              p.outputs.push({
                type: data.output.constructor.name,
                values: Array.from(data.output),
                metadata: data.metadata,
              });
            }
          });
        }
        postMessage(data, ...args) {
          const p = window.precisionProbe;
          if (data.kind === "load") {
            this.inference = true;
            p.loads.push({
              provider: data.provider,
              precision: data.precision,
              compatibilityFixes: data.compatibilityFixes,
              bytes: data.model.byteLength,
            });
          }
          if (this.inference && data.kind === "run")
            p.inputs.push({
              type: data.input.constructor.name,
              length: data.input.length,
              finite: data.input.every(Number.isFinite),
              geometry: data.geometry,
            });
          return super.postMessage(data, ...args);
        }
      };
    });
    await page.goto(url);
    try {
      await page.waitForFunction(() => window.viewer?.state);
    } catch (error) {
      console.error("Viewer startup failed", {
        url: page.url(),
        errors,
        page: await page.evaluate(() => ({
          ready: document.readyState,
          title: document.title,
          text: document.body.innerText,
        })),
      });
      throw error;
    }
    const environment = await page.evaluate(() => ({
      isolated: window.crossOriginIsolated,
      hardwareConcurrency: navigator.hardwareConcurrency || 1,
    }));
    assert.equal(
      environment.isolated,
      isolated,
      "Expected cross-origin isolation fixture environment",
    );
    return {
      page,
      context,
      requests,
      assets,
      assetInspections,
      environment,
      errors,
    };
  };
  const close = async ({ context }) => {
    await context.close();
    contexts.delete(context);
  };
  const probe = (page) => page.evaluate(() => window.precisionProbe);
  const openDialog = (page) =>
    page.evaluate(() =>
      window.viewer.element.dispatchEvent(
        new CustomEvent("action:open-onnx-inference", { bubbles: true }),
      ),
    );
  const recipeFromState = (state) => {
    const layer = state.layers.find((l) => l.name === resultName);
    assert(layer, "Published result must serialize");
    const sources = Array.isArray(layer.source) ? layer.source : [layer.source];
    assert.equal(sources.length, 1);
    assert.equal(sources[0].url, "inference://recipe");
    return sources[0].state;
  };
  const assertMetadata = (metadata, c, environment) => {
    const expectedThreads = environment.isolated
      ? Math.max(1, Math.min(4, environment.hardwareConcurrency || 1))
      : 1;
    assert.equal(
      metadata.threads,
      expectedThreads,
      "Worker WASM thread configuration must match isolation and capped hardware concurrency",
    );
    assert.equal(metadata.requestedProvider, c.provider);
    assert.equal(metadata.actualProvider, c.actualProvider);
    assert.equal(metadata.requestedPrecision, c.fp16 ? "float16" : "float32");
    assert.equal(metadata.actualPrecision, c.actualPrecision || "float32");
    assert.deepEqual(metadata.inputShape, [1, 1, 16, 128, 128]);
    assert.deepEqual(metadata.outputShape, [1, 1, 48, 128, 128]);
    assert.equal(
      metadata.preparation,
      c.compatibilityFixes ? "model6280000-jsep" : undefined,
      "Only the explicit padding-only case applies the historical recipe tag",
    );
    if (c.fp16 && c.actualPrecision !== "float16") {
      assert.equal(typeof metadata.precisionFallbackReason, "string");
      assert(
        metadata.precisionFallbackReason.trim().length > 0,
        "FP32 fallback must explain why",
      );
      if (c.reason) assert.match(metadata.precisionFallbackReason, c.reason);
    } else assert.equal(metadata.precisionFallbackReason, undefined);
  };
  const assertVisiblePrecision = async (page, c, metadata) => {
    const status = page.getByLabel("Inference precision status", {
      exact: true,
    });
    assert.equal(await status.isVisible(), true);
    const text = await status.textContent();
    assert.match(
      text,
      c.fp16 ? /Requested precision: FP16/ : /Requested precision: FP32/,
    );
    assert.match(
      text,
      c.actualPrecision === "float16"
        ? /last initialized precision: FP16.*public I\/O FP32/
        : /last initialized precision: FP32/,
    );
    if (metadata.precisionFallbackReason) {
      assert.match(text, /FP32 fallback:/);
      assert(
        text.includes(metadata.precisionFallbackReason),
        "Metadata fallback reason must be visible, not just logged",
      );
    }
  };
  const setup = async (run, c) => {
    const { page } = run;
    await page.waitForFunction(() =>
      window.viewer.layerManager.managedLayers[0]?.isReady(),
    );
    assert.equal((await probe(page)).loads.length, 0, "Runtime is lazy");
    await openDialog(page);
    const fp16 = page.getByLabel("Experimental FP16 GPU inference", {
      exact: true,
    });
    assert.equal(await fp16.isChecked(), false, "FP16 must be opt-in");
    await page
      .getByLabel("Execution provider", { exact: true })
      .selectOption(c.provider);
    if (c.fp16) await fp16.check();
    if (c.compatibilityFixes)
      await page
        .getByLabel("Apply legacy JSEP padding fixes", {
          exact: true,
        })
        .check();
    await page.getByLabel("Model URL (.onnx)").fill(modelUrl(c.real));
    await page
      .getByRole("button", { name: "Load model URL", exact: true })
      .click();
    await page.waitForFunction(() =>
      /Model ready|failed/i.test(
        document.querySelector("[role=status]")?.textContent || "",
      ),
    );
    assert.match(
      await page.locator("[role=status]").textContent(),
      /Model ready/,
    );
    const metadata = (await probe(page)).metadata;
    assertMetadata(metadata, c, run.environment);
    await assertVisiblePrecision(page, c, metadata);
    assert.equal(
      await page
        .getByLabel("Apply legacy JSEP padding fixes", {
          exact: true,
        })
        .isChecked(),
      c.compatibilityFixes ?? false,
    );
    const overlapToggle = page.getByLabel("Overlap and blend output patches", {
      exact: true,
    });
    assert.equal(
      await overlapToggle.isChecked(),
      false,
      "overlap defaults off",
    );
    await overlapToggle.setChecked(false);
    await page.getByLabel("Image source").selectOption("0");
    const inputScale = page.getByLabel("Input scale X Y Z", { exact: true });
    assert.equal(
      await inputScale.inputValue(),
      "0",
      "finest scale defaults on",
    );
    await inputScale.selectOption("0");
    const outputField = page.getByLabel("Output voxel size X Y Z");
    if (c.coarse) {
      assert.deepEqual(
        await inputScale
          .locator("option")
          .evaluateAll((options) => options.map((option) => option.value)),
        ["0", "1"],
        "both pyramid scales are selectable by scaleIndex",
      );
      const assertSpacing = async (expectedInput, expectedOutput) => {
        const readout = (
          await page.getByLabel("Current input voxel size X Y Z").textContent()
        ).match(
          /^Current input voxel size X Y Z: (\S+) m, (\S+) m, (\S+) m; axes: x, y, z\.$/,
        );
        assert(readout, "selected input readout retains XYZ units and axes");
        const suggested = (await outputField.inputValue())
          .trim()
          .split(/[\s,]+/)
          .map(Number);
        assert.equal(suggested.length, 3);
        expectedInput.forEach((v, i) =>
          assert(Math.abs(Number(readout[i + 1]) - v) < 1e-20),
        );
        expectedOutput.forEach((v, i) =>
          assert(Math.abs(suggested[i] - v) < 1e-20),
        );
      };
      await assertSpacing(spacing, outputSpacing);
      await page.getByLabel("I verified").check();
      await inputScale.selectOption("1");
      assert.equal(await inputScale.inputValue(), "1");
      assert.equal(await page.getByLabel("I verified").isChecked(), false);
      await assertSpacing(coarseSpacing, coarseOutputSpacing);
      // Do not fill output: inference must use the automatic coarse suggestion.
    } else {
      await outputField.fill("16e-9 16e-9 15e-9");
    }
    await page.getByLabel("I verified").check();
    await page.getByRole("button", { name: "Start live", exact: true }).click();
    await page.waitForFunction(() =>
      /^Live:|failed/i.test(
        document.querySelector("[role=status]")?.textContent || "",
      ),
    );
    assert.match(await page.locator("[role=status]").textContent(), /^Live:/);
  };
  const settle = async (page) => {
    await page.waitForFunction(
      (name) => {
        const layer = window.viewer.layerManager.managedLayers.find(
          (l) => l.name === name,
        );
        const source = layer?.layer?.renderLayers[0]?.visibleSources
          ?.keys()
          .next().value;
        const p = layer?.layer?.renderLayers[0]?.layerChunkProgressInfo;
        return (
          p?.numVisibleChunksNeeded > 0 &&
          p.numVisibleChunksAvailable === p.numVisibleChunksNeeded &&
          source?.chunks.size > 0 &&
          [...source.chunks.values()].every((c) => c.data?.length) &&
          window.precisionProbe.outputs.length > 0
        );
      },
      resultName,
      { timeout },
    );
    return page.evaluate((name) => {
      const layer = window.viewer.layerManager.managedLayers.find(
        (l) => l.name === name,
      );
      const source = layer.layer.renderLayers[0].visibleSources
        .keys()
        .next().value;
      const chunks = [...source.chunks].map(([key, c]) => ({
        position: key.split(",").map(Number),
        shape: Array.from(c.chunkDataSize),
        type: c.data?.constructor.name,
        values: c.data ? Array.from(c.data) : null,
      }));
      return {
        bounds: Array.from(source.spec.upperVoxelBound),
        chunkSize: Array.from(source.spec.chunkDataSize),
        chunks,
        state: JSON.parse(JSON.stringify(window.viewer.state.toJSON())),
      };
    }, resultName);
  };
  const check = async (run, c) => {
    const { page } = run;
    const published = await settle(page);
    const p = await probe(page);
    assert.deepEqual(run.errors, []);
    assert.deepEqual(p.errors, []);
    assert.equal(p.loads.length, 1, "One real model load per fresh context");
    assert.equal(p.loads[0].bytes, c.real ? known.length : fixture.length);
    assert.equal(p.loads[0].provider, c.provider);
    assert.equal(
      p.loads[0].precision,
      c.legacy ? undefined : c.fp16 ? "float16" : "float32",
    );
    assert.equal(p.loads[0].compatibilityFixes, c.compatibilityFixes ?? false);
    assert.equal(
      p.outputs.length,
      1,
      "One retained context, not a second hidden session",
    );
    assert.equal(p.inputs.length, 1);
    assert.equal(p.inputs[0].type, "Float32Array", "Public input stays FP32");
    assert.equal(p.inputs[0].finite, true);
    assert.equal(p.inputs[0].length, 16 * 128 * 128);
    const geometry = p.inputs[0].geometry;
    assert.deepEqual(geometry.inputShape, [16, 128, 128]);
    assert.deepEqual(geometry.rawOutputShape, [48, 128, 128]);
    assert.deepEqual(geometry.cropBefore, [6, 16, 16]);
    assert.deepEqual(geometry.cropAfter, [6, 16, 16]);
    assert.equal(geometry.outputChannels, 1);
    assert.equal(
      p.outputs[0].type,
      "Float32Array",
      "Public output stays FP32, including native FP16",
    );
    const values = p.outputs[0].values;
    assert.equal(values.length, retainedLength);
    assert(
      values.every(Number.isFinite),
      "Every retained output must be finite",
    );
    assertMetadata(p.loadedMetadata, c, run.environment);
    assertMetadata(p.metadata, c, run.environment);
    assertMetadata(p.outputs[0].metadata, c, run.environment);
    if (!c.real) {
      let i = 0,
        max = 0;
      for (let z = 0; z < 36; ++z)
        for (let y = 0; y < 96; ++y)
          for (let x = 0; x < 96; ++x) {
            max = Math.max(
              max,
              Math.abs(
                values[i++] -
                  expectedValue(
                    (c.coarse ? coarseOrigin[0] : origin[0]) + 16 + x,
                    (c.coarse ? coarseOrigin[1] : origin[1]) + 16 + y,
                    (c.coarse ? coarseOrigin[2] : origin[2]) + ((6 + z) % 16),
                    c.coarse,
                  ),
              ),
            );
          }
      assert(max < 2e-6, `Conv/Concat independent oracle max error ${max}`);
    }
    assert.deepEqual(published.bounds, [...liveSize, 1]);
    assert.deepEqual(published.chunkSize, [60, 60, 16, 1]);
    const pixels = {};
    for (const chunk of published.chunks) {
      assert.equal(
        chunk.type,
        "Float32Array",
        "Published datasource stays FP32",
      );
      assert(chunk.values?.every(Number.isFinite));
      assert.deepEqual(chunk.shape, [60, 60, 16, 1]);
      const [sx, sy, sz] = chunk.shape;
      for (let z = 0; z < sz; ++z)
        for (let y = 0; y < sy; ++y)
          for (let x = 0; x < sx; ++x) {
            const gx = chunk.position[0] * published.chunkSize[0] + x,
              gy = chunk.position[1] * published.chunkSize[1] + y,
              gz = chunk.position[2] * published.chunkSize[2] + z;
            assert(gx < liveSize[0] && gy < liveSize[1] && gz < liveSize[2]);
            const value = chunk.values[(z * sy + y) * sx + x];
            // Both full display tiles share the only retained source context.
            assert(
              Math.abs(value - values[(gz * 96 + gy) * 96 + gx]) < 2e-6,
              "Published pixels must match actual worker output",
            );
            pixels[(gz * liveSize[1] + gy) * liveSize[0] + gx] = value;
          }
    }
    assert(
      Object.keys(pixels).length >= 60 * 60 * 16,
      "Every voxel of at least one full demanded display chunk is checked",
    );
    const recipe = recipeFromState(published.state);
    assert.equal(recipe.version, 2);
    assert.equal(recipe.profile, "ncdhw-centered-v2");
    assert.equal(
      recipe.precision,
      c.legacy ? undefined : c.fp16 ? "float16" : "float32",
      "New recipes persist requested precision; legacy omission must survive replay",
    );
    assert.equal(recipe.provider, c.provider);
    assert.equal(recipe.compatibilityFixes, c.compatibilityFixes ?? false);
    assert.equal(recipe.overlap, false);
    assert.equal(recipe.mode, "live");
    assert.equal("roi" in recipe, false);
    assert.equal(
      recipe.inputScaleIndex,
      c.legacyScale ? undefined : c.coarse ? 1 : 0,
    );
    assert.deepEqual(
      recipe.outputSpacingZYX,
      [...(c.coarse ? coarseOutputSpacing : outputSpacing)].reverse(),
    );
    assert.deepEqual(
      recipe.spacingZYX,
      [...(c.coarse ? coarseSpacing : spacing)].reverse(),
    );
    assert.equal("preprocessing" in recipe, false);
    assert.equal(recipe.model.sha256, c.real ? knownHash : hash(fixture));
    assert.deepEqual(recipe.model.urls, [modelUrl(c.real)]);
    assert(run.requests.includes(c.real ? "known.onnx" : "fixture.onnx"));
    const sourcePath = c.coarse ? "pyramid" : "source";
    assert(run.requests.includes(`${sourcePath}/info`));
    assert(
      run.requests.some((r) =>
        r.startsWith(`${sourcePath}/${c.coarse ? "coarse" : "native"}/`),
      ),
      "selected scale chunks must actually be fetched",
    );
    await Promise.all(run.assetInspections);
    const runtimeAssets = run.assets.filter((a) =>
      /\.(mjs|wasm)$/.test(new URL(a.url).pathname),
    );
    if (runtimeManifest)
      assert.deepEqual(
        [...new Set(runtimeAssets.map((a) => a.url))].sort(),
        Object.values(nativeRuntimeAssets)
          .map((a) => a.url)
          .sort(),
        "Only the exact manifest runtime URLs may be fetched",
      );
    for (const [extension, expected] of Object.entries(nativeRuntimeAssets)) {
      const observed = runtimeAssets.filter((a) => a.url === expected.url);
      const expectedOrigin = new URL(expected.url).origin;
      const sameOrigin = expectedOrigin === appUrl.origin;
      const verified = (a) =>
        a.status === 200 &&
        a.nativeAsyncify &&
        a.bytes === expected.bytes &&
        a.sha256 === expected.sha256 &&
        (runtimeManifest
          ? a.requestedUrl === expected.url &&
            !a.redirectedFrom &&
            new URL(a.url).origin === expectedOrigin &&
            (sameOrigin || a.accessControlAllowOrigin === "*") &&
            !a.inspectionError &&
            a.contentType?.split(";", 1)[0].trim().toLowerCase() ===
              expected.contentType &&
            (extension !== "wasm" ||
              (a.contentEncoding === "br" &&
                (!sameOrigin ||
                  a.vary
                    ?.split(",")
                    .some(
                      (v) => v.trim().toLowerCase() === "accept-encoding",
                    )))) &&
            (expected.contentEncoding === undefined ||
              a.contentEncoding === expected.contentEncoding) &&
            (expected.encodedBytes === undefined ||
              a.contentLength === undefined ||
              a.contentLength === expected.encodedBytes)
          : a.accessControlAllowOrigin === "*" &&
            (extension === "wasm"
              ? a.contentType?.includes("application/wasm")
              : /javascript|ecmascript/.test(a.contentType || "")));
      assert(
        observed.length > 0 &&
          (runtimeManifest
            ? observed.every(verified)
            : observed.some(verified)),
        `${runtimeManifest ? "Manifest" : "Pinned"} native Asyncify ${extension} URL, status, CORS, MIME, inspected bytes and declared encoding must match; observed: ${JSON.stringify(runtimeAssets)}`,
      );
    }
    assert(
      !run.assets.some((a) => a.jsep || /jsep/i.test(new URL(a.url).pathname)),
      "No JSEP asset may be fetched (including content-hashed assets)",
    );
    return {
      values,
      pixels,
      recipe,
      metadata: p.metadata,
      runtimeAssets,
      environment: run.environment,
    };
  };
  const execute = async (browser, c) => {
    let run = await open(browser, stateUrl(initialState(c)));
    try {
      await setup(run, c);
      const first = await check(run, c);
      await assertVisiblePrecision(run.page, c, first.metadata);
      // Read the real URL binding, not a hand-constructed recipe replay URL.
      await run.page.waitForFunction(
        ({ name, precision }) => {
          try {
            const state = JSON.parse(
              decodeURIComponent(location.hash.slice(2)),
            );
            const source = state.layers.find((l) => l.name === name)?.source;
            return (
              (Array.isArray(source) ? source[0] : source)?.state?.precision ===
              precision
            );
          } catch {
            return false;
          }
        },
        { name: resultName, precision: c.fp16 ? "float16" : "float32" },
      );
      const copiedUrl = run.page.url();
      const copiedRecipe = recipeFromState(
        JSON.parse(decodeURIComponent(new URL(copiedUrl).hash.slice(2))),
      );
      assert.deepEqual(copiedRecipe, first.recipe);
      await close(run);
      run = await open(browser, copiedUrl); // Fresh storage/context, original closed.
      const replay = await check(run, c);
      assert.deepEqual(replay.recipe, first.recipe);
      assert.deepEqual(
        replay.values,
        first.values,
        "Fresh URL replay must recompute the same retained outputs",
      );
      assert.deepEqual(replay.pixels, first.pixels);
      if (!c.fp16 && !c.real && !c.coarse && c.provider === "cpu") {
        for (const omitted of ["precision", "inputScaleIndex"]) {
          const legacyState = JSON.parse(
            decodeURIComponent(new URL(copiedUrl).hash.slice(2)),
          );
          delete recipeFromState(legacyState)[omitted];
          await close(run);
          run = await open(browser, stateUrl(legacyState));
          const legacy = await check(run, {
            ...c,
            legacy: omitted === "precision",
            legacyScale: omitted === "inputScaleIndex",
          });
          assert.deepEqual(
            legacy.values,
            first.values,
            `Absent legacy recipe ${omitted} still means FP32 at scale 0`,
          );
          assert.deepEqual(legacy.pixels, first.pixels);
        }
        report.legacyAbsentPrecisionReplay = true;
        report.legacyAbsentInputScaleIndexReplay = true;
      }
      report.cases.push({
        name: c.name,
        metadata: first.metadata,
        retainedShape,
        retainedElements: first.values.length,
        publishedElements: Object.keys(first.pixels).length,
        freshContextReplay: true,
        publicTensorType: "float32",
        nativeAsyncify: true,
        runtimeAssets: first.runtimeAssets,
        environment: first.environment,
        inputScaleIndex: first.recipe.inputScaleIndex,
        automaticCoarseOutputSpacing: c.coarse || false,
      });
      return first;
    } finally {
      await close(run);
    }
  };
  const compare = (name, a, b) => {
    const stats = (x, y) => {
      assert.equal(x.length, y.length);
      let maxAbs = 0,
        sumAbs = 0,
        sumSquares = 0;
      for (let i = 0; i < x.length; ++i) {
        const d = Math.abs(x[i] - y[i]);
        maxAbs = Math.max(maxAbs, d);
        sumAbs += d;
        sumSquares += d * d;
      }
      return {
        elements: x.length,
        maxAbs,
        meanAbs: sumAbs / x.length,
        rmse: Math.sqrt(sumSquares / x.length),
      };
    };
    const comparison = {
      name,
      retained: stats(a.values, b.values),
      publishedLive: stats(Object.values(a.pixels), Object.values(b.pixels)),
      interpretation:
        "Measured differences only; no FP16/FP32 segmentation equivalence claimed. Retained crop, not uncropped raw output.",
    };
    report.comparisons.push(comparison);
    return comparison;
  };

  const cpuBrowser = await launch(false);
  const baseline = await execute(cpuBrowser, {
    name: "default FP32 unchanged",
    provider: "cpu",
    actualProvider: "wasm",
    fp16: false,
  });
  const cpuRequested = await execute(cpuBrowser, {
    name: "CPU FP16 request uses original FP32",
    provider: "cpu",
    actualProvider: "wasm",
    fp16: true,
    reason: /CPU|WASM|WebGPU/i,
  });
  assert.deepEqual(
    cpuRequested.values,
    baseline.values,
    "CPU requested FP16 must run the original FP32 graph",
  );
  compare(
    "CPU requested FP16 vs default CPU FP32 (exact)",
    baseline,
    cpuRequested,
  );
  await execute(cpuBrowser, {
    name: "unknown Conv/Concat FP16, WebGPU unavailable -> visible FP32",
    provider: "auto",
    actualProvider: "wasm",
    fp16: true,
    reason: /unavailable|adapter|WebGPU/i,
  });
  if (scaleSmoke)
    await execute(cpuBrowser, {
      name: "selected coarse scale, automatic output spacing and numerical shared replay",
      provider: "cpu",
      actualProvider: "wasm",
      fp16: false,
      coarse: true,
    });
  await cpuBrowser.close();
  browsers.delete(cpuBrowser);

  if (hardware) {
    const gpuBrowser = await launch(true);
    const capabilityPage = await gpuBrowser.newPage();
    await capabilityPage.goto(appUrl.href);
    const capability = await capabilityPage.evaluate(async () => {
      const adapter = await navigator.gpu?.requestAdapter();
      return {
        available: !!adapter,
        fallback: adapter?.info?.isFallbackAdapter,
        shaderF16: adapter?.features.has("shader-f16"),
        info: adapter
          ? {
              vendor: adapter.info.vendor,
              architecture: adapter.info.architecture,
              device: adapter.info.device,
              description: adapter.info.description,
            }
          : null,
      };
    });
    assert(
      capability.available && !capability.fallback && capability.shaderF16,
      `Hardware suite requires a real shader-f16 adapter: ${JSON.stringify(capability)}`,
    );
    report.adapter = capability;
    await capabilityPage.close();
    await execute(gpuBrowser, {
      name: "unverified model runs native WebGPU FP16",
      provider: "webgpu",
      actualProvider: "webgpu",
      fp16: true,
      actualPrecision: "float16",
    });
    if (known) {
      const cpu = await execute(gpuBrowser, {
        name: "original model6280000 CPU FP32",
        real: true,
        provider: "cpu",
        actualProvider: "wasm",
        fp16: false,
      });
      const fp32 = await execute(gpuBrowser, {
        name: "original model6280000 native WebGPU FP32",
        real: true,
        provider: "webgpu",
        actualProvider: "webgpu",
        fp16: false,
      });
      const fp16 = await execute(gpuBrowser, {
        name: "original model6280000 native WebGPU FP16",
        real: true,
        provider: "webgpu",
        actualProvider: "webgpu",
        fp16: true,
        actualPrecision: "float16",
      });
      const fp32Comparison = compare(
        "native WebGPU FP32 vs original CPU FP32",
        cpu,
        fp32,
      );
      assert(
        fp32Comparison.retained.maxAbs <= 0.01 &&
          fp32Comparison.retained.meanAbs <= 0.001,
        `Native FP32 regression: ${JSON.stringify(fp32Comparison)}`,
      );
      const paddingOnly = await execute(gpuBrowser, {
        name: "model6280000 padding-only compatibility fixes, native WebGPU FP32",
        real: true,
        provider: "webgpu",
        actualProvider: "webgpu",
        fp16: false,
        compatibilityFixes: true,
      });
      const paddingComparison = compare(
        "padding-only native WebGPU FP32 vs original CPU FP32",
        cpu,
        paddingOnly,
      );
      assert(
        paddingComparison.retained.maxAbs <= 0.01 &&
          paddingComparison.retained.meanAbs <= 0.001,
        `Padding-only FP32 regression: ${JSON.stringify(paddingComparison)}`,
      );
      compare("native WebGPU FP16 vs original CPU FP32", cpu, fp16);
      compare("native WebGPU FP16 vs native WebGPU FP32", fp32, fp16);
    } else
      report.realModelSkipped =
        "Set MODEL to verified original model6280000 for actual FP16/numerical comparisons";
  } else
    report.hardwareSkipped =
      "HARDWARE=1 required; default suite deliberately disables WebGPU. Unverified-model and actual FP16 GPU success are not claimed.";
  console.log(JSON.stringify({ ok: true, ...report }, null, 2));
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  for (const browser of browsers) await browser.close().catch(() => {});
  if (server) await new Promise((resolve) => server.close(resolve));
}
