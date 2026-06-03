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
 * @file In-memory patch chunk for voxel editing. Holds mutable BigUint64 voxel
 * data aligned to a single base chunk grid position. Phase 0: pure data; GPU
 * texture management lives on the patched render layer (Phase 1).
 *
 * A voxel is "patched" iff its entry in the parallel `patched: Uint8Array`
 * mask is non-zero. The patched bit is the sole source of truth for "the
 * user has explicitly written this voxel" — including erasing to 0. The
 * shader gates rendering on this bit, NOT on `data[i] !== 0n`, so that
 * erase-to-zero visually replaces the baseline segmentation instead of
 * silently falling through to it.
 */

import type { vec3 } from "#src/util/geom.js";

export class LocalPatchChunk {
  data: BigUint64Array;
  /**
   * Per-voxel patched mask. `0` = "no patch — render baseline through";
   * `1` = "user wrote this voxel (any value, including 0n)". Length matches
   * `data.length`.
   */
  patched: Uint8Array;
  dirty = true;

  constructor(public readonly chunkDataSize: vec3) {
    const volume = chunkDataSize[0] * chunkDataSize[1] * chunkDataSize[2];
    this.data = new BigUint64Array(volume);
    this.patched = new Uint8Array(volume);
  }

  private flatIndex(x: number, y: number, z: number): number {
    const [sx, sy] = this.chunkDataSize;
    return x + sx * (y + sy * z);
  }

  /**
   * Write a single voxel value and mark it patched. Returns true if either
   * the value OR the patched bit changed; marks the chunk dirty in that case.
   */
  writeVoxel(x: number, y: number, z: number, value: bigint): boolean {
    const idx = this.flatIndex(x, y, z);
    const valueChanged = this.data[idx] !== value;
    const patchedChanged = this.patched[idx] !== 1;
    if (!valueChanged && !patchedChanged) return false;
    this.data[idx] = value;
    this.patched[idx] = 1;
    this.dirty = true;
    return true;
  }

  /** Read a single voxel value. Note: 0n is also a valid patched value (erase). */
  getVoxel(x: number, y: number, z: number): bigint {
    return this.data[this.flatIndex(x, y, z)];
  }

  /** Returns true if this voxel has a patch applied (regardless of value). */
  hasPatchAt(x: number, y: number, z: number): boolean {
    return this.patched[this.flatIndex(x, y, z)] !== 0;
  }

  /** Total number of voxels in this chunk (chunk volume). */
  get volume(): number {
    return this.data.length;
  }

  /** Number of voxels with the patched bit set (any value, including 0n). */
  countPatchedVoxels(): number {
    let n = 0;
    for (let i = 0; i < this.patched.length; i++) {
      if (this.patched[i] !== 0) n++;
    }
    return n;
  }
}
