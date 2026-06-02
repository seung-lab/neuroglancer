/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type {
  BrushApplyInput,
  BrushStrokeInput,
  ChunkCoord,
  ChunkId as ChunkIdType,
  ChunkVoxelBuffer,
  FillInput,
  LayerMetadata,
  PaintChunkWrite,
  PaintCompute,
  PaintWriteBatch,
  ReadonlyChunkVoxelBuffer,
  Resolution as ResolutionType,
  ScaleMetadata,
  VoxelDataType,
} from "@zettaai/edit-session";
import { ChunkId, scaleFor } from "@zettaai/edit-session";

import {
  applyMorphologyPipeline,
  type MaskBuffer,
} from "#src/editing/tool_runtimes/mask_compute.js";
import {
  imageChunksCovering,
  type VoxelTriple,
} from "#src/editing/tool_runtimes/mask_coord.js";

/**
 * Neuroglancer-side `PaintCompute` implementation. Computes per-chunk write
 * batches for brush stamps, interpolated brush strokes, and 3D flood-fills.
 * Pure main-thread compute — no worker offload in v1. Reads baseline (or
 * overlaid) chunk content via the `readChunk` callback the framework supplies
 * on every input; never touches `LocalPatchStore` directly (writes flow
 * through `PatchMirror` after the framework applies the returned batch).
 *
 * Clipping writes to the session bbox is NOT this compute's concern: the
 * library's paint write path clamps every voxel write to the session region
 * (`SessionVoxelBounds`), so a stroke crossing the bbox edge is trimmed by
 * the framework. This is why the compute is per-session state-free.
 */
export class PaintingCompute implements PaintCompute {
  async applyBrush(input: BrushApplyInput): Promise<PaintWriteBatch> {
    const builder = new PaintBatchBuilder(
      input.metadata,
      input.targetLayerId,
      input.targetResolution,
    );
    const maskCtx = resolveMaskContext(input);
    if (maskCtx === undefined) {
      stampDisk2D(builder, input.voxelPosition, input.radius, input.value);
    } else {
      await stampDisk2DMasked(
        builder,
        input.voxelPosition,
        input.radius,
        input.value,
        maskCtx,
      );
    }
    return builder.build();
  }

