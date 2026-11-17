/* global Event, EventTarget, MessageEvent, URL, console, performance, process, structuredClone */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  runSingleBenchmark,
  startGpuSampler,
  installObserver,
} from "./pipeline_benchmark.mjs";

const invalidCli = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL("./pipeline_benchmark.mjs", import.meta.url)),
    "--label",
    "ignored",
  ],
  { encoding: "utf8", timeout: 10000 },
);
assert.ifError(invalidCli.error);
assert.equal(invalidCli.status, 1);
assert.match(invalidCli.stderr, /command-line flags are not supported/);

const source = await fs.readFile(
  new URL("./pipeline_benchmark.mjs", import.meta.url),
  "utf8",
);
const expected = JSON.parse(
  await fs.readFile(
    new URL("./integration-benchmark-expected-hashes.json", import.meta.url),
    "utf8",
  ),
);
const scene = JSON.parse(
  await fs.readFile(
    new URL("./integration-benchmark-scene.json", import.meta.url),
    "utf8",
  ),
);
const sourceUri =
  "gs://princeton-eric-medial-entorhinal-cortex-prod-central1/alignment/img/v2/|neuroglancer-precomputed:";
const modelUri =
  "https://storage.googleapis.com/zetta-research-kisuk/hammerschmith_mouse_mec/DeepEM/experiments/260225-MEC-finetune-v1-mec+cutout1-8nm-updown2x-no-overseg-x0/models/aff3_mye1/model300000.onnx";
const modelSha256 =
  "0493be1d38f98236a4782404e616569b5838020a5a892de429d30a5372285860";
assert.deepEqual(scene.position, [161000.828125, 128652.0234375, 4890.5]);
assert.equal(scene.crossSectionScale, 0.3583323536400848);
assert.equal(
  scene.layers.find((layer) => layer.name === "mec").source,
  sourceUri,
);
const affinitySource = scene.layers.find(
  (layer) => layer.name === "mec_affinity",
).source;
assert.equal(affinitySource.url, "inference://recipe");
const recipe = affinitySource.state;
assert.equal(recipe.version, 2);
assert.equal(recipe.profile, "ncdhw-centered-v2");
assert.equal(recipe.source.source, sourceUri);
assert.equal(recipe.provider, "auto");
assert.equal(recipe.precision, "float16");
assert.equal(recipe.mode, "live");
assert.equal(recipe.compatibilityFixes, false);
assert.equal(recipe.overlap, true);
assert.deepEqual(recipe.spacingZYX, [4.5e-8, 1.6e-8, 1.6e-8]);
assert.deepEqual(recipe.outputSpacingZYX, [4.5e-8, 1.6e-8, 1.6e-8]);
assert.equal(recipe.model.kind, "url");
assert.deepEqual(recipe.model.urls, [modelUri]);
assert.equal(recipe.model.size, 42520250);
assert.equal(recipe.model.sha256, modelSha256);
assert.equal(expected.length, 36);
assert.equal(new Set(expected.map((hash) => hash.grid)).size, 36);
for (const hash of expected) {
  assert.match(hash.grid, /^-?\d+,-?\d+,-?\d+$/);
  assert.equal(hash.bytes, 921600);
  assert.match(hash.sha256, /^[0-9a-f]{64}$/);
}
console.log(
  "PASS: pinned scene position/source/model/precision and 36 complete chunk hash fixtures",
);

const begin = source.indexOf("const sortedIntervals = runs");
const end = source.indexOf("const perWorkerRuns = {};", begin);
assert(begin >= 0 && end > begin);
const union = new Function(
  "runs",
  "activeInfWallMs",
  `const interRunGaps = [];\n${source.slice(begin, end)}\nreturn {unionBusyMs, zeroWorkersActiveMs, interRunGaps};`,
);
for (const [intervals, wall, busy, idle, gaps] of [
  [[], 0, 0, 0, []],
  [
    [
      [0, 3],
      [5, 9],
    ],
    9,
    7,
    2,
    [2],
  ],
  [
    [
      [2, 4],
      [0, 10],
      [12, 15],
    ],
    15,
    13,
    2,
    [2],
  ],
  [
    [
      [0, 4],
      [3, 8],
      [8, 10],
    ],
    10,
    10,
    0,
    [],
  ],
  [
    [
      [10, 14],
      [0, 3],
      [20, 21],
    ],
    21,
    8,
    13,
    [7, 6],
  ],
])
  assert.deepEqual(
    union(
      intervals.map(([sentAt, recvAt]) => ({ sentAt, recvAt })),
      wall,
    ),
    { unionBusyMs: busy, zeroWorkersActiveMs: idle, interRunGaps: gaps },
  );
