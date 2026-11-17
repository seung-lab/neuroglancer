/* global URL, console, process, window */
// Hardware-only cancellation/recovery smoke. Builds/deploys nothing.
// Build first with tests/inference/build_pipeline_benchmark.sh.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";
import { httpContentType } from "./http_content_type.mjs";
import { installObserver } from "./pipeline_benchmark.mjs";

const root = path.resolve(process.env.DIST ?? "dist/client");
const scene = JSON.parse(
  await fs.readFile(
    new URL("./integration-benchmark-scene.json", import.meta.url),
    "utf8",
  ),
);
const expectedHashes = JSON.parse(
  await fs.readFile(
    new URL("./integration-benchmark-expected-hashes.json", import.meta.url),
    "utf8",
  ),
);
const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname,
    );
    const filename = path.resolve(
      root,
      "." + (pathname === "/" ? "/index.html" : pathname),
    );
    assert(filename.startsWith(root + path.sep));
    const data = await fs.readFile(filename);
    res.writeHead(200, {
      "Content-Type": httpContentType(filename),
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
let browser;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({
    executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
    headless: false,
    ignoreDefaultArgs: ["--enable-unsafe-swiftshader"],
    args: [
      "--no-sandbox",
      "--enable-unsafe-webgpu",
      "--enable-blink-features=WebGPUExperimentalFeatures",
      "--enable-dawn-features=vulkan_enable_f16_on_nvidia,allow_unsafe_apis,use_vulkan_memory_model",
      "--ozone-platform=wayland",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });
  await context.addInitScript(installObserver);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(
    `http://localhost:${server.address().port}/#!${encodeURIComponent(JSON.stringify(scene))}`,
    { waitUntil: "domcontentloaded" },
  );
  await page.waitForFunction(
    () => window.__benchSnapshot?.().pendingRuns > 0,
    null,
    { timeout: 90000 },
  );
  // Navigate while work is genuinely active, not after a completed viewport.
  for (const delta of [600, -800, 1200, -1200, 300, 0]) {
    await page.evaluate(
      ({ position, delta }) => {
        window.viewer.navigationState.position.value = new Float32Array([
          position[0] + delta,
          position[1] + delta,
          position[2],
        ]);
      },
      { position: scene.position, delta },
    );
    await page.waitForTimeout(120);
  }
  await page
    .waitForFunction(
      () => {
        const s = window.__benchSnapshot?.();
        return (
          s &&
          s.affinity.needed === 36 &&
          s.affinity.available === 36 &&
          s.tilesInFlight === 0 &&
          s.pendingRuns === 0 &&
          s.nativeInFlight === 0 &&
          s.quietMs >= 350
        );
      },
      null,
      { timeout: Number(process.env.PAN_TIMEOUT_MS ?? 180000) },
    )
    .catch(async (error) => {
      console.error(
        "Pan recovery deadline diagnostics",
        JSON.stringify(
          await page.evaluate(() => ({
            snapshot: window.__benchSnapshot?.(),
            workers: window.__benchProbe.workers.map((w) => ({
              index: w.index,
              terminatedAt: w.terminatedAt,
              loadedAt: w.loadedAt,
              submittedRuns: w.submittedRuns,
              pendingRuns: [...w.pendingRuns.keys()],
              nativePending: [...w.nativePending],
            })),
          })),
        ),
      );
      throw error;
    });
  const result = await page.evaluate(async () => ({
    snapshot: window.__benchSnapshot(),
    workers: window.__benchProbe.workers
      .filter((w) => w.isInference && w.submittedRuns > 0)
      .map((w) => ({ metadata: w.metadata })),
    cancelledSourceRequests: window.__benchProbe.nativeCancels,
    outputs: await window.__benchCollectOutputs(),
  }));
  if (errors.length || result.snapshot.errors.length) {
    console.error(
      JSON.stringify(
        await page.evaluate(() =>
          window.__benchProbe.workers.map((w) => ({
            index: w.index,
            url: w.url,
            terminatedAt: w.terminatedAt,
            submittedRuns: w.submittedRuns,
            isInference: w.isInference,
            loadedAt: w.loadedAt,
          })),
        ),
        null,
        2,
      ),
    );
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(result.snapshot.errors, []);
  for (const worker of result.workers) {
    assert.equal(worker.metadata.actualProvider, "webgpu");
    assert.equal(worker.metadata.actualPrecision, "float16");
    assert.equal(worker.metadata.webgpuSubgroupMatrix, true);
  }
  // Intermediate pan locations may add other grids; all original visible grids
  // must still match the complete baseline bytes after returning to the scene.
  const hashesByGrid = new Map(
    result.outputs.outputHashes.map((h) => [h.grid, h]),
  );
  for (const expected of expectedHashes) {
    assert.deepEqual(
      hashesByGrid.get(expected.grid),
      expected,
      `Pan/revisit output mismatch: ${expected.grid}`,
    );
  }
  console.log(
    JSON.stringify(
      {
        passed: true,
        baselineOutputHashesMatched: expectedHashes.length,
        ...result,
      },
      null,
      2,
    ),
  );
} finally {
  try {
    await browser?.close();
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