  async applyBrushStroke(input: BrushStrokeInput): Promise<PaintWriteBatch> {
    const builder = new PaintBatchBuilder(
      input.metadata,
      input.targetLayerId,
      input.targetResolution,
    );
    // Step size: caller may pass a coarse stepVoxels, but to avoid gaps the
    // stamp spacing must be no larger than the brush radius. We use the
    // smaller of the supplied step and max(1, radius / 2) — radius/2 is the
    // conventional dab-spacing for an opaque disk brush.
    const stepRequested = input.stepVoxels > 0 ? input.stepVoxels : 1;
    const safeStep = Math.max(
      1,
      Math.min(stepRequested, Math.max(1, Math.floor(input.radius / 2))),
    );
    const [x0, y0, z0] = input.from;
    const [x1, y1, z1] = input.to;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dz = z1 - z0;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const maskCtx = resolveMaskContext(input);
    const stamp = async (pos: readonly [number, number, number]) => {
      if (maskCtx === undefined) {
        stampDisk2D(builder, pos, input.radius, input.value);
      } else {
        await stampDisk2DMasked(builder, pos, input.radius, input.value, maskCtx);
      }
    };
    // Always stamp the endpoint; if the segment is short, that's the only stamp.
    if (dist <= safeStep) {
      await stamp(input.to);
      return builder.build();
    }
    const steps = Math.ceil(dist / safeStep);
    // Start at i = 1 so we don't re-stamp `from` — the previous brush call
    // already covered it.
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const px = x0 + dx * t;
      const py = y0 + dy * t;
      const pz = z0 + dz * t;
      await stamp([px, py, pz]);
    }
    return builder.build();
  }

  async fill3d(input: FillInput): Promise<PaintWriteBatch> {
    const scale = scaleFor(input.metadata, input.targetResolution);
    const chunkDataSize = scale.chunkDataSize;
    const builder = new PaintBatchBuilder(
      input.metadata,
      input.targetLayerId,
      input.targetResolution,
    );

    const seedX = Math.floor(input.seedVoxelPosition[0]);
    const seedY = Math.floor(input.seedVoxelPosition[1]);
    const seedZ = Math.floor(input.seedVoxelPosition[2]);

    const cap = Math.max(
      1,
      Math.min(input.maxVoxels ?? FILL_DEFAULT_MAX_VOXELS, FILL_HARD_CAP),
    );

    // Read the seed voxel's baseline value via the per-chunk reader. The
    // chunk reader caches reads inside the builder.
    const chunkReader = new ChunkReader(input.readChunk, chunkDataSize);
    const seedValue = await chunkReader.readVoxel(seedX, seedY, seedZ);
    if (seedValue === undefined) {
      return builder.build();
    }
    // If the seed already equals the target value, painting it would be a
    // no-op — short-circuit to avoid the BFS entirely.
    if (voxelEqualsTarget(seedValue, input.value)) {
      return builder.build();
    }

    // BFS with 6-connectivity. We use a string-keyed Set to mark visited
    // voxels — 3D flood fills cross chunk boundaries so per-chunk Uint8Array
    // visited bitmaps would blow up. A Map<string, true> is acceptable for
    // the v1 1M-voxel cap (~80 MB worst case; tightened by the cap below).
    const visited = new Set<string>();
    const queueX: number[] = [seedX];
    const queueY: number[] = [seedY];
    const queueZ: number[] = [seedZ];
    let head = 0;
    let voxelsWritten = 0;
    let truncated = false;

    while (head < queueX.length) {
      if (voxelsWritten >= cap) {
        truncated = true;
        break;
      }
      const x = queueX[head];
      const y = queueY[head];
      const z = queueZ[head];
      head++;
      const key = `${x},${y},${z}`;
      if (visited.has(key)) continue;
      visited.add(key);

      const value = await chunkReader.readVoxel(x, y, z);
      if (value === undefined) continue;
      if (!voxelEqualsTarget(value, seedValue)) continue;

      // Mark the voxel for write. The builder coalesces per-chunk writes.
      builder.writeVoxel(x, y, z, input.value);
      voxelsWritten++;

      // 6-neighbors.
      queueX.push(x + 1, x - 1, x, x, x, x);
      queueY.push(y, y, y + 1, y - 1, y, y);
      queueZ.push(z, z, z, z, z + 1, z - 1);
    }

    return builder.build(
      truncated ? { reason: "max-voxels", voxelsWritten } : undefined,
    );
  }
}

// ---------------------------------------------------------------------------
// Fill cap constants
// ---------------------------------------------------------------------------

/**
 * Default voxel cap when `FillInput.maxVoxels` is unspecified. Matches the v1
 * single-chunk fill cap (`1 << 20` voxels ≈ 1.05 M).
 */
const FILL_DEFAULT_MAX_VOXELS = 1 << 20;

/**
 * Absolute hard cap regardless of `FillInput.maxVoxels` — guards against
 * runaway fills if a caller passes an unreasonably large value. Set well
 * above `FILL_DEFAULT_MAX_VOXELS` to leave the per-call cap effective.
 */
const FILL_HARD_CAP = 1 << 24; // ~16.7 M voxels

// ---------------------------------------------------------------------------
// Disk stamp — 2D disk in the XY plane at fixed Z (matches v1 behavior).
// ---------------------------------------------------------------------------

function stampDisk2D(
  builder: PaintBatchBuilder,
  voxelPosition: readonly [number, number, number],
  radius: number,
  value: number | bigint,
): void {
  const r = Math.max(0, Math.floor(radius));
  const cx = Math.floor(voxelPosition[0]);
  const cy = Math.floor(voxelPosition[1]);
  const cz = Math.floor(voxelPosition[2]);
  const r2 = r * r;
  if (r === 0) {
    builder.writeVoxel(cx, cy, cz, value);
    return;
  }
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      builder.writeVoxel(cx + dx, cy + dy, cz, value);
    }
  }
}

// ---------------------------------------------------------------------------
// Mask-aware disk stamp
// ---------------------------------------------------------------------------

interface MaskContext {
  readonly mask: BrushApplyInput["mask"] & {};
  readonly maskMetadata: LayerMetadata;
  readonly targetVoxelSizeNm: VoxelTriple;
  readonly imageVoxelSizeNm: VoxelTriple;
  readonly imageScale: ScaleMetadata;
  readonly reader: MaskChunkReader;
}

