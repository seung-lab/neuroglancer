#!/usr/bin/env node
/**
 * Actual affinity model: production UI -> worker -> native ORT WebGPU.
 * BASE_URL, MODEL_URL, MODEL, INPUT and REFERENCE are required.
 * MODEL_URL is native HTTPS; MODEL is the matching local audit copy.
 * INPUT: raw uint8 NCDHW [1,1,48,96,96], X fastest (442368 bytes).
 * REFERENCE: uncropped CPU FP32 logits [1,6,48,96,96], little endian
 * (2654208 values), computed from Float32(INPUT), NOT INPUT/255.
 * PRECISION is requested; EXPECTED_PRECISION defaults to that same precision.
 * Expected float32: REFERENCE is CPU ORT original FP32, abs/rel gate 1e-3.
 * Expected float16: REFERENCE is CPU ORT EXACT browser-converted graph, raw
 * abs/rel gate 1e-2; ORIGINAL_REFERENCE is required for separate drift.
 * PROBABILITY_GATE=1 explicitly replaces ONLY raw-tolerance acceptance with
 * max abs error <=0.01 after sigmoid(0.2*logit) vs BOTH CPU references, on all
 * retained six-channel values; finite values and zero violations required.
 * Allowed ONLY with requested AND expected actual float16. Raw metrics remain
 * diagnostic in this mode; >=0.70 flips on channels 0..2 remain reported, not
 * gated. This is application-level acceptance, NOT raw-half arithmetic equality
 * or segmentation-quality validation. PROBABILITY_GATE=0 (default) is unchanged.
 * Commands (also supply the required paths/URLs and browser options):
 *   PRECISION=float32 PROBABILITY_GATE=0 \
 *     node tests/inference/affinity_production.mjs
 *   PRECISION=float16 EXPECTED_PRECISION=float16 PROBABILITY_GATE=1 \
 *     node tests/inference/affinity_production.mjs
 * Only explicit PRECISION=float16 EXPECTED_PRECISION=float32 permits precision
 * fallback, with a visible reason and original FP32 oracle. No provider fallback
 * or tolerance overrides. The recipe always preserves requested PRECISION.
 * OUT optionally saves full JSON including visible Float32 values;
 * without OUT the full report goes to stdout. No server/build/model rewriting.
 * HEADFUL=1, CHROME, LAUNCH_OPTIONS, TIMEOUT and RUNTIME_MANIFEST follow
 * precision_production.mjs. MAX_CPU_THREADS=8 is the expected build cap, not
 * a runtime override; it must be 8, with >=8 logical cores and seven initialized
 * native pthread workers. Readiness barriers install device/pthread observers
 * BEFORE model/native-load delivery, not before bootstrap JS. Queued calls
 * snapshot immediately and detach transfers; no inference timing claim.
 * Only this owned test browser receives the Dawn f16 flag.
 */
import assert from "node:assert/strict";
import console from "node:console";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";
import { chromium } from "playwright";

/* global window, document, navigator, location, CustomEvent,
          globalThis, performance, WebAssembly, setTimeout, clearTimeout,
          structuredClone */
const modelSha256 =
  "783d9970d185f7f7211e5a62c4802cf1b6799022c6804e2bcbcf0d5a2c15a0b0";
const inputShape = [1, 1, 48, 96, 96];
const outputShape = [1, 6, 48, 96, 96];
const retainedShape = [36, 72, 72];
const retainedLength = 1119744;
const channelLength = 36 * 72 * 72;
const sizeXYZ = [96, 96, 48];
const resolutionNm = [9, 9, 20];
const spacingXYZ = [9e-9, 9e-9, 20e-9];
const sourceName = "affinity raw";
const resultName = `${sourceName} inference`;
const precision = process.env.PRECISION || "float32";
const expectedPrecision = process.env.EXPECTED_PRECISION || precision;
const expectPrecisionFallback = precision !== expectedPrecision;
const probabilityGate = process.env.PROBABILITY_GATE === "1";
const probabilityAbsGate = 1e-2;
const fp32Gate = { abs: 1e-3, rel: 1e-3 };
const gate =
  expectedPrecision === "float16" ? { abs: 1e-2, rel: 1e-2 } : fp32Gate;
