/* global URL, process, structuredClone */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const reducerPath = fileURLToPath(
  new URL("./pipeline_summarize.mjs", import.meta.url),
);
const expectedHashes = [0, 1].map((index) => {
  const data = new Float32Array([index, index + 1, index + 2, index + 3]);
  return {
    grid: `0,0,${index}`,
    bytes: data.byteLength,
    sha256: createHash("sha256")
      .update(new Uint8Array(data.buffer))
      .digest("hex"),
  };
});
function syntheticRuns() {
  return [3000, 2000, 4000].map((viewport, index) => ({
    label: `synthetic-${index + 1}`,
    outputHashes: structuredClone(expectedHashes),
    isolated: true,
    hasShaderF16: true,
    hasSubgroupMatrix: true,
    visibleChunksNeeded: 2,
    timingsMs: {
      allAffinityVisibleComplete: viewport,
      firstAffinityChunkVisible: 500 + 100 * index,
      activeInferenceWindowMs: viewport - 600,
      workerLoadDur: 30 + index,
    },
    inferenceStats: {
      metadata: {
        initMs: 25 + index,
        actualProvider: "webgpu",
        actualPrecision: "float16",
        webgpuSubgroupMatrix: true,
        threads: 8,
      },
      workerRunMsAll: { p50: 40 + index, sum: 1000 + 10 * index },
      zeroWorkersActiveMs: viewport - 1600,
      tilesCompleted: 2,
      runsCount: 25,
      totalPatchesEvaluated: 25,
      inferenceWorkerCount: 1,
    },
    sourceIoStats: { nativeChunkRpcRequests: 4, maxNativeChunkRpcInFlight: 1 },
    gpuUtilization: {
      fullPageVisibleLoad: {
        count: 100 + index,
        mean: [30, 10, 20][index],
        p50: 15 + 10 * index,
        peakMemoryMiB: 1000 + 100 * index,
      },
      activeInferencePhase: {
        count: 80 + index,
        mean: [40, 20, 30][index],
        p50: 35 + index,
        peakMemoryMiB: 900 + 100 * index,
      },
    },
    pageErrors: [],
  }));
}
async function reduce(
  stages,
  { defaultFixture = false, expectedRuns, builds = {} } = {},
) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "pipeline-summary-test-"),
  );
  try {
    const inputDir = path.join(dir, "results");
    await fs.mkdir(inputDir);
    for (const [name, runs] of Object.entries(stages)) {
      await fs.writeFile(
        path.join(inputDir, `${name}.json`),
        JSON.stringify(runs),
      );
    }
    for (const [name, build] of Object.entries(builds)) {
      await fs.writeFile(
        path.join(inputDir, `${name}-version.json`),
        JSON.stringify(build),
      );
    }
    let script = reducerPath;
    let fixture = path.join(dir, "synthetic-hashes.json");
    if (defaultFixture) {
      const scriptDir = path.join(dir, "scripts");
      await fs.mkdir(scriptDir);
      script = path.join(scriptDir, "pipeline_summarize.mjs");
      await fs.copyFile(reducerPath, script);
      fixture = path.join(
        scriptDir,
        "integration-benchmark-expected-hashes.json",
      );
    }
    await fs.writeFile(fixture, JSON.stringify(expectedHashes));
    const out = path.join(inputDir, "summary.json");
    const args = defaultFixture
      ? [script, inputDir]
      : [script, inputDir, out, fixture];
    if (expectedRuns !== undefined) args.push(String(expectedRuns));
    const result = spawnSync(process.execPath, args, {
      cwd: dir,
      encoding: "utf8",
      timeout: 10000,
    });
    assert.ifError(result.error);
    let summary = null;
    try {
      summary = JSON.parse(await fs.readFile(out, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return { ...result, summary };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("retains individual metrics, computes medians/deltas, and losslessly deduplicates hashes", async () => {
  const baseline = syntheticRuns();
  const step = syntheticRuns();
  for (const run of step) run.timingsMs.allAffinityVisibleComplete *= 0.8;
  // Insert the stage files out of order to exercise numeric stage sorting.
  const { status, summary: s } = await reduce({
    step10: step,
    baseline,
    step3: step,
    step2: step,
  });
  assert.equal(status, 0);
  assert.equal(s.schemaVersion, 1);
  assert.equal(s.allValid, true);
  assert.deepEqual(Object.keys(s.stages), [
    "baseline",
    "step2",
    "step3",
    "step10",
  ]);
  assert.deepEqual(s.stages.baseline.medians, {
    viewportMs: 3000,
    firstVisibleMs: 600,
    activeWindowMs: 2400,
    rpcIdleMs: 1400,
    sessionInitMs: 26,
    workerLoadMs: 31,
    workerRunP50Ms: 41,
    workerRunTotalMs: 1010,
    fullGpuMeanPct: 20,
    fullGpuP50Pct: 25,
    activeGpuMeanPct: 30,
    activeGpuP50Pct: 36,
    fullPeakMemoryMiB: 1100,
    activePeakMemoryMiB: 1000,
  });
  assert.deepEqual(
    s.stages.baseline.runs.map((r) => r.metrics.viewportMs),
    [3000, 2000, 4000],
  );
  assert.deepEqual(s.stages.step3.relativeToBaseline.viewportMs, {
    delta: -600,
    percentChange: -20,
  });
  assert.equal(Object.keys(s.outputHashSets).length, 1);
  for (const stage of Object.values(s.stages)) {
    assert.equal(
      stage.sourceSha256,
      createHash("sha256")
        .update(
          JSON.stringify(stage.source === "baseline.json" ? baseline : step),
        )
        .digest("hex"),
    );
    for (const run of stage.runs) {
      assert.deepEqual(run.hashComparison, {
        matches: true,
        missing: [],
        extra: [],
        mismatches: [],
      });
      assert.deepEqual(s.outputHashSets[run.outputHashSet], expectedHashes);
    }
  }
});

test("default fixture is relative to the reducer, not the working directory", async () => {
  const { status, summary } = await reduce(
    { baseline: syntheticRuns() },
    { defaultFixture: true },
  );
  assert.equal(status, 0);
  assert.equal(summary.allValid, true);
  assert.equal(
    summary.fixture.source,
    "integration-benchmark-expected-hashes.json",
  );
  assert.deepEqual(
    summary.outputHashSets[summary.fixture.outputHashSet],
    expectedHashes,
  );
});

test("missing metric remains null, makes its median null, and fails visibly", async () => {
  const runs = syntheticRuns();
  delete runs[1].gpuUtilization.activeInferencePhase.mean;
  const { status, summary: s, stderr } = await reduce({ baseline: runs });
  assert.equal(status, 1);
  assert.equal(s.allValid, false);
  assert.equal(s.stages.baseline.runs[1].metrics.activeGpuMeanPct, null);
  assert.equal(s.stages.baseline.medians.activeGpuMeanPct, null);
  assert.match(stderr, /missing\/invalid metric activeGpuMeanPct/);
});

test("different SHA or byte count preserves expected and actual hash sets", async () => {
  const runs = syntheticRuns();
  runs[1].outputHashes[0].sha256 = "f".repeat(64);
  runs[2].outputHashes[0].bytes *= 2;
  const { status, summary: s } = await reduce({ baseline: runs });
  assert.equal(status, 1);
  assert.equal(Object.keys(s.outputHashSets).length, 3);
  for (const index of [1, 2]) {
    const run = s.stages.baseline.runs[index];
    assert.equal(run.hashComparison.matches, false);
    assert.deepEqual(run.hashComparison.mismatches, [
      {
        grid: expectedHashes[0].grid,
        expected: expectedHashes[0],
        actual: runs[index].outputHashes[0],
      },
    ]);
    assert.deepEqual(
      s.outputHashSets[run.outputHashSet],
      runs[index].outputHashes,
    );
  }
});

test("missing and extra grid keys fail even when chunk counts agree", async () => {
  const runs = syntheticRuns();
  runs[1].outputHashes[0].grid = "2,0,0";
  const { status, summary: s } = await reduce({ baseline: runs });
  assert.equal(status, 1);
  assert.deepEqual(s.stages.baseline.runs[1].hashComparison, {
    matches: false,
    missing: ["0,0,0"],
    extra: ["2,0,0"],
    mismatches: [],
  });
});

test("incomplete stage is retained and rejected; measured zero GPU is not missing", async () => {
  const runs = syntheticRuns().slice(0, 2);
  for (const run of runs) run.gpuUtilization.activeInferencePhase.mean = 0;
  const { status, summary: s, stderr } = await reduce({ baseline: runs });
  assert.equal(status, 1);
  assert.equal(s.stages.baseline.runCount, 2);
  assert.equal(s.stages.baseline.medians.viewportMs, 2500);
  assert.equal(s.stages.baseline.medians.activeGpuMeanPct, 0);
  assert.match(stderr, /expected 3 runs, got 2/);
  const custom = await reduce(
    { baseline: runs, step3: runs },
    { expectedRuns: 2 },
  );
  assert.equal(custom.status, 0);
  assert.deepEqual(
    custom.summary.stages.step3.relativeToBaseline.activeGpuMeanPct,
    {
      delta: 0,
      percentChange: null,
    },
  );
});

test("legacy metadata is accepted only when no rewrite was requested or applied", async () => {
  const runs = syntheticRuns();
  runs[0].inferenceStats.metadata.compatibilityFixes = false;
  const good = await reduce({ baseline: runs });
  assert.equal(good.status, 0);
  assert.equal(good.summary.allValid, true);

  runs[1].inferenceStats.metadata.compatibilityFixes = true;
  runs[2].inferenceStats.metadata.preparation = "model6280000-jsep";
  const bad = await reduce({ baseline: runs });
  assert.equal(bad.status, 1);
  assert.deepEqual(
    bad.summary.stages.baseline.runs.map((r) => r.valid),
    [true, false, false],
  );
  assert.match(bad.stderr, /without legacy graph rewrites/);
});

test("runtime fallback, browser errors, and empty GPU samples invalidate runs", async () => {
  const runs = syntheticRuns();
  runs[0].inferenceStats.metadata.actualProvider = "wasm";
  runs[1].pageErrors = ["synthetic page error"];
  runs[2].gpuUtilization.fullPageVisibleLoad.count = 0;
  const { status, summary: s, stderr } = await reduce({ baseline: runs });
  assert.equal(status, 1);
  assert.ok(s.stages.baseline.runs.every((run) => !run.valid));
  assert.match(stderr, /runtime does not match/);
  assert.match(stderr, /pageErrors missing or nonempty/);
  assert.match(stderr, /no full-window physical GPU samples/);
});

test("invalid run-count argument and missing baseline fail before producing a summary", async () => {
  const invalid = await reduce(
    { baseline: syntheticRuns() },
    { expectedRuns: 0 },
  );
  assert.equal(invalid.status, 1);
  assert.equal(invalid.summary, null);
  assert.match(invalid.stderr, /runs-per-stage must be a positive integer/);
  const missing = await reduce({ step3: syntheticRuns() });
  assert.equal(missing.status, 1);
  assert.equal(missing.summary, null);
  assert.match(missing.stderr, /baseline.json is required/);
});

test("retains optional build provenance and rejects a silently reduced worker pool", async () => {
  const stamp = {
    commit: "synthetic-source",
    trackedDiffSha256: "synthetic-diff",
    benchmark: { maxWebGpuWorkers: 1, patchCacheMiB: 384 },
  };
  const good = await reduce(
    { baseline: syntheticRuns(), step8: syntheticRuns() },
    { builds: { step8: stamp } },
  );
  assert.equal(good.status, 0);
  assert.equal(good.summary.stages.baseline.sourceBuild, null);
  const build = good.summary.stages.step8.sourceBuild;
  assert.equal(build.source, "step8-version.json");
  assert.deepEqual(build.info, stamp);
  assert.equal(
    build.sourceSha256,
    createHash("sha256").update(JSON.stringify(stamp)).digest("hex"),
  );
  const bad = await reduce(
    { baseline: syntheticRuns(), step8: syntheticRuns() },
    {
      builds: {
        step8: {
          ...stamp,
          benchmark: { ...stamp.benchmark, maxWebGpuWorkers: 2 },
        },
      },
    },
  );
  assert.equal(bad.status, 1);
  assert.equal(bad.summary.stages.step8.valid, false);
  assert.match(
    bad.stderr,
    /observed inference worker count differs from build configuration/,
  );
});