function resolveMaskContext(
  input: BrushApplyInput | BrushStrokeInput,
): MaskContext | undefined {
  if (input.mask === undefined) return undefined;
  if (input.maskMetadata === undefined) {
    warnOncePerStroke(
      `advanced brush: image layer "${input.mask.imageLayerId}" is not in the session ` +
        `metadata; falling back to unmasked stroke.`,
    );
    return undefined;
  }
  // uint64 images can't be thresholded against a number band; the UI
  // disables this case but compute defends in depth.
  if (input.maskMetadata.voxelDataType === "uint64") {
    warnOncePerStroke(
      `advanced brush: image layer "${input.mask.imageLayerId}" has voxelDataType "uint64" ` +
        `which is not supported for thresholding; falling back to unmasked stroke.`,
    );
    return undefined;
  }
  let imageScale: ScaleMetadata;
  try {
    imageScale = scaleFor(input.maskMetadata, input.mask.imageResolution);
  } catch {
    warnOncePerStroke(
      `advanced brush: image resolution "${input.mask.imageResolution}" is not available ` +
        `on layer "${input.mask.imageLayerId}"; falling back to unmasked stroke.`,
    );
    return undefined;
  }
  const targetScale = scaleFor(input.metadata, input.targetResolution);
  return {
    mask: input.mask,
    maskMetadata: input.maskMetadata,
    targetVoxelSizeNm: [
      targetScale.voxelSizeNm[0],
      targetScale.voxelSizeNm[1],
      targetScale.voxelSizeNm[2],
    ],
    imageVoxelSizeNm: [
      imageScale.voxelSizeNm[0],
      imageScale.voxelSizeNm[1],
      imageScale.voxelSizeNm[2],
    ],
    imageScale,
    reader: new MaskChunkReader(
      input.mask.imageLayerId,
      input.mask.imageResolution,
      input.readChunkAt,
      [
        imageScale.chunkDataSize[0],
        imageScale.chunkDataSize[1],
        imageScale.chunkDataSize[2],
      ],
    ),
  };
}

let lastWarning = "";
function warnOncePerStroke(message: string): void {
  if (lastWarning === message) return;
  lastWarning = message;
   
  console.warn(message);
}

/**
 * Reference-parity mask stamp.
 *
 * Mirrors the structure of `PythonPainter.apply_brush`:
 *
 * 1. Build the disk bbox in TARGET voxel coords.
 * 2. For every voxel in the bbox, look up the corresponding image voxel
 *    (nearest-neighbor via physical nm ratio) and combine `circle ∧ (img ∈ [low, high])`
 *    into a 2D mask the size of the disk bbox.
 * 3. Run binary closing and component-min-size filter on that 2D mask
 *    (using shape `[bbx, bby, 1]` so `binaryClose3D`/`filterComponentsByMinSize`
 *    degrade to 4-connected planar ops — matching scipy's default).
 * 4. Sample each disk voxel out of the processed mask and stamp.
 *
 * Differences from a literal port of the reference:
 *  - We read image chunks lazily through `ctx.reader.readChunk` instead of
 *    receiving a whole-session image buffer up front.
 *  - The reference operates on a buffer already sized to the bbox; we copy
 *    the image-voxel slab the bbox projects to into a small Float64Array
 *    once, then index it for every target voxel.
 *  - Morphology near the disk bbox boundary erodes (border=false), same as
 *    `scipy.ndimage.binary_closing` defaults.
 */
