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
 * Pure read-back summarizer for the edit-paint harness (TM-331, phase 2).
 *
 * After a stroke, the painted voxels live in the target layer's
 * `LocalPatchStore` (`source.chunks`: a map of chunk-grid-key → patch chunk with
 * a `BigUint64Array data` + `Uint8Array patched` mask). This module turns that
 * map into a compact, DETERMINISTIC summary the Playwright spec can assert on:
 * a painted-voxel count, bounding box, distinct values, a small sample, and a
 * stable `signature` (FNV-1a over the sorted `x,y,z=value` set) for regression.
 *
 * Kept separate from `edit_paint_bench.ts` (which only runs in the COI browser)
 * so this logic is unit-testable under vitest with synthetic chunks.
 */

/** Minimal shape of a `LocalPatchChunk` this summarizer reads. */
export interface PatchChunkLike {
  /** `[cx, cy, cz]` voxel extent of the chunk. */
  readonly chunkDataSize: ArrayLike<number>;
  /** Per-voxel values (length `cx*cy*cz`). */
  readonly data: { readonly length: number; readonly [i: number]: bigint };
  /** Per-voxel patched mask (`!== 0` ⇒ painted). */
  readonly patched: ArrayLike<number>;
}

export interface PatchReadbackSummary {
  /** Total patched (painted or explicitly erased) voxels across all chunks. */
  readonly paintedVoxels: number;
  /** Number of chunks holding at least one patched voxel. */
  readonly chunkCount: number;
  /** Inclusive `lo`, exclusive `hi` global-voxel bounds, or null if empty. */
  readonly bbox: {
    readonly lo: readonly [number, number, number];
    readonly hi: readonly [number, number, number];
  } | null;
  /** Stable 8-hex-digit hash of the sorted painted `{coord, value}` set. */
  readonly signature: string;
  /** Distinct painted values (decimal strings; bigint isn't JSON-safe), sorted. */
  readonly distinctValues: readonly string[];
  /** First `sampleSize` painted voxels in sorted order (debug aid). */
  readonly sample: ReadonlyArray<{
    readonly g: readonly [number, number, number];
    readonly v: string;
  }>;
  /** True if `maxVoxels` capped the collected set (count/bbox stay exact). */
  readonly truncated: boolean;
}

export interface PatchReadbackOptions {
  /** Cap on voxels collected for the signature/sample (count + bbox stay exact). */
  readonly maxVoxels?: number;
  /** How many painted voxels to include in `sample`. Default 8. */
  readonly sampleSize?: number;
  /**
   * Added to every reconstructed coordinate. The patch store is keyed by
   * chunk-grid-relative positions (offset-relative), so pass the target layer's
   * scale `voxelOffset` to report ABSOLUTE global voxels — the same frame as the
   * edit region and the saved data. Default `[0,0,0]` (no shift).
   */
  readonly originOffset?: readonly [number, number, number];
}

function parseGridKey(key: string): [number, number, number] {
  const parts = key.split(",");
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

/**
 * Summarize the patched voxels across a `LocalPatchSource.chunks` map. `chunks`
 * yields `[gridKey, chunk]` where `gridKey` is the CSV of the chunk-grid
 * position (the `LocalPatchSource` key convention).
 */
export function summarizePatchedVoxels(
  chunks: Iterable<readonly [string, PatchChunkLike]>,
  options: PatchReadbackOptions = {},
): PatchReadbackSummary {
  const maxVoxels = options.maxVoxels ?? 500000;
  const sampleSize = options.sampleSize ?? 8;
  const [offX, offY, offZ] = options.originOffset ?? [0, 0, 0];

  let paintedVoxels = 0;
  let chunkCount = 0;
  let truncated = false;
  let lo: [number, number, number] | null = null;
  let hi: [number, number, number] | null = null;
  const collected: Array<[number, number, number, bigint]> = [];

  for (const [key, chunk] of chunks) {
    const cx = chunk.chunkDataSize[0];
    const cy = chunk.chunkDataSize[1];
    const cz = chunk.chunkDataSize[2];
    const [gx, gy, gz] = parseGridKey(key);
    const baseX = gx * cx;
    const baseY = gy * cy;
    const baseZ = gz * cz;
    let chunkHasPatch = false;

    for (let i = 0; i < chunk.patched.length; i++) {
      if (chunk.patched[i] === 0) continue;
      chunkHasPatch = true;
      paintedVoxels++;
      const lx = i % cx;
      const ly = Math.floor(i / cx) % cy;
      const lz = Math.floor(i / (cx * cy));
      const x = baseX + lx + offX;
      const y = baseY + ly + offY;
      const z = baseZ + lz + offZ;
      if (lo === null || hi === null) {
        lo = [x, y, z];
        hi = [x, y, z];
      } else {
        if (x < lo[0]) lo[0] = x;
        if (y < lo[1]) lo[1] = y;
        if (z < lo[2]) lo[2] = z;
        if (x > hi[0]) hi[0] = x;
        if (y > hi[1]) hi[1] = y;
        if (z > hi[2]) hi[2] = z;
      }
      if (collected.length < maxVoxels) {
        collected.push([x, y, z, chunk.data[i]]);
      } else {
        truncated = true;
      }
    }
    if (chunkHasPatch) chunkCount++;
  }

  // Sort z-major so the signature is independent of map iteration order.
  collected.sort((a, b) => a[2] - b[2] || a[1] - b[1] || a[0] - b[0]);

  let h = 0x811c9dc5 >>> 0; // FNV-1a (32-bit)
  const distinct = new Set<string>();
  const sample: Array<{ g: [number, number, number]; v: string }> = [];
  for (const [x, y, z, v] of collected) {
    const value = v.toString();
    distinct.add(value);
    const s = `${x},${y},${z}=${value};`;
    for (let k = 0; k < s.length; k++) {
      h ^= s.charCodeAt(k);
      h = Math.imul(h, 0x01000193);
    }
    if (sample.length < sampleSize) sample.push({ g: [x, y, z], v: value });
  }

  return {
    paintedVoxels,
    chunkCount,
    bbox:
      lo !== null && hi !== null
        ? { lo, hi: [hi[0] + 1, hi[1] + 1, hi[2] + 1] }
        : null,
    signature: (h >>> 0).toString(16).padStart(8, "0"),
    distinctValues: [...distinct].sort(),
    sample,
    truncated,
  };
}
