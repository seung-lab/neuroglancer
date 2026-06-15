/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Dedicated brush rasterization worker pool (TM-322 phase 3 step 2).
 *
 * A small pool of module workers that rasterize stroke tiles into
 * SharedArrayBuffer-backed chunk buffers in place. Modeled on
 * `async_computation/request.ts` (free-list + pending queue, first-message-as-
 * ready handshake), but copy-free: the shared buffers are passed by reference
 * (never transferred), and a completed job returns only the written bbox.
 *
 * Requires the chunk buffers to be SAB-backed (cross-origin isolated); the
 * caller (PaintStrokePipeline) only dispatches here when that holds — a job
 * given a non-shared buffer would have its writes land in a structured-clone
 * copy and be lost. In-flight cancellation is cooperative via the job's shared
 * generation word (see `brush_worker_protocol`), not the worker queue.
 */

import type { RasterizedSubregion } from "#src/editing/tool_runtimes/paint_rasterize.js";
import type {
  BrushRasterizeJob,
  BrushRasterizeRequest,
  BrushRasterizeResult,
} from "#src/editing/tool_runtimes/brush_worker_protocol.js";

type Resolve = (value: RasterizedSubregion | null) => void;
type Reject = (error: unknown) => void;

let numWorkers = 0;
const freeWorkers: Worker[] = [];
const pendingJobs = new Map<
  number,
  { msg: BrushRasterizeRequest; cleanup?: () => void }
>();
const tasks = new Map<number, { resolve: Resolve; reject: Reject }>();
let nextTaskId = 0;

// Leave a core for the main thread (input/render); at least one worker.
const maxWorkers =
  typeof navigator === "undefined" ||
  typeof navigator.hardwareConcurrency === "undefined"
    ? 3
    : Math.max(1, Math.min(8, navigator.hardwareConcurrency - 1));

function returnWorker(worker: Worker): void {
  for (const [id, job] of pendingJobs) {
    pendingJobs.delete(id);
    job.cleanup?.();
    worker.postMessage(job.msg);
    return;
  }
  freeWorkers.push(worker);
}

function launchWorker(): void {
  ++numWorkers;
  // A literal `new URL(..., import.meta.url)` is required for bundler worker
  // resolution (no `#src/...` subpath import).
  const worker = new Worker(
    /* webpackChunkName: "neuroglancer_brush_worker" */
    new URL("../../brush_worker.bundle.js", import.meta.url),
    { type: "module" },
  );
  let ready = false;
  worker.onmessage = (msg: MessageEvent) => {
    // First message is the ready handshake.
    if (!ready) {
      ready = true;
      returnWorker(worker);
      return;
    }
    const data = msg.data as BrushRasterizeResult;
    returnWorker(worker);
    const task = tasks.get(data.id);
    if (task === undefined) return; // superseded/aborted before completion
    tasks.delete(data.id);
    if ("error" in data) {
      task.reject(new Error(data.error));
    } else {
      task.resolve(data.written);
    }
  };
}

/**
 * Rasterize one stroke tile on the pool. Resolves with the chunk-local bbox of
 * written voxels, or null when nothing committable was produced (the tile was a
 * miss or the job was superseded). `signal` cancels a still-queued job; an
 * in-flight job is stopped cooperatively via its generation word.
 */
export function requestBrushRasterize(
  job: BrushRasterizeJob,
  signal?: AbortSignal,
): Promise<RasterizedSubregion | null> {
  const id = nextTaskId++;
  const msg: BrushRasterizeRequest = { id, job };
  signal?.throwIfAborted();

  const promise = new Promise<RasterizedSubregion | null>((resolve, reject) => {
    tasks.set(id, { resolve, reject });
  });

  if (freeWorkers.length !== 0) {
    freeWorkers.pop()!.postMessage(msg);
  } else {
    let cleanup: (() => void) | undefined;
    if (signal !== undefined) {
      const abortHandler = () => {
        pendingJobs.delete(id);
        const task = tasks.get(id);
        if (task !== undefined) {
          tasks.delete(id);
          task.reject(signal.reason);
        }
      };
      signal.addEventListener("abort", abortHandler, { once: true });
      cleanup = () => signal.removeEventListener("abort", abortHandler);
    }
    pendingJobs.set(id, { msg, cleanup });
    if (tasks.size > numWorkers && numWorkers < maxWorkers) {
      launchWorker();
    }
  }

  return promise;
}