async function stampDisk2DMasked(
  builder: PaintBatchBuilder,
  voxelPosition: readonly [number, number, number],
  radius: number,
  value: number | bigint,
  ctx: MaskContext,
): Promise<void> {
  const r = Math.max(0, Math.floor(radius));
  const cx = Math.floor(voxelPosition[0]);
  const cy = Math.floor(voxelPosition[1]);
  const cz = Math.floor(voxelPosition[2]);
  const r2 = r * r;

  // Disk bbox in target voxel coords (closed-open).
  const loTx = cx - r;
  const loTy = cy - r;
  const tShapeX = 2 * r + 1;
  const tShapeY = 2 * r + 1;

  // Per-target-voxel image coord mapping. Uses physical nm ratio so any
  // anisotropic ratio works (matches reference's `scale = image_size/target_size`
  // when both buffers cover the same physical extent).
  const sxRatio = ctx.targetVoxelSizeNm[0] / ctx.imageVoxelSizeNm[0];
  const syRatio = ctx.targetVoxelSizeNm[1] / ctx.imageVoxelSizeNm[1];
  const szRatio = ctx.targetVoxelSizeNm[2] / ctx.imageVoxelSizeNm[2];
  const imageZ = Math.floor(cz * szRatio);
  const imgX = new Int32Array(tShapeX);
  const imgY = new Int32Array(tShapeY);
  let minIx = Number.POSITIVE_INFINITY;
  let maxIx = Number.NEGATIVE_INFINITY;
  let minIy = Number.POSITIVE_INFINITY;
  let maxIy = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < tShapeX; i++) {
    const ix = Math.floor((loTx + i) * sxRatio);
    imgX[i] = ix;
    if (ix < minIx) minIx = ix;
    if (ix > maxIx) maxIx = ix;
  }
  for (let j = 0; j < tShapeY; j++) {
    const iy = Math.floor((loTy + j) * syRatio);
    imgY[j] = iy;
    if (iy < minIy) minIy = iy;
    if (iy > maxIy) maxIy = iy;
  }

  // Image-voxel region we need (single z-slice).
  const loImage: VoxelTriple = [minIx, minIy, imageZ];
  const hiImage: VoxelTriple = [maxIx + 1, maxIy + 1, imageZ + 1];
  const iShapeX = hiImage[0] - loImage[0];
  const iShapeY = hiImage[1] - loImage[1];
  const imageValues = new Float64Array(iShapeX * iShapeY);

  const chunks = imageChunksCovering(loImage, hiImage, ctx.imageScale);
  const ics = ctx.imageScale.chunkDataSize;
  for (const coord of chunks) {
    const chunkBuf = await ctx.reader.readChunk(coord);
    if (chunkBuf === undefined) continue;
    const view = chunkBuf.asView();
    const cox = coord.x * ics[0];
    const coy = coord.y * ics[1];
    const coz = coord.z * ics[2];
    const x0 = Math.max(loImage[0], cox);
    const y0 = Math.max(loImage[1], coy);
    const z0 = Math.max(loImage[2], coz);
    const x1 = Math.min(hiImage[0], cox + ics[0]);
    const y1 = Math.min(hiImage[1], coy + ics[1]);
    const z1 = Math.min(hiImage[2], coz + ics[2]);
    for (let iz = z0; iz < z1; iz++) {
      const lz = iz - coz;
      for (let iy = y0; iy < y1; iy++) {
        const ly = iy - coy;
        for (let ix = x0; ix < x1; ix++) {
          const lx = ix - cox;
          const linearChunk = lx + ics[0] * (ly + ics[1] * lz);
          const raw =
            view instanceof BigUint64Array
              ? Number(view[linearChunk])
              : (view as Exclude<ChunkVoxelBuffer, BigUint64Array>)[
                  linearChunk
                ];
          // Single z-slice destination so dstZ = 0.
          imageValues[ix - loImage[0] + iShapeX * (iy - loImage[1])] = raw;
        }
      }
    }
  }

  // Build the 2D target-space mask: gate by circle ∧ threshold-band.
  const tMaskShape: VoxelTriple = [tShapeX, tShapeY, 1];
  const tMaskData = new Uint8Array(tShapeX * tShapeY);
  const low = ctx.mask.thresholdLow;
  const high = ctx.mask.thresholdHigh;
  if (r === 0) {
    const v = imageValues[imgX[0] - loImage[0] + iShapeX * (imgY[0] - loImage[1])];
    if (v >= low && v <= high) tMaskData[0] = 1;
  } else {
    for (let j = 0; j < tShapeY; j++) {
      const dy = j - r;
      const iyLocal = imgY[j] - loImage[1];
      for (let i = 0; i < tShapeX; i++) {
        const dx = i - r;
        if (dx * dx + dy * dy > r2) continue;
        const ixLocal = imgX[i] - loImage[0];
        const v = imageValues[ixLocal + iShapeX * iyLocal];
        if (v >= low && v <= high) tMaskData[i + tShapeX * j] = 1;
      }
    }
  }

  // Apply binary closing + component filter in TARGET voxel space.
  // Shape `[tShapeX, tShapeY, 1]` makes the 3D helpers degrade to
  // 4-connected planar ops — same as scipy's default in the reference.
  const processed: MaskBuffer = applyMorphologyPipeline({
    mask: { data: tMaskData, shape: tMaskShape },
    binaryClosing: ctx.mask.binaryClosing,
    minComponentSize: ctx.mask.minComponentSize,
    filterComponentsFirst: ctx.mask.filterComponentsFirst,
  });

  // Sample back: for each target voxel in the disk, the mask byte is its
  // entry in the processed buffer. The chunk builder records the disk's
  // bounding box as the subregion; the per-voxel mask drives gating.
  if (r === 0) {
    builder.writeVoxelMasked(cx, cy, cz, value, processed.data[0] === 1 ? 1 : 0);
    return;
  }
  for (let dy = -r; dy <= r; dy++) {
    const j = dy + r;
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const i = dx + r;
      const maskByte =
        processed.data[i + tShapeX * j] === 1 ? 1 : 0;
      builder.writeVoxelMasked(cx + dx, cy + dy, cz, value, maskByte);
    }
  }
}