console.log(
  "PASS: 5 exact union-code cases, including completion-order overlap and nonnegative global gaps",
);

const timeoutBegin = source.indexOf(
  "    if (tAllAffinityVisible === null)\n      throw new Error",
);
const timeoutEnd = source.indexOf("    const initialProbe =", timeoutBegin);
assert(timeoutBegin >= 0 && timeoutEnd > timeoutBegin);
const checkSettled = new Function(
  "tAllAffinityVisible",
  "tAllSettled",
  "settledConfirmed",
  "label",
  source.slice(timeoutBegin, timeoutEnd),
);
assert.throws(() => checkSettled(10, null, false, "test"), /queue to settle/);
assert.throws(() => checkSettled(10, 20, false, "test"), /queue to settle/);
assert.throws(() => checkSettled(null, null, false, "test"), /visible chunks/);
checkSettled(10, 20, true, "test");
console.log(
  "PASS: deadline guard rejects unconfirmed/unsettled and incomplete coverage; no synthetic success time",
);

const assertBegin = source.indexOf("    assert(\n      initialProbe.isolated");
const assertEnd = source.indexOf(
  "    // Compute initial-load metrics",
  assertBegin,
);
assert(assertBegin >= 0 && assertEnd > assertBegin);
const validate = new Function(
  "initialProbe",
  "expectedHashes",
  "assert",
  "gpuSampler",
  source.slice(assertBegin, assertEnd),
);
const metadata = {
  actualProvider: "webgpu",
  actualPrecision: "float16",
  webgpuSubgroupMatrix: true,
};
const valid = () => ({
  isolated: true,
  finalSnap: {
    affinity: { needed: 36, available: 36 },
    pendingRuns: 0,
    tilesInFlight: 0,
    errors: [],
  },
  completedTiles: [{ ok: true }],
  outputHashes: structuredClone(expected),
  outputShapes: expected.map(({ grid }) => ({
    grid,
    shapeCZYX: [4, 16, 60, 60],
  })),
  workers: [
    { index: 1, submittedRuns: 1, canceledRuns: 0, pendingRuns: 0, metadata },
  ],
  runs: [
    { id: 2, worker: 1, metadata, sentAt: 1, recvAt: 2, workerRunMs: 0.5 },
  ],
});
validate(valid(), expected, assert, { samples: [{}] });
for (const mutate of [
  (p) => {
    p.outputHashes.pop();
  },
  (p) => {
    p.outputHashes[0].bytes -= 4;
  },
  (p) => {
    p.outputHashes[0].sha256 = "0".repeat(64);
  },
  (p) => {
    p.workers[0].metadata = { ...metadata, actualProvider: "wasm" };
  },
  (p) => {
    p.runs[0].metadata = { ...metadata, actualPrecision: "float32" };
  },
  (p) => {
    p.workers[0].submittedRuns = 2;
  },
  (p) => {
    p.finalSnap.pendingRuns = 1;
  },
]) {
  const p = valid();
  mutate(p);
  assert.throws(() => validate(p, expected, assert, { samples: [{}] }));
}
console.log(
  "PASS: actual assertion block accepts valid output and rejects missing/wrong-byte/wrong-hash/CPU/FP32/lost/pending results",
);

// Exercise the real observer with lightweight worker events, not Chrome or GPU.
class FakeWorker extends EventTarget {
  postMessage() {}
  terminate() {}
}
const window = { Worker: FakeWorker };
vm.runInNewContext(`(${installObserver.toString()})()`, {
  window,
  performance,
  Float32Array,
  Map,
  Set,
  Object,
  Array,
  String,
  Math,
  Uint8Array,
  crypto: webcrypto,
});
const worker = new window.Worker("fake-worker");
worker.postMessage({ kind: "load", id: 1, model: new ArrayBuffer(1) });
worker.dispatchEvent(
  new MessageEvent("message", { data: { kind: "loaded", metadata } }),
);
worker.postMessage({ kind: "run", id: 2 });
worker.dispatchEvent(
  new MessageEvent("message", {
    data: {
      kind: "output",
      id: 2,
      runMs: 1,
      metadata: { ...metadata, actualProvider: "wasm" },
    },
  }),
);
assert.equal(window.__benchProbe.runs[0].metadata.actualProvider, "wasm");
assert.equal(window.__benchProbe.workers[0].metadata.actualProvider, "wasm");
assert.match(window.__benchProbe.errors[0], /expected WebGPU/);
console.log(
  "PASS: observer records output-time fallback and flags it immediately",
);

