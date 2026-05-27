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
import { LocalPatchChunk } from "#src/editing/local_patch_chunk.js";
import { LocalPatchSource } from "#src/editing/local_patch_source.js";
import { LocalPatchStore } from "#src/editing/local_patch_store.js";

describe("LocalPatchChunk", () => {
  it("starts empty", () => {
    const chunk = new LocalPatchChunk([4, 4, 4] as any);
    expect(chunk.volume).toBe(64);
    expect(chunk.countPatchedVoxels()).toBe(0);
    expect(chunk.getVoxel(0, 0, 0)).toBe(0n);
    expect(chunk.hasPatchAt(2, 2, 2)).toBe(false);
  });

  it("writes and reads a voxel", () => {
    const chunk = new LocalPatchChunk([8, 8, 8] as any);
    const v = 12345678901234n;
    expect(chunk.writeVoxel(3, 4, 5, v)).toBe(true);
    expect(chunk.getVoxel(3, 4, 5)).toBe(v);
    expect(chunk.hasPatchAt(3, 4, 5)).toBe(true);
    expect(chunk.countPatchedVoxels()).toBe(1);
  });

  it("writeVoxel returns false when value unchanged", () => {
    const chunk = new LocalPatchChunk([2, 2, 2] as any);
    chunk.dirty = false;
    expect(chunk.writeVoxel(0, 0, 0, 0n)).toBe(false);
    expect(chunk.dirty).toBe(false);
    expect(chunk.writeVoxel(0, 0, 0, 42n)).toBe(true);
    expect(chunk.dirty).toBe(true);
    chunk.dirty = false;
    expect(chunk.writeVoxel(0, 0, 0, 42n)).toBe(false);
    expect(chunk.dirty).toBe(false);
  });

  it("flat indexing matches Fortran-order x + sx*(y + sy*z)", () => {
    const chunk = new LocalPatchChunk([3, 5, 7] as any);
    chunk.writeVoxel(2, 0, 0, 100n);
    chunk.writeVoxel(0, 4, 0, 200n);
    chunk.writeVoxel(0, 0, 6, 300n);
    chunk.writeVoxel(2, 4, 6, 400n);
    // Flat index for (2, 4, 6) with sx=3, sy=5: 2 + 3*(4 + 5*6) = 2 + 3*34 = 104.
    expect(chunk.data[104]).toBe(400n);
    expect(chunk.data[2]).toBe(100n);
    expect(chunk.data[3 * 4]).toBe(200n);
    expect(chunk.data[3 * 5 * 6]).toBe(300n);
  });
});

describe("LocalPatchSource", () => {
  it("creates chunks lazily", () => {
    const source = new LocalPatchSource();
    try {
      expect(source.getChunk([0, 0, 0])).toBeUndefined();
      expect(source.chunks.size).toBe(0);

      const chunk = source.getOrCreateChunk([1, 2, 3], [4, 4, 4]);
      expect(chunk).toBeDefined();
      expect(source.chunks.size).toBe(1);
      expect(source.getChunk([1, 2, 3])).toBe(chunk);

      // Idempotent.
      const same = source.getOrCreateChunk([1, 2, 3], [4, 4, 4]);
      expect(same).toBe(chunk);
      expect(source.chunks.size).toBe(1);
    } finally {
      source.dispose();
    }
  });

  it("write/read voxels through the source helper", () => {
    const source = new LocalPatchSource();
    try {
      expect(source.writeVoxel([0, 0, 0], [4, 4, 4], 1, 1, 1, 42n)).toBe(true);
      expect(source.getVoxel([0, 0, 0], 1, 1, 1)).toBe(42n);
      // Different grid position is independent.
      expect(source.getVoxel([1, 0, 0], 1, 1, 1)).toBe(0n);
      expect(source.dirtyKeys.has("0,0,0")).toBe(true);
    } finally {
      source.dispose();
    }
  });

  it("clearAll wipes everything", () => {
    const source = new LocalPatchSource();
    try {
      source.writeVoxel([0, 0, 0], [4, 4, 4], 0, 0, 0, 1n);
      source.writeVoxel([5, 5, 5], [4, 4, 4], 0, 0, 0, 2n);
      expect(source.chunks.size).toBe(2);
      source.clearAll();
      expect(source.chunks.size).toBe(0);
      expect(source.dirtyKeys.size).toBe(0);
    } finally {
      source.dispose();
    }
  });

  it("consumeDirtyKeys returns then clears dirty state", () => {
    const source = new LocalPatchSource();
    try {
      source.writeVoxel([1, 0, 0], [4, 4, 4], 0, 0, 0, 10n);
      source.writeVoxel([0, 2, 0], [4, 4, 4], 0, 0, 0, 20n);
      const keys = Array.from(source.consumeDirtyKeys());
      expect(new Set(keys)).toEqual(new Set(["1,0,0", "0,2,0"]));
      expect(source.dirtyKeys.size).toBe(0);
    } finally {
      source.dispose();
    }
  });
});

describe("LocalPatchStore", () => {
  it("totals patched voxels across chunks", () => {
    const store = new LocalPatchStore();
    try {
      store.source.writeVoxel([0, 0, 0], [4, 4, 4], 0, 0, 0, 1n);
      store.source.writeVoxel([0, 0, 0], [4, 4, 4], 1, 0, 0, 2n);
      store.source.writeVoxel([1, 0, 0], [4, 4, 4], 0, 0, 0, 3n);
      expect(store.countPatchedVoxels()).toBe(3);
    } finally {
      store.dispose();
    }
  });

  it("flushImmediately fires `changed` synchronously and clears any debounce", () => {
    const store = new LocalPatchStore();
    try {
      let fires = 0;
      store.changed.add(() => fires++);
      store.scheduleGPUFlush(); // queues an rAF callback
      store.flushImmediately(); // cancels rAF and dispatches synchronously
      expect(fires).toBe(1);
    } finally {
      store.dispose();
    }
  });

  it("clearAll drops every patch and dispatches `changed`", () => {
    const store = new LocalPatchStore();
    try {
      let fires = 0;
      store.changed.add(() => fires++);
      store.source.writeVoxel([2, 2, 2], [4, 4, 4], 1, 1, 1, 99n);
      expect(store.countPatchedVoxels()).toBe(1);
      store.clearAll();
      expect(store.countPatchedVoxels()).toBe(0);
      expect(fires).toBe(1);
    } finally {
      store.dispose();
    }
  });
});