class MaskChunkReader {
  private readonly cache = new Map<
    string,
    Promise<ReadonlyChunkVoxelBuffer> | ReadonlyChunkVoxelBuffer
  >();

  constructor(
    private readonly layerId: BrushApplyInput["targetLayerId"],
    private readonly resolution: ResolutionType,
    private readonly readChunkAt: BrushApplyInput["readChunkAt"],
    // chunkDataSize intentionally retained for parity with ChunkReader and
    // potential per-voxel access patterns later.
    private readonly chunkDataSize: readonly [number, number, number],
  ) {
    void this.chunkDataSize;
  }

  async readChunk(
    coord: ChunkCoord,
  ): Promise<ReadonlyChunkVoxelBuffer | undefined> {
    const key = `${coord.x},${coord.y},${coord.z}`;
    const entry = this.cache.get(key);
    if (entry === undefined) {
      const chunkId = ChunkId.fromCoord(coord);
      const promise = this.readChunkAt(this.layerId, this.resolution, chunkId);
      this.cache.set(key, promise);
      try {
        const resolved = await promise;
        this.cache.set(key, resolved);
        return resolved;
      } catch {
        this.cache.delete(key);
        return undefined;
      }
    }
    if (entry instanceof Promise) {
      try {
        const resolved = await entry;
        this.cache.set(key, resolved);
        return resolved;
      } catch {
        this.cache.delete(key);
        return undefined;
      }
    }
    return entry;
  }
}

// ---------------------------------------------------------------------------
// PaintBatchBuilder
// ---------------------------------------------------------------------------

/**
 * Accumulates per-voxel writes into per-chunk dense blocks. Each affected
 * chunk gets one `PaintChunkWrite` with a tight sub-region bounding box, a
 * dense `values` buffer (filled at written voxels, zero elsewhere), and a
 * matching `valueMask` (1 where written, 0 where not).
 */
interface PendingChunkWrite {
  readonly chunkCoord: ChunkCoord;
  readonly chunkId: ChunkIdType;
  // Voxel-space bbox (inclusive) of all written voxels for this chunk —
  // expressed in chunk-local coordinates.
  loX: number;
  loY: number;
  loZ: number;
  hiX: number;
  hiY: number;
  hiZ: number;
  // Linear list of writes (chunk-local coords). `maskByte` ends up in the
  // chunk's `valueMask`: 1 = paint, 0 = skip (library gates on this).
  voxels: Array<{
    x: number;
    y: number;
    z: number;
    value: number | bigint;
    maskByte: 0 | 1;
  }>;
}

class PaintBatchBuilder {
  private readonly chunks = new Map<string, PendingChunkWrite>();
  private readonly chunkDataSize: readonly [number, number, number];
  private readonly voxelDataType: VoxelDataType;

