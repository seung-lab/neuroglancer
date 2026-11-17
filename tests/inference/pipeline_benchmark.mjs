/* global URL, console, crypto, navigator, performance, process, setTimeout, window */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Resolve the project's existing Playwright installation even from an exported /tmp copy.
const { chromium } = createRequire(path.resolve(process.cwd(), "package.json"))(
  "playwright",
);
let BENCH_HASH;
let expectedHashes;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".map": "application/json; charset=utf-8",
};

async function startLocalServer(rootDir) {
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? "/", "http://localhost");
      let rel = decodeURIComponent(u.pathname);
      if (rel === "/") rel = "/index.html";
      const filePath = path.resolve(rootDir, "." + rel);
      const root = path.resolve(rootDir);
      if (filePath !== root && !filePath.startsWith(root + path.sep)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      const data = await fs.readFile(filePath);
      const ext = path.extname(filePath);
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cache-Control": "no-cache",
      });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  return { server, baseUrl: `http://localhost:${addr.port}/` };
}

function startGpuSampler(intervalMs = 100) {
  const samples = [];
  const t0 = performance.now();
  const procMs = spawn("nvidia-smi", [
    "--query-gpu=utilization.gpu,utilization.memory,memory.used",
    "--format=csv,noheader,nounits",
    "-lms",
    String(intervalMs),
  ]);
  let buf = "";
  let stderr = "";
  let failure;
  let exited = false;
  let stopping = false;
  const closed = new Promise((resolve) => {
    procMs.once("error", (error) => {
      failure = error;
    });
    procMs.once("close", (code, signal) => {
      exited = true;
      if (!stopping && failure === undefined)
        failure = new Error(
          `nvidia-smi exited unexpectedly: code=${code}, signal=${signal}; ${stderr}`,
        );
      resolve();
    });
  });
  procMs.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  procMs.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const parts = line.split(",").map((x) => Number(x.trim()));
      if (parts.length >= 3 && parts.every(Number.isFinite)) {
        samples.push({
          t: performance.now() - t0,
          gpu: parts[0],
          memUtil: parts[1],
          memUsedMiB: parts[2],
        });
      }
    }
  });
  return {
    samples,
    assertHealthy() {
      if (failure !== undefined) throw failure;
      if (exited)
        throw new Error(
          "nvidia-smi sampler exited before benchmark completion",
        );
    },
    async stop() {
      stopping = true;
      if (!exited) procMs.kill("SIGTERM");
      await closed;
    },
  };
}

