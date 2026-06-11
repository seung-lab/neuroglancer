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
 * Main-thread client for the pyodide morphology worker (TM-304).
 *
 * Owns one long-lived worker + its `RPC` channel and exposes a single
 * `apply()` round-trip. Threading deliberately reuses neuroglancer's RPC
 * primitives (`RPC` + `promiseInvoke`) rather than the async_computation pool
 * or the chunk worker — see `docs/pyodide-morphology-compute.md` §5.
 *
 * Notably absent: a "latest-wins" queue. In the old whole-buffer editor,
 * dropping a superseded request only skipped a preview frame; here each dab
 * contributes distinct voxels, so dropping one loses paint. Any coalescing
 * therefore happens at the stroke-segment level in `painting_compute.ts`, not
 * inside this client.
 */

import {
  MORPHOLOGY_APPLY_RPC,
  type MorphologyRequest,
  type MorphologyResponse,
} from "#src/editing/tool_runtimes/morphology_request.js";
import { RefCounted } from "#src/util/disposable.js";
import { RPC } from "#src/worker_rpc.js";

export class MorphologyClient extends RefCounted {
  private worker: Worker | undefined;
  private rpc: RPC | undefined;
  private inFlight = 0;
  private needsReinit = false;

  private ensureWorker(): RPC {
    if (this.rpc !== undefined) return this.rpc;
    // For multi-bundler compatibility the worker URL must be a literal
    // `new URL(..., import.meta.url)` (same constraint as
    // data_management_context.ts). The bundle lives at `src/`, this file at
    // `src/editing/tool_runtimes/`, hence the `../../` prefix.
    this.worker = new Worker(
      new URL("../../pyodide_morphology.bundle.js", import.meta.url),
      { type: "module" },
    );
    this.rpc = new RPC(this.worker, /*waitUntilReady=*/ true);
    return this.rpc;
  }

  /**
   * Eagerly boot the worker (and pyodide) so the multi-second cold start is
   * paid while the edit session opens, not on the first brush stroke.
   */
  warmup(): void {
    this.ensureWorker();
  }

  /**
   * Run the morphology pipeline in the worker. `req.mask`'s buffer is
   * transferred, so the caller must not reuse it afterwards. The returned
   * `Uint8Array` is a freshly-transferred buffer owned by the caller.
   *
   * Rejects if the worker fails; the caller (`PaintingCompute`) catches and
   * falls back to the TS pipeline so painting never hard-breaks.
   */
  async apply(
    req: MorphologyRequest,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const rpc = this.ensureWorker();
    this.inFlight++;
    try {
      const res = await rpc.promiseInvoke<MorphologyResponse>(
        MORPHOLOGY_APPLY_RPC,
        req,
        { transfers: [req.mask.buffer], signal },
      );
      if (res.heapPressure) this.needsReinit = true;
      return res.mask;
    } finally {
      this.inFlight--;
      this.maybeReinitOnIdle();
    }
  }

  /**
   * Memory-pressure reinit (ported from `pyodide.bridge.ts`): once the worker
   * reports heap pressure and we go idle, terminate it. The next `apply()`
   * lazily recreates a fresh worker; its cold start is absorbed by the RPC
   * `waitUntilReady` queue.
   */
  private maybeReinitOnIdle(): void {
    if (!this.needsReinit || this.inFlight > 0) return;
    this.needsReinit = false;
    this.terminate();
  }

  private terminate(): void {
    this.worker?.terminate();
    this.worker = undefined;
    this.rpc = undefined;
  }

  disposed(): void {
    this.terminate();
  }
}