  constructor(
    metadata: LayerMetadata,
    private readonly targetLayerId: BrushApplyInput["targetLayerId"],
    private readonly targetResolution: ResolutionType,
  ) {
    const scale: ScaleMetadata = scaleFor(metadata, targetResolution);
    this.chunkDataSize = [
      scale.chunkDataSize[0],
      scale.chunkDataSize[1],
      scale.chunkDataSize[2],
    ];
    this.voxelDataType = metadata.voxelDataType;
  }

  /** Mark a single voxel for write. Coordinates are in resolution voxel space. */
  writeVoxel(vx: number, vy: number, vz: number, value: number | bigint): void {
    this.writeVoxelMasked(vx, vy, vz, value, 1);
  }

  /**
   * Mark a voxel with an explicit mask byte. `maskByte === 0` means the
   * library's paint write path will skip this voxel (gating via
   * `PaintChunkWrite.valueMask`). The voxel still contributes to the
   * chunk's subregion bounding box so the dense buffer covers a
   * contiguous stamp footprint.
   */
  writeVoxelMasked(
    vx: number,
    vy: number,
    vz: number,
    value: number | bigint,
    maskByte: 0 | 1,
  ): void {
    // Out-of-bbox voxels are NOT filtered here — the library's paint write
    // path clamps every write to the session region (`SessionVoxelBounds`).
    const sx = this.chunkDataSize[0];
    const sy = this.chunkDataSize[1];
    const sz = this.chunkDataSize[2];
    const gx = Math.floor(vx / sx);
    const gy = Math.floor(vy / sy);
    const gz = Math.floor(vz / sz);
    const lx = vx - gx * sx;
    const ly = vy - gy * sy;
    const lz = vz - gz * sz;
    const key = `${gx},${gy},${gz}`;
    let entry = this.chunks.get(key);
    if (entry === undefined) {
      entry = {
        chunkCoord: { x: gx, y: gy, z: gz },
        chunkId: ChunkId.fromCoord({ x: gx, y: gy, z: gz }),
        loX: lx,
        loY: ly,
        loZ: lz,
        hiX: lx,
        hiY: ly,
        hiZ: lz,
        voxels: [],
      };
      this.chunks.set(key, entry);
    } else {
      if (lx < entry.loX) entry.loX = lx;
      if (ly < entry.loY) entry.loY = ly;
      if (lz < entry.loZ) entry.loZ = lz;
      if (lx > entry.hiX) entry.hiX = lx;
      if (ly > entry.hiY) entry.hiY = ly;
      if (lz > entry.hiZ) entry.hiZ = lz;
    }
    entry.voxels.push({ x: lx, y: ly, z: lz, value, maskByte });
  }

  build(truncated?: PaintWriteBatch["truncated"]): PaintWriteBatch {
    const writes: PaintChunkWrite[] = [];
    for (const entry of this.chunks.values()) {
      const sx = entry.hiX - entry.loX + 1;
      const sy = entry.hiY - entry.loY + 1;
      const sz = entry.hiZ - entry.loZ + 1;
      const voxelCount = sx * sy * sz;
      const values = allocateVoxelBuffer(this.voxelDataType, voxelCount);
      const valueMask = new Uint8Array(voxelCount);
      for (const w of entry.voxels) {
        const rx = w.x - entry.loX;
        const ry = w.y - entry.loY;
        const rz = w.z - entry.loZ;
        const linear = rx + sx * (ry + sy * rz);
        writeIntoBuffer(values, this.voxelDataType, linear, w.value);
        // Later writes to the same voxel may toggle the mask byte; OR
        // semantics keep a `1` once any caller has set it (matches the
        // disk-stamp behavior where overlapping stamps within a stroke
        // should produce a single painted voxel).
        if (w.maskByte === 1) {
          valueMask[linear] = 1;
        }
      }
      writes.push({
        chunkId: entry.chunkId,
        chunkCoord: entry.chunkCoord,
        subregion: {
          origin: [entry.loX, entry.loY, entry.loZ],
          size: [sx, sy, sz],
        },
        values,
        valueMask,
      });
    }
    const batch: PaintWriteBatch = {
      targetLayerId: this.targetLayerId,
      targetResolution: this.targetResolution,
      chunks: writes,
      ...(truncated !== undefined ? { truncated } : {}),
    };
    return batch;
  }
}