function summarizeArray(arr) {
  if (!arr.length) return { count: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const q = (p) =>
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return {
    count: sorted.length,
    min: Number(sorted[0].toFixed(2)),
    p50: Number(q(0.5).toFixed(2)),
    mean: Number((sum / sorted.length).toFixed(2)),
    p90: Number(q(0.9).toFixed(2)),
    p95: Number(q(0.95).toFixed(2)),
    max: Number(sorted[sorted.length - 1].toFixed(2)),
    sum: Number(sum.toFixed(2)),
  };
}

function summarizeGpu(samples, tStart, tEnd) {
  const win = samples.filter((s) => s.t >= tStart && s.t <= tEnd);
  const vals = win.map((s) => s.gpu);
  if (!vals.length) return { count: 0 };
  const stats = summarizeArray(vals);
  const b0 = vals.filter((v) => v === 0).length;
  const b1_20 = vals.filter((v) => v >= 1 && v <= 20).length;
  const b21_45 = vals.filter((v) => v >= 21 && v <= 45).length;
  const b46_70 = vals.filter((v) => v >= 46 && v <= 70).length;
  const b71_100 = vals.filter((v) => v >= 71).length;
  return {
    ...stats,
    peakMemoryMiB: Math.max(...win.map((s) => s.memUsedMiB)),
    pctZero: Number(((100 * b0) / vals.length).toFixed(1)),
    pct1_20: Number(((100 * b1_20) / vals.length).toFixed(1)),
    pct21_45: Number(((100 * b21_45) / vals.length).toFixed(1)),
    pct46_70: Number(((100 * b46_70) / vals.length).toFixed(1)),
    pct71_100: Number(((100 * b71_100) / vals.length).toFixed(1)),
  };
}

function installObserver() {
  const probe = {
    workers: [],
    runs: [],
    tiles: new Map(),
    completedTiles: [],
    nativeInFlight: 0,
    maxNativeInFlight: 0,
    nativeRequests: 0,
    nativeCancels: 0,
    errors: [],
    terminatedWorkerEvents: [],
    outputBytes: new Map(),
    outputShapes: new Map(),
    lastActivity: performance.now(),
  };
  window.__benchProbe = probe;
  const NativeWorker = window.Worker;
  window.Worker = class ObservedWorker extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      const w = {
        index: probe.workers.length,
        url: String(url),
        spawnAt: performance.now(),
        loadSentAt: null,
        loadedAt: null,
        metadata: null,
        isInference: false,
        pendingRuns: new Map(),
        submittedRuns: 0,
        canceledRuns: 0,
        terminatedAt: null,
        nativePending: new Set(),
      };
      probe.workers.push(w);
      this.obs = w;
      const journalTerminatedEvent = (type, details) => {
        probe.terminatedWorkerEvents.push({
          worker: w.index,
          at: performance.now(),
          terminatedAt: w.terminatedAt,
          type,
          ...details,
        });
      };
      this.addEventListener("error", (event) => {
        if (w.terminatedAt !== null) {
          journalTerminatedEvent("error", { message: event.message });
          event.preventDefault();
          return;
        }
        probe.errors.push(`Worker ${w.index}: ${event.message}`);
      });
      this.addEventListener("messageerror", () => {
        if (w.terminatedAt !== null) {
          journalTerminatedEvent("messageerror", {
            message: "message deserialization failed",
          });
          return;
        }
        probe.errors.push(`Worker ${w.index}: message deserialization failed`);
      });

      this.addEventListener("message", (ev) => {
        const now = performance.now();
        const d = ev.data;
        if (w.terminatedAt !== null) {
          journalTerminatedEvent("message", {
            kind: d?.kind,
            functionName: d?.functionName,
            id: d?.id,
            message: d?.message,
          });
          return;
        }
        if (
          d?.functionName === "rpc.promise.response" &&
          w.nativePending.has(d.id)
        ) {
          w.nativePending.delete(d.id);
          probe.nativeInFlight = Math.max(0, probe.nativeInFlight - 1);
          probe.lastActivity = now;
        } else if (d?.functionName === "inference/tile") {
          probe.tiles.set(d.id, {
            id: d.id,
            grid: Array.from(d.gridZYX ?? []),
            worker: w.index,
            reqAt: now,
          });
          probe.lastActivity = now;
        } else if (
          d?.functionName === "rpc.promise.cancel" &&
          probe.tiles.has(d.id)
        ) {
          probe.tiles.delete(d.id);
          probe.lastActivity = now;
        }
        if (w.isInference) {
          if (d?.metadata !== undefined) {
            w.metadata = d.metadata;
            if (
              d.metadata.actualProvider !== "webgpu" ||
              d.metadata.actualPrecision !== "float16" ||
              d.metadata.webgpuSubgroupMatrix !== true
            )
              probe.errors.push(
                `Worker ${w.index}: expected WebGPU/FP16/subgroup matrix, got ${d.metadata.actualProvider}/${d.metadata.actualPrecision}/${d.metadata.webgpuSubgroupMatrix}`,
              );
          }
          if (d?.kind === "warmed") {
            w.warmedAt = now;
            probe.lastActivity = now;
          } else if (d?.kind === "loaded") {
            w.loadedAt = now;
            w.metadata = d.metadata;
            probe.lastActivity = now;
          } else if (d?.kind === "output") {
            const r = w.pendingRuns.get(d.id);
            w.pendingRuns.delete(d.id);
            probe.lastActivity = now;
            if (r) {
              r.recvAt = now;
              r.workerRunMs = d.runMs;
              r.rpcMs = now - r.sentAt;
              r.metadata = {
                actualProvider: d.metadata?.actualProvider,
                actualPrecision: d.metadata?.actualPrecision,
                webgpuSubgroupMatrix: d.metadata?.webgpuSubgroupMatrix,
              };
              probe.runs.push(r);
            } else {
              probe.errors.push(
                `Worker ${w.index}: output for untracked request ${d.id}`,
              );
            }
          } else if (d?.kind === "error") {
            w.pendingRuns.delete(d.id);
            probe.errors.push(String(d.message));
          }
        }
      });
    }

    terminate() {
      const w = this.obs;
      if (w.terminatedAt === null) {
        w.terminatedAt = performance.now();
        w.canceledRuns += w.pendingRuns.size;
        w.pendingRuns.clear();
        probe.nativeInFlight -= w.nativePending.size;
        w.nativePending.clear();
        for (const [id, tile] of probe.tiles)
          if (tile.worker === w.index) probe.tiles.delete(id);
        probe.lastActivity = w.terminatedAt;
      }
      return super.terminate();
    }

    postMessage(data, ...rest) {
      const now = performance.now();
      const w = this.obs;
      if (data?.functionName === "ChunkManager.requestChunk") {
        w.nativePending.add(data.id);
        probe.nativeRequests++;
        probe.nativeInFlight++;
        if (probe.nativeInFlight > probe.maxNativeInFlight) {
          probe.maxNativeInFlight = probe.nativeInFlight;
        }
        probe.lastActivity = now;
      } else if (
        data?.functionName === "rpc.promise.cancel" &&
        w.nativePending.has(data.id)
      ) {
        probe.nativeCancels++;
      } else if (
        data?.functionName === "rpc.promise.response" &&
        probe.tiles.has(data.id)
      ) {
        const t = probe.tiles.get(data.id);
        probe.tiles.delete(data.id);
        t.doneAt = now;
        t.ok = Object.hasOwn(data, "value");
        if (t.ok && data.value instanceof Float32Array) {
          // Copy before postMessage transfers/detaches it. Hash after timing ends.
          probe.outputBytes.set(t.grid.join(","), data.value.slice().buffer);
          // inference:// live display chunks are fixed at ZYX [16, 60, 60].
          t.shapeCZYX = [data.value.length / (16 * 60 * 60), 16, 60, 60];
          probe.outputShapes.set(t.grid.join(","), t.shapeCZYX);
        } else if (t.ok) {
          probe.errors.push("Inference tile response is not a Float32Array");
        }
        probe.completedTiles.push(t);
        probe.lastActivity = now;
      }
      if (data?.kind === "warmup") {
        w.isInference = true;
        w.warmupSentAt = now;
        probe.lastActivity = now;
      } else if (data?.kind === "load") {
        w.isInference = true;
        w.loadSentAt = now;
        probe.lastActivity = now;
      } else if (w.isInference && data?.kind === "run") {
        const batchSize = Array.isArray(data.inputs) ? data.inputs.length : 1;
        if (w.pendingRuns.has(data.id))
          probe.errors.push(
            `Worker ${w.index}: duplicate pending run ID ${data.id}`,
          );
        w.submittedRuns++;
        w.pendingRuns.set(data.id, {
          id: data.id,
          worker: w.index,
          sentAt: now,
          batchSize,
        });
        probe.lastActivity = now;
      }
      return super.postMessage(data, ...rest);
    }
  };

  window.__benchCollectOutputs = async () => {
    const outputHashes = await Promise.all(
      [...probe.outputBytes].map(async ([grid, bytes]) => {
        const values = new Float32Array(bytes);
        for (let i = 0; i < values.length; ++i)
          if (!Number.isFinite(values[i]))
            throw new Error(
              `Non-finite inference output: grid=${grid}, element=${i}`,
            );
        const shape = probe.outputShapes.get(grid);
        if (
          !shape ||
          shape.length !== 4 ||
          shape.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
          shape.reduce((size, value) => size * value, 4) !== bytes.byteLength
        )
          throw new Error(`Invalid complete output shape: grid=${grid}`);
        return {
          grid,
          bytes: bytes.byteLength,
          sha256: [
            ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          ]
            .map((value) => value.toString(16).padStart(2, "0"))
            .join(""),
        };
      }),
    );
    return {
      outputHashes,
      outputShapes: [...probe.outputShapes].map(([grid, shapeCZYX]) => ({
        grid,
        shapeCZYX,
      })),
    };
  };

  window.__benchSnapshot = () => {
    const viewer = window.viewer;
    const getLayerProg = (name) => {
      const l = viewer?.layerManager?.managedLayers?.find(
        (m) => m.name === name,
      );
      const rls = l?.layer?.renderLayers ?? [];
      let needed = 0;
      let available = 0;
      for (const r of rls) {
        needed += r.layerChunkProgressInfo?.numVisibleChunksNeeded ?? 0;
        available += r.layerChunkProgressInfo?.numVisibleChunksAvailable ?? 0;
      }
      return { exists: !!l, renderLayers: rls.length, needed, available };
    };
    const infWorkers = probe.workers.filter((w) => w.isInference);
    let pendingRuns = 0;
    for (const w of infWorkers) pendingRuns += w.pendingRuns.size;
    return {
      now: performance.now(),
      mec: getLayerProg("mec"),
      affinity: getLayerProg("mec_affinity"),
      tilesInFlight: probe.tiles.size,
      tilesCompleted: probe.completedTiles.length,
      runsCompleted: probe.runs.length,
      pendingRuns,
      nativeInFlight: probe.nativeInFlight,
      errors: probe.errors,
      terminatedWorkerEvents: probe.terminatedWorkerEvents,
      quietMs: performance.now() - probe.lastActivity,
    };
  };
}

