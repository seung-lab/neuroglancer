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
 * A value of 0n means "no patch" — the base chunk value is rendered. Any
 * non-zero value is the patch's supervoxel ID and overrides the base.
 */

import type { vec3 } from "#src/util/geom.js";

export class LocalPatchChunk {
  data: BigUint64Array;
  dirty = true;

  constructor(public readonly chunkDataSize: vec3) {
    const volume = chunkDataSize[0] * chunkDataSize[1] * chunkDataSize[2];
    this.data = new BigUint64Array(volume);
  }

  private flatIndex(x: number, y: number, z: number): number {
    const [sx, sy] = this.chunkDataSize;
    return x + sx * (y + sy * z);
  }

  /** Write a single voxel value. Marks the chunk dirty. */
  writeVoxel(x: number, y: number, z: number, value: bigint): boolean {
    const idx = this.flatIndex(x, y, z);
    if (this.data[idx] === value) return false;
    this.data[idx] = value;
    this.dirty = true;
    return true;
  }

  /** Read a single voxel value. 0n means "no patch at this voxel". */
  getVoxel(x: number, y: number, z: number): bigint {
    return this.data[this.flatIndex(x, y, z)];
  }

  /** Returns true if this voxel has a patch applied. */
  hasPatchAt(x: number, y: number, z: number): boolean {
    return this.data[this.flatIndex(x, y, z)] !== 0n;
  }

  /** Total number of voxels in this chunk (chunk volume). */
  get volume(): number {
    return this.data.length;
  }

  /** Number of voxels with a non-zero patch value. */
  countPatchedVoxels(): number {
    let n = 0;
    for (let i = 0; i < this.data.length; i++) {
      if (this.data[i] !== 0n) n++;
    }
    return n;
  }
}
