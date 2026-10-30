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

/* global window, navigator, performance, fetch, AbortSignal */

/**
 * Bounded, real-volume production regression; NEVER builds or rewrites app JS.
 * Coordinate GPU use before running. Supply the ORIGINAL shared viewer JSON:
 *
 *   STATE_FILE=/absolute/path/shared-viewer-state.json HEADFUL=1 \
 *   CHROME=/usr/bin/google-chrome XDG_RUNTIME_DIR=/run/user/2050 \
 *   WAYLAND_DISPLAY=wayland-0 \
 *   VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/nvidia_icd.json \
 *   node tests/inference/navigation_recovery_production.mjs
 *
 * BASE_URL defaults to https://ng-onnx-dot-seung-lab.appspot.com/.
 * Fresh browsers run: stationary, navigation, transient. The stationary recipe,
 * layout, source, model and HTTP responses are unchanged. Navigation starts only
 * after a visible live layer AND a loaded worker actually running inference,
 * never the earlier model-inspection load. Navigation returns to the EXACT base
 * position. Transient stays at base, aborts a real selected-input-scale GCS
 * image-data request AFTER that gate, clears routing, then requires a successful
 * source retry AND all 25 original outputs. No simultaneous pan can make the
 * injected request irrelevant. Sharded inputs require minishard_bits=0 so only
 * proven image-data bytes, never shard/minishard indexes, are aborted. A retry
 * qualifies only after the actual injected request fails with CONNECTION_RESET:
 * a distinct GET must start later (monotonic event order), cover the failed
 * bytes, finish successfully and have response.finished() === null.
 * No missing-data/404 fixtures, model/runtime replacements, API mocks or reloads.
 * Worker wrappers only observe messages; tensor contents/transfers are unchanged.
 * This is a liveness/finite-output check, not a segmentation-quality oracle.
 *
 * Optional env (all bounds are enforced):
 *   CASES=stationary,navigation,transient (subsets are reported as partial)
 *   REPORT_DIR=... (default: a new OS temporary directory; JSON + screenshots)
 *   EXPECTED_VISIBLE=25, TIMEOUT=90000 (each startup/recovery wait, ms)
 *   CASE_TIMEOUT=240000, RUN_TIMEOUT=800000 (hard run watchdog)
 *   MOVES=36, MOVE_INTERVAL_MS=70, PAN_STEP_XYZ=144,113,9
 *   MOVE_OFFSETS_JSON=[[0,0,0],[144,113,9],...] (cycled relative XYZ offsets)
 *   FAULT_COUNT=1 (1..3), FAULT_TIMEOUT=15000
 *   LAUNCH_OPTIONS={...} (Playwright options; args appended to GPU flags)
 *
 * Offsets use viewer coordinates, not native input voxels. Before launch, real
 * source metadata bounds-checks the entire sweep with generous
 * input-context margins. Keep custom offsets within independently known image
 * coverage: rectangular metadata bounds cannot certify absence of internal holes.
 * Launch errors, missing GPU/shader-f16, CPU/FP32 fallback, a fault that never
 * fires, missing successful retry, incomplete tiles and deadlines are FAILURES,
 * never skips. TIMEOUT does not silently turn a stall into success.
 */
import assert from "node:assert/strict";
import console from "node:console";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";
import { URL } from "node:url";
import { chromium } from "playwright";

const report = {
  started: new Date().toISOString(),
  ok: false,
  scope:
    "Unmodified production app, real shared recipe/input/model, fresh browsers; no reload or GPU skips",
  cases: [],
  retryOracle: "confirmed-reset/post-failure-request-start/complete-body-v2",
};
let reportDir, reportPath, watchdog, activeBrowser;
const log = (event) => console.log(JSON.stringify(event));
const save = () =>
  fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
