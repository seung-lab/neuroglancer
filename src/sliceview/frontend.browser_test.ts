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

import { describe, expect, it, vi } from "vitest";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import {
  makeSliceViewChunkSpecification,
  SLICEVIEW_REQUEST_CHUNK_RPC_ID,
} from "#src/sliceview/base.js";
import {
  SliceViewChunk,
  SliceViewChunkSource,
} from "#src/sliceview/frontend.js";
import {
  registerPromiseRPC,
  registerSharedObject,
  registerSharedObjectOwner,
  RPC,
  SharedObject,
  SharedObjectCounterpart,
} from "#src/worker_rpc.js";

// Queue delivery like a worker, but exercise the real RPC/ref-count protocol
// without a worker, ChunkManager, WebGL context, or downloads.
class InMemoryRpcTarget {
  onmessage: ((event: MessageEvent) => void) | null = null;
  peer!: InMemoryRpcTarget;

  postMessage(message: unknown) {
    const data = structuredClone(message);
    queueMicrotask(() => this.peer.onmessage!({ data } as MessageEvent));
  }
}

class TestChunkSource extends SliceViewChunkSource {}
class TestCounterpart extends SharedObjectCounterpart {}
const TEST_RPC_TYPE = "sliceview.fetchChunk.browser_test";
registerSharedObject(TEST_RPC_TYPE)(TestCounterpart);
registerSharedObjectOwner(TEST_RPC_TYPE)(TestChunkSource);

async function fixture() {
  const frontendTarget = new InMemoryRpcTarget();
  const backendTarget = new InMemoryRpcTarget();
  frontendTarget.peer = backendTarget;
  backendTarget.peer = frontendTarget;
  const frontend = new RPC(frontendTarget, false);
  const backend = new RPC(backendTarget, false);
  const source = new TestChunkSource({} as ChunkManager, {
    spec: makeSliceViewChunkSpecification({
      rank: 3,
      chunkDataSize: Uint32Array.of(1, 1, 1),
      upperVoxelBound: Float32Array.of(1, 1, 1),
    }),
  });
  // Only counterpart construction is substituted. fetchChunk and both sides'
  // SharedObject ownership/cancellation machinery are the production methods.
  SharedObject.prototype.initializeCounterpart.call(source, frontend);
  const sourceId = source.rpcId!;
  const disposed = vi.fn();
  source.registerDisposer(disposed);
  await Promise.resolve();
  const counterpart = backend.get(sourceId) as TestCounterpart;
  const counterpartDisposed = vi.spyOn(counterpart, "disposed");
  return {
    source,
    sourceId,
    frontend,
    backend,
    counterpart,
    disposed,
    counterpartDisposed,
  };
}

describe("SliceViewChunkSource.fetchChunk RPC ownership", () => {
  it("does not strand a counterpart reference for an already-aborted request", async () => {
    const f = await fixture();
    const addCounterpartRef = vi.spyOn(f.source, "addCounterpartRef");
    const transform = vi.fn();
    const reason = new DOMException("Request already cancelled", "AbortError");
    const pending = f.source.fetchChunk(new Float32Array(3), transform, {
      signal: AbortSignal.abort(reason),
    });
    // Release the owner immediately, as when a layer is deleted/reset.
    f.source.dispose();
    await expect(pending).rejects.toBe(reason);

    // A rejection alone is insufficient: the old implementation rejects but
    // strands a generation, leaving both shared objects registered forever.
    expect(f.disposed).toHaveBeenCalledOnce();
    expect(f.source.wasDisposed).toBe(true);
    expect(f.frontend.get(f.sourceId)).toBeUndefined();
    expect(f.backend.get(f.sourceId)).toBeUndefined();
    expect(f.counterpartDisposed).toHaveBeenCalledOnce();
    expect(addCounterpartRef).not.toHaveBeenCalled();
    expect(transform).not.toHaveBeenCalled();
    expect(f.source.chunkRequesters).toBeUndefined();
  });

  it("consumes and releases an active request reference after the owner releases", async () => {
    const f = await fixture();
    const started = Promise.withResolvers<TestCounterpart>();
    const complete = Promise.withResolvers<void>();
    registerPromiseRPC(
      SLICEVIEW_REQUEST_CHUNK_RPC_ID,
      async function (x: { source: { id: number; gen: number } }) {
        const source = this.getRef<TestCounterpart>(x.source);
        started.resolve(source);
        try {
          await complete.promise;
          return { value: undefined };
        } finally {
          source.dispose();
        }
      },
    );
    const chunk = new SliceViewChunk(f.source, {
      chunkGridPosition: new Float32Array(3),
    });
    const transform = vi.fn(() => 42);
    const pending = f.source.fetchChunk(new Float32Array(3), transform, {
      signal: new AbortController().signal,
    });
    expect(await started.promise).toBe(f.counterpart);
    expect(f.counterpart.refCount).toBe(1);
    f.source.dispose();
    expect(f.disposed).not.toHaveBeenCalled();
    expect(f.frontend.get(f.sourceId)).toBe(f.source);
    expect(f.backend.get(f.sourceId)).toBe(f.counterpart);

    // Deliver the requested chunk as the frontend chunk-update queue would.
    for (const requester of f.source.chunkRequesters!.get("0,0,0")!) {
      requester(chunk);
    }
    complete.resolve();
    await expect(pending).resolves.toBe(42);

    expect(transform).toHaveBeenCalledExactlyOnceWith(chunk);
    expect(f.source.chunkRequesters).toBeUndefined();
    expect(f.counterpart.refCount).toBe(0);
    expect(f.disposed).toHaveBeenCalledOnce();
    expect(f.source.wasDisposed).toBe(true);
    expect(f.counterpartDisposed).toHaveBeenCalledOnce();
    expect(f.frontend.numObjects).toBe(0);
    expect(f.backend.numObjects).toBe(0);
  });
});