async function runSingleBenchmark({ context, baseUrl, label }) {
  const gpuSampler = startGpuSampler(100);
  const tBench0 = performance.now();
  const hostEpoch = Date.now();
  let page;
  try {
    const net = {
      model: [],
      ort: [],
      gcsInfo: [],
      gcsShards: [],
      maxConcurrentGcsShards: 0,
    };
    let inFlightShards = 0;
    const reqStart = new Map();

    page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    const consoleWarnings = [];
    page.on("pageerror", (e) => {
      console.error("[pageerror]", String(e));
      pageErrors.push(String(e));
    });
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") {
        console.error("[console:" + m.type() + "]", m.text());
        const knownFavicon404 =
          m.location().url.endsWith("/favicon.ico") && m.text().includes("404");
        if (m.type() === "error" && !knownFavicon404)
          consoleErrors.push(m.text());
        else consoleWarnings.push(m.text());
      }
    });

    page.on("request", (req) => {
      const t = performance.now() - tBench0;
      const url = req.url();
      reqStart.set(req, t);
      if (
        url.includes("princeton-eric-medial-entorhinal-cortex") &&
        !url.endsWith("/info") &&
        !url.includes("info?")
      ) {
        inFlightShards++;
        if (inFlightShards > net.maxConcurrentGcsShards) {
          net.maxConcurrentGcsShards = inFlightShards;
        }
      }
    });

    const finishReq = async (req, failed = false) => {
      const tEnd = performance.now() - tBench0;
      const tStart = reqStart.get(req) ?? tEnd;
      const url = req.url();
      let status = 0;
      if (!failed) {
        const resp = await req.response().catch(() => null);
        status = resp?.status() ?? 0;
      }
      if (url.includes("model300000.onnx")) {
        net.model.push({ tStart, tEnd, dur: tEnd - tStart, status, failed });
      } else if (url.includes("ort-wasm")) {
        net.ort.push({
          name: url.split("/").pop(),
          tStart,
          tEnd,
          dur: tEnd - tStart,
          status,
          failed,
        });
      } else if (url.includes("princeton-eric-medial-entorhinal-cortex")) {
        if (url.endsWith("/info") || url.includes("info?")) {
          net.gcsInfo.push({ tStart, tEnd, dur: tEnd - tStart, status });
        } else {
          inFlightShards = Math.max(0, inFlightShards - 1);
          net.gcsShards.push({
            tStart,
            tEnd,
            dur: tEnd - tStart,
            range: req.headers()["range"] ?? "",
            status,
            failed,
          });
        }
      }
    };
    page.on("requestfinished", (req) => void finishReq(req, false));
    page.on("requestfailed", (req) => void finishReq(req, true));

    const tGotoStart = performance.now() - tBench0;
    await page.goto(baseUrl + BENCH_HASH, {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });
    const tDomLoaded = performance.now() - tBench0;

    // Poll until affinity visible chunks are all available AND prefetch queue settles
    let tFirstAffinityVisible = null;
    let tAllAffinityVisible = null;
    let tAllSettled = null;
    let settledConfirmed = false;
    let runsAtAllVisible = null;
    let tilesAtAllVisible = null;
    let tAllMecVisible = null;
    let lastLogAt = 0;
    const pollHistory = [];
    const deadline = performance.now() + 180000;

    while (performance.now() < deadline) {
      gpuSampler.assertHealthy();
      if (pageErrors.length || consoleErrors.length)
        throw new Error([...pageErrors, ...consoleErrors].join("; "));
      const snap = await page.evaluate(() => window.__benchSnapshot?.());
      const tNow = performance.now() - tBench0;
      if (snap) {
        if (snap.errors.length) {
          throw new Error(`Inference worker errors: ${snap.errors.join("; ")}`);
        }
        if (tNow - lastLogAt >= 2000) {
          lastLogAt = tNow;
          console.error(
            `[${label} ${(tNow / 1000).toFixed(1)}s] mec=${snap.mec.available}/${snap.mec.needed} aff=${snap.affinity.available}/${snap.affinity.needed} tilesInFlight=${snap.tilesInFlight} tilesDone=${snap.tilesCompleted} runs=${snap.runsCompleted} pendingRuns=${snap.pendingRuns} nativeInFlight=${snap.nativeInFlight}`,
          );
        }
        if (
          tAllMecVisible === null &&
          snap.mec.needed > 0 &&
          snap.mec.available === snap.mec.needed
        ) {
          tAllMecVisible = tNow;
        }
        if (tFirstAffinityVisible === null && snap.affinity.available > 0) {
          tFirstAffinityVisible = tNow;
        }
        if (
          snap.affinity.needed > 0 &&
          snap.affinity.available === snap.affinity.needed
        ) {
          if (tAllAffinityVisible === null) {
            tAllAffinityVisible = tNow;
            runsAtAllVisible = snap.runsCompleted;
            tilesAtAllVisible = snap.tilesCompleted;
            console.error(
              `[${label} ${(tNow / 1000).toFixed(2)}s] *** ALL VISIBLE AFFINITY CHUNKS COMPLETE (${snap.affinity.available}/${snap.affinity.needed}, tilesDone=${snap.tilesCompleted}, runs=${snap.runsCompleted}, tilesInFlight=${snap.tilesInFlight}) ***`,
            );
          }
        } else {
          tAllAffinityVisible = null;
        }
        const allSettled =
          snap.affinity.needed > 0 &&
          snap.affinity.available === snap.affinity.needed &&
          snap.tilesInFlight === 0 &&
          snap.pendingRuns === 0;
        if (allSettled) {
          if (tAllSettled === null) {
            tAllSettled = tNow;
          }
          if (snap.quietMs >= 350) {
            pollHistory.push({ tNow, ...snap });
            settledConfirmed = true;
            break;
          }
        } else {
          tAllSettled = null;
        }
        pollHistory.push({ tNow, ...snap });
      }
      await new Promise((r) => setTimeout(r, 40));
    }

    if (tAllAffinityVisible === null)
      throw new Error(
        `${label}: Timed out waiting for mec_affinity visible chunks to finish`,
      );
    if (!settledConfirmed || tAllSettled === null)
      throw new Error(
        `${label}: Timed out waiting for the inference queue to settle`,
      );

    const initialProbe = await page.evaluate(async () => {
      const p = window.__benchProbe;
      const adapter = await navigator.gpu?.requestAdapter();
      return {
        timeOrigin: performance.timeOrigin,
        isolated: window.crossOriginIsolated,
        ...(await window.__benchCollectOutputs()),
        hardwareConcurrency: navigator.hardwareConcurrency,
        adapterFeatures: adapter ? [...adapter.features].sort() : [],
        subgroupMatrixCount: adapter?.info?.subgroupMatrixConfigs?.length ?? 0,
        workers: p.workers.map((w) => ({
          index: w.index,
          url: w.url,
          isInference: w.isInference,
          spawnAt: w.spawnAt,
          loadSentAt: w.loadSentAt,
          loadedAt: w.loadedAt,
          warmupSentAt: w.warmupSentAt ?? null,
          warmedAt: w.warmedAt ?? null,
          submittedRuns: w.submittedRuns,
          canceledRuns: w.canceledRuns,
          terminatedAt: w.terminatedAt,
          pendingRuns: w.pendingRuns.size,
          metadata: w.metadata,
        })),
        runs: p.runs,
        completedTiles: p.completedTiles,
        nativeRequests: p.nativeRequests,
        nativeCancels: p.nativeCancels,
        maxNativeInFlight: p.maxNativeInFlight,
        finalSnap: window.__benchSnapshot(),
      };
    });

    gpuSampler.assertHealthy();
    if (pageErrors.length || consoleErrors.length)
      throw new Error([...pageErrors, ...consoleErrors].join("; "));
    assert(
      initialProbe.isolated,
      "Benchmark page must be cross-origin isolated",
    );
    assert(
      initialProbe.finalSnap.affinity.needed > 0,
      "No visible affinity chunks",
    );
    assert.equal(
      initialProbe.finalSnap.affinity.available,
      initialProbe.finalSnap.affinity.needed,
    );
    assert.equal(initialProbe.finalSnap.pendingRuns, 0);
    assert.equal(initialProbe.finalSnap.tilesInFlight, 0);
    assert.equal(initialProbe.finalSnap.errors.length, 0);
    assert(
      initialProbe.completedTiles.every((tile) => tile.ok),
      "Inference tile failed",
    );
    const outputHashes = initialProbe.outputHashes.sort((a, b) =>
      a.grid.localeCompare(b.grid),
    );
    assert.deepEqual(
      outputHashes,
      expectedHashes,
      "Complete output chunk grid/byte/SHA-256 mismatch",
    );
    assert.equal(initialProbe.finalSnap.affinity.needed, expectedHashes.length);
    assert.equal(initialProbe.outputShapes.length, expectedHashes.length);
    for (const output of initialProbe.outputShapes)
      assert.deepEqual(
        output.shapeCZYX,
        [4, 16, 60, 60],
        `Output shape for grid ${output.grid}`,
      );
    assert(initialProbe.runs.length > 0, "No completed inference runs");
    for (const worker of initialProbe.workers.filter(
      (worker) => worker.submittedRuns > 0,
    )) {
      assert.equal(
        worker.canceledRuns,
        0,
        `Worker ${worker.index} canceled cold-load runs`,
      );
      assert.equal(
        worker.pendingRuns,
        0,
        `Worker ${worker.index} has pending runs`,
      );
      assert.equal(
        initialProbe.runs.filter((run) => run.worker === worker.index).length,
        worker.submittedRuns,
        `Worker ${worker.index} lost an inference run`,
      );
      assert.equal(
        worker.metadata?.actualProvider,
        "webgpu",
        `Worker ${worker.index} provider`,
      );
      assert.equal(
        worker.metadata?.actualPrecision,
        "float16",
        `Worker ${worker.index} precision`,
      );
      assert.equal(
        worker.metadata?.webgpuSubgroupMatrix,
        true,
        `Worker ${worker.index} subgroup matrix`,
      );
    }
    for (const run of initialProbe.runs) {
      assert.equal(
        run.metadata?.actualProvider,
        "webgpu",
        `Run ${run.worker}/${run.id} provider`,
      );
      assert.equal(
        run.metadata?.actualPrecision,
        "float16",
        `Run ${run.worker}/${run.id} precision`,
      );
      assert.equal(
        run.metadata?.webgpuSubgroupMatrix,
        true,
        `Run ${run.worker}/${run.id} subgroup matrix`,
      );
      assert(
        Number.isFinite(run.workerRunMs) && run.workerRunMs >= 0,
        "Invalid worker run duration",
      );
      assert(
        Number.isFinite(run.sentAt) &&
          Number.isFinite(run.recvAt) &&
          run.recvAt >= run.sentAt,
        "Invalid run interval",
      );
    }
    assert(
      gpuSampler.samples.length > 0,
      "nvidia-smi produced no valid samples",
    );

    // Compute initial-load metrics
    const infWorkers = initialProbe.workers.filter((w) => w.isInference);
    const runs = initialProbe.runs;
    const workerRunMsAll = runs.map((r) => r.workerRunMs);
    const seenWorkers = new Set();
    const workerRunMsWarm = [...runs]
      .sort((a, b) => a.sentAt - b.sentAt)
      .filter((run) => {
        if (seenWorkers.has(run.worker)) return true;
        seenWorkers.add(run.worker);
        return false;
      })
      .map((run) => run.workerRunMs);
    const rpcMsAll = runs.map((r) => r.rpcMs);
    const interRunGaps = [];
    const firstRun = runs.reduce((first, run) =>
      run.sentAt < first.sentAt ? run : first,
    );
    const firstRunSent = firstRun.sentAt;
    const lastRunRecv = runs.length
      ? Math.max(...runs.map((r) => r.recvAt))
      : 0;
    const activeInfWallMs = lastRunRecv - firstRunSent;
    const sumWorkerRunMs = workerRunMsAll.reduce((a, b) => a + b, 0);
    const sortedIntervals = runs
      .map((r) => [r.sentAt, r.recvAt])
      .sort((a, b) => a[0] - b[0]);
    let unionBusyMs = 0;
    let curStart = -Infinity;
    let curEnd = -Infinity;
    for (const [s, e] of sortedIntervals) {
      if (s > curEnd) {
        if (curEnd > curStart) {
          unionBusyMs += curEnd - curStart;
          interRunGaps.push(s - curEnd);
        }
        curStart = s;
        curEnd = e;
      } else if (e > curEnd) {
        curEnd = e;
      }
    }
    if (curEnd > curStart) unionBusyMs += curEnd - curStart;
    const zeroWorkersActiveMs = Math.max(0, activeInfWallMs - unionBusyMs);
    const perWorkerRuns = {};
    for (const r of runs) {
      perWorkerRuns[r.worker] = (perWorkerRuns[r.worker] ?? 0) + 1;
    }

    // Align page performance.now() roughly with tBench0 (page created right after tGotoStart)
    const infGpuWindowStart =
      initialProbe.timeOrigin - hostEpoch + firstRunSent;
    const infGpuWindowEnd = initialProbe.timeOrigin - hostEpoch + lastRunRecv;

    return {
      label,
      outputHashes,
      outputShapes: initialProbe.outputShapes.sort((a, b) =>
        a.grid.localeCompare(b.grid),
      ),
      isolated: initialProbe.isolated,
      subgroupMatrixCount: initialProbe.subgroupMatrixCount,
      hasSubgroupMatrix: initialProbe.adapterFeatures.includes(
        "chromium-experimental-subgroup-matrix",
      ),
      hasShaderF16: initialProbe.adapterFeatures.includes("shader-f16"),
      visibleChunksNeeded: initialProbe.finalSnap.affinity.needed,
      mecChunksNeeded: initialProbe.finalSnap.mec.needed,
      timingsMs: {
        domLoaded: Number((tDomLoaded - tGotoStart).toFixed(1)),
        mecVisibleComplete: tAllMecVisible
          ? Number((tAllMecVisible - tGotoStart).toFixed(1))
          : null,
        modelFetchStart: net.model[0]
          ? Number(net.model[0].tStart.toFixed(1))
          : null,
        modelFetchEnd: net.model[0]
          ? Number(net.model[0].tEnd.toFixed(1))
          : null,
        modelFetchDur: net.model[0]
          ? Number(net.model[0].dur.toFixed(1))
          : null,
        ortFetchDur: net.ort.length
          ? Number(
              (
                Math.max(...net.ort.map((o) => o.tEnd)) -
                Math.min(...net.ort.map((o) => o.tStart))
              ).toFixed(1),
            )
          : null,
        workerSpawnAt: infWorkers[0]
          ? Number(infWorkers[0].spawnAt.toFixed(1))
          : null,
        workerWarmupSentAt: infWorkers[0]?.warmupSentAt
          ? Number(infWorkers[0].warmupSentAt.toFixed(1))
          : null,
        workerWarmedAt: infWorkers[0]?.warmedAt
          ? Number(infWorkers[0].warmedAt.toFixed(1))
          : null,
        workerLoadSentAt: infWorkers[0]?.loadSentAt
          ? Number(infWorkers[0].loadSentAt.toFixed(1))
          : null,
        workerLoadedAt: infWorkers[0]?.loadedAt
          ? Number(infWorkers[0].loadedAt.toFixed(1))
          : null,
        workerLoadDur:
          infWorkers[0]?.loadedAt && infWorkers[0]?.loadSentAt
            ? Number(
                (infWorkers[0].loadedAt - infWorkers[0].loadSentAt).toFixed(1),
              )
            : null,
        firstTileReqAt: initialProbe.completedTiles.length
          ? Number(
              Math.min(
                ...initialProbe.completedTiles.map((t) => t.reqAt),
              ).toFixed(1),
            )
          : null,
        firstRunSentAt: Number(firstRunSent.toFixed(1)),
        firstRunMs: Number(firstRun.workerRunMs.toFixed(1)),
        lastRunRecvAt: Number(lastRunRecv.toFixed(1)),
        activeInferenceWindowMs: Number(activeInfWallMs.toFixed(1)),
        firstAffinityChunkVisible: tFirstAffinityVisible
          ? Number((tFirstAffinityVisible - tGotoStart).toFixed(1))
          : null,
        allAffinityVisibleComplete: Number(
          (tAllAffinityVisible - tGotoStart).toFixed(1),
        ),
        allQueueSettledComplete: Number((tAllSettled - tGotoStart).toFixed(1)),
        runsAtAllVisible,
        tilesAtAllVisible,
      },
      inferenceStats: {
        inferenceWorkerCount: infWorkers.length,
        metadata: infWorkers[0]?.metadata ?? null,
        workers: infWorkers,
        tilesCompleted: initialProbe.completedTiles.length,
        runsCount: runs.length,
        totalPatchesEvaluated: runs.reduce((s, r) => s + (r.batchSize ?? 1), 0),
        workerRunMsAll: summarizeArray(workerRunMsAll),
        workerRunMsSteadyState: summarizeArray(workerRunMsWarm),
        rpcRoundtripMs: summarizeArray(rpcMsAll),
        interRunIdleGapMs: summarizeArray(interRunGaps),
        perWorkerRuns,
        unionBusyMs: Number(unionBusyMs.toFixed(1)),
        zeroWorkersActiveMs: Number(zeroWorkersActiveMs.toFixed(1)),
        atLeastOneWorkerActivePct:
          activeInfWallMs > 0
            ? Number(((100 * unionBusyMs) / activeInfWallMs).toFixed(1))
            : 0,
        aggregateWorkerRunTimeInActiveWindowPct:
          activeInfWallMs > 0
            ? Number(((100 * sumWorkerRunMs) / activeInfWallMs).toFixed(1))
            : 0,
        aggregateWorkerRunTimeOverFullLoadPct:
          tAllAffinityVisible - tGotoStart > 0
            ? Number(
                (
                  (100 * sumWorkerRunMs) /
                  (tAllAffinityVisible - tGotoStart)
                ).toFixed(1),
              )
            : 0,
      },
      sourceIoStats: {
        gcsInfoRequests: net.gcsInfo.length,
        gcsShardRequests: net.gcsShards.length,
        maxConcurrentGcsShards: net.maxConcurrentGcsShards,
        gcsShardLatencyMs: summarizeArray(
          net.gcsShards.filter((s) => !s.failed).map((s) => s.dur),
        ),
        nativeChunkRpcRequests: initialProbe.nativeRequests,
        nativeChunkRpcCancels: initialProbe.nativeCancels,
        maxNativeChunkRpcInFlight: initialProbe.maxNativeInFlight,
      },
      gpuUtilization: {
        fullPageVisibleLoad: summarizeGpu(
          gpuSampler.samples,
          tGotoStart,
          tAllAffinityVisible,
        ),
        fullPageSettledLoad: summarizeGpu(
          gpuSampler.samples,
          tGotoStart,
          tAllSettled,
        ),
        activeInferencePhase: summarizeGpu(
          gpuSampler.samples,
          infGpuWindowStart,
          infGpuWindowEnd,
        ),
      },
      terminatedWorkerEvents: initialProbe.finalSnap.terminatedWorkerEvents,
      pageErrors,
      consoleErrors,
      consoleWarnings,
    };
  } finally {
    try {
      await gpuSampler.stop();
    } finally {
      await page?.close();
    }
  }
}

