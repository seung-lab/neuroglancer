#!/usr/bin/env node
/* global URL, console, process */
// node pipeline_summarize.mjs [results-dir] [output.json] [expected-hashes.json] [runs-per-stage]
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const inputDir = path.resolve(process.argv[2] ?? "/tmp/ng-integration-bench");
const outputPath = path.resolve(
  process.argv[3] ?? path.join(inputDir, "summary.json"),
);
const fixturePath = process.argv[4]
  ? path.resolve(process.argv[4])
  : fileURLToPath(
      new URL("./integration-benchmark-expected-hashes.json", import.meta.url),
    );
const expectedRuns = Number(process.argv[5] ?? 3);
if (!Number.isSafeInteger(expectedRuns) || expectedRuns < 1)
  throw new Error("runs-per-stage must be a positive integer");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const round = (value) => Number(value.toFixed(3));
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const median = (values) => {
  if (!values.length || !values.every(finite)) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return round(
    sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
  );
};
function canonicalHashes(rows) {
  if (!Array.isArray(rows) || !rows.length)
    throw new Error("outputHashes must be a nonempty array");
  const seen = new Set();
  return rows
    .map(({ grid, bytes, sha256: digest }) => {
      if (
        typeof grid !== "string" ||
        !/^-?\d+,-?\d+,-?\d+$/.test(grid) ||
        seen.has(grid) ||
        !Number.isSafeInteger(bytes) ||
        bytes <= 0 ||
        !/^[a-f0-9]{64}$/.test(digest)
      ) {
        throw new Error(
          `invalid or duplicate output hash: ${JSON.stringify({ grid, bytes, sha256: digest })}`,
        );
      }
      seen.add(grid);
      return { grid, bytes, sha256: digest };
    })
    .sort((a, b) => a.grid.localeCompare(b.grid));
}
const fixtureBytes = await fs.readFile(fixturePath);
const expectedHashes = canonicalHashes(JSON.parse(fixtureBytes));
const hashSets = {};
function retainHashes(hashes) {
  const id = sha256(JSON.stringify(hashes));
  hashSets[id] = hashes;
  return id;
}
const expectedHashSet = retainHashes(expectedHashes);
const expectedByGrid = new Map(expectedHashes.map((item) => [item.grid, item]));
function compareHashes(hashes) {
  const actual = new Map(hashes.map((item) => [item.grid, item]));
  const missing = expectedHashes
    .filter((item) => !actual.has(item.grid))
    .map((item) => item.grid);
  const extra = hashes
    .filter((item) => !expectedByGrid.has(item.grid))
    .map((item) => item.grid);
  const mismatches = hashes
    .filter((item) => {
      const expected = expectedByGrid.get(item.grid);
      return (
        expected &&
        (expected.bytes !== item.bytes || expected.sha256 !== item.sha256)
      );
    })
    .map((item) => ({
      grid: item.grid,
      expected: expectedByGrid.get(item.grid),
      actual: item,
    }));
  return {
    matches: !missing.length && !extra.length && !mismatches.length,
    missing,
    extra,
    mismatches,
  };
}
const definitions = {
  viewportMs:
    "timingsMs.allAffinityVisibleComplete; navigation to all visible affinity chunks",
  firstVisibleMs:
    "timingsMs.firstAffinityChunkVisible; navigation to first visible affinity chunk",
  activeWindowMs:
    "timingsMs.activeInferenceWindowMs; first run RPC send through last reply",
  rpcIdleMs:
    "inferenceStats.zeroWorkersActiveMs; active window minus union of pending run RPC intervals; NOT physical GPU idle",
  sessionInitMs:
    "inferenceStats.metadata.initMs; reported worker model/session initialization duration",
  workerLoadMs:
    "timingsMs.workerLoadDur; load request through loaded reply, including worker startup overhead",
  workerRunP50Ms:
    "inferenceStats.workerRunMsAll.p50; per-run median of all patch runMs (includes first run)",
  workerRunTotalMs:
    "inferenceStats.workerRunMsAll.sum; summed reported runMs, NOT hardware kernel timing",
  fullGpuMeanPct:
    "gpuUtilization.fullPageVisibleLoad.mean; nvidia-smi physical GPU sample mean over navigation-to-visible window",
  fullGpuP50Pct:
    "gpuUtilization.fullPageVisibleLoad.p50; physical GPU sample median over navigation-to-visible window",
  activeGpuMeanPct:
    "gpuUtilization.activeInferencePhase.mean; physical GPU sample mean over active RPC window",
  activeGpuP50Pct:
    "gpuUtilization.activeInferencePhase.p50; physical GPU sample median over active RPC window",
  fullPeakMemoryMiB:
    "gpuUtilization.fullPageVisibleLoad.peakMemoryMiB; whole-device peak sampled memory, not browser-only allocation",
  activePeakMemoryMiB:
    "gpuUtilization.activeInferencePhase.peakMemoryMiB; whole-device peak sampled memory during active RPC window",
};
const stages = {};
const files = (await fs.readdir(inputDir))
  .filter((name) => /^(baseline|step\d+)\.json$/.test(name))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