// ---------------------------------------------------------------------------
// Voxel-buffer allocation / write helpers
// ---------------------------------------------------------------------------

function allocateVoxelBuffer(
  type: VoxelDataType,
  voxelCount: number,
): ChunkVoxelBuffer {
  switch (type) {
    case "uint8":
      return new Uint8Array(voxelCount);
    case "int8":
      return new Int8Array(voxelCount);
    case "uint16":
      return new Uint16Array(voxelCount);
    case "int16":
      return new Int16Array(voxelCount);
    case "uint32":
      return new Uint32Array(voxelCount);
    case "int32":
      return new Int32Array(voxelCount);
    case "float32":
      return new Float32Array(voxelCount);
    case "uint64":
      return new BigUint64Array(voxelCount);
    default: {
      const exhaustive: never = type;
      throw new Error(`Unknown voxelDataType: ${String(exhaustive)}`);
    }
  }
}

function writeIntoBuffer(
  buffer: ChunkVoxelBuffer,
  type: VoxelDataType,
  index: number,
  value: number | bigint,
): void {
  if (type === "uint64") {
    const b = buffer as BigUint64Array;
    b[index] = typeof value === "bigint" ? value : BigInt(value);
    return;
  }
  const numericValue = typeof value === "bigint" ? Number(value) : value;
  (buffer as Exclude<ChunkVoxelBuffer, BigUint64Array>)[index] = numericValue;
}

function voxelEqualsTarget(a: number | bigint, b: number | bigint): boolean {
  if (typeof a === "bigint" && typeof b === "bigint") return a === b;
  if (typeof a === "number" && typeof b === "number") return a === b;
  // Mixed types: coerce via Number for comparison. bigint comparisons that
  // overflow a JS Number degrade gracefully (segmentation IDs > 2^53 would
  // collide), but the surrounding StrokeTool / FillTool flows only pass
  // homogeneous types in practice.
  const an = typeof a === "bigint" ? Number(a) : a;
  const bn = typeof b === "bigint" ? Number(b) : b;
  return an === bn;
}

// ---------------------------------------------------------------------------
// ChunkReader — caches `readChunk(chunkId)` results per-chunk.
// ---------------------------------------------------------------------------

/**
 * Caches the result of `readChunk(chunkId)` so a BFS that revisits a chunk
 * does not re-fetch. Buffer reads are returned as typed-array views.
 */
class ChunkReader {
  private readonly cache = new Map<
    string,
    Promise<ReadonlyChunkVoxelBuffer> | ReadonlyChunkVoxelBuffer
  >();

  constructor(
    private readonly readChunk: (
      chunkId: ChunkIdType,
    ) => Promise<ReadonlyChunkVoxelBuffer>,
    private readonly chunkDataSize: readonly [number, number, number],
  ) {}

  async readVoxel(
    vx: number,
    vy: number,
    vz: number,
  ): Promise<number | bigint | undefined> {
    const sx = this.chunkDataSize[0];
    const sy = this.chunkDataSize[1];
    const sz = this.chunkDataSize[2];
    const gx = Math.floor(vx / sx);
    const gy = Math.floor(vy / sy);
    const gz = Math.floor(vz / sz);
    const lx = vx - gx * sx;
    const ly = vy - gy * sy;
    const lz = vz - gz * sz;
    if (lx < 0 || ly < 0 || lz < 0) return undefined;
    if (lx >= sx || ly >= sy || lz >= sz) return undefined;
    const key = `${gx},${gy},${gz}`;
    let entry = this.cache.get(key);
    if (entry === undefined) {
      const chunkId = ChunkId.fromCoord({ x: gx, y: gy, z: gz });
      const promise = this.readChunk(chunkId);
      this.cache.set(key, promise);
      try {
        const resolved = await promise;
        this.cache.set(key, resolved);
        entry = resolved;
      } catch {
        this.cache.delete(key);
        return undefined;
      }
    } else if (entry instanceof Promise) {
      try {
        entry = await entry;
        this.cache.set(key, entry);
      } catch {
        this.cache.delete(key);
        return undefined;
      }
    }
    const view = (entry as ReadonlyChunkVoxelBuffer).asView();
    const linear = lx + sx * (ly + sy * lz);
    if (view instanceof BigUint64Array) return view[linear];
    return view[linear];
  }
}
