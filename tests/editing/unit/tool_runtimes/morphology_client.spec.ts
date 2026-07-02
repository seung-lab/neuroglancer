/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

// Lifecycle unit tests for MorphologyClient (TM-304). The real worker + pyodide
// are mocked: we replace `RPC` with a controllable fake and stub the `Worker`
// global, so these run in plain node without any wasm assets.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` below is hoisted above all imports by vitest, so MorphologyClient
// (which imports `#src/worker_rpc.js`) binds to the faked RPC.
import { MorphologyClient } from "#src/editing/tool_runtimes/morphology_client.js";
import type {
  MorphologyRequest,
  MorphologyResponse,
} from "#src/editing/tool_runtimes/morphology_request.js";

const promiseInvoke =
  vi.fn<(name: string, x: any, opts: any) => Promise<MorphologyResponse>>();
const rpcInstances: Array<{ target: unknown; waitUntilReady: boolean }> = [];

vi.mock("#src/worker_rpc.js", () => ({
  RPC: class {
    // `ensureWorker` fires a readiness probe (PAINT_PIPELINE_READY_RPC =
    // "painting.ready") before any morphology call. Resolve it here so it
    // neither returns undefined (the boot probe `.then`s on it) nor consumes the
    // per-test morphology mocks (mockResolvedValueOnce / call-index asserts).
    // Literal string because a hoisted vi.mock factory can't reference imports.
    promiseInvoke = (name: string, x: any, opts?: any) =>
      name === "painting.ready"
        ? Promise.resolve({})
        : promiseInvoke(name, x, opts);
    constructor(
      public target: unknown,
      public waitUntilReady: boolean,
    ) {
      rpcInstances.push(this);
    }
  },
}));

class FakeWorker {
  static instances: FakeWorker[] = [];
  terminate = vi.fn();
  constructor(
    public url: URL,
    public opts: unknown,
  ) {
    FakeWorker.instances.push(this);
  }
}

function req(overrides: Partial<MorphologyRequest> = {}): MorphologyRequest {
  return {
    mask: new Uint8Array([1, 0, 1, 0]),
    shape: [2, 2, 1],
    binaryClosing: 0,
    minComponentSize: 0,
    filterComponentsFirst: false,
    ...overrides,
  };
}

function ok(mask: Uint8Array, heapPressure = false): MorphologyResponse {
  return { mask, heapPressure };
}

beforeEach(() => {
  vi.stubGlobal("Worker", FakeWorker as unknown as typeof Worker);
  FakeWorker.instances = [];
  rpcInstances.length = 0;
  promiseInvoke.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MorphologyClient", () => {
  it("lazily creates exactly one worker + RPC(waitUntilReady) and reuses it", async () => {
    promiseInvoke.mockImplementation(async (_n, x) => ok(x.mask));
    const client = new MorphologyClient();

    expect(FakeWorker.instances).toHaveLength(0); // nothing until first use
    await client.apply(req());
    await client.apply(req());

    expect(FakeWorker.instances).toHaveLength(1);
    expect(rpcInstances).toHaveLength(1);
    expect(rpcInstances[0].waitUntilReady).toBe(true);
    client.dispose();
  });

  it("warmup() boots the worker before any stroke", () => {
    const client = new MorphologyClient();
    client.warmup();
    expect(FakeWorker.instances).toHaveLength(1);
    client.dispose();
  });

  it("returns the processed mask and transfers the request buffer", async () => {
    const processed = new Uint8Array([1, 1, 1, 1]);
    promiseInvoke.mockResolvedValue(ok(processed));
    const client = new MorphologyClient();

    const request = req();
    const result = await client.apply(request);

    expect(result).toBe(processed);
    const [, , opts] = promiseInvoke.mock.calls[0];
    expect(opts.transfers).toEqual([request.mask.buffer]);
    client.dispose();
  });

  it("propagates worker rejection (so the caller can fall back to TS)", async () => {
    promiseInvoke.mockRejectedValue(new Error("worker died"));
    const client = new MorphologyClient();
    await expect(client.apply(req())).rejects.toThrow("worker died");
    client.dispose();
  });

  it("reinits on idle after heap pressure: terminates and recreates the worker", async () => {
    promiseInvoke.mockResolvedValueOnce(
      ok(new Uint8Array(4), /*heapPressure=*/ true),
    );
    promiseInvoke.mockResolvedValue(ok(new Uint8Array(4)));
    const client = new MorphologyClient();

    await client.apply(req()); // heap pressure → idle → terminate
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledTimes(1);

    await client.apply(req()); // lazily recreates a fresh worker
    expect(FakeWorker.instances).toHaveLength(2);
    client.dispose();
  });

  it("does NOT reinit while a call is still in flight", async () => {
    let resolveFirst!: (r: MorphologyResponse) => void;
    promiseInvoke.mockImplementationOnce(
      () => new Promise<MorphologyResponse>((r) => (resolveFirst = r)),
    );
    promiseInvoke.mockResolvedValue(ok(new Uint8Array(4)));
    const client = new MorphologyClient();

    const p1 = client.apply(req()); // in flight
    const p2 = client.apply(req()); // second call starts while first pending
    resolveFirst(ok(new Uint8Array(4), /*heapPressure=*/ true));
    await Promise.all([p1, p2]);

    // Pressure was flagged mid-flight; terminate only once both settle and idle.
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
    expect(FakeWorker.instances).toHaveLength(1);
    client.dispose();
  });

  it("dispose() terminates the worker", async () => {
    promiseInvoke.mockResolvedValue(ok(new Uint8Array(4)));
    const client = new MorphologyClient();
    await client.apply(req());
    client.dispose();
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
  });
});