const canceled = new window.Worker("cancel-worker");
canceled.postMessage({ kind: "load", id: 11, model: new ArrayBuffer(1) });
canceled.postMessage({ kind: "run", id: 12 });
canceled.postMessage({ functionName: "ChunkManager.requestChunk", id: -11 });
canceled.dispatchEvent(
  new MessageEvent("message", {
    data: { functionName: "inference/tile", id: -12, gridZYX: [0, 0, 0] },
  }),
);
assert.equal(window.__benchSnapshot().pendingRuns, 1);
assert.equal(window.__benchSnapshot().nativeInFlight, 1);
assert.equal(window.__benchSnapshot().tilesInFlight, 1);
canceled.terminate();
canceled.terminate();
assert.equal(window.__benchSnapshot().pendingRuns, 0);
assert.equal(window.__benchSnapshot().nativeInFlight, 0);
assert.equal(window.__benchSnapshot().tilesInFlight, 0);
assert.equal(window.__benchProbe.workers[1].canceledRuns, 1);
console.log(
  "PASS: terminate clears only owned pending run/native/tile maps and is idempotent",
);

const lateMessage =
  "Uncaught NetworkError: Failed to execute 'importScripts' ...342... failed to load.";
const workerError = () => {
  const event = new Event("error", { cancelable: true });
  Object.defineProperty(event, "message", { value: lateMessage });
  return event;
};
const active = new window.Worker("active-error-worker");
active.postMessage({ kind: "load", id: 21, model: new ArrayBuffer(1) });
const errorsBeforeActive = window.__benchProbe.errors.length;
const activeError = workerError();
active.dispatchEvent(activeError);
active.dispatchEvent(new Event("messageerror"));
assert.equal(window.__benchProbe.errors.length, errorsBeforeActive + 2);
assert.match(window.__benchProbe.errors[errorsBeforeActive], /importScripts/);
assert.equal(activeError.defaultPrevented, false);

const late = new window.Worker("terminated-loading-worker");
const lateIndex = window.__benchProbe.workers.length - 1;
late.postMessage({ kind: "load", id: 31, model: new ArrayBuffer(1) });
late.terminate();
const errorsBeforeLate = window.__benchProbe.errors.length;
const runsBeforeLate = window.__benchProbe.runs.length;
const quietSince = window.__benchProbe.lastActivity;
const lateError = workerError();
late.dispatchEvent(lateError);
late.dispatchEvent(new Event("messageerror"));
late.dispatchEvent(
  new MessageEvent("message", {
    data: {
      kind: "output",
      id: 32,
      runMs: 1,
      metadata: { ...metadata, actualProvider: "wasm" },
    },
  }),
);
late.dispatchEvent(
  new MessageEvent("message", {
    data: {
      kind: "loaded",
      metadata: { ...metadata, actualPrecision: "float32" },
    },
  }),
);
late.dispatchEvent(
  new MessageEvent("message", {
    data: {
      kind: "error",
      id: 31,
      message: "late protocol error",
    },
  }),
);
late.dispatchEvent(
  new MessageEvent("message", {
    data: {
      functionName: "inference/tile",
      id: -31,
      gridZYX: [0, 0, 0],
    },
  }),
);
assert.equal(window.__benchProbe.errors.length, errorsBeforeLate);
assert.equal(window.__benchProbe.runs.length, runsBeforeLate);
assert.equal(window.__benchProbe.workers[lateIndex].metadata, null);
assert.equal(window.__benchProbe.workers[lateIndex].loadedAt, null);
assert.equal(window.__benchProbe.lastActivity, quietSince);
assert.equal(window.__benchSnapshot().pendingRuns, 0);
assert.equal(window.__benchSnapshot().tilesInFlight, 0);
assert.equal(lateError.defaultPrevented, true);
const journal = window.__benchSnapshot().terminatedWorkerEvents;
assert.deepEqual(
  Array.from(journal, (event) => event.type),
  ["error", "messageerror", "message", "message", "message", "message"],
);
assert.equal(journal[0].message, lateMessage);
assert.equal(journal[2].kind, "output");
assert.equal(journal[2].id, 32);
assert.equal(journal[4].message, "late protocol error");
assert(
  journal.every(
    (event) => event.worker === lateIndex && event.at >= event.terminatedAt,
  ),
);
console.log(
  "PASS: active worker errors remain fatal; explicitly terminated late errors/messages are ignored, journaled, and cannot revive work",
);