if (!files.includes("baseline.json"))
  throw new Error("baseline.json is required for comparisons");
for (const filename of files) {
  const sourceBytes = await fs.readFile(path.join(inputDir, filename));
  const sourceRuns = JSON.parse(sourceBytes);
  const buildFilename = filename.replace(/\.json$/, "-version.json");
  let sourceBuild = null;
  try {
    const buildBytes = await fs.readFile(path.join(inputDir, buildFilename));
    sourceBuild = {
      source: buildFilename,
      sourceSha256: sha256(buildBytes),
      info: JSON.parse(buildBytes),
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!Array.isArray(sourceRuns))
    throw new Error(`${filename}: expected an array of runs`);
  const stageIssues = [];
  if (sourceRuns.length !== expectedRuns)
    stageIssues.push(`expected ${expectedRuns} runs, got ${sourceRuns.length}`);
  const seenLabels = new Set();
  const runs = sourceRuns.map((run, index) => {
    const issues = [];
    const label = run.label ?? `${filename}:run-${index + 1}`;
    if (typeof run.label !== "string" || seenLabels.has(label))
      issues.push("missing or duplicate run label");
    seenLabels.add(label);
    const t = run.timingsMs ?? {};
    const inf = run.inferenceStats ?? {};
    const meta = inf.metadata ?? {};
    const full = run.gpuUtilization?.fullPageVisibleLoad ?? {};
    const active = run.gpuUtilization?.activeInferencePhase ?? {};
    const measurements = {
      viewportMs: t.allAffinityVisibleComplete,
      firstVisibleMs: t.firstAffinityChunkVisible,
      activeWindowMs: t.activeInferenceWindowMs,
      rpcIdleMs: inf.zeroWorkersActiveMs,
      sessionInitMs: meta.initMs,
      workerLoadMs: t.workerLoadDur,
      workerRunP50Ms: inf.workerRunMsAll?.p50,
      workerRunTotalMs: inf.workerRunMsAll?.sum,
      fullGpuMeanPct: full.mean,
      fullGpuP50Pct: full.p50,
      activeGpuMeanPct: active.mean,
      activeGpuP50Pct: active.p50,
      fullPeakMemoryMiB: full.peakMemoryMiB,
      activePeakMemoryMiB: active.peakMemoryMiB,
    };
    const metrics = Object.fromEntries(
      Object.entries(measurements).map(([key, value]) => {
        if (!finite(value) || value < 0) {
          issues.push(`missing/invalid metric ${key}`);
          return [key, null];
        }
        return [key, round(value)];
      }),
    );
    if (full.count < 1 || !Number.isInteger(full.count))
      issues.push("no full-window physical GPU samples");
    if (active.count < 1 || !Number.isInteger(active.count))
      issues.push("no active-window physical GPU samples");
    if (
      run.isolated !== true ||
      run.hasShaderF16 !== true ||
      run.hasSubgroupMatrix !== true ||
      meta.actualProvider !== "webgpu" ||
      meta.actualPrecision !== "float16" ||
      meta.webgpuSubgroupMatrix !== true ||
      meta.threads !== 8 ||
      (meta.compatibilityFixes !== undefined &&
        meta.compatibilityFixes !== false) ||
      meta.preparation !== undefined
    ) {
      issues.push(
        "runtime does not match isolated WebGPU FP16/subgroup/8-thread benchmark without legacy graph rewrites",
      );
    }
    const configuredWorkers = sourceBuild?.info?.benchmark?.maxWebGpuWorkers;
    if (
      configuredWorkers !== undefined &&
      inf.inferenceWorkerCount !== configuredWorkers
    )
      issues.push(
        "observed inference worker count differs from build configuration",
      );
    if (!Array.isArray(run.pageErrors) || run.pageErrors.length)
      issues.push("pageErrors missing or nonempty");
    let outputHashSet = null;
    let hashComparison = null;
    try {
      const hashes = canonicalHashes(run.outputHashes);
      outputHashSet = retainHashes(hashes);
      hashComparison = compareHashes(hashes);
      if (!hashComparison.matches)
        issues.push("output hashes differ from fixture");
      if (run.visibleChunksNeeded !== hashes.length)
        issues.push("hash count differs from visible chunks needed");
    } catch (error) {
      issues.push(error.message);
    }
    return {
      label,
      metrics,
      counts: {
        visibleChunksNeeded: run.visibleChunksNeeded ?? null,
        completedTiles: inf.tilesCompleted ?? null,
        runCalls: inf.runsCount ?? null,
        patchesEvaluated: inf.totalPatchesEvaluated ?? null,
        inferenceWorkers: inf.inferenceWorkerCount ?? null,
        nativeChunkRequests: run.sourceIoStats?.nativeChunkRpcRequests ?? null,
        maxNativeChunkRpcInFlight:
          run.sourceIoStats?.maxNativeChunkRpcInFlight ?? null,
        fullGpuSamples: full.count ?? null,
        activeGpuSamples: active.count ?? null,
      },
      runtime: {
        isolated: run.isolated ?? null,
        provider: meta.actualProvider ?? null,
        precision: meta.actualPrecision ?? null,
        subgroupMatrix: meta.webgpuSubgroupMatrix ?? null,
        threads: meta.threads ?? null,
        compatibilityFixes: meta.compatibilityFixes ?? null,
      },
      outputHashSet,
      hashComparison,
      pageErrors: run.pageErrors ?? null,
      valid: issues.length === 0,
      issues,
    };
  });
  stages[path.basename(filename, ".json")] = {
    source: filename,
    sourceSha256: sha256(sourceBytes),
    sourceBuild,
    expectedRuns,
    runCount: runs.length,
    valid: !stageIssues.length && runs.every((run) => run.valid),
    issues: stageIssues,
    medians: Object.fromEntries(
      Object.keys(definitions).map((key) => [
        key,
        median(runs.map((run) => run.metrics[key])),
      ]),
    ),
    runs,
  };
}
for (const [name, stage] of Object.entries(stages)) {
  if (name === "baseline") continue;
  stage.relativeToBaseline = Object.fromEntries(
    Object.keys(definitions).map((key) => {
      const baseline = stages.baseline.medians[key];
      const current = stage.medians[key];
      return [
        key,
        {
          delta:
            finite(current) && finite(baseline)
              ? round(current - baseline)
              : null,
          percentChange:
            finite(current) && finite(baseline) && baseline !== 0
              ? round((100 * (current - baseline)) / baseline)
              : null,
        },
      ];
    }),
  );
}
const summary = {
  schemaVersion: 1,
  allValid: Object.values(stages).every((stage) => stage.valid),
  fixture: {
    source: path.basename(fixturePath),
    sourceSha256: sha256(fixtureBytes),
    outputHashSet: expectedHashSet,
    chunks: expectedHashes.length,
  },
  definitions,
  notes: [
    "Medians aggregate per-run measurements; GPU means are not pooled across runs. Relative deltas/percentChange are current minus baseline: negative latency is an improvement.",
    "Physical GPU utilization and memory are device-wide nvidia-smi samples; RPC activity is not hardware occupancy. Other device users and sampling alignment can affect these values.",
    "Every run references a complete canonical outputHashSet below. Identical sets are stored once without dropping any chunk hashes; mismatching sets are preserved separately.",
    "Only completed baseline.json/stepN.json files currently present are included. A stage requires exactly the requested runs-per-stage. Missing/invalid metrics remain null and make allValid false; no incomplete stage is silently excluded.",
    "Fresh browser contexts do not imply cold OS/CDN/driver caches. These hashes test identity to the pinned fixture, not independent segmentation accuracy.",
  ],
  stages,
  outputHashSets: hashSets,
};
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, JSON.stringify(summary, null, 2) + "\n");
console.log(
  `Wrote ${outputPath}; allValid=${summary.allValid}; fixture chunks=${expectedHashes.length}`,
);
console.log(
  "| Stage | Runs | Viewport s | First visible s | Active s | RPC idle s | Init ms | Physical GPU active/full mean % | Peak MiB | Valid |",
);
console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---|");
const seconds = (value) =>
  value === null ? "n/a" : (Math.round(value) / 1000).toFixed(3);
for (const [name, stage] of Object.entries(stages)) {
  const m = stage.medians;
  console.log(
    `| ${name} | ${stage.runCount} | ${seconds(m.viewportMs)} | ${seconds(m.firstVisibleMs)} | ${seconds(m.activeWindowMs)} | ${seconds(m.rpcIdleMs)} | ${m.sessionInitMs ?? "n/a"} | ${m.activeGpuMeanPct ?? "n/a"}/${m.fullGpuMeanPct ?? "n/a"} | ${m.fullPeakMemoryMiB ?? "n/a"} | ${stage.valid} |`,
  );
  for (const issue of stage.issues) console.error(`${name}: ${issue}`);
  for (const run of stage.runs)
    for (const issue of run.issues) console.error(`${run.label}: ${issue}`);
}
if (!summary.allValid) process.exitCode = 1;
