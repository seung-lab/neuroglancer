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
 * Brush worker entry handler (TM-322 phase 3 step 2). Runs in the dedicated
 * brush worker bundle. Each message is one chunk-tile rasterize job; the worker
 * writes covered voxels directly into the shared chunk buffer and replies with
 * the written bbox (no voxel data — the buffer is shared). It bails early when
 * the stroke's generation has been superseded (cooperative cancellation).
 */

import type {
  BrushWorkerRequest,
  BrushWorkerResult,
} from "#src/editing/tool_runtimes/brush_worker_protocol.js";
import {
  GENERATION_INDEX,
  maskViewForJob,
  viewForJob,
} from "#src/editing/tool_runtimes/brush_worker_protocol.js";
import {
  rasterizeStrokeIntoChunk,
  stampMaskIntoChunk,
  type RasterizedSubregion,
} from "#src/editing/tool_runtimes/paint_rasterize.js";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent) => {
  const { id, job } = event.data as BrushWorkerRequest;
  try {
    const control = new Int32Array(job.controlBuffer);
    const superseded = () =>
      Atomics.load(control, GENERATION_INDEX) !== job.generation;
    // Skip entirely if already stale (the stroke advanced/cancelled before we
    // were scheduled).
    let written: RasterizedSubregion | null = null;
    if (!superseded()) {
      const view = viewForJob(job);
      written =
        (job.kind === "mask"
          ? stampMaskIntoChunk(
              view,
              {
                mask: maskViewForJob(job),
                maskW: job.maskW,
                maskH: job.maskH,
                loTx: job.loTx,
                loTy: job.loTy,
                cz: job.cz,
                value: job.value,
                chunkOrigin: job.chunkOrigin,
                chunkSize: job.chunkSize,
              },
              superseded,
            )
          : rasterizeStrokeIntoChunk(
              view,
              {
                points: job.points,
                radius: job.radius,
                value: job.value,
                chunkOrigin: job.chunkOrigin,
                chunkSize: job.chunkSize,
              },
              superseded,
            )) ?? null;
    }
    const result: BrushWorkerResult = { id, written };
    ctx.postMessage(result);
  } catch (error) {
    const result: BrushWorkerResult = { id, error: String(error) };
    ctx.postMessage(result);
  }
};

// Notify the pool that this worker is ready to receive jobs (mirrors the
// async-computation handshake: the first message from a worker is the ready
// signal).
ctx.postMessage(null);