const tiles = new window.Worker("tile-worker");
tiles.dispatchEvent(
  new MessageEvent("message", {
    data: { functionName: "inference/tile", id: -20, gridZYX: [0, 0, 0] },
  }),
);
tiles.postMessage({
  functionName: "rpc.promise.response",
  id: -20,
  value: new Float32Array(4 * 16 * 60 * 60),
});
const collected = await window.__benchCollectOutputs();
assert.deepEqual(
  Array.from(collected.outputShapes[0].shapeCZYX),
  [4, 16, 60, 60],
);
assert.equal(collected.outputHashes[0].bytes, 921600);
new Float32Array(window.__benchProbe.outputBytes.get("0,0,0"))[230399] = NaN;
await assert.rejects(window.__benchCollectOutputs(), /element=230399/);
console.log(
  "PASS: output collector records complete CZYX shape/bytes/hash and rejects nonfinite final element",
);

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "ng-bench-clean-test-"));
const originalPath = process.env.PATH;
const pidFile = path.join(temp, "pid");
process.env.BENCH_FAKE_PID = pidFile;
const executable = path.join(temp, "nvidia-smi");
const writeSampler = async (body) => {
  await fs.writeFile(executable, `#!${process.execPath}\n${body}\n`, {
    mode: 0o755,
  });
};
const aliveSampler = `require('node:fs').writeFileSync(process.env.BENCH_FAKE_PID, String(process.pid)); process.stdout.write('12,3,123\\n'); setInterval(() => process.stdout.write('12,3,123\\n'), 20); process.on('SIGTERM', () => process.exit(0));`;
try {
  process.env.PATH = temp;
  await writeSampler(aliveSampler);
  const sampler = startGpuSampler();
  await delay(150);
  sampler.assertHealthy();
  assert(sampler.samples.length > 0);
  const pid = Number(await fs.readFile(pidFile, "utf8"));
  await sampler.stop();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });

  const testFailure = async (kind, expectedError) => {
    let closed = false;
    const page = {
      on() {},
      async goto() {
        await delay(100);
        if (kind === "goto") throw new Error("synthetic goto failure");
      },
      async evaluate(fn) {
        if (kind === "evaluate") throw new Error("synthetic evaluate failure");
        if (kind === "worker") return { errors: ["synthetic worker failure"] };
        if (fn.toString().includes("const p = window.__benchProbe")) {
          const values = new Float32Array(8);
          values[7] = Infinity;
          return vm.runInNewContext(`(${fn.toString()})()`, {
            window: {
              __benchCollectOutputs: async () => {
                window.__benchProbe.outputBytes.set("0,0,0", values.buffer);
                return window.__benchCollectOutputs();
              },
            },
            navigator: { gpu: { requestAdapter: async () => null } },
            performance,
            Float32Array,
            Uint8Array,
            crypto: webcrypto,
            Number,
            Error,
          });
        }
        return {
          errors: [],
          mec: { needed: 1, available: 1 },
          affinity: { needed: 1, available: 1 },
          tilesInFlight: 0,
          pendingRuns: 0,
          quietMs: 500,
          tilesCompleted: 1,
          runsCompleted: 1,
        };
      },
      async close() {
        closed = true;
      },
    };
    await assert.rejects(
      runSingleBenchmark({
        context: { newPage: async () => page },
        baseUrl: "http://example.invalid/",
        label: "no-gpu-test",
      }),
      expectedError,
    );
    assert(closed, `${kind}: page was not closed`);
    const child = Number(await fs.readFile(pidFile, "utf8"));
    assert.throws(() => process.kill(child, 0), { code: "ESRCH" });
  };
  await testFailure("goto", /synthetic goto failure/);
  await testFailure("evaluate", /synthetic evaluate failure/);
  await testFailure("worker", /synthetic worker failure/);
  await testFailure(
    "nonfinite",
    /Non-finite inference output: grid=0,0,0, element=7/,
  );
  console.log(
    "PASS: actual goto/evaluate/worker/nonfinite failure paths close page and reap fake sampler; no GPU/browser launched",
  );

  await writeSampler(
    "process.stderr.write('synthetic sampler exit'); process.exit(7);",
  );
  const bad = startGpuSampler();
  await delay(100);
  assert.throws(() => bad.assertHealthy(), /code=7/);
  await bad.stop();
  process.env.PATH = path.join(temp, "missing");
  const missing = startGpuSampler();
  await delay(100);
  assert.throws(() => missing.assertHealthy(), /ENOENT/);
  await missing.stop();
  console.log(
    "PASS: sampler unexpected exit and ENOENT fail visibly without unhandled events",
  );
} finally {
  process.env.PATH = originalPath;
  delete process.env.BENCH_FAKE_PID;
  await fs.rm(temp, { recursive: true, force: true });
}