async function main() {
  assert.equal(
    process.argv.length,
    2,
    "Configure this benchmark with DIST, LABEL, RUNS and BENCH_OUT environment variables; command-line flags are not supported",
  );
  const runCount = Number(process.env.RUNS ?? 3);
  assert(
    Number.isSafeInteger(runCount) && runCount > 0,
    "RUNS must be a positive integer",
  );
  const scene = JSON.parse(
    await fs.readFile(
      process.env.BENCH_SCENE ??
        new URL("./integration-benchmark-scene.json", import.meta.url),
      "utf8",
    ),
  );
  BENCH_HASH = "#!" + encodeURIComponent(JSON.stringify(scene));
  expectedHashes = JSON.parse(
    await fs.readFile(
      process.env.BENCH_EXPECTED_HASHES ??
        new URL(
          "./integration-benchmark-expected-hashes.json",
          import.meta.url,
        ),
      "utf8",
    ),
  );
  assert(
    Array.isArray(expectedHashes) && expectedHashes.length > 0,
    "Expected hashes fixture is empty",
  );
  assert.equal(
    new Set(expectedHashes.map((hash) => hash.grid)).size,
    expectedHashes.length,
    "Expected hashes fixture contains duplicate grids",
  );
  for (const hash of expectedHashes) {
    assert(
      typeof hash.grid === "string" && /^-?\d+,-?\d+,-?\d+$/.test(hash.grid),
    );
    assert(
      Number.isSafeInteger(hash.bytes) &&
        hash.bytes > 0 &&
        hash.bytes % 4 === 0,
    );
    assert(/^[0-9a-f]{64}$/.test(hash.sha256));
  }
  expectedHashes.sort((a, b) => a.grid.localeCompare(b.grid));
  const outPath =
    process.env.BENCH_OUT ?? "/tmp/ng-integration-bench/results.json";
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const localServer = await startLocalServer(
    path.resolve(process.env.DIST ?? "dist/client"),
  );
  let browser;
  const results = [];
  try {
    for (let i = 0; i < runCount; i++) {
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
        serviceWorkers: "block",
      });
      await context.addInitScript(installObserver);
      results.push(
        await runSingleBenchmark({
          context,
          baseUrl: localServer.baseUrl,
          label: `${process.env.LABEL ?? "local"}-cold-${i + 1}`,
        }),
      );
      await browser.close();
      browser = undefined;
      await fs.writeFile(outPath, JSON.stringify(results, null, 2) + "\n");
    }
    for (const r of results)
      console.log(
        JSON.stringify({
          label: r.label,
          time: r.timingsMs,
          runs: r.inferenceStats.runsCount,
          idle: r.inferenceStats.zeroWorkersActiveMs,
          gpu: r.gpuUtilization,
          hashes: r.outputHashes.length,
        }),
      );
  } finally {
    try {
      await browser?.close();
    } finally {
      localServer.server.closeAllConnections?.();
      await new Promise((resolve, reject) =>
        localServer.server.close((error) =>
          error ? reject(error) : resolve(),
        ),
      );
    }
  }
}

export { installObserver, runSingleBenchmark, startGpuSampler };
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