function integer(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  assert(
    Number.isSafeInteger(value) && value >= min && value <= max,
    `${name} must be an integer in [${min}, ${max}]`,
  );
  return value;
}
function xyz(text, name) {
  const value = text.split(",").map(Number);
  assert(
    value.length === 3 && value.every(Number.isFinite),
    `${name} must be finite X,Y,Z`,
  );
  return value;
}
// Recognize only public GCS object URLs, ignoring cache-busting query strings.
function gcsObject(text, bucket) {
  const url = new URL(text);
  if (url.protocol !== "https:") return;
  const prefix = `/storage/v1/b/${bucket}/o/`;
  if (url.hostname === "storage.googleapis.com") {
    if (url.pathname.startsWith(prefix))
      return decodeURIComponent(url.pathname.slice(prefix.length));
    if (url.pathname.startsWith(`/${bucket}/`))
      return decodeURIComponent(url.pathname.slice(bucket.length + 2));
  }
  if (url.hostname === `${bucket}.storage.googleapis.com`)
    return decodeURIComponent(url.pathname.slice(1));
}
// A coalesced/full-object retry is valid too, but an unrelated successful read
// of the same shard must not disguise a poisoned/zero-filled failed chunk.
function coversRange(failed, successful) {
  if (failed === successful || successful === null) return true;
  const a = /^bytes=(\d+)-(\d+)$/.exec(failed ?? "");
  const b = /^bytes=(\d+)-(\d+)$/.exec(successful);
  return (
    !!a && !!b && BigInt(b[1]) <= BigInt(a[1]) && BigInt(b[2]) >= BigInt(a[2])
  );
}
function observeWorkers() {
  const probe = (window.__navigationRecovery = {
    workers: [],
    events: [],
    outputCount: 0,
    nonfinite: 0,
    invalidOutputs: 0,
    wrongPrecision: 0,
    errors: [],
    lastActivity: performance.now(),
  });
  const record = (event) => {
    probe.lastActivity = performance.now();
    probe.events.push({ time: probe.lastActivity, ...event });
    if (probe.events.length > 2000) probe.events.shift();
  };
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      const worker = (this.observation = {
        index: probe.workers.length,
        url: String(args[0]),
        loaded: false,
        runs: 0,
        outputs: 0,
        pending: new Set(),
        terminated: false,
      });
      probe.workers.push(worker);
      record({ kind: "worker.create", worker: worker.index, url: worker.url });
      this.addEventListener("message", ({ data }) => {
        if (
          data?.functionName === "rpc.promise.response" &&
          Object.hasOwn(data, "error")
        ) {
          record({
            kind: "rpc.error",
            worker: worker.index,
            message: String(data.error?.message ?? data.error),
          });
        }
        if (!worker.load) return;
        if (data?.kind === "loaded") {
          worker.loaded = true;
          worker.metadata = data.metadata;
          record({
            kind: "loaded",
            worker: worker.index,
            metadata: data.metadata,
          });
        } else if (data?.kind === "output") {
          worker.pending.delete(data.id);
          worker.outputs++;
          probe.outputCount++;
          probe.lastOutputAt = Date.now();
          let min = Infinity,
            max = -Infinity;
          for (const value of data.output ?? []) {
            if (!Number.isFinite(value)) probe.nonfinite++;
            min = Math.min(min, value);
            max = Math.max(max, value);
          }
          const geometry = worker.geometry;
          const expectedLength = geometry?.rawOutputShape.reduce(
            (n, v, i) =>
              n * (v - geometry.cropBefore[i] - geometry.cropAfter[i]),
            geometry.outputChannels,
          );
          if (
            data.output?.constructor.name !== "Float32Array" ||
            !expectedLength ||
            data.output.length !== expectedLength
          )
            probe.invalidOutputs++;
          const metadata = data.metadata;
          if (
            metadata?.actualProvider !== "webgpu" ||
            metadata?.actualPrecision !== "float16" ||
            metadata?.precisionFallbackReason
          )
            probe.wrongPrecision++;
          probe.firstOutput ??= {
            length: data.output?.length,
            expectedLength,
            min,
            max,
            metadata,
          };
          record({
            kind: "output",
            worker: worker.index,
            id: data.id,
            runMs: data.runMs,
          });
        } else if (data?.kind === "error") {
          worker.pending.delete(data.id);
          probe.errors.push(data.message);
          record({
            kind: "error",
            worker: worker.index,
            message: data.message,
          });
        }
      });
      this.addEventListener("error", (event) => {
        if (!worker.terminated) probe.errors.push(event.message);
        record({
          kind: "worker.error",
          worker: worker.index,
          terminated: worker.terminated,
          message: event.message,
        });
      });
    }
    postMessage(data, ...args) {
      const worker = this.observation;
      if (data?.kind === "load") {
        worker.load = {
          provider: data.provider,
          precision: data.precision,
          bytes: data.model?.byteLength,
        };
        record({ kind: "load", worker: worker.index, ...worker.load });
      } else if (worker.load && data?.kind === "run") {
        worker.runs++;
        worker.geometry = data.geometry;
        worker.pending.add(data.id);
        record({ kind: "run", worker: worker.index, id: data.id });
      }
      return super.postMessage(data, ...args);
    }
    terminate() {
      this.observation.terminated = true;
      this.observation.pending.clear();
      record({ kind: "worker.terminate", worker: this.observation.index });
      return super.terminate();
    }
  };
  window.__navigationRecoverySnapshot = (name) => {
    const viewer = window.viewer;
    const layer = viewer?.layerManager.managedLayers.find(
      (l) => l.name === name,
    );
    const progress =
      layer?.layer?.renderLayers?.map((r) => ({
        needed: r.layerChunkProgressInfo.numVisibleChunksNeeded,
        available: r.layerChunkProgressInfo.numVisibleChunksAvailable,
      })) ?? [];
    const workers = probe.workers
      .filter((w) => w.load)
      .map((w) => ({
        ...w,
        pending: w.pending.size,
      }));
    return {
      time: performance.now(),
      position: Array.from(viewer?.navigationState.position.value ?? []),
      visible: layer?.visible,
      progress,
      ready: viewer?.isReady(),
      needed: progress.reduce((n, p) => n + p.needed, 0),
      available: progress.reduce((n, p) => n + p.available, 0),
      liveLoaded: workers.some((w) => !w.terminated && w.loaded && w.runs > 0),
      workers,
      outputs: probe.outputCount,
      lastOutputAt: probe.lastOutputAt,
      nonfinite: probe.nonfinite,
      invalidOutputs: probe.invalidOutputs,
      wrongPrecision: probe.wrongPrecision,
      firstOutput: probe.firstOutput,
      errors: probe.errors,
      pending: workers.reduce((n, w) => n + w.pending, 0),
      quietMs: performance.now() - probe.lastActivity,
    };
  };
}

