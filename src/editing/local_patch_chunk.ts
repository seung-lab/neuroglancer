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

/** Chunk-local inclusive voxel box, used to bound partial GPU uploads. */
export interface ChunkVoxelBox {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

/**
 * GPU upload obligation for a chunk. `box === null` means the WHOLE chunk
 * must be (re)uploaded; otherwise only `box` is stale. `valueDone` /
 * `maskDone` track which of the two textures (RG32UI value, R8UI mask) has
 * already consumed this obligation — the box is released only when both
 * have, so the visible mask and value always reflect the same snapshot.
 */
export interface PendingUpload {
  box: ChunkVoxelBox | null;
  valueDone: boolean;
  maskDone: boolean;
}

export class LocalPatchChunk {
  data: BigUint64Array;
  /**
   * Per-voxel patched mask. `0` = "no patch — render baseline through";
   * `1` = "user wrote this voxel (any value, including 0n)". Length matches
   * `data.length`.
   */
  patched: Uint8Array;
  dirty = true;
  /**
   * Outstanding GPU upload, or `null` when the textures are current.
   * `PatchTextureCache` consumes this instead of re-uploading every chunk on
   * a global generation bump: untouched chunks skip upload entirely, and
   * touched chunks upload only their stale sub-box via `texSubImage3D`.
   */
  pendingUpload: PendingUpload | null = {
    box: null,
    valueDone: false,
    maskDone: false,
  };

  constructor(public readonly chunkDataSize: vec3) {
    const volume = chunkDataSize[0] * chunkDataSize[1] * chunkDataSize[2];
    this.data = new BigUint64Array(volume);
    this.patched = new Uint8Array(volume);
  }

  /** Require a full re-upload of both textures (e.g. whole-chunk replace). */
  markFullUpload(): void {
    this.pendingUpload = { box: null, valueDone: false, maskDone: false };
  }

  /**
   * Union `box` into the outstanding upload obligation. Any new write
   * invalidates prior partial consumption, so both done-flags reset.
   */
  mergePendingUpload(box: ChunkVoxelBox): void {
    const pending = this.pendingUpload;
    if (pending === null) {
      this.pendingUpload = {
        box: { ...box },
        valueDone: false,
        maskDone: false,
      };
      return;
    }
    pending.valueDone = false;
    pending.maskDone = false;
    if (pending.box === null) return; // already full — stays full
    const b = pending.box;
    if (box.x0 < b.x0) b.x0 = box.x0;
    if (box.y0 < b.y0) b.y0 = box.y0;
    if (box.z0 < b.z0) b.z0 = box.z0;
    if (box.x1 > b.x1) b.x1 = box.x1;
    if (box.y1 > b.y1) b.y1 = box.y1;
    if (box.z1 > b.z1) b.z1 = box.z1;
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
    this.mergePendingUpload({ x0: x, y0: y, z0: z, x1: x, y1: y, z1: z });
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