const timeout = Number(process.env.TIMEOUT || 180000);
const maxCpuThreads = Number(process.env.MAX_CPU_THREADS || 8);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const contexts = new Set();
const report = {
  ok: false,
  precision,
  expectedPrecision,
  gate: {
    ...gate,
    rule: "abs(actual-ref) <= abs + rel*abs(ref)",
    diagnosticOnly: probabilityGate,
    oracle:
      expectedPrecision === "float16"
        ? "CPU ORT exact browser-converted FP16 graph"
        : "CPU ORT original FP32 graph",
  },
  probabilityGate: {
    enabled: probabilityGate,
    maxAbs: probabilityAbsGate,
    rule: "abs(sigmoid(0.2*actual)-sigmoid(0.2*ref)) <= 0.01",
    oracles: ["REFERENCE", "ORIGINAL_REFERENCE"],
    scope: "All retained values, all six channels; finite with zero violations",
    thresholdFlips: "Diagnostic >=0.70 crossings on channels 0..2; not gated",
  },
  assumptions: {
    model:
      "Native browser HTTPS delivery; exact local SHA/size must match the app recipe, without sending model response bodies through DevTools",
    input:
      "Exact raw uint8 -> Float32 intensities 0..255; NO normalization/resampling",
    reference:
      "Caller-supplied same-graph CPU ORT logits on Float32(INPUT), full uncropped NCDHW little-endian FP32; CPU/converter provenance is not independently attested",
    sensitivity:
      "Reference-close spatial variation on this real input, not a perturbed-input or segmentation-quality experiment",
    precision:
      "Requested recipe and expected actual precision are checked independently; only explicitly expected float16 -> float32 fallback is allowed and must report its reason",
    fp16: probabilityGate
      ? "Explicit application-level probability acceptance vs BOTH CPU references; raw-logit drift is diagnostic, NOT raw-half arithmetic equality or segmentation-quality validation"
      : "When actual FP16 is expected, converted-graph numerical correctness only; separate ORIGINAL_REFERENCE drift is diagnostic, NOT quality equivalence",
    postprocessing: probabilityGate
      ? "Both CPU references report sigmoid(0.2*x) changes on all six channels and diagnostic >=0.70 crossings on channels 0..2; not applied to published logits"
      : "Original-FP32 drift also reports sigmoid(0.2*x) changes on all six channels and >=0.70 crossings on channels 0..2; not applied to published logits",
    runtime:
      "URL/HTTP-header checks only; byte integrity belongs to precision/network smoke",
    threads:
      "Post-run inference-worker isolation and seven shared-memory native pthreads loaded AND started prove eight-thread runtime capability, not utilization by every operator",
    gpu: "Actual inference-worker requestDevice results and their queue submissions; no additional adapter requests",
  },
  runs: [],
  errors: [],
};
// Snapshot the entire envelope NOW: preserve aliases and immediate transfer
// detachment while holding model delivery until this actual worker is observed.
const observeWindowWorkers = (deadline) => {
  const Original = window.Worker;
  const workers = [];
  let nextToken = 0;
  window.affinityProbe = {
    loads: [],
    inputs: [],
    outputs: [],
    errors: [],
    signals: [],
    readiness: [],
  };
  const validateModel = (signal) => {
    // Keep the ever-created roster: an older same-URL target must not stand in
    // for the signaling instance, even if CDP has not published the new one.
    const matches = workers.filter((worker) => worker.workerUrl === signal.url);
    if (matches.length !== 1)
      throw new Error(`Ambiguous Window worker identity: ${signal.url}`);
    const worker = matches[0];
    if (
      worker.failed ||
      worker.observerId ||
      worker.token !== signal.token ||
      worker.signal?.id !== signal.id ||
      !worker.deferred.some(
        ({ data }) => data.kind === "load" && data.id === signal.id,
      )
    )
      throw new Error("Model worker identity invalid or not queued");
    return worker;
  };
  window.__affinityValidateModel = (signal) => {
    const worker = validateModel(signal);
    return { token: worker.token, url: worker.workerUrl, id: worker.signal.id };
  };
  window.__affinityReleaseModel = (signal, observerId) =>
    validateModel(signal).release(signal, observerId);
  window.Worker = class extends Original {
    constructor(...args) {
      super(...args);
      this.inference = false;
      this.token = ++nextToken;
      this.workerUrl = new URL(String(args[0]), document.baseURI).href;
      this.deferred = [];
      workers.push(this);
      this.addEventListener("message", ({ data }) => {
        if (!this.inference) return;
        const p = window.affinityProbe;
        if (data.metadata) p.metadata = data.metadata;
        if (data.kind === "loaded") p.loadedMetadata = data.metadata;
        if (data.kind === "error") p.errors.push(data.message);
        if (data.kind === "output")
          p.outputs.push({
            type: data.output.constructor.name,
            values: Array.from(data.output),
            runMs: data.runMs,
            metadata: data.metadata,
          });
      });
    }
    release(signal, observerId) {
      if (
        this.failed ||
        this.observerId ||
        typeof observerId !== "string" ||
        !observerId ||
        !this.signal ||
        signal.token !== this.token ||
        signal.url !== this.workerUrl ||
        signal.id !== this.signal.id
      )
        throw new Error("Model readiness expired, mismatched or duplicated");
      this.observerId = observerId;
      this.readyAt = performance.now();
      clearTimeout(this.timer);
      for (const { data, args } of this.deferred.splice(0))
        this.deliver(data, args, true);
      return {
        observerId,
        workerUrl: this.workerUrl,
        workerToken: this.token,
        loadId: this.signal.id,
        readyAt: this.readyAt,
      };
    }
    deliver(data, args, queued = false) {
      if (data.kind === "load")
        window.affinityProbe.readiness.push({
          id: data.id,
          observerId: this.observerId,
          workerUrl: this.workerUrl,
          workerToken: this.token,
          queued,
          readyBeforeDelivery: !!this.observerId,
          readyAt: this.readyAt,
          forwardedAt: performance.now(),
        });
      return super.postMessage(data, ...args);
    }
    postMessage(data, ...args) {
      const p = window.affinityProbe;
      if (data.kind === "load") {
        this.inference = true;
        p.loads.push({
          id: data.id,
          workerUrl: this.workerUrl,
          provider: data.provider,
          precision: data.precision,
          compatibilityFixes: data.compatibilityFixes,
          bytes: data.model.byteLength,
        });
      }
      if (this.inference && data.kind === "run")
        p.inputs.push({
          type: data.input.constructor.name,
          values: Array.from(data.input),
          geometry: data.geometry,
        });
      if (
        (data.kind === "load" && !this.observerId) ||
        this.deferred.length ||
        this.failed
      ) {
        const snapshot = structuredClone(
          { data, args },
          {
            transfer: Array.isArray(args[0])
              ? args[0]
              : args[0]?.transfer || [],
          },
        );
        this.deferred.push(snapshot);
        this.timer ??= setTimeout(() => {
          this.failed = true;
          p.errors.push(`Model observer readiness timeout: ${this.workerUrl}`);
        }, deadline);
        if (data.kind === "load") {
          if (this.signal) {
            this.failed = true;
            throw new Error("Duplicate model-load signal");
          }
          // Notify only AFTER snapshot/detachment. The binding carries identity,
          // never model bytes, transfer lists or replacement inference results.
          this.signal = {
            token: this.token,
            url: this.workerUrl,
            id: snapshot.data.id,
            signaledAt: performance.now(),
          };
          p.signals.push(this.signal);
          void Promise.resolve()
            .then(() => window.__affinityModelLoad(this.signal))
            .catch((error) => {
              this.failed = true;
              p.errors.push(`Model observer signal: ${error}`);
            });
        }
        return;
      }
      return this.deliver(data, args);
    }
  };
};
// A queued model-load signal selects one page-owned inference target. No
// page-wide auto-attach or unrelated-worker injection/inspection. Readiness
// gates, not debugger-pause ownership, order init; no response interception.
// Pinned native Asyncify glue: stock 59cf7815… and approved custom dea3ad7f….
// Select only from a real, type-checked first load; never infer threads from numbers.
const nativeProtocols = [
  { id: "stock-gd", command: "gd", memory: "Ue", module: "Ve", pthread: "cd" },
  { id: "custom-Bc", command: "Bc", memory: "Xd", module: "Yd", pthread: "Ac" },
];
const watchWorkers = async (context, page, record) => {
  const inject = (observerId, deadline, protocols) => {
    const state = {
      url: globalThis.location.href,
      observerId,
      isolated: globalThis.crossOriginIsolated,
      secure: globalThis.isSecureContext,
      hardwareConcurrency: navigator.hardwareConcurrency,
      sharedArrayBuffer: typeof SharedArrayBuffer === "function",
      loads: [],
      runs: [],
      children: [],
      errors: [],
    };
    const devices = [],
      queues = new WeakMap(),
      modules = new WeakMap(),
      memories = new WeakMap(),
      pthreads = [];
    let nextModule = 0,
      nextMemory = 0,
      poolTimer,
      poolFailed = false;
    const info = (value) =>
      value && {
        vendor: value.vendor,
        architecture: value.architecture,
        device: value.device,
        description: value.description,
        isFallbackAdapter: value.isFallbackAdapter,
      };
    globalThis.__affinityWorkerEvidence = () => ({
      ...state,
      // Children are sampled before native load; the main is inspected post-run.
      // Busy pthreads must never be evaluated after native run.
      isolated: globalThis.crossOriginIsolated,
      secure: globalThis.isSecureContext,
      hardwareConcurrency: navigator.hardwareConcurrency,
      sampledAt: performance.now(),
      devices: devices.map(({ adapter, device, ...observation }) => ({
        ...observation,
        adapter: {
          ...info(adapter.info),
          isFallbackAdapter:
            adapter.info?.isFallbackAdapter ?? adapter.isFallbackAdapter,
          features: [...adapter.features],
        },
        device: { ...info(device.adapterInfo), features: [...device.features] },
      })),
    });
    globalThis.addEventListener("message", ({ data }) => {
      if (data?.kind === "load")
        state.loads.push({
          id: data.id,
          provider: data.provider,
          precision: data.precision,
          compatibilityFixes: data.compatibilityFixes,
          bytes: data.model?.byteLength,
        });
      if (data?.kind === "run") state.runs.push({ id: data.id });
    });
    const { GPUAdapter, GPUQueue, Worker: OriginalWorker } = globalThis;
    if (GPUAdapter && GPUQueue) {
      const requestDevice = GPUAdapter.prototype.requestDevice;
      GPUAdapter.prototype.requestDevice = function (...args) {
        const stack = new Error("Observed requestDevice").stack;
        const promise = Reflect.apply(requestDevice, this, args);
        // Return the original promise/device, never substitute an adapter or
        // change required features, descriptors, session options or results.
        promise.then(
          (device) => {
            const observation = {
              adapter: this,
              device,
              stack,
              submissions: 0,
              runSubmissions: 0,
            };
            devices.push(observation);
            queues.set(device.queue, observation);
          },
          (error) => state.errors.push(`requestDevice: ${error}`),
        );
        return promise;
      };
      const submit = GPUQueue.prototype.submit;
      GPUQueue.prototype.submit = function (...args) {
        const result = Reflect.apply(submit, this, args);
        const observation = queues.get(this);
        if (observation) {
          ++observation.submissions;
          if (state.runs.length) ++observation.runSubmissions;
        }
        return result;
      };
    }
    // Both pinned factories yield awaiting seven native loaded replies BEFORE
    // _OrtInit. Hold native load, not bootstrap JS, until all child snapshots.
    globalThis.__affinityReleasePthreads = (snapshots) => {
      if (poolFailed || state.poolReadiness)
        throw new Error("Native readiness expired or duplicated");
      if (
        snapshots.length !== 7 ||
        pthreads.length !== 7 ||
        new Set(snapshots.map((s) => s.observerId)).size !== 7
      )
        throw new Error("Native readiness requires seven child snapshots");
      if (
        snapshots.some(
          (s) =>
            !s.isolated ||
            !s.secure ||
            !s.sharedArrayBuffer ||
            s.hardwareConcurrency < 8 ||
            !Number.isFinite(s.hookReadyAt),
        )
      )
        throw new Error("Native child capabilities unavailable");
      if (
        snapshots
          .map((s) => s.url)
          .sort()
          .join("\n") !==
        pthreads
          .map((w) => w.observation.url)
          .sort()
          .join("\n")
      )
        throw new Error("Native readiness URLs do not match children");
      state.poolReadiness = {
        observerIds: snapshots.map((s) => s.observerId),
        readyAt: performance.now(),
      };
      clearTimeout(poolTimer);
      for (const worker of pthreads) worker.release();
      return state.poolReadiness;
    };
    if (OriginalWorker)
      globalThis.Worker = class extends OriginalWorker {
        constructor(...args) {
          super(...args);
          this.observation = {
            url: new URL(String(args[0]), globalThis.location.href).href,
            name: args[1]?.name,
            loads: [],
            ready: [],
            starts: [],
            terminated: false,
          };
          this.deferred = [];
          state.children.push(this.observation);
          if (this.observation.name === "em-pthread") pthreads.push(this);
          this.addEventListener("message", ({ data }) => {
            const protocol = state.nativeProtocol;
            if (protocol && data?.[protocol.command] === "loaded")
              this.observation.ready.push({
                protocol: protocol.id,
                commandKey: protocol.command,
                command: "loaded",
                loadsSeen: this.observation.loads.length,
              });
          });
        }
        deliver(data, args, load) {
          if (load)
            Object.assign(load, {
              readyBeforeDelivery: !!state.poolReadiness,
              forwardedAt: performance.now(),
            });
          return super.postMessage(data, ...args);
        }
        release() {
          for (const { data, args, load } of this.deferred.splice(0))
            this.deliver(data, args, load);
        }
        postMessage(data, ...args) {
          let load;
          if (this.observation.name === "em-pthread") {
            const matches = protocols.filter(
              (p) => data?.[p.command] === "load",
            );
            const protocol = matches[0] || state.nativeProtocol;
            if (
              !protocol ||
              matches.length > 1 ||
              (!this.observation.loads.length && matches.length !== 1) ||
              (state.nativeProtocol &&
                state.nativeProtocol.id !== protocol.id) ||
              protocols.some(
                (p) => p.id !== protocol.id && data?.[p.command] !== undefined,
              ) ||
              (typeof data?.[protocol.command] !== "string" &&
                data?.target !== "setimmediate")
            ) {
              state.errors.push("Unknown or mixed native pthread protocol");
              throw new Error("Unknown or mixed native pthread protocol");
            }
            const command = data?.[protocol.command];
            if (command === "load") {
              const memory = data[protocol.memory],
                module = data[protocol.module];
              if (
                !(memory instanceof WebAssembly.Memory) ||
                !(module instanceof WebAssembly.Module) ||
                typeof SharedArrayBuffer !== "function" ||
                !(memory.buffer instanceof SharedArrayBuffer)
              ) {
                state.errors.push("Invalid native pthread load memory/module");
                throw new Error("Invalid native pthread load memory/module");
              }
              state.nativeProtocol = protocol;
              if (!modules.has(module)) modules.set(module, ++nextModule);
              if (!memories.has(memory)) memories.set(memory, ++nextMemory);
              load = {
                protocol: protocol.id,
                commandKey: protocol.command,
                command,
                wasmMemory: true,
                shared: true,
                memoryBytes: memory.buffer.byteLength,
                memoryId: memories.get(memory),
                wasmModule: true,
                moduleId: modules.get(module),
              };
              this.observation.loads.push(load);
              if (!state.poolReadiness || poolFailed) {
                const snapshot = structuredClone(
                  { data, args },
                  {
                    transfer: Array.isArray(args[0])
                      ? args[0]
                      : args[0]?.transfer || [],
                  },
                );
                load.queued = true;
                this.deferred.push({ ...snapshot, load });
                poolTimer ??= setTimeout(() => {
                  poolFailed = true;
                  state.errors.push("Native child observer readiness timeout");
                }, deadline);
                return;
              }
            }
            if (command === "run") {
              const pthread = data[protocol.pthread];
              if (!Number.isSafeInteger(pthread) || pthread <= 0) {
                state.errors.push("Invalid native pthread run pointer");
                throw new Error("Invalid native pthread run pointer");
              }
              this.observation.starts.push({
                protocol: protocol.id,
                commandKey: protocol.command,
                command,
                pthread,
              });
            }
          }
          return this.deliver(data, args, load);
        }
        terminate(...args) {
          this.observation.terminated = true;
          return super.terminate(...args);
        }
      };
    state.hookReadyAt = performance.now();
    return globalThis.__affinityWorkerEvidence();
  };
  const cdp = await context.newCDPSession(page);
  const pageTarget = (await cdp.send("Target.getTargetInfo")).targetInfo;
  if (pageTarget.type !== "page" || !pageTarget.browserContextId)
    throw new Error("Observer requires an owned private page context");
  const targets = new Map(),
    pending = new Map(),
    tasks = new Map(),
    initializing = new Set();
  record.workerObservationErrors = [];
  record.modelSignals = [];
  let nextId = 0,
    selection;
  const send = (session, method, params = {}) => {
    if (!session) return cdp.send(method, params);
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          pending.delete(id);
          reject(new Error(`Worker CDP timeout: ${method}`));
        },
        Math.min(timeout, 10000),
      );
      pending.set(id, { session, resolve, reject, timer });
      send(targets.get(session).parent, "Target.sendMessageToTarget", {
        sessionId: session,
        message: JSON.stringify({ id, method, params }),
      }).catch((error) => {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      });
    });
  };
  const autoAttach = {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: false,
  };
  const evaluate = async (session, expression) => {
    const result = await send(session, "Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const dispatch = (parent, { method, params }) => {
    if (method === "Target.receivedMessageFromTarget") {
      const message = JSON.parse(params.message);
      if (message.id) {
        const command = pending.get(message.id);
        if (command && command.session === params.sessionId) {
          clearTimeout(command.timer);
          pending.delete(message.id);
          if (message.error)
            command.reject(new Error(JSON.stringify(message.error)));
          else command.resolve(message.result);
        }
      } else dispatch(params.sessionId, message);
    } else if (method === "Target.detachedFromTarget") {
      const target = targets.get(params.sessionId);
      if (target) target.detached = true;
    } else if (method === "Target.attachedToTarget") {
      const { sessionId, targetInfo, waitingForDebugger } = params;
      if (targets.has(sessionId)) return;
      if (!parent && targetInfo.targetId !== selection?.targetId) {
        record.workerObservationErrors.push(
          `Unexpected root attachment: ${targetInfo.url}`,
        );
        return;
      }
      const target = {
        parent,
        targetInfo,
        waitingForDebugger,
        ...(!parent ? { modelSignal: selection.signal } : {}),
      };
      targets.set(sessionId, target);
      const initialize = (async () => {
        try {
          await send(sessionId, "Target.setAutoAttach", autoAttach);
          if (targetInfo.type === "worker") {
            target.startup = await evaluate(
              sessionId,
              `(${inject.toString()})(${JSON.stringify(targetInfo.targetId)},${Math.min(timeout, 10000)},${JSON.stringify(nativeProtocols)})`,
            );
            target.hookInstalled = true;
            if (!parent)
              target.modelReadiness = await page.evaluate(
                ({ signal, id }) => window.__affinityReleaseModel(signal, id),
                { signal: target.modelSignal, id: targetInfo.targetId },
              );
            else {
              const owner = targets.get(parent);
              const siblings = [...targets.values()].filter(
                (t) => t.parent === parent && t.hookInstalled,
              );
              if (siblings.length === 7 && !owner.releasingPool) {
                owner.releasingPool = true;
                owner.poolReadiness = await evaluate(
                  parent,
                  `globalThis.__affinityReleasePthreads(${JSON.stringify(siblings.map((t) => t.startup))})`,
                );
              }
            }
          }
        } catch (error) {
          record.workerObservationErrors.push(
            `${targetInfo.url}: ${error.stack || error}`,
          );
        } finally {
          // Resume EVERY owned auto-attached target, even if injection failed.
          try {
            await send(sessionId, "Runtime.runIfWaitingForDebugger");
          } catch (error) {
            record.workerObservationErrors.push(`Worker resume: ${error}`);
          }
        }
      })();
      tasks.set(sessionId, initialize);
      initializing.add(initialize);
      void initialize.finally(() => initializing.delete(initialize));
    }
  };
  cdp.on("Target.attachedToTarget", (params) =>
    dispatch(null, { method: "Target.attachedToTarget", params }),
  );
  cdp.on("Target.receivedMessageFromTarget", (params) =>
    dispatch(null, { method: "Target.receivedMessageFromTarget", params }),
  );
  cdp.on("Target.detachedFromTarget", (params) =>
    dispatch(null, { method: "Target.detachedFromTarget", params }),
  );
  await page.exposeBinding("__affinityModelLoad", async (source, signal) => {
    try {
      if (
        source.page !== page ||
        source.frame !== page.mainFrame() ||
        !Number.isSafeInteger(signal?.token) ||
        signal.token <= 0 ||
        !Number.isSafeInteger(signal.id) ||
        typeof signal.url !== "string" ||
        !Number.isFinite(signal.signaledAt) ||
        record.modelSignals.length
      )
        throw new Error("Invalid or duplicate model-load signal");
      record.modelSignals.push({ ...signal });
      const expires = Date.now() + Math.min(timeout, 10000);
      let candidates;
      do {
        candidates = (await cdp.send("Target.getTargets")).targetInfos.filter(
          (t) =>
            t.type === "worker" &&
            t.url === signal.url &&
            t.browserContextId === pageTarget.browserContextId &&
            (t.parentId === pageTarget.targetId ||
              t.parentFrameId === pageTarget.targetId),
        );
        if (candidates.length > 1)
          throw new Error("Ambiguous inference worker URL/context");
        if (candidates.length === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      } while (Date.now() < expires);
      if (candidates.length !== 1)
        throw new Error("Inference worker target readiness timeout");
      const targetInfo = candidates[0];
      // Recheck AFTER the candidate snapshot, BEFORE any worker attachment:
      // any older candidate was Window-created before this snapshot and must
      // therefore appear in the ever-created roster checked here.
      const identity = await page.evaluate(
        (value) => window.__affinityValidateModel(value),
        signal,
      );
      if (
        identity.token !== signal.token ||
        identity.url !== signal.url ||
        identity.id !== signal.id
      )
        throw new Error("Mismatched Window worker identity");
      selection = { signal: { ...signal }, targetId: targetInfo.targetId };
      const { sessionId } = await cdp.send("Target.attachToTarget", {
        targetId: targetInfo.targetId,
        flatten: false,
      });
      // Public attach may report its session before/after the attached event.
      dispatch(null, {
        method: "Target.attachedToTarget",
        params: {
          sessionId,
          targetInfo,
          waitingForDebugger: false,
        },
      });
      await tasks.get(sessionId);
      const target = targets.get(sessionId);
      if (!target.modelReadiness)
        throw new Error("Inference observer was not ready");
      return target.modelReadiness;
    } catch (error) {
      record.workerObservationErrors.push(
        `Model signal: ${error.stack || error}`,
      );
      throw error;
    }
  });
  return async () => {
    await Promise.all(initializing);
    const liveTargets = new Set(
      (await cdp.send("Target.getTargets")).targetInfos
        .filter((t) => t.attached)
        .map((t) => t.targetId),
    );
    const snapshots = [];
    for (const [session, target] of targets) {
      const snapshot = {
        ...target,
        parentTargetId: targets.get(target.parent)?.targetInfo.targetId,
        live: liveTargets.has(target.targetInfo.targetId),
      };
      // Never evaluate a native child after load/run: cached pre-load capability
      // plus browser liveness only. Main post-run inspection remains mandatory.
      if (!target.parent && !target.detached && target.hookInstalled) {
        try {
          snapshot.evidence = await evaluate(
            session,
            "globalThis.__affinityWorkerEvidence()",
          );
        } catch (error) {
          snapshot.inspectionError = String(error);
        }
      }
      snapshots.push(snapshot);
    }
    return (record.workerTargets = snapshots);
  };
};
let browser, activeRun;
try {
  const fileNames = [
    "MODEL",
    "INPUT",
    "REFERENCE",
    ...(expectedPrecision === "float16" ? ["ORIGINAL_REFERENCE"] : []),
  ];
  for (const name of ["BASE_URL", "MODEL_URL", ...fileNames])
    assert(process.env[name], `${name} is required`);
  assert(["float32", "float16"].includes(precision), "Invalid PRECISION");
  assert(
    ["float32", "float16"].includes(expectedPrecision),
    "Invalid EXPECTED_PRECISION",
  );
  assert(
    !expectPrecisionFallback ||
      (precision === "float16" && expectedPrecision === "float32"),
    "Only requested float16 -> expected float32 fallback is supported",
  );
  assert(
    ["0", "1"].includes(process.env.PROBABILITY_GATE || "0"),
    "Invalid PROBABILITY_GATE; use 0 (raw default) or 1 (fixed probability gate)",
  );
  assert(
    !probabilityGate ||
      (precision === "float16" && expectedPrecision === "float16"),
    "PROBABILITY_GATE=1 requires PRECISION=float16 and EXPECTED_PRECISION=float16; no FP32/fallback bypass",
  );
  assert(Number.isSafeInteger(timeout) && timeout > 0, "Invalid TIMEOUT");
  assert.equal(
    maxCpuThreads,
    8,
    "MAX_CPU_THREADS must be 8; no service-gate bypass",
  );
  const appUrl = new URL(process.env.BASE_URL);
  assert(["http:", "https:"].includes(appUrl.protocol));
  assert(!appUrl.hash && !appUrl.username && !appUrl.password);
  report.baseUrl = appUrl.href;
  report.maxCpuThreads = maxCpuThreads;
  const files = await Promise.all(
    fileNames.map((name) => fs.readFile(process.env[name])),
  );
  const [model, input, reference, originalReference] = files;
  report.files = Object.fromEntries(
    fileNames.map((name, i) => {
      const bytes = files[i];
      return [
        name,
        { path: process.env[name], bytes: bytes.length, sha256: hash(bytes) },
      ];
    }),
  );
  assert.equal(
    hash(model),
    modelSha256,
    "MODEL must be the supplied ORIGINAL affinity graph",
  );
  assert.equal(input.length, 442368, "INPUT must be raw uint8 [1,1,48,96,96]");
  assert(
    input.some((v) => v !== input[0]),
    "INPUT must contain real, nonconstant intensities",
  );
  const [expected, originalExpected] = [reference, originalReference]
    .filter(Boolean)
    .map((bytes, r) => {
      const name = r === 0 ? "REFERENCE" : "ORIGINAL_REFERENCE";
      assert.equal(
        bytes.length,
        2654208 * 4,
        `${name} must be uncropped FP32 [1,6,48,96,96]`,
      );
      for (let i = 0; i < 2654208; ++i)
        assert(
          Number.isFinite(bytes.readFloatLE(4 * i)),
          `Non-finite ${name} at raw index ${i}`,
        );
      // Independent CPU-reference crop, not the application's helper or output.
      const cropped = new Float32Array(retainedLength);
      let n = 0;
      for (let c = 0; c < 6; ++c)
        for (let z = 6; z < 42; ++z)
          for (let y = 12; y < 84; ++y)
            for (let x = 12; x < 84; ++x)
              cropped[n++] = bytes.readFloatLE(
                4 * (((c * 48 + z) * 96 + y) * 96 + x),
              );
      assert.equal(n, retainedLength);
      return cropped;
    });

  const fixtureBase = new URL("/__affinity_smoke/", appUrl).href;
  const modelLocation = new URL(process.env.MODEL_URL);
  assert.equal(modelLocation.protocol, "https:", "MODEL_URL must use HTTPS");
  assert(
    !modelLocation.hash && !modelLocation.username && !modelLocation.password,
  );
  const modelUrl = modelLocation.href;
  assert(
    !modelUrl.startsWith(fixtureBase),
    "MODEL_URL must not be a routed fixture",
  );
  report.modelUrl = modelUrl;
  const chunkPath = "source/native/0-96_0-96_0-48";
  report.fixture = {
    inputShape,
    outputShape,
    retainedShape,
    cropZYX: [6, 12, 12],
    resolutionNm,
    voxelOffsetXYZ: [0, 0, 0],
    source: `${fixtureBase}source`,
  };
  let manifest;
  let runtimeBase = new URL(
    "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/",
  );
  if (process.env.RUNTIME_MANIFEST) {
    manifest = JSON.parse(
      await fs.readFile(process.env.RUNTIME_MANIFEST, "utf8"),
    );
    assert.equal(typeof manifest.base, "string");
    assert(Array.isArray(manifest.artifacts));
    runtimeBase = new URL(manifest.base, appUrl);
    assert(
      runtimeBase.origin === appUrl.origin || runtimeBase.protocol === "https:",
    );
    report.runtimeManifest = {
      path: process.env.RUNTIME_MANIFEST,
      base: runtimeBase.href,
    };
  }
  const runtimeAssets = ["mjs", "wasm"].map((extension) => {
    const name = `ort-wasm-simd-threaded.asyncify.${extension}`;
    const artifact = manifest?.artifacts.find((a) => a.name === name);
    if (manifest) assert(artifact, `Missing manifest artifact ${name}`);
    const url = new URL(name, runtimeBase).href;
    if (artifact) assert.equal(new URL(artifact.path, appUrl).href, url);
    return { ...artifact, extension, url };
  });
  report.expectedRuntimeAssets = runtimeAssets.map(
    ({ extension, url, contentType, contentEncoding }) => ({
      extension,
      url,
      contentType,
      contentEncoding,
    }),
  );

  const extra = JSON.parse(process.env.LAUNCH_OPTIONS || "{}");
  assert(extra.ignoreDefaultArgs !== true, "Do not drop all Chromium defaults");
  browser = await chromium.launch({
    ...extra,
    ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}),
    headless: process.env.HEADFUL !== "1",
    args: [
      "--no-sandbox",
      "--enable-unsafe-webgpu",
      "--enable-dawn-features=vulkan_enable_f16_on_nvidia",
      ...(process.env.WAYLAND_DISPLAY ? ["--ozone-platform=wayland"] : []),
      ...(extra.args || []),
    ],
    ignoreDefaultArgs: [
      ...new Set([
        "--enable-unsafe-swiftshader",
        ...(extra.ignoreDefaultArgs || []),
      ]),
    ],
  });
  report.browser = {
    version: browser.version(),
    owned: true,
    headful: process.env.HEADFUL === "1",
  };

  const open = async (url, label) => {
    const record = {
      label,
      url,
      fixtureRequests: [],
      modelResponses: [],
      runtimeAssets: [],
      errors: [],
    };
    report.runs.push(record);
    const context = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: 1280, height: 1000 },
    });
    contexts.add(context);
    context.on("response", (response) => {
      const request = response.request();
      let first = request;
      while (first.redirectedFrom()) first = first.redirectedFrom();
      if (first.url() === modelUrl) {
        const cleanUrl = (value) => {
          const url = new URL(value);
          if (url.href !== modelUrl && url.search) url.search = "?redacted";
          return url.href;
        };
        const h = response.headers();
        record.modelResponses.push({
          requestedUrl: cleanUrl(request.url()),
          url: cleanUrl(response.url()),
          redirectedFrom: request.redirectedFrom()
            ? cleanUrl(request.redirectedFrom().url())
            : undefined,
          status: response.status(),
          method: request.method(),
          contentLength: Number(h["content-length"]) || undefined,
          accessControlAllowOrigin: h["access-control-allow-origin"],
          fromServiceWorker: response.fromServiceWorker(),
        });
      }
      if (!/ort-wasm|\.(mjs|wasm)(?:\?|$)/.test(response.url())) return;
      const h = response.headers();
      record.runtimeAssets.push({
        requestedUrl: response.request().url(),
        url: response.url(),
        redirectedFrom: response.request().redirectedFrom()?.url(),
        status: response.status(),
        contentType: h["content-type"],
        contentEncoding: h["content-encoding"],
        accessControlAllowOrigin: h["access-control-allow-origin"],
        vary: h.vary,
        contentLength: Number(h["content-length"]) || undefined,
        resourceType: response.request().resourceType(),
      });
    });
    context.on("requestfailed", (request) =>
      record.errors.push(`${request.url()}: ${request.failure()?.errorText}`),
    );
    // Whitelist only local data. Never route production JS, workers or ORT.
    await context.route(`${fixtureBase}**`, async (route) => {
      const resource = route.request().url().slice(fixtureBase.length);
      record.fixtureRequests.push(resource);
      let body,
        contentType = "application/octet-stream";
      if (resource === chunkPath)
        body = input; // Exact X-fastest real-EM bytes.
      else if (resource === "source/info") {
        contentType = "application/json";
        body = JSON.stringify({
          type: "image",
          data_type: "uint8",
          num_channels: 1,
          scales: [
            {
              key: "native",
              size: sizeXYZ,
              resolution: resolutionNm,
              voxel_offset: [0, 0, 0],
              chunk_sizes: [sizeXYZ],
              encoding: "raw",
            },
          ],
        });
      } else {
        record.errors.push(`Unexpected fixture request: ${resource}`);
        await route.abort();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType,
        body,
        headers: { "Cache-Control": "no-store" },
      });
    });
    const page = await context.newPage();
    activeRun = { page, context, record };
    activeRun.captureWorkers = await watchWorkers(context, page, record);
    page.setDefaultTimeout(timeout);
    page.on("pageerror", (error) =>
      record.errors.push(error.stack || String(error)),
    );
    await page.addInitScript(observeWindowWorkers, Math.min(timeout, 10000));
    await page.goto(url);
    await page.waitForFunction(() => window.viewer?.state);
    record.environment = await page.evaluate(() => ({
      isolated: window.crossOriginIsolated,
      secure: window.isSecureContext,
      hardwareConcurrency: navigator.hardwareConcurrency,
    }));
    const env = record.environment;
    assert.equal(env.isolated, true, "Candidate must serve an isolated page");
    assert.equal(env.secure, true);
    assert(
      env.hardwareConcurrency >= 8,
      "Eight-thread service gate requires >=8 logical cores",
    );
    return activeRun;
  };
  const probe = (page) => page.evaluate(() => window.affinityProbe);
  const metadataCheck = (metadata, initial = false) => {
    assert(metadata, "Worker metadata required");
    assert.equal(metadata.requestedProvider, "webgpu");
    assert.equal(metadata.actualProvider, "webgpu");
    assert.equal(metadata.requestedPrecision, precision);
    // A session may initialize in FP16, then fall back on its first execution.
    // Only explicit expected-fallback tests permit this INITIAL state.
    const pendingFallback =
      initial &&
      expectPrecisionFallback &&
      metadata.actualPrecision === precision;
    assert.equal(
      metadata.actualPrecision,
      pendingFallback ? precision : expectedPrecision,
      "Actual precision must match EXPECTED_PRECISION; no invisible fallback",
    );
    if (expectPrecisionFallback && !pendingFallback) {
      assert.equal(typeof metadata.precisionFallbackReason, "string");
      assert(
        metadata.precisionFallbackReason.trim(),
        "Expected precision fallback needs a reason",
      );
    } else
      assert.equal(
        metadata.precisionFallbackReason,
        undefined,
        "Unexpected precision fallback",
      );
    for (const key of ["fallbackReason", "preparation"])
      assert.equal(metadata[key], undefined, `Unexpected ${key}`);
    assert.equal(metadata.compatibilityFixes, false);
    assert.deepEqual(metadata.inputNames, ["image"]);
    assert.deepEqual(metadata.outputNames, ["logits"]);
    assert.deepEqual(
      metadata.inputShape,
      inputShape,
      "Symbolic N must be bound to 1",
    );
    assert.deepEqual(metadata.outputShape, outputShape);
    // Necessary, not sufficient: also require the post-init native pool below.
    assert.equal(
      metadata.threads,
      8,
      "Worker must report the eight-thread cap",
    );
  };
  const recipeFromState = (state) => {
    const layer = state.layers.find((l) => l.name === resultName);
    assert(layer, "Published live result must serialize");
    const sources = Array.isArray(layer.source) ? layer.source : [layer.source];
    assert.equal(sources.length, 1);
    assert.equal(sources[0].url, "inference://recipe");
    return sources[0].state;
  };
  const drift = (values, oracle, tolerance) => {
    const channels = [];
    let firstFailure = null,
      sumAbs = 0,
      sumSquared = 0,
      maxAbs = 0,
      badCount = 0,
      nonFiniteCount = 0;
    for (let c = 0; c < 6; ++c) {
      let abs = 0,
        squared = 0,
        max = 0,
        bad = 0,
        nonFinite = 0;
      let actualMin = Infinity,
        actualMax = -Infinity,
        refMin = Infinity,
        refMax = -Infinity,
        constantLowerBound = -Infinity,
        constantUpperBound = Infinity;
      for (let j = 0; j < channelLength; ++j) {
        const i = c * channelLength + j,
          actual = values[i],
          ref = oracle[i];
        const finite = Number.isFinite(actual);
        const error = finite ? Math.abs(actual - ref) : Infinity;
        const limit = tolerance.abs + tolerance.rel * Math.abs(ref);
        abs += error;
        squared += error * error;
        max = Math.max(max, error);
        refMin = Math.min(refMin, ref);
        refMax = Math.max(refMax, ref);
        constantLowerBound = Math.max(constantLowerBound, ref - limit);
        constantUpperBound = Math.min(constantUpperBound, ref + limit);
        if (finite) {
          actualMin = Math.min(actualMin, actual);
          actualMax = Math.max(actualMax, actual);
        } else ++nonFinite;
        if (error > limit) {
          ++bad;
          if (!firstFailure) {
            const z = Math.floor(j / (72 * 72)),
              y = Math.floor(j / 72) % 72,
              x = j % 72;
            firstFailure = {
              index: i,
              channel: c,
              retainedZYX: [z, y, x],
              rawZYX: [z + 6, y + 12, x + 12],
              actual,
              reference: ref,
              abs: error,
              limit,
            };
          }
        }
      }
      channels.push({
        channel: c,
        count: channelLength,
        maxAbs: max,
        meanAbs: abs / channelLength,
        rmse: Math.sqrt(squared / channelLength),
        badCount: bad,
        nonFiniteCount: nonFinite,
        actualMin,
        actualMax,
        referenceMin: refMin,
        referenceMax: refMax,
        constantCanPassGate: constantLowerBound <= constantUpperBound,
      });
      sumAbs += abs;
      sumSquared += squared;
      maxAbs = Math.max(maxAbs, max);
      badCount += bad;
      nonFiniteCount += nonFinite;
    }
    return {
      count: retainedLength,
      maxAbs,
      meanAbs: sumAbs / retainedLength,
      rmse: Math.sqrt(sumSquared / retainedLength),
      badCount,
      nonFiniteCount,
      firstFailure,
      channels,
    };
  };
  const check = async (run) => {
    const { page, record } = run;
    await page.waitForFunction(
      (name) => {
        if (window.affinityProbe.errors.length) return true;
        const r = window.viewer.layerManager.managedLayers.find(
          (l) => l.name === name,
        )?.layer?.renderLayers[0];
        const source = r?.visibleSources?.keys().next().value;
        const p = r?.layerChunkProgressInfo;
        return (
          p?.numVisibleChunksNeeded > 0 &&
          p.numVisibleChunksAvailable === p.numVisibleChunksNeeded &&
          source?.chunks.size > 0 &&
          [...source.chunks.values()].every((c) => c.data?.length) &&
          window.affinityProbe.outputs.length > 0
        );
      },
      resultName,
      { timeout },
    );
    const p = await probe(page);
    await run.captureWorkers();
    record.worker = {
      loads: p.loads,
      readiness: p.readiness,
      inputCount: p.inputs.length,
      outputCount: p.outputs.length,
      loadedMetadata: p.loadedMetadata,
      metadata: p.metadata,
      errors: p.errors,
    };
    assert.deepEqual(
      p.errors,
      [],
      "Production worker rejected load/run; no result available",
    );
    assert.equal(
      p.outputs.length,
      1,
      "One demanded context, not whole-volume or duplicate inference",
    );
    assert.equal(p.outputs[0].values.length, retainedLength);
    const values = p.outputs[0].values;
    // Always collect statistics before assertions, including a failed FP16 gate.
    record.referenceDrift = drift(values, expected, gate);
    if (originalExpected) {
      record.originalFp32Drift = {
        ...drift(values, originalExpected, fp32Gate),
        diagnosticOnly: true,
        badCountUses: "Original FP32 gate for scale, not FP16 acceptance",
        sigmoid: [],
      };
      record.probabilityComparisons = {};
      for (const [name, comparison, oracle] of [
        ...(probabilityGate
          ? [["REFERENCE", record.referenceDrift, expected]]
          : []),
        ["ORIGINAL_REFERENCE", record.originalFp32Drift, originalExpected],
      ]) {
        const sigmoid = (comparison.sigmoid = []);
        let totalAbs = 0,
          totalSquared = 0,
          firstFailure = null;
        for (let c = 0; c < 6; ++c) {
          let maxAbs = 0,
            sumAbs = 0,
            sumSquared = 0,
            badCount = 0,
            nonFiniteCount = 0,
            upward = 0,
            downward = 0;
          for (let j = 0; j < channelLength; ++j) {
            const i = c * channelLength + j;
            const actual = 1 / (1 + Math.exp(-0.2 * values[i]));
            const reference = 1 / (1 + Math.exp(-0.2 * oracle[i]));
            const finite =
              Number.isFinite(values[i]) &&
              Number.isFinite(oracle[i]) &&
              Number.isFinite(actual) &&
              Number.isFinite(reference);
            const error = finite ? Math.abs(actual - reference) : Infinity;
            maxAbs = Math.max(maxAbs, error);
            sumAbs += error;
            sumSquared += error * error;
            if (!finite) ++nonFiniteCount;
            if (error > probabilityAbsGate) {
              ++badCount;
              firstFailure ??= {
                index: i,
                channel: c,
                actualLogit: values[i],
                referenceLogit: oracle[i],
                actual,
                reference,
                abs: error,
                limit: probabilityAbsGate,
              };
            }
            if (c < 3 && finite) {
              if (actual >= 0.7 && reference < 0.7) ++upward;
              if (actual < 0.7 && reference >= 0.7) ++downward;
            }
          }
          sigmoid.push({
            channel: c,
            count: channelLength,
            maxAbs,
            meanAbs: sumAbs / channelLength,
            rmse: Math.sqrt(sumSquared / channelLength),
            badCount,
            nonFiniteCount,
            ...(c < 3
              ? {
                  threshold: 0.7,
                  upward,
                  downward,
                  crossings: upward + downward,
                  thresholdComparedCount: channelLength - nonFiniteCount,
                  thresholdDiagnosticOnly: true,
                }
              : {}),
          });
          totalAbs += sumAbs;
          totalSquared += sumSquared;
        }
        record.probabilityComparisons[name] = {
          diagnosticOnly: !probabilityGate,
          count: retainedLength,
          maxAbs: Math.max(...sigmoid.map((c) => c.maxAbs)),
          meanAbs: totalAbs / retainedLength,
          rmse: Math.sqrt(totalSquared / retainedLength),
          badCount: sigmoid.reduce((n, c) => n + c.badCount, 0),
          nonFiniteCount: sigmoid.reduce((n, c) => n + c.nonFiniteCount, 0),
          firstFailure,
          channels: sigmoid,
        };
      }
    }
    record.output = {
      type: p.outputs[0].type,
      elements: p.outputs[0].values.length,
      runMs: p.outputs[0].runMs,
      metadata: p.outputs[0].metadata,
      rawFiniteCheck:
        "Successful production worker output follows its full uncropped FP32 shape/type/finite gate; observer does not expose uncropped GPU logits",
    };
    record.published = await page.evaluate((name) => {
      const layer = window.viewer.layerManager.managedLayers.find(
        (l) => l.name === name,
      );
      const r = layer.layer.renderLayers[0],
        source = r.visibleSources.keys().next().value;
      return {
        info: JSON.parse(JSON.stringify(r.multiscaleSource.info)),
        bounds: Array.from(source.spec.upperVoxelBound),
        chunkSize: Array.from(source.spec.chunkDataSize),
        chunks: [...source.chunks].map(([key, c]) => ({
          position: key.split(",").map(Number),
          shape: Array.from(c.chunkDataSize),
          type: c.data?.constructor.name,
          values: Array.from(c.data),
        })),
        state: JSON.parse(JSON.stringify(window.viewer.state.toJSON())),
      };
    }, resultName);
    assert.deepEqual(record.errors, []);
    assert.equal(
      p.loads.length,
      1,
      "One worker model load per fresh context (symbolic binding may rebuild internally)",
    );
    // Match the actual worker's received load to the unchanged Window Worker
    // observation, not another worker or a post-run capability-probe adapter.
    const inferenceTargets = record.workerTargets.filter(
      (t) => t.evidence?.loads.length,
    );
    record.executingWorkers = inferenceTargets;
    assert.deepEqual(record.workerObservationErrors, []);
    assert.equal(
      inferenceTargets.length,
      1,
      "Exactly one observed inference worker required",
    );
    const target = inferenceTargets[0],
      actual = target.evidence;
    assert.equal(target.live, true);
    assert.equal(target.targetInfo.url, p.loads[0].workerUrl);
    assert.equal(actual.url, p.loads[0].workerUrl);
    assert.deepEqual(actual.loads, [
      {
        id: p.loads[0].id,
        provider: "webgpu",
        precision,
        compatibilityFixes: false,
        bytes: model.length,
      },
    ]);
    assert.deepEqual(p.loads[0], { ...actual.loads[0], workerUrl: actual.url });
    assert.equal(record.modelSignals.length, 1);
    assert.deepEqual(p.signals, record.modelSignals);
    assert.deepEqual(target.modelSignal, record.modelSignals[0]);
    assert.equal(target.modelSignal.url, actual.url);
    assert.equal(target.modelSignal.id, actual.loads[0].id);
    assert.equal(p.readiness.length, 1);
    const ready = p.readiness[0];
    assert.equal(ready.id, p.loads[0].id);
    assert.equal(ready.observerId, actual.observerId);
    assert.equal(ready.workerUrl, actual.url);
    assert.equal(ready.workerToken, target.modelSignal.token);
    assert.equal(ready.workerToken, target.modelReadiness.workerToken);
    assert.equal(target.modelReadiness.loadId, target.modelSignal.id);
    assert(ready.readyAt >= target.modelSignal.signaledAt);
    assert.equal(ready.readyBeforeDelivery, true);
    assert.equal(ready.readyAt, target.modelReadiness.readyAt);
    assert(ready.forwardedAt >= ready.readyAt);
    assert.equal(actual.runs.length, 1);
    assert.deepEqual(actual.errors, []);
    assert.equal(
      actual.isolated,
      true,
      "Inference worker itself must be isolated",
    );
    assert.equal(actual.secure, true);
    assert(actual.hardwareConcurrency >= 8);
    assert.equal(actual.sharedArrayBuffer, true);
    // Bootstrap may run first. The Window gate must withhold model delivery
    // until this actual worker's complete hook/capability snapshot is captured.
    assert.equal(target.hookInstalled, true);
    assert.equal(target.startup?.observerId, target.targetInfo.targetId);
    assert(Number.isFinite(target.startup?.hookReadyAt));
    assert.deepEqual(target.startup.loads, []);
    assert.deepEqual(target.startup.children, []);
    assert.deepEqual(target.startup.devices, []);
    assert.equal(actual.observerId, target.targetInfo.targetId);
    assert.equal(target.modelReadiness?.observerId, actual.observerId);
    assert.equal(target.modelReadiness.workerUrl, actual.url);
    const pthreads = actual.children.filter((c) => c.name === "em-pthread");
    record.initializedRuntime = {
      postRun: true,
      initializedThreads:
        1 + pthreads.filter((c) => c.ready.length === 1).length,
      startedThreads: 1 + pthreads.filter((c) => c.starts.length > 0).length,
      protocol: actual.nativeProtocol,
      evidence: actual.nativeProtocol
        ? `${actual.nativeProtocol.id}: ${actual.nativeProtocol.command}:load(${actual.nativeProtocol.memory} shared WebAssembly.Memory, ${actual.nativeProtocol.module} WebAssembly.Module) -> ${actual.nativeProtocol.command}:loaded -> ${actual.nativeProtocol.command}:run(${actual.nativeProtocol.pthread}); plus inference main`
        : "No recognized native pthread load protocol observed",
      pthreads,
    };
    assert.equal(
      pthreads.length,
      7,
      "Eight-thread runtime requires seven real pthread workers",
    );
    const protocol = nativeProtocols.find(
      (p) => p.id === actual.nativeProtocol?.id,
    );
    assert(protocol, "Recognized native pthread load protocol is required");
    assert.deepEqual(actual.nativeProtocol, protocol);
    const poolTargets = record.workerTargets.filter(
      (t) => t.parentTargetId === target.targetInfo.targetId,
    );
    assert.equal(
      poolTargets.length,
      7,
      "Seven live native pthread targets must remain attached after initialization/run",
    );
    assert.equal(
      new Set(poolTargets.map((t) => t.targetInfo.targetId)).size,
      7,
    );
    assert.deepEqual(
      poolTargets.map((t) => t.targetInfo.url).sort(),
      pthreads.map((c) => c.url).sort(),
    );
    assert(
      actual.poolReadiness,
      "Native observers must be ready before loading pthreads",
    );
    assert.deepEqual(target.poolReadiness, actual.poolReadiness);
    assert.deepEqual(
      [...actual.poolReadiness.observerIds].sort(),
      poolTargets.map((c) => c.targetInfo.targetId).sort(),
    );
    assert(Number.isFinite(actual.poolReadiness.readyAt));
    for (const child of poolTargets) {
      assert.equal(child.live, true);
      assert.notEqual(child.detached, true);
      assert.equal(child.hookInstalled, true);
      assert.equal(child.startup?.observerId, child.targetInfo.targetId);
      assert(Number.isFinite(child.startup?.hookReadyAt));
      assert.equal(child.startup?.url, child.targetInfo.url);
      assert.equal(child.startup?.isolated, true);
      assert.equal(child.startup?.secure, true);
      assert.equal(child.startup?.sharedArrayBuffer, true);
      assert(child.startup?.hardwareConcurrency >= 8);
    }
    for (const child of pthreads) {
      assert.equal(child.terminated, false);
      assert.equal(child.loads.length, 1);
      const load = child.loads[0];
      assert.equal(load.protocol, protocol.id);
      assert.equal(load.commandKey, protocol.command);
      assert.equal(load.command, "load");
      assert.equal(load.readyBeforeDelivery, true);
      assert(load.forwardedAt >= actual.poolReadiness.readyAt);
      assert.equal(load.wasmMemory, true);
      assert.equal(load.shared, true);
      assert(load.memoryBytes > 0);
      assert(load.memoryId > 0);
      assert.equal(load.memoryId, pthreads[0].loads[0].memoryId);
      assert.equal(load.wasmModule, true);
      assert(load.moduleId > 0);
      assert.equal(load.moduleId, pthreads[0].loads[0].moduleId);
      assert.deepEqual(child.ready, [
        {
          protocol: protocol.id,
          commandKey: protocol.command,
          command: "loaded",
          loadsSeen: 1,
        },
      ]);
      assert(
        child.starts.some(
          (s) =>
            s.protocol === protocol.id &&
            s.commandKey === protocol.command &&
            s.command === "run" &&
            Number.isSafeInteger(s.pthread) &&
            s.pthread > 0,
        ),
        "Native ORT must start every initialized pthread",
      );
    }
    const executingDevices = actual.devices.filter((d) => d.runSubmissions > 0);
    record.executingDevices = executingDevices;
    assert(
      executingDevices.length > 0,
      "Observe actual GPUDevice queue submissions during the inference-worker run, not only initialization",
    );
    for (const observation of executingDevices) {
      for (const identity of [observation.adapter, observation.device]) {
        assert.equal(
          identity.isFallbackAdapter,
          false,
          "Actual ORT adapter/device must not be fallback",
        );
        const description = [
          identity.vendor,
          identity.architecture,
          identity.device,
          identity.description,
        ].join(" ");
        assert.match(
          description,
          /nvidia|0x10de/i,
          "Actual executing ORT device must be NVIDIA",
        );
        assert(!/swiftshader|llvmpipe|software|lavapipe/i.test(description));
      }
      if (expectedPrecision === "float16")
        assert(
          observation.device.features.includes("shader-f16"),
          "shader-f16 must be enabled on the actual executing GPUDevice",
        );
    }
    assert.equal(p.inputs.length, 1);
    const observedInput = p.inputs[0];
    assert.equal(observedInput.type, "Float32Array");
    assert.equal(observedInput.values.length, input.length);
    let mismatches = 0,
      min = Infinity,
      max = -Infinity,
      firstMismatch = null;
    for (let i = 0; i < input.length; ++i) {
      const actual = observedInput.values[i];
      min = Math.min(min, actual);
      max = Math.max(max, actual);
      if (actual !== input[i]) {
        ++mismatches;
        firstMismatch ??= { index: i, actual, expected: input[i] };
      }
    }
    record.input = {
      type: observedInput.type,
      elements: input.length,
      min,
      max,
      mismatches,
      firstMismatch,
    };
    assert.equal(
      mismatches,
      0,
      "ALL input elements must equal raw uint8 intensities, NOT /255",
    );
    const geometry = observedInput.geometry;
    record.geometry = geometry;
    assert.deepEqual(geometry.inputShape, [48, 96, 96]);
    assert.deepEqual(geometry.rawOutputShape, [48, 96, 96]);
    assert.deepEqual(geometry.cropBefore, [6, 12, 12]);
    assert.deepEqual(geometry.cropAfter, [6, 12, 12]);
    assert.equal(geometry.outputChannels, 6);
    for (let i = 0; i < 3; ++i) {
      assert(Math.abs(geometry.inputSpacing[i] - spacingXYZ[2 - i]) < 1e-20);
      assert(Math.abs(geometry.outputSpacing[i] - spacingXYZ[2 - i]) < 1e-20);
      assert(Math.abs(geometry.rawOutputOrigin[i]) < 1e-20);
    }
    assert.equal(
      p.outputs[0].type,
      "Float32Array",
      "Public I/O remains FP32 even for native FP16",
    );
    metadataCheck(p.loadedMetadata, true);
    for (const metadata of [p.metadata, p.outputs[0].metadata])
      metadataCheck(metadata);
    const published = record.published;
    assert.deepEqual(published.bounds, [60, 60, 32, 6]);
    assert.deepEqual(published.chunkSize, [60, 60, 16, 6]);
    assert.equal(published.info.channels, 6);
    assert.deepEqual(published.info.shapeZYX, [32, 60, 60]);
    assert.deepEqual(published.info.originZYX, [6, 12, 12]);
    assert.deepEqual(published.info.spacingZYX, geometry.outputSpacing);
    assert.deepEqual(
      JSON.parse(published.info.provenanceJson).geometry,
      geometry,
    );
    let checked = 0,
      publishedMismatches = 0;
    for (const chunk of published.chunks) {
      assert.equal(chunk.type, "Float32Array");
      assert.deepEqual(chunk.shape, [60, 60, 16, 6]);
      assert.equal(chunk.position.length, 4);
      assert.equal(chunk.position[3], 0);
      assert.equal(chunk.values.length, 6 * 16 * 60 * 60);
      for (let c = 0; c < 6; ++c)
        for (let z = 0; z < 16; ++z)
          for (let y = 0; y < 60; ++y)
            for (let x = 0; x < 60; ++x) {
              const gx = chunk.position[0] * 60 + x,
                gy = chunk.position[1] * 60 + y,
                gz = chunk.position[2] * 16 + z;
              assert(
                gx >= 0 && gx < 60 && gy >= 0 && gy < 60 && gz >= 0 && gz < 32,
              );
              const value = chunk.values[((c * 16 + z) * 60 + y) * 60 + x];
              if (
                !Number.isFinite(value) ||
                value !==
                  p.outputs[0].values[((c * 36 + gz) * 72 + gy) * 72 + gx]
              )
                ++publishedMismatches;
              ++checked;
            }
    }
    record.publishedComparison = {
      elements: checked,
      mismatches: publishedMismatches,
    };
    assert(
      checked >= 6 * 16 * 60 * 60,
      "At least one full visible tile, all six channels",
    );
    assert.equal(
      publishedMismatches,
      0,
      "Visible Float32 values must equal retained worker output",
    );
    const recipe = recipeFromState(published.state);
    record.recipe = recipe;
    assert.equal(recipe.version, 2);
    assert.equal(recipe.profile, "ncdhw-centered-v2");
    assert.equal(recipe.precision, precision);
    assert.equal(recipe.provider, "webgpu");
    assert.equal(recipe.compatibilityFixes, false);
    assert.equal(recipe.overlap, false);
    assert.equal(recipe.mode, "live");
    assert.equal(recipe.inputScaleIndex, 0);
    assert.equal("roi" in recipe, false);
    assert.equal("preprocessing" in recipe, false);
    assert.deepEqual(recipe.spacingZYX, geometry.inputSpacing);
    assert.deepEqual(recipe.outputSpacingZYX, geometry.outputSpacing);
    assert.equal(recipe.model.kind, "url");
    assert.equal(recipe.model.sha256, modelSha256);
    assert.equal(recipe.model.size, model.length);
    assert.deepEqual(recipe.model.urls, [modelUrl]);
    assert.equal(recipe.source.name, sourceName);
    for (const resource of ["source/info", chunkPath])
      assert(
        record.fixtureRequests.includes(resource),
        `Actual fixture fetch required: ${resource}`,
      );
    assert.equal(record.modelResponses[0]?.requestedUrl, modelUrl);
    const deliveries = record.modelResponses.filter((r) => r.status === 200);
    assert.equal(deliveries.length, 1, "One native browser model GET required");
    const delivery = deliveries[0];
    assert.equal(delivery.method, "GET");
    assert.equal(new URL(delivery.url).protocol, "https:");
    assert.equal(delivery.contentLength, model.length);
    assert.equal(delivery.fromServiceWorker, false);
    if (new URL(delivery.url).origin !== appUrl.origin)
      assert(
        ["*", appUrl.origin].includes(delivery.accessControlAllowOrigin),
        "Native model response must allow the deployed app origin",
      );
    assert.deepEqual(
      [...new Set(record.runtimeAssets.map((a) => a.url))].sort(),
      runtimeAssets.map((a) => a.url).sort(),
      "Only the expected native Asyncify runtime URLs may be fetched",
    );
    for (const asset of record.runtimeAssets) {
      const target = runtimeAssets.find((a) => a.url === asset.url);
      assert(target);
      assert.equal(asset.requestedUrl, target.url);
      assert.equal(asset.redirectedFrom, undefined);
      assert.equal(asset.status, 200);
      const mime = asset.contentType?.split(";", 1)[0].trim().toLowerCase();
      if (target.contentType) assert.equal(mime, target.contentType);
      else if (target.extension === "wasm")
        assert.equal(mime, "application/wasm");
      else assert.match(mime || "", /javascript|ecmascript/);
      const sameOrigin = new URL(asset.url).origin === appUrl.origin;
      if (!sameOrigin) assert.equal(asset.accessControlAllowOrigin, "*");
      const encoding =
        target.contentEncoding ??
        (manifest && target.extension === "wasm" ? "br" : undefined);
      if (encoding !== undefined) assert.equal(asset.contentEncoding, encoding);
      if (
        sameOrigin &&
        asset.contentEncoding === "br" &&
        target.extension === "wasm"
      )
        assert(
          asset.vary
            ?.split(",")
            .some((v) => v.trim().toLowerCase() === "accept-encoding"),
        );
      if (
        target.encodedBytes !== undefined &&
        asset.contentLength !== undefined
      )
        assert.equal(asset.contentLength, target.encodedBytes);
    }
    for (const channel of record.referenceDrift.channels) {
      assert(
        channel.actualMax > channel.actualMin,
        `Output channel ${channel.channel} must be nonconstant`,
      );
      assert(
        channel.referenceMax > channel.referenceMin &&
          !channel.constantCanPassGate,
        `CPU reference channel ${channel.channel} must distinguish spatial variation from constant output`,
      );
    }
    assert.equal(
      record.referenceDrift.nonFiniteCount,
      0,
      "Every retained output must be finite",
    );
    if (probabilityGate) {
      for (const name of ["REFERENCE", "ORIGINAL_REFERENCE"]) {
        const comparison = record.probabilityComparisons[name];
        assert.equal(comparison.count, retainedLength);
        assert.equal(
          comparison.nonFiniteCount,
          0,
          `${name} calibrated probability comparison must be finite`,
        );
        assert.equal(
          comparison.badCount,
          0,
          `${name} failed frozen calibrated probability gate (max abs <=0.01 after sigmoid(0.2*logit)); statistics and first failure are in report`,
        );
        assert(comparison.maxAbs <= probabilityAbsGate);
      }
    } else
      assert.equal(
        record.referenceDrift.badCount,
        0,
        `${expectedPrecision} failed frozen same-graph CPU gate (${gate.abs} + ${gate.rel}*abs(ref)); drift statistics and first failure are in report`,
      );
    return { values: p.outputs[0].values, recipe, geometry };
  };

  const state = {
    dimensions: Object.fromEntries(
      ["x", "y", "z"].map((name, i) => [name, [spacingXYZ[i], "m"]]),
    ),
    position: [42, 42, 14],
    crossSectionScale: 0.02,
    layout: "xy",
    prefetch: false,
    layers: [
      {
        type: "image",
        name: sourceName,
        source: `precomputed://${fixtureBase}source`,
      },
    ],
  };
  let run = await open(
    `${appUrl.href}#!${encodeURIComponent(JSON.stringify(state))}`,
    "UI",
  );
  const page = run.page;
  await page.waitForFunction(() =>
    window.viewer.layerManager.managedLayers[0]?.isReady(),
  );
  assert.equal(
    (await probe(page)).loads.length,
    0,
    "Runtime must stay lazy until UI load",
  );
  await page.evaluate(() =>
    window.viewer.element.dispatchEvent(
      new CustomEvent("action:open-onnx-inference", { bubbles: true }),
    ),
  );
  await page
    .getByLabel("Execution provider", { exact: true })
    .selectOption("webgpu");
  const fp16 = page.getByLabel("Experimental FP16 GPU inference", {
    exact: true,
  });
  assert.equal(await fp16.isChecked(), false, "FP16 is opt-in");
  if (precision === "float16") await fp16.check();
  const legacy = page.getByLabel("Apply legacy JSEP padding fixes", {
    exact: true,
  });
  assert.equal(
    await legacy.isChecked(),
    false,
    "Use original graph, no legacy fixes",
  );
  await page.getByLabel("Model URL (.onnx)").fill(modelUrl);
  await page
    .getByRole("button", { name: "Load model URL", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      window.affinityProbe.errors.length ||
      /Model ready|failed/i.test(
        document.querySelector("[role=status]")?.textContent || "",
      ),
  );
  assert.deepEqual(
    (await probe(page)).errors,
    [],
    "Model observer/load failed",
  );
  assert.match(
    await page.locator("[role=status]").textContent(),
    /Model ready/,
  );
  await page.getByLabel("Image source").selectOption("0");
  await page.getByLabel("Input scale X Y Z", { exact: true }).selectOption("0");
  await page
    .getByLabel("Overlap and blend output patches", { exact: true })
    .setChecked(false);
  // Do NOT edit output voxel size: the candidate must suggest native spacing.
  const suggested = (
    await page.getByLabel("Output voxel size X Y Z").inputValue()
  )
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  assert.equal(suggested.length, 3);
  suggested.forEach((v, i) => assert(Math.abs(v - spacingXYZ[i]) < 1e-20));
  run.record.ui = {
    requestedPrecision: precision,
    expectedPrecision,
    legacyFixes: await legacy.isChecked(),
    automaticOutputSpacingXYZ: suggested,
  };
  await page.getByLabel("I verified").check();
  await page.getByRole("button", { name: "Start live", exact: true }).click();
  await page.waitForFunction(() =>
    /^Live:|failed/i.test(
      document.querySelector("[role=status]")?.textContent || "",
    ),
  );
  assert.match(await page.locator("[role=status]").textContent(), /^Live:/);
  const first = await check(run);
  const precisionStatus = page.getByLabel("Inference precision status", {
    exact: true,
  });
  const providerStatus = page.getByLabel("Execution provider status", {
    exact: true,
  });
  assert(await precisionStatus.isVisible());
  assert(await providerStatus.isVisible());
  run.record.ui.precisionStatus = await precisionStatus.textContent();
  run.record.ui.providerStatus = await providerStatus.textContent();
  const tag = precision === "float16" ? "FP16" : "FP32";
  const actualTag =
    expectedPrecision === "float16" ? "FP16 (public I/O FP32)" : "FP32";
  assert.equal(await fp16.isChecked(), precision === "float16");
  assert(run.record.ui.precisionStatus.includes(`Requested precision: ${tag}`));
  assert(
    run.record.ui.precisionStatus.includes(
      `last initialized precision: ${actualTag}.`,
    ),
  );
  if (expectPrecisionFallback)
    assert(
      run.record.ui.precisionStatus.includes(
        `FP32 fallback: ${run.record.output.metadata.precisionFallbackReason}`,
      ),
    );
  else assert(!/fallback:/i.test(run.record.ui.precisionStatus));
  assert.match(
    run.record.ui.providerStatus,
    /Requested: webgpu; last initialized provider: WebGPU.*CPU kernel fallback disabled/,
  );
  assert(!/fallback:/i.test(run.record.ui.providerStatus));
  await page.waitForFunction(
    ({ name, precision }) => {
      try {
        const state = JSON.parse(decodeURIComponent(location.hash.slice(2)));
        const source = state.layers.find((l) => l.name === name)?.source;
        return (
          (Array.isArray(source) ? source[0] : source)?.state?.precision ===
          precision
        );
      } catch {
        return false;
      }
    },
    { name: resultName, precision },
  );
  report.replayUrl = page.url();
  assert.deepEqual(
    recipeFromState(
      JSON.parse(decodeURIComponent(new URL(report.replayUrl).hash.slice(2))),
    ),
    first.recipe,
  );
  await run.context.close();
  contexts.delete(run.context);
  activeRun = undefined;
  run = await open(report.replayUrl, "fresh-context URL replay");
  // Restore owns a separate hidden inference session; do not open a new dialog.
  const replay = await check(run);
  assert.deepEqual(replay.recipe, first.recipe);
  assert.deepEqual(replay.geometry, first.geometry);
  if (expectPrecisionFallback)
    assert.equal(
      run.record.output.metadata.precisionFallbackReason,
      report.runs[0].output.metadata.precisionFallbackReason,
      "Fresh context must report the same expected precision fallback",
    );
  let replayMaxAbs = 0,
    replayDifferences = 0;
  for (let i = 0; i < retainedLength; ++i) {
    replayMaxAbs = Math.max(
      replayMaxAbs,
      Math.abs(replay.values[i] - first.values[i]),
    );
    if (replay.values[i] !== first.values[i]) ++replayDifferences;
  }
  report.replayComparison = {
    elements: retainedLength,
    maxAbs: replayMaxAbs,
    differences: replayDifferences,
  };
  assert.equal(
    replayDifferences,
    0,
    "Fresh context must recompute the same retained outputs",
  );
  report.ok = true;
} catch (error) {
  report.errors.push(error.stack || String(error));
  process.exitCode = 1;
  if (activeRun) {
    try {
      if (activeRun.captureWorkers) await activeRun.captureWorkers();
    } catch (inspectionError) {
      report.errors.push(
        `Failure worker inspection: ${inspectionError.stack || inspectionError}`,
      );
    }
    try {
      activeRun.record.failureProbe = await activeRun.page.evaluate(() => {
        const p = window.affinityProbe;
        return (
          p && {
            loads: p.loads,
            readiness: p.readiness,
            inputCount: p.inputs.length,
            outputCount: p.outputs.length,
            loadedMetadata: p.loadedMetadata,
            metadata: p.metadata,
            errors: p.errors,
          }
        );
      });
    } catch (inspectionError) {
      report.errors.push(
        `Failure inspection: ${inspectionError.stack || inspectionError}`,
      );
    }
  }
} finally {
  // Only contexts/browser launched here; never attach to or close user Chrome.
  for (const context of contexts) {
    try {
      await context.close();
    } catch (error) {
      report.errors.push(`Context close: ${error.stack || error}`);
    }
  }
  if (browser) {
    try {
      await browser.close();
    } catch (error) {
      report.errors.push(`Browser close: ${error.stack || error}`);
    }
  }
  if (report.errors.length) {
    report.ok = false;
    process.exitCode = 1;
  }
  // JSON cannot encode NaN/Infinity: preserve failed drift values as strings.
  const replacer = (_key, value) =>
    typeof value === "number" && !Number.isFinite(value)
      ? String(value)
      : value;
  let saved = false;
  if (process.env.OUT) {
    try {
      await fs.writeFile(
        process.env.OUT,
        `${JSON.stringify(report, replacer, 2)}\n`,
      );
      saved = true;
    } catch (error) {
      report.errors.push(`OUT: ${error.stack || error}`);
      report.ok = false;
      process.exitCode = 1;
    }
  }
  console.log(
    JSON.stringify(
      report,
      (key, value) =>
        saved && key === "values" && Array.isArray(value)
          ? `${value.length} Float32 values saved in ${process.env.OUT}`
          : replacer(key, value),
      2,
    ),
  );
}
