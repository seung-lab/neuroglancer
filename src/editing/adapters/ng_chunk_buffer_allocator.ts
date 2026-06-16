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
 * SharedArrayBuffer-backed `ChunkBufferAllocator` (TM-322).
 *
 * The edit-session overlay routes every materialized working buffer
 * (`slot.data`) through the host's `ChunkBufferAllocator`. Backing those buffers
 * with `SharedArrayBuffer` lets the brush worker pool read and write overlay
 * chunks with zero copies. Only the live working buffer is shared; history
 * clones and the pristine baseline snapshot stay on the normal heap (see the
 * library's `ChunkBufferAllocator` docs), so undo/redo data never inflates the
 * shared region.
 *
 * `SharedArrayBuffer` requires cross-origin isolation (COOP/COEP — configured in
 * `vercel.json` and `build_tools/cli.ts`). When that is unavailable (e.g. a
 * non-isolated context), we fall back to a plain `ArrayBuffer`: identical
 * behavior, just not shareable with workers.
 */

import type { ChunkBufferAllocator } from "@zettaai/edit-session";

/** Whether `SharedArrayBuffer` can be used (i.e. the context is cross-origin isolated). */
export function sharedArrayBufferAvailable(): boolean {
  return (
    typeof SharedArrayBuffer !== "undefined" &&
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated ===
      true
  );
}

/**
 * Create the overlay working-buffer allocator. Defaults to SAB-backed buffers
 * when cross-origin isolation is available, else plain `ArrayBuffer`. `shared`
 * is injectable for testing.
 */
export function createChunkBufferAllocator(
  shared: boolean = sharedArrayBufferAvailable(),
): ChunkBufferAllocator {
  return {
    allocate(byteLength: number): ArrayBufferLike {
      return shared
        ? new SharedArrayBuffer(byteLength)
        : new ArrayBuffer(byteLength);
    },
  };
}
