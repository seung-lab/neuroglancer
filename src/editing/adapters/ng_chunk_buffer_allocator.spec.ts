/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect } from "vitest";

import {
  createChunkBufferAllocator,
  sharedArrayBufferAvailable,
} from "#src/editing/adapters/ng_chunk_buffer_allocator.js";

describe("createChunkBufferAllocator", () => {
  it("allocates a SharedArrayBuffer of the exact size when shared", () => {
    const buf = createChunkBufferAllocator(true).allocate(64);
    expect(buf).toBeInstanceOf(SharedArrayBuffer);
    expect(buf.byteLength).toBe(64);
  });

  it("allocates a plain ArrayBuffer of the exact size when not shared", () => {
    const buf = createChunkBufferAllocator(false).allocate(32);
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(buf).not.toBeInstanceOf(SharedArrayBuffer);
    expect(buf.byteLength).toBe(32);
  });

  it("defaults to the cross-origin-isolation capability", () => {
    // In the (non-isolated) test environment this is false, so the default
    // allocator yields a plain ArrayBuffer — the safe fallback.
    expect(sharedArrayBufferAvailable()).toBe(false);
    const buf = createChunkBufferAllocator().allocate(16);
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(buf).not.toBeInstanceOf(SharedArrayBuffer);
  });
});