try {
  reportDir = process.env.REPORT_DIR
    ? path.resolve(process.env.REPORT_DIR)
    : await fs.mkdtemp(
        path.join(os.tmpdir(), "neuroglancer-navigation-recovery-"),
      );
  await fs.mkdir(reportDir, { recursive: true });
  reportPath = path.join(reportDir, "report.json");
  await save();
  const timeout = integer("TIMEOUT", 90000, 1000, 300000);
  const caseTimeout = integer("CASE_TIMEOUT", 240000, 40000, 600000);
  const runTimeout = integer("RUN_TIMEOUT", 800000, 60000, 1800000);
  watchdog = setTimeout(() => {
    report.error = "Hard RUN_TIMEOUT exceeded";
    report.ok = false;
    report.finished = new Date().toISOString();
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
    console.error(`FAILURE: Hard RUN_TIMEOUT exceeded; ${reportPath}`);
    const kill = setTimeout(() => process.exit(1), 5000);
    Promise.resolve(activeBrowser?.close())
      .catch(() => {})
      .finally(() => {
        clearTimeout(kill);
        process.exit(1);
      });
  }, runTimeout);
  assert(
    process.env.STATE_FILE,
    "STATE_FILE is required (original shared viewer JSON, no temporary-path default)",
  );
  const stateBytes = await fs.readFile(process.env.STATE_FILE);
  const state = JSON.parse(stateBytes);
  const inferenceLayers = state.layers.filter((l) => {
    const sources = Array.isArray(l.source) ? l.source : [l.source];
    return sources.some((s) => s?.url === "inference://recipe");
  });
  assert.equal(
    inferenceLayers.length,
    1,
    "Supply a recipe with exactly one inference layer",
  );
  const layer = inferenceLayers[0];
  const sources = Array.isArray(layer.source) ? layer.source : [layer.source];
  const recipe = sources.find((s) => s.url === "inference://recipe").state;
  assert.equal(recipe.mode, "live");
  assert.equal(recipe.precision, "float16");
  assert(
    ["auto", "webgpu"].includes(recipe.provider),
    "Real WebGPU recipe required",
  );
  assert.equal(layer.visible ?? true, true);
  assert.deepEqual(Object.keys(state.dimensions), ["x", "y", "z"]);
  const base = state.position;
  assert(
    Array.isArray(base) && base.length === 3 && base.every(Number.isFinite),
  );
  assert.deepEqual(
    base,
    Array.from(new Float32Array(base)),
    "Base must round-trip exactly through viewer Float32 coordinates",
  );
  const inputSource = recipe.source.source;
  assert.equal(typeof inputSource, "string");
  const inputMatch =
    /^gs:\/\/([^/]+)\/([^|]*)\|neuroglancer-precomputed:$/.exec(inputSource);
  assert(
    inputMatch,
    "This real-volume regression requires a GCS precomputed input",
  );
  const [, bucket, inputPath] = inputMatch;
  const prefix = inputPath.replace(/\/$/, "") + "/";
  // Read-only metadata verifies coverage; not a fixture and never served to app.
  const metadataUrl = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(prefix + "info")}?alt=media`;
  const metadataResponse = await fetch(metadataUrl, {
    signal: AbortSignal.timeout(15000),
  });
  assert(
    metadataResponse.ok,
    `Real input metadata HTTP ${metadataResponse.status}`,
  );
  const info = await metadataResponse.json();
  const scale = info.scales[recipe.inputScaleIndex ?? 0];
  assert(
    scale?.key && scale.size?.length === 3 && scale.resolution?.length === 3,
  );
  const scalePrefix = prefix + scale.key.replace(/\/$/, "") + "/";
  const step = xyz(process.env.PAN_STEP_XYZ ?? "144,113,9", "PAN_STEP_XYZ");
  const offsets = process.env.MOVE_OFFSETS_JSON
    ? JSON.parse(process.env.MOVE_OFFSETS_JSON)
    : Array.from({ length: 36 }, (_, i) => [
        (i % 4) * step[0],
        (i % 3) * step[1],
        (i % 6) * step[2],
      ]);
  assert(Array.isArray(offsets) && offsets.length > 0 && offsets.length <= 120);
  assert(
    offsets.every(
      (p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite),
    ),
  );
  assert(
    offsets.some((p) => p[0] !== 0 || p[1] !== 0),
    "Navigation must pan XY",
  );
  assert(
    offsets.some((p) => p[2] !== 0),
    "Navigation must scroll Z",
  );
  const moves = integer("MOVES", 36, 2, 120);
  const interval = integer("MOVE_INTERVAL_MS", 70, 20, 1000);
  const positions = Array.from({ length: moves }, (_, i) =>
    base.map((v, j) => v + offsets[i % offsets.length][j]),
  );
  const faultPosition = base;
  const checkCoverage = (metadata) => {
    // Two full input contexts plus one native chunk on each side is deliberately
    // conservative. Gate-time model metadata supplies the real tensor shape.
    const context = metadata?.inputShape?.slice(-3).reverse();
    assert(
      context?.length === 3 &&
        context.every((v) => Number.isSafeInteger(v) && v > 0),
    );
    for (const p of [base, ...positions])
      p.forEach((v, i) => {
        const dimension = state.dimensions[["x", "y", "z"][i]];
        assert.equal(dimension[1], "m");
        const native = (v * dimension[0] * 1e9) / scale.resolution[i];
        const margin = 2 * context[i] + scale.chunk_sizes[0][i];
        const lower = scale.voxel_offset?.[i] ?? 0;
        assert(
          native - margin >= lower && native + margin < lower + scale.size[i],
          `Movement outside safe real input bounds on axis ${i}: ${JSON.stringify(p)}`,
        );
      });
  };
  // The full tensor-aware check runs before any movement. This early check keeps
  // even a malformed custom sweep from launching a browser out of image bounds.
  checkCoverage({ inputShape: [1, 1, 1, 1, 1] });
  const expectedVisible = integer("EXPECTED_VISIBLE", 25, 1, 10000);
  const faultCount = integer("FAULT_COUNT", 1, 1, 3);
  const faultTimeout = integer("FAULT_TIMEOUT", 15000, 1000, 60000);
  const cases = (process.env.CASES ?? "stationary,navigation,transient").split(
    ",",
  );
  assert(cases.length > 0 && new Set(cases).size === cases.length);
  assert(
    cases.every((c) => ["stationary", "navigation", "transient"].includes(c)),
  );
  const appUrl = new URL(
    process.env.BASE_URL ?? "https://ng-onnx-dot-seung-lab.appspot.com/",
  );
  assert(
    (appUrl.protocol === "https:" ||
      (appUrl.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(appUrl.hostname))) &&
      !appUrl.search &&
      !appUrl.hash &&
      !appUrl.username &&
      !appUrl.password,
  );
  const launch = JSON.parse(process.env.LAUNCH_OPTIONS ?? "{}");
  assert(
    launch.ignoreDefaultArgs !== true,
    "Do not drop all Chromium defaults",
  );
  assert(!launch.args || Array.isArray(launch.args));
  assert(!launch.ignoreDefaultArgs || Array.isArray(launch.ignoreDefaultArgs));
  report.configuration = {
    baseUrl: appUrl.href,
    stateSha256: createHash("sha256").update(stateBytes).digest("hex"),
    layer: layer.name,
    base,
    model: recipe.model,
    inputSource,
    inputScale: scale.key,
    expectedVisible,
    cases,
    partial: cases.length !== 3,
    timeout,
    caseTimeout,
    runTimeout,
    positions,
    interval,
    faultPosition,
    faultCount,
    viewport: { width: 1280, height: 800 },
  };
  log({ stage: "configuration", reportPath, ...report.configuration });

  for (const name of cases) {
    const entry = {
      name,
      started: new Date().toISOString(),
      ok: false,
      samples: [],
      console: [],
      networkFailures: [],
      sourceResponses: [],
      injections: [],
      shardDataEnds: {},
    };
    report.cases.push(entry);
    await save();
    if (name === "transient" && scale.sharding) {
      assert.equal(
        scale.sharding.minishard_bits,
        0,
        "Deterministic sharded fault requires a single minishard; do not guess which bytes are image data",
      );
    }
    let page,
      context,
      deadline,
      stopped = false;
    const sourceMatcher = (url) => {
      const key = gcsObject(url.href, bucket);
      if (!key?.startsWith(scalePrefix)) return false;
      const tail = key.slice(scalePrefix.length);
      return scale.sharding
        ? /^[^/]+\.shard$/.test(tail)
        : /^-?\d+--?\d+_-?\d+--?\d+_-?\d+--?\d+$/.test(tail);
    };
    let armed = false,
      networkSequence = 0,
      requestSequence = 0;
    const requestStarts = new WeakMap();
    const injectedRequests = new WeakMap();
    const networkEvent = () => ({
      time: Date.now(),
      sequence: ++networkSequence,
    });
    const requestKey = (request) => ({
      ...requestStarts.get(request),
      object: gcsObject(request.url(), bucket),
      range: request.headers()["range"] ?? null,
    });
    const faultRoute = async (route) => {
      if (
        !armed ||
        entry.injections.length >= faultCount ||
        route.request().method() !== "GET"
      )
        return route.continue();
      const key = requestKey(route.request());
      if (scale.sharding) {
        const range = /^bytes=(\d+)-(\d+)$/.exec(key.range ?? "");
        const dataEnd = entry.shardDataEnds[key.object];
        if (
          !range ||
          !dataEnd ||
          Number(range[1]) < 16 ||
          Number(range[2]) >= dataEnd
        )
          return route.continue();
      }
      const fault = {
        ...networkEvent(),
        ...key,
        dataEndExclusive: entry.shardDataEnds[key.object],
        code: "connectionreset",
      };
      entry.injections.push(fault);
      injectedRequests.set(route.request(), fault);
      if (entry.injections.length === faultCount) {
        armed = false;
        entry.injectionCleared = Date.now();
      }
      log({ case: name, stage: "requesting network reset", ...fault });
      await route.abort("connectionreset");
      fault.abortCompleted = networkEvent();
      log({
        case: name,
        stage: "route.abort completed",
        requestId: fault.requestId,
        ...fault.abortCompleted,
      });
    };
    const snapshot = () =>
      page.evaluate(
        (name) => window.__navigationRecoverySnapshot(name),
        layer.name,
      );
    const healthy = (s) => {
      assert.equal(s.nonfinite, 0, "Nonfinite real model output");
      assert.equal(
        s.invalidOutputs,
        0,
        "Wrong retained real model output type/shape",
      );
      assert.equal(
        s.wrongPrecision,
        0,
        "Every output must actually use WebGPU FP16, without fallback",
      );
      assert.deepEqual(s.errors, [], "Inference worker error");
      assert.deepEqual(entry.pageErrors ?? [], [], "Uncaught page error");
    };
    const at = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    const wait = async (stage, predicate, limit = timeout) => {
      const start = Date.now();
      let lastLog = 0,
        s;
      while (!stopped && Date.now() - start < limit) {
        s = await snapshot();
        healthy(s);
        if (Date.now() - lastLog >= 5000 || predicate(s)) {
          entry.samples.push({ stage, elapsed: Date.now() - start, ...s });
          log({
            case: name,
            stage,
            elapsed: Date.now() - start,
            position: s.position,
            needed: s.needed,
            available: s.available,
            outputs: s.outputs,
            pending: s.pending,
            liveLoaded: s.liveLoaded,
          });
          lastLog = Date.now();
        }
        if (predicate(s)) return s;
        await sleep(250);
      }
      throw new Error(
        `${name}: ${stage} exceeded ${limit}ms; last progress ${s?.available}/${s?.needed}, outputs ${s?.outputs}`,
      );
    };
    const complete = (s, position, count) =>
      at(s.position, position) &&
      s.visible &&
      s.ready &&
      s.needed > 0 &&
      s.needed === s.available &&
      (count === undefined || s.needed === count) &&
      s.outputs > 0 &&
      s.pending === 0 &&
      s.quietMs >= 500;
    const move = async (position) => {
      assert(!stopped, "Case already stopped");
      await page.evaluate((p) => {
        window.viewer.navigationState.position.value = new Float32Array(p);
      }, position);
    };
    try {
      const body = async () => {
        entry.stage = "browser launch";
        activeBrowser = await chromium.launch({
          ...launch,
          executablePath:
            process.env.CHROME ??
            launch.executablePath ??
            "/usr/bin/google-chrome",
          headless: process.env.HEADFUL !== "1",
          timeout: 30000,
          args: [
            "--no-sandbox",
            "--enable-unsafe-webgpu",
            "--enable-dawn-features=vulkan_enable_f16_on_nvidia",
            ...(process.env.WAYLAND_DISPLAY
              ? ["--ozone-platform=wayland"]
              : []),
            ...(launch.args ?? []),
          ],
          ignoreDefaultArgs: [
            ...new Set([
              "--enable-unsafe-swiftshader",
              ...(launch.ignoreDefaultArgs ?? []),
            ]),
          ],
        });
        entry.browser = activeBrowser.version();
        context = await activeBrowser.newContext({
          viewport: report.configuration.viewport,
          serviceWorkers: "block",
        });
        context.on("request", (request) => {
          const started = networkEvent();
          requestStarts.set(request, {
            requestId: ++requestSequence,
            requestStartTime: started.time,
            requestStartSequence: started.sequence,
          });
        });
        context.on("requestfailed", (request) => {
          const event = {
            ...networkEvent(),
            ...requestKey(request),
            url: request.url().split("?")[0],
            failure: request.failure(),
          };
          entry.networkFailureCount = (entry.networkFailureCount ?? 0) + 1;
          if (entry.networkFailures.length < 3000)
            entry.networkFailures.push(event);
          // Identity, not an overlapping URL/range, proves this was our abort.
          const fault = injectedRequests.get(request);
          if (fault) {
            fault.requestFailed = {
              time: event.time,
              sequence: event.sequence,
              requestId: event.requestId,
              errorText: event.failure?.errorText,
            };
            log({
              case: name,
              stage: "injected request failed",
              ...fault.requestFailed,
            });
          }
        });
        context.on("requestfinished", (request) => {
          const finished = { ...networkEvent(), ...requestKey(request) };
          if (stopped || request.method() !== "GET") return;
          const faults = entry.injections.filter(
            (fault) =>
              fault.requestFailed?.errorText === "net::ERR_CONNECTION_RESET" &&
              fault.object === finished.object &&
              Number.isSafeInteger(fault.requestId) &&
              Number.isSafeInteger(finished.requestId) &&
              fault.requestId !== finished.requestId &&
              // Strict event order rejects pre-existing requests even when the
              // wall-clock milliseconds are equal. IDs identify distinct requests.
              finished.requestStartSequence > fault.requestFailed.sequence,
          );
          if (!faults.length) return;
          void (async () => {
            const response = await request.response();
            if (!response || ![200, 206].includes(response.status())) return;
            const contentRange = /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/.exec(
              response.headers()["content-range"] ?? "",
            );
            const responseRange =
              response.status() === 200
                ? null
                : contentRange
                  ? `bytes=${contentRange[1]}-${contentRange[2]}`
                  : undefined;
            if (responseRange === undefined) return;
            // Headers alone are insufficient: a response can fail in its body.
            const error = await response.finished();
            if (error !== null || stopped || request.failure() !== null) return;
            const bodyCompleted = networkEvent();
            for (const fault of faults) {
              if (!coversRange(fault.range, responseRange)) continue;
              fault.successfulRetry = {
                ...finished,
                status: response.status(),
                responseRange,
                sameRange: fault.range === finished.range,
                bodyCompleted,
                responseFinished: null,
              };
              log({
                case: name,
                stage: "confirmed complete-body source retry",
                ...fault.successfulRetry,
              });
            }
          })().catch((error) => {
            (entry.observationErrors ??= []).push(String(error));
          });
        });
        context.on("response", (response) => {
          if (!sourceMatcher(new URL(response.url()))) return;
          const item = {
            ...networkEvent(),
            ...requestKey(response.request()),
            phase: "response-headers",
            status: response.status(),
          };
          entry.sourceResponseCount = (entry.sourceResponseCount ?? 0) + 1;
          if (entry.sourceResponses.length < 3000)
            entry.sourceResponses.push(item);
          // Observe the real, tiny shard header. With one minishard it records
          // the exclusive end of image bytes (offsets are relative to byte 16).
          // No requests/responses are synthesized, replayed or rewritten.
          if (
            name === "transient" &&
            scale.sharding &&
            item.range === "bytes=0-15" &&
            item.status === 206
          ) {
            void response
              .body()
              .then((body) => {
                if (body.length !== 16) return;
                const end = Number(body.readBigUInt64LE(0)) + 16;
                if (Number.isSafeInteger(end) && end > 16)
                  entry.shardDataEnds[item.object] = end;
              })
              .catch((error) => {
                (entry.observationErrors ??= []).push(String(error));
              });
          }
        });
        await context.addInitScript(observeWorkers);
        if (name === "transient")
          await context.route(sourceMatcher, faultRoute);
        page = await context.newPage();
        entry.documentLoads = 0;
        page.on("domcontentloaded", () => entry.documentLoads++);
        page.on("pageerror", (error) =>
          (entry.pageErrors ??= []).push(String(error)),
        );
        page.on("console", (message) => {
          if (entry.console.length < 300)
            entry.console.push({ type: message.type(), text: message.text() });
        });
        entry.stage = "viewer startup";
        const response = await page.goto(
          appUrl.href + "#!" + encodeURIComponent(JSON.stringify(state)),
          { waitUntil: "domcontentloaded", timeout: 60000 },
        );
        assert(response?.ok(), `Production viewer HTTP ${response?.status()}`);
        await page.waitForFunction(() => window.viewer?.state, null, {
          timeout,
        });
        entry.adapter = await page.evaluate(async () => {
          const adapter = await navigator.gpu?.requestAdapter();
          return {
            available: !!adapter,
            fallback: adapter?.info?.isFallbackAdapter,
            shaderF16: adapter?.features.has("shader-f16"),
            features: adapter ? [...adapter.features] : [],
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
          entry.adapter.available &&
            !entry.adapter.fallback &&
            entry.adapter.shaderF16,
          `Real shader-f16 GPU required, never skipped: ${JSON.stringify(entry.adapter)}`,
        );
        entry.stage = "visible live layer with loaded/running model";
        entry.gate = await wait(
          entry.stage,
          (s) => s.visible && s.needed > 0 && s.liveLoaded,
        );
        assert(
          at(entry.gate.position, base),
          "Recipe base changed before start gate",
        );
        const live = entry.gate.workers.find(
          (w) => !w.terminated && w.loaded && w.runs > 0,
        );
        assert.equal(live.load.precision, "float16");
        assert.equal(live.load.bytes, recipe.model.size);
        assert.equal(live.metadata.actualProvider, "webgpu");
        assert.equal(live.metadata.actualPrecision, "float16");
        assert(!live.metadata.precisionFallbackReason);
        checkCoverage(live.metadata);
        await page.screenshot({
          path: path.join(reportDir, `${name}-gate.png`),
          timeout: 5000,
        });

        if (name === "navigation") {
          entry.stage = "bounded XYZ navigation";
          for (const position of positions) {
            await move(position);
            await sleep(interval);
          }
          await move(base);
          entry.navigationStopped = Date.now();
        } else if (name === "transient") {
          entry.stage = "inject selected live input request";
          armed = true;
          entry.injectionArmed = Date.now();
          await wait(
            entry.stage,
            () =>
              entry.injections.length === faultCount &&
              entry.injections.every(
                (f) =>
                  f.abortCompleted &&
                  f.requestFailed?.errorText === "net::ERR_CONNECTION_RESET",
              ),
            faultTimeout,
          );
          armed = false;
          await context.unroute(sourceMatcher, faultRoute);
          entry.routeRemoved = Date.now();
          entry.stage =
            "recover original visible outputs and successful source retry after clearing reset";
          entry.faultRecovered = await wait(
            entry.stage,
            (s) =>
              complete(s, base, expectedVisible) &&
              entry.injections.every(
                (f) =>
                  s.lastOutputAt >= f.requestFailed.time && f.successfulRetry,
              ),
          );
          await page.screenshot({
            path: path.join(reportDir, `${name}-recovered-fault.png`),
            timeout: 5000,
          });
        }
        entry.stage = "all original visible outputs without reload";
        entry.final = await wait(entry.stage, (s) =>
          complete(s, base, expectedVisible),
        );
        assert(
          entry.final.firstOutput.max > entry.final.firstOutput.min,
          "First real model output must not be constant",
        );
        if (name === "stationary")
          assert(
            at(entry.final.position, entry.gate.position),
            "Stationary control moved",
          );
        if (name === "transient") {
          assert.equal(
            entry.injections.length,
            faultCount,
            "Fault injection must actually fire after layer creation",
          );
          assert(
            entry.injections.every(
              (f) =>
                f.time >= entry.injectionArmed &&
                f.abortCompleted &&
                f.requestFailed?.errorText === "net::ERR_CONNECTION_RESET" &&
                f.requestFailed.requestId === f.requestId &&
                f.successfulRetry &&
                f.successfulRetry.requestId !== f.requestId &&
                f.successfulRetry.requestStartSequence >
                  f.requestFailed.sequence &&
                f.successfulRetry.responseFinished === null &&
                f.successfulRetry.bodyCompleted,
            ),
            "Each confirmed injected reset must have a later-started, distinct retry that completes the failed source bytes",
          );
        }
        assert.equal(
          entry.documentLoads,
          1,
          "Viewer must recover without reloading",
        );
        entry.ok = true;
      };
      await Promise.race([
        body(),
        new Promise((_, reject) => {
          deadline = setTimeout(
            () =>
              reject(
                new Error(
                  `${name}: CASE_TIMEOUT ${caseTimeout}ms exceeded at ${entry.stage}`,
                ),
              ),
            caseTimeout,
          );
        }),
      ]);
    } catch (error) {
      entry.error = error.stack ?? String(error);
      process.exitCode = 1;
      console.error(`FAILURE: ${name}: ${entry.stage}: ${error.message}`);
    } finally {
      stopped = true;
      armed = false;
      clearTimeout(deadline);
      if (page && !page.isClosed()) {
        entry.last = await Promise.race([
          snapshot().catch(() => null),
          sleep(3000).then(() => null),
        ]);
        entry.events = await Promise.race([
          page
            .evaluate(() => window.__navigationRecovery?.events)
            .catch(() => null),
          sleep(3000).then(() => null),
        ]);
        await page
          .screenshot({
            path: path.join(
              reportDir,
              `${name}-${entry.ok ? "pass" : "failure"}.png`,
            ),
            timeout: 5000,
          })
          .catch((error) => {
            entry.screenshotError = String(error);
          });
      }
      const cleanup = setTimeout(() => {
        entry.cleanupError = "Browser close exceeded 10s";
        report.ok = false;
        writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
        process.exit(1);
      }, 10000);
      try {
        await activeBrowser?.close();
      } finally {
        clearTimeout(cleanup);
        activeBrowser = undefined;
      }
      entry.finished = new Date().toISOString();
      await save();
      log({
        case: name,
        ok: entry.ok,
        visible: entry.final
          ? `${entry.final.available}/${entry.final.needed}`
          : null,
        outputs: entry.final?.outputs,
        error: entry.error,
        reportPath,
      });
    }
  }
  report.ok =
    report.cases.length === cases.length && report.cases.every((c) => c.ok);
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  report.error = error.stack ?? String(error);
  process.exitCode = 1;
  console.error(`FAILURE: navigation recovery: ${error.message}`);
} finally {
  clearTimeout(watchdog);
  report.finished = new Date().toISOString();
  if (reportPath) await save();
  log({
    ok: report.ok,
    partial: report.configuration?.partial,
    reportPath,
    error: report.error,
  });
}
