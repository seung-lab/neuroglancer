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

import { applyMorphologyPipeline } from "#src/editing/tool_runtimes/mask_compute.js";
import {
  imageChunksCovering,
  type VoxelTriple,
} from "#src/editing/tool_runtimes/mask_coord.js";
import type { MorphologyClient } from "#src/editing/tool_runtimes/morphology_client.js";
import type { MorphologyRequest } from "#src/editing/tool_runtimes/morphology_request.js";
import { paintProfiler } from "#src/editing/tool_runtimes/paint_profiler.js";

/**
 * Runs the post-threshold morphology pipeline (binary closing + component
 * filter) and returns the processed 1/0 mask data. Injected into
 * `stampDisk2DMasked` so the stamp logic is agnostic to whether morphology
 * runs in the pyodide worker (`PaintingCompute.runMorphology`) or, in tests,
 * synchronously in TS.
 */
type RunMorphology = (req: MorphologyRequest) => Promise<Uint8Array>;

/**
 * Attach the current brush params to the paint profiler so each stroke summary
 * is self-describing (size, mask band, morphology, dtypes, code path). No-op
 * unless profiling is enabled.
 */
function recordPaintContext(
  radius: number,
  maskCtx: MaskContext | undefined,
  path: string,
  targetDataType: VoxelDataType,
): void {
  if (!paintProfiler.enabled) return;
  const r = Math.max(0, Math.floor(radius));
  const ctx: Record<string, string | number | boolean> = {
    brush: 2 * r + 1,
    r,
    mask: maskCtx === undefined ? "off" : "on",
    path,
    target: targetDataType,
  };
  if (maskCtx !== undefined) {
    ctx.band = `${maskCtx.mask.thresholdLow}..${maskCtx.mask.thresholdHigh}`;
    ctx.closing = maskCtx.mask.binaryClosing;
    ctx.minSize = maskCtx.mask.minComponentSize;
    ctx.fcf = maskCtx.mask.filterComponentsFirst;
    ctx.image = maskCtx.maskMetadata.voxelDataType;
  }
  paintProfiler.setContext(ctx);
}

/**
 * Tool id of the eraser leaf in the library's `painting` composite tool. The
 * eraser shares `PaintingSharedState` (including `mask`) with the brush, so the
 * compute keys off the active tool id to suppress masking for erase strokes.
 */
const TOOL_ID_ERASE = "painting.erase";

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
  /**
   * @param getActiveToolId Returns the id of the currently-active painting
   *   tool (e.g. `"painting.brush"` / `"painting.erase"`), or `undefined` when
   *   none is active.
   *
   *   This exists to keep the eraser's masking behavior explicit (TM-297). The
   *   library shares a single `PaintingSharedState.mask` across the brush and
   *   erase `StrokeTool`s and feeds it to BOTH through `BrushApplyInput.mask`.
   *   Only the brush exposes mask settings, but without this guard the eraser
   *   silently inherits the brush's hidden threshold band and fails to remove
   *   labels the user can plainly see. The eraser must never follow the brush's
   *   mask, so we drop it whenever the eraser is the active tool. Defaults to
   *   "no active tool" → mask honored, leaving brush/fill behavior unchanged.
   */
  /**
   * @param getActiveToolId See the note above.
   * @param morphology Optional pyodide morphology worker (TM-304). When
   *   provided, the masked brush offloads `binary_closing` + component
   *   filtering to scipy in the worker; on any worker failure it falls back to
   *   the in-process TS `applyMorphologyPipeline`. When omitted (e.g. unit
   *   tests), morphology always runs in TS, preserving prior behavior.
   */
  constructor(
    private readonly getActiveToolId: () => string | undefined = () =>
      undefined,
    private readonly morphology?: MorphologyClient,
  ) {}

  /**
   * Image-chunk cache shared across this compute's strokes (P2, TM-304). The
   * image layer is read-only during a paint session, so caching decoded chunks
   * avoids re-reading the same EM data on every overlapping stroke segment.
   */
  private readonly imageChunkCache = new ImageChunkCache();

  /** Guards the fallback warning so it logs once per instance, not per dab. */
  private fallbackWarned = false;

  /**
   * Pyodide-first morphology with a TS fallback. The fallback guarantees a
   * masked stroke never hard-breaks if the worker fails to boot or a call
   * errors — painting degrades to the in-process pipeline instead. Whenever the
   * fallback is taken because the worker failed (as opposed to no worker being
   * configured at all, e.g. in tests), a single console warning is emitted so
   * it is obvious the scipy path is NOT in use.
   */
  private runMorphology = async (
    req: MorphologyRequest,
  ): Promise<Uint8Array> => {
    if (this.morphology !== undefined) {
      try {
        return await this.morphology.apply(req);
      } catch (e) {
        if (!this.fallbackWarned) {
          this.fallbackWarned = true;
          console.warn(
            "[painting] pyodide morphology worker unavailable — falling back to " +
              "the TypeScript morphology pipeline on the main thread. Brush " +
              "results stay correct, but are NOT computed via scipy/pyodide. " +
              "First failure:",
            e,
          );
        }
      }
    }
    return applyMorphologyPipeline({
      mask: { data: req.mask, shape: req.shape },
      binaryClosing: req.binaryClosing,
      minComponentSize: req.minComponentSize,
      filterComponentsFirst: req.filterComponentsFirst,
    }).data;
  };

  /**
   * The eraser deliberately ignores the brush's image mask (TM-297): its
   * behavior must be predictable and not gated by another tool's hidden state.
   * Brush strokes honor the mask normally.
   */
  private maskEnabledForActiveTool(): boolean {
    return this.getActiveToolId() !== TOOL_ID_ERASE;
  }

  async applyBrush(input: BrushApplyInput): Promise<PaintWriteBatch> {
    const builder = new PaintBatchBuilder(
      input.metadata,
      input.targetLayerId,
      input.targetResolution,
    );
    const maskCtx = this.maskEnabledForActiveTool()
      ? resolveMaskContext(input, this.imageChunkCache)
      : undefined;
    recordPaintContext(
      input.radius,
      maskCtx,
      "click",
      input.metadata.voxelDataType,
    );
    // A single click is a degenerate (from === to) capsule, so route it through
    // the capsule stamps to get the fast slice write path (TM-304).
    const pos = input.voxelPosition;
    if (maskCtx === undefined) {
      stampCapsule2D(builder, pos, pos, input.radius, input.value);
    } else {
      await stampCapsule2DMasked(
        builder,
        pos,
        pos,
        input.radius,
        input.value,
        maskCtx,
        this.runMorphology,
      );
    }
    return paintProfiler.time("3.build(cpu)", () => builder.build());
  }

  async applyBrushStroke(input: BrushStrokeInput): Promise<PaintWriteBatch> {
    const t0 = paintProfiler.enabled ? performance.now() : 0;
    try {
      return await this.applyBrushStrokeInner(input);
    } finally {
      if (paintProfiler.enabled) {
        paintProfiler.record("0.stroke(total)", performance.now() - t0);
      }
    }
  }

  private async applyBrushStrokeInner(
    input: BrushStrokeInput,
  ): Promise<PaintWriteBatch> {
    const builder = new PaintBatchBuilder(
      input.metadata,
      input.targetLayerId,
      input.targetResolution,
    );
    const maskCtx = this.maskEnabledForActiveTool()
      ? resolveMaskContext(input, this.imageChunkCache)
      : undefined;
    const r = Math.max(0, Math.floor(input.radius));
    const sameZ = Math.floor(input.from[2]) === Math.floor(input.to[2]);
    recordPaintContext(
      input.radius,
      maskCtx,
      r >= 1 && sameZ ? "capsule" : sameZ ? "fallback(r0)" : "fallback(zvary)",
      input.metadata.voxelDataType,
    );

    // Fast path: when the segment stays on one z-slice and the brush has a real
    // radius, rasterize its swept area as a single capsule (stadium) instead of
    // many overlapping dabs. Each voxel — and the morphology over the whole
    // capsule — is computed exactly once, eliminating per-dab overlap recompute
    // and collapsing N morphology round-trips into one (TM-304).
    if (r >= 1 && sameZ) {
      if (maskCtx === undefined) {
        stampCapsule2D(builder, input.from, input.to, input.radius, input.value);
      } else {
        await stampCapsule2DMasked(
          builder,
          input.from,
          input.to,
          input.radius,
          input.value,
          maskCtx,
          this.runMorphology,
        );
      }
      return paintProfiler.time("3.build(cpu)", () => builder.build());
    }

    // Fallback: interpolate dabs along the segment. Used for a 1-voxel brush
    // (r === 0) and z-varying segments (the swept volume is a 3D capsule we
    // don't rasterize directly). Spacing = radius/2 for gap-free coverage.
    const safeStep = Math.max(1, Math.floor(input.radius / 2));
    const [x0, y0, z0] = input.from;
    const [x1, y1, z1] = input.to;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dz = z1 - z0;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const stamp = async (pos: readonly [number, number, number]) => {
      if (maskCtx === undefined) {
        stampDisk2D(builder, pos, input.radius, input.value);
      } else {
        await stampDisk2DMasked(
          builder,
          pos,
          input.radius,
          input.value,
          maskCtx,
          this.runMorphology,
        );
      }
    };
    // Always stamp the endpoint; if the segment is short, that's the only stamp.
    if (dist <= safeStep) {
      await stamp(input.to);
      return paintProfiler.time("3.build(cpu)", () => builder.build());
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
    return paintProfiler.time("3.build(cpu)", () => builder.build());
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
  // No slice mode here: stampDisk2D is used by the per-dab fallback (many
  // stamps per builder), which must accumulate on the legacy path.
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

/**
 * Squared distance from point `(px, py)` to the segment `a→b`, with the
 * projection parameter clamped to `[0, 1]` so the ends round off into caps.
 * For a degenerate segment (`a === b`) this is the squared distance to the
 * point — i.e. the footprint becomes a plain disk. This is the shape test that
 * turns a brush stroke into a single "capsule" (stadium) instead of many
 * overlapping dabs.
 */
function segmentDistanceSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  let t = len2 > 0 ? ((px - ax) * abx + (py - ay) * aby) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const dx = px - (ax + t * abx);
  const dy = py - (ay + t * aby);
  return dx * dx + dy * dy;
}

/**
 * Unmasked swept-stroke stamp: rasterize the capsule (all voxels within
 * `radius` of the segment `from→to`) on a single z-slice, writing each voxel
 * exactly once. Replaces stamping many overlapping disks along the segment, so
 * overlap voxels aren't written repeatedly. Caller guarantees `from`/`to` share
 * a z-slice.
 */
function stampCapsule2D(
  builder: PaintBatchBuilder,
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  radius: number,
  value: number | bigint,
): void {
  const r = Math.max(0, Math.floor(radius));
  const r2 = r * r;
  const ax = from[0];
  const ay = from[1];
  const bx = to[0];
  const by = to[1];
  const cz = Math.floor(from[2]);
  const loTx = Math.floor(Math.min(ax, bx)) - r;
  const loTy = Math.floor(Math.min(ay, by)) - r;
  const hiTx = Math.ceil(Math.max(ax, bx)) + r;
  const hiTy = Math.ceil(Math.max(ay, by)) + r;
  builder.beginSliceStamp(loTx, loTy, hiTx, hiTy, cz);
  for (let vy = loTy; vy <= hiTy; vy++) {
    for (let vx = loTx; vx <= hiTx; vx++) {
      if (segmentDistanceSq(vx, vy, ax, ay, bx, by) <= r2) {
        builder.writeVoxel(vx, vy, cz, value);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Mask-aware stamp (single disk or swept capsule, sharing one core)
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
  imageChunkCache: ImageChunkCache,
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
      imageChunkCache,
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
/**
 * Shared masked-stamp core for a single z-slice. Rasterizes an arbitrary 2D
 * brush footprint (the `inShape` predicate, in absolute target voxel coords)
 * over the bbox `[loTx, loTx+tShapeX) × [loTy, loTy+tShapeY)`:
 *
 *  1. project each target voxel to its image voxel (nm ratio → anisotropy),
 *  2. assemble the EM slab once,
 *  3. gate by `inShape ∧ threshold-band` into a dense mask,
 *  4. run morphology ONCE over the whole footprint (or skip if it's a no-op),
 *  5. stamp each in-shape voxel with its processed mask byte.
 *
 * Both the single-disk stamp and the swept-capsule stamp delegate here. Because
 * the capsule covers the whole stroke segment in one footprint, overlap voxels
 * are thresholded, morphology'd, and written exactly once — not once per dab.
 */
async function stampShape2DMasked(
  builder: PaintBatchBuilder,
  loTx: number,
  loTy: number,
  tShapeX: number,
  tShapeY: number,
  cz: number,
  value: number | bigint,
  ctx: MaskContext,
  runMorphology: RunMorphology,
  inShape: (vx: number, vy: number) => boolean,
  // Slice-stamp fast write path. Only safe when this is the SOLE stamp for the
  // builder (single click / one capsule); the per-dab fallback writes many
  // stamps into one builder and must stay on the legacy accumulating path.
  useSlice: boolean,
): Promise<void> {
  if (tShapeX <= 0 || tShapeY <= 0) return;
  if (useSlice) {
    builder.beginSliceStamp(loTx, loTy, loTx + tShapeX - 1, loTy + tShapeY - 1, cz);
  }

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
  const prof = paintProfiler.enabled;
  let readMs = 0;
  let copyMs = 0;
  for (const coord of chunks) {
    let t = prof ? performance.now() : 0;
    const chunkBuf = await ctx.reader.readChunk(coord);
    if (prof) readMs += performance.now() - t;
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
    if (prof) t = performance.now();
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
    if (prof) copyMs += performance.now() - t;
  }
  if (prof) {
    paintProfiler.record("1a.chunkRead(io)", readMs);
    paintProfiler.record("1b.slabCopy(cpu)", copyMs);
  }

  // Build the 2D target-space mask: gate by footprint ∧ threshold-band.
  const tMaskShape: VoxelTriple = [tShapeX, tShapeY, 1];
  const tMaskData = new Uint8Array(tShapeX * tShapeY);
  const low = ctx.mask.thresholdLow;
  const high = ctx.mask.thresholdHigh;
  const tMask = prof ? performance.now() : 0;
  for (let j = 0; j < tShapeY; j++) {
    const vy = loTy + j;
    const iyLocal = imgY[j] - loImage[1];
    for (let i = 0; i < tShapeX; i++) {
      if (!inShape(loTx + i, vy)) continue;
      const ixLocal = imgX[i] - loImage[0];
      const v = imageValues[ixLocal + iShapeX * iyLocal];
      if (v >= low && v <= high) tMaskData[i + tShapeX * j] = 1;
    }
  }
  if (prof) paintProfiler.record("2a.maskBuild(cpu)", performance.now() - tMask);

  // Apply binary closing + component filter in TARGET voxel space, via the
  // injected runner (pyodide worker in production, TS pipeline in tests/
  // fallback). Shape `[tShapeX, tShapeY, 1]` makes the morphology degrade to
  // 4-connected planar ops — same as scipy's default in the reference.
  //
  // Short-circuit when no morphology is requested (the default: closing 0,
  // minComponentSize 0). In that case the pipeline is an identity transform, so
  // calling the worker would round-trip to compute nothing — a pure latency hit
  // on the live-paint path. Skip it and stamp the raw threshold mask directly.
  const needsMorphology =
    ctx.mask.binaryClosing > 0 || ctx.mask.minComponentSize > 1;
  const processed: Uint8Array = needsMorphology
    ? await paintProfiler.timeAsync("2b.morphology(worker)", () =>
        runMorphology({
          mask: tMaskData,
          shape: tMaskShape,
          binaryClosing: ctx.mask.binaryClosing,
          minComponentSize: ctx.mask.minComponentSize,
          filterComponentsFirst: ctx.mask.filterComponentsFirst,
        }),
      )
    : tMaskData;

  // Sample back: each in-footprint voxel takes its mask byte from the processed
  // buffer. The chunk builder records the footprint's bounding box as the
  // subregion; the per-voxel mask drives gating.
  const tWrite = prof ? performance.now() : 0;
  let painted = 0;
  for (let j = 0; j < tShapeY; j++) {
    const vy = loTy + j;
    for (let i = 0; i < tShapeX; i++) {
      const vx = loTx + i;
      if (!inShape(vx, vy)) continue;
      const maskByte = processed[i + tShapeX * j] === 1 ? 1 : 0;
      if (maskByte === 1) painted++;
      builder.writeVoxelMasked(vx, vy, cz, value, maskByte);
    }
  }
  if (prof) {
    paintProfiler.record("2c.write(cpu)", performance.now() - tWrite);
    paintProfiler.count("voxels.footprintBbox", tShapeX * tShapeY);
    paintProfiler.count("voxels.painted", painted);
  }
}

/** Mask-aware single-disk stamp — a degenerate (point) capsule. */
function stampDisk2DMasked(
  builder: PaintBatchBuilder,
  voxelPosition: readonly [number, number, number],
  radius: number,
  value: number | bigint,
  ctx: MaskContext,
  runMorphology: RunMorphology,
): Promise<void> {
  const r = Math.max(0, Math.floor(radius));
  const cx = Math.floor(voxelPosition[0]);
  const cy = Math.floor(voxelPosition[1]);
  const cz = Math.floor(voxelPosition[2]);
  const r2 = r * r;
  return stampShape2DMasked(
    builder,
    cx - r,
    cy - r,
    2 * r + 1,
    2 * r + 1,
    cz,
    value,
    ctx,
    runMorphology,
    (vx, vy) => {
      const dx = vx - cx;
      const dy = vy - cy;
      return dx * dx + dy * dy <= r2;
    },
    // Disk masked stamp is used by the per-dab fallback (many stamps per
    // builder) → must accumulate on the legacy path, not slice mode.
    /* useSlice */ false,
  );
}

/**
 * Mask-aware swept-stroke stamp: one pass over the capsule (stadium) covering
 * the whole segment `from→to` on a single z-slice. Each voxel — and the
 * morphology over the whole capsule — is computed exactly once, replacing the
 * per-dab stamp loop (which recomputed overlap voxels and round-tripped to the
 * worker once per dab). Morphology now acts on the union shape rather than each
 * disk independently. Caller guarantees `from`/`to` share a z-slice.
 */
function stampCapsule2DMasked(
  builder: PaintBatchBuilder,
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  radius: number,
  value: number | bigint,
  ctx: MaskContext,
  runMorphology: RunMorphology,
): Promise<void> {
  const r = Math.max(0, Math.floor(radius));
  const r2 = r * r;
  const ax = from[0];
  const ay = from[1];
  const bx = to[0];
  const by = to[1];
  const cz = Math.floor(from[2]);
  const loTx = Math.floor(Math.min(ax, bx)) - r;
  const loTy = Math.floor(Math.min(ay, by)) - r;
  const hiTx = Math.ceil(Math.max(ax, bx)) + r;
  const hiTy = Math.ceil(Math.max(ay, by)) + r;
  return stampShape2DMasked(
    builder,
    loTx,
    loTy,
    hiTx - loTx + 1,
    hiTy - loTy + 1,
    cz,
    value,
    ctx,
    runMorphology,
    (vx, vy) => segmentDistanceSq(vx, vy, ax, ay, bx, by) <= r2,
    // Single capsule per builder → safe to use the fast slice write path.
    /* useSlice */ true,
  );
}

/**
 * Bounded image-chunk cache shared across all strokes of a `PaintingCompute`
 * (P2, TM-304). The image (mask source) layer is read-only for the lifetime of
 * a paint session, so decoded chunks can be cached indefinitely and reused
 * across stroke segments — eliminating the per-segment re-reads that dominated
 * the `chunkRead` await time. Keyed by `layerId | resolution | chunkCoord` so
 * different layers/resolutions never collide. Bounded by chunk count with
 * insertion-order (FIFO) eviction; entries are references to already-decoded
 * buffers, not copies.
 */
class ImageChunkCache {
  private readonly entries = new Map<
    string,
    Promise<ReadonlyChunkVoxelBuffer> | ReadonlyChunkVoxelBuffer
  >();

  constructor(private readonly capacity = 192) {}

  get(
    key: string,
  ): Promise<ReadonlyChunkVoxelBuffer> | ReadonlyChunkVoxelBuffer | undefined {
    return this.entries.get(key);
  }

  set(
    key: string,
    value: Promise<ReadonlyChunkVoxelBuffer> | ReadonlyChunkVoxelBuffer,
  ): void {
    this.entries.set(key, value);
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}

class MaskChunkReader {
  constructor(
    private readonly layerId: BrushApplyInput["targetLayerId"],
    private readonly resolution: ResolutionType,
    private readonly readChunkAt: BrushApplyInput["readChunkAt"],
    // chunkDataSize intentionally retained for parity with ChunkReader and
    // potential per-voxel access patterns later.
    private readonly chunkDataSize: readonly [number, number, number],
    private readonly cache: ImageChunkCache,
  ) {
    void this.chunkDataSize;
  }

  async readChunk(
    coord: ChunkCoord,
  ): Promise<ReadonlyChunkVoxelBuffer | undefined> {
    const key = `${this.layerId}|${this.resolution}|${coord.x},${coord.y},${coord.z}`;
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

/**
 * A single chunk's dense write block for slice-stamp mode (P1, TM-304). Sized
 * to `stampBbox ∩ chunk` for one z-layer, written into directly so a 2D stamp
 * avoids the per-voxel string key + `Map.get` + object allocation that
 * dominated the write cost at large brush sizes.
 */
interface SliceCell {
  readonly gx: number;
  readonly gy: number;
  readonly ox: number; // chunk-local x origin of the sub-bbox
  readonly oy: number; // chunk-local y origin of the sub-bbox
  readonly w: number;
  readonly h: number;
  readonly lz: number; // chunk-local z (single layer)
  // Global voxel ranges this cell covers — used by the 1-entry write cache.
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
  readonly values: ChunkVoxelBuffer;
  readonly valueMask: Uint8Array;
  touched: boolean;
}

class PaintBatchBuilder {
  private readonly chunks = new Map<string, PendingChunkWrite>();
  private readonly chunkDataSize: readonly [number, number, number];
  private readonly voxelDataType: VoxelDataType;

  // Slice-stamp mode state (P1). Active between `beginSliceStamp` and the next
  // `beginSliceStamp`/`build`. `fill3d` never enters slice mode (it stays on
  // the legacy per-voxel path), so its 3D, sparse writes are unaffected.
  private readonly sliceWrites: PaintChunkWrite[] = [];
  private sliceCells: (SliceCell | undefined)[] | undefined;
  private sliceGx0 = 0;
  private sliceGy0 = 0;
  private sliceGz = 0;
  private sliceNcols = 0;
  private sliceLz = 0;
  private sliceZGlobal = Number.NaN;
  private sliceLoTx = 0;
  private sliceLoTy = 0;
  private sliceHiTx = 0;
  private sliceHiTy = 0;
  private sliceCacheCell: SliceCell | undefined;

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

  /**
   * Enter slice-stamp mode for a single z-slice footprint bounded (inclusive)
   * by `[loTx, hiTx] × [loTy, hiTy]` at `z`. Pre-establishes a lazy per-chunk
   * dense grid so subsequent `writeVoxelMasked`/`writeVoxel` calls write
   * straight into dense buffers. Finalizes any previous slice first, so the
   * z-varying per-dab fallback can call this once per dab.
   */
  beginSliceStamp(
    loTx: number,
    loTy: number,
    hiTx: number,
    hiTy: number,
    z: number,
  ): void {
    this.finalizeSlice();
    const [sx, sy, sz] = this.chunkDataSize;
    this.sliceGx0 = Math.floor(loTx / sx);
    this.sliceGy0 = Math.floor(loTy / sy);
    this.sliceGz = Math.floor(z / sz);
    this.sliceLz = z - this.sliceGz * sz;
    this.sliceZGlobal = z;
    const gx1 = Math.floor(hiTx / sx);
    const gy1 = Math.floor(hiTy / sy);
    this.sliceNcols = gx1 - this.sliceGx0 + 1;
    const nrows = gy1 - this.sliceGy0 + 1;
    this.sliceCells = new Array<SliceCell | undefined>(
      this.sliceNcols * nrows,
    );
    this.sliceLoTx = loTx;
    this.sliceLoTy = loTy;
    this.sliceHiTx = hiTx;
    this.sliceHiTy = hiTy;
    this.sliceCacheCell = undefined;
  }

  private makeSliceCell(gx: number, gy: number): SliceCell {
    const [sx, sy] = this.chunkDataSize;
    const x0 = Math.max(this.sliceLoTx, gx * sx);
    const x1 = Math.min(this.sliceHiTx, (gx + 1) * sx - 1);
    const y0 = Math.max(this.sliceLoTy, gy * sy);
    const y1 = Math.min(this.sliceHiTy, (gy + 1) * sy - 1);
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    return {
      gx,
      gy,
      ox: x0 - gx * sx,
      oy: y0 - gy * sy,
      w,
      h,
      lz: this.sliceLz,
      x0,
      x1,
      y0,
      y1,
      values: allocateVoxelBuffer(this.voxelDataType, w * h),
      valueMask: new Uint8Array(w * h),
      touched: false,
    };
  }

  /** Flush the current slice's touched cells into `sliceWrites` and exit mode. */
  private finalizeSlice(): void {
    const cells = this.sliceCells;
    if (cells === undefined) return;
    for (const c of cells) {
      if (c === undefined || !c.touched) continue;
      this.sliceWrites.push({
        chunkId: ChunkId.fromCoord({ x: c.gx, y: c.gy, z: this.sliceGz }),
        chunkCoord: { x: c.gx, y: c.gy, z: this.sliceGz },
        subregion: { origin: [c.ox, c.oy, c.lz], size: [c.w, c.h, 1] },
        values: c.values,
        valueMask: c.valueMask,
      });
    }
    this.sliceCells = undefined;
    this.sliceCacheCell = undefined;
    this.sliceZGlobal = Number.NaN;
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
    // Slice-stamp fast path (P1): for a 2D single-z stamp, write straight into
    // the pre-sized dense per-chunk buffer. Skips masked-off voxels entirely
    // (the subregion is fixed to bbox∩chunk, so 0-bytes need not be recorded).
    // A 1-entry cell cache makes the common case (contiguous run along a row)
    // free of `Math.floor`/grid lookups.
    const cells = this.sliceCells;
    if (cells !== undefined && vz === this.sliceZGlobal) {
      if (maskByte === 0) return;
      let c = this.sliceCacheCell;
      if (
        c === undefined ||
        vx < c.x0 ||
        vx > c.x1 ||
        vy < c.y0 ||
        vy > c.y1
      ) {
        const [sx, sy] = this.chunkDataSize;
        const gx = Math.floor(vx / sx);
        const gy = Math.floor(vy / sy);
        const cgx = gx - this.sliceGx0;
        const cgy = gy - this.sliceGy0;
        if (
          cgx >= 0 &&
          cgy >= 0 &&
          cgx < this.sliceNcols &&
          vx >= this.sliceLoTx &&
          vx <= this.sliceHiTx &&
          vy >= this.sliceLoTy &&
          vy <= this.sliceHiTy
        ) {
          const gi = cgx + this.sliceNcols * cgy;
          c = cells[gi];
          if (c === undefined) {
            c = this.makeSliceCell(gx, gy);
            cells[gi] = c;
          }
          this.sliceCacheCell = c;
        } else {
          c = undefined; // out of slice bbox → fall through to legacy path
        }
      }
      if (c !== undefined) {
        // Dense index is relative to the cell's sub-bbox origin (x0, y0); ox/oy
        // are only the chunk-local origin recorded in the emitted subregion.
        const idx = vx - c.x0 + c.w * (vy - c.y0);
        writeIntoBuffer(c.values, this.voxelDataType, idx, value);
        c.valueMask[idx] = 1;
        c.touched = true;
        return;
      }
    }

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
    // Flush any in-progress slice stamp, then emit its dense chunks alongside
    // any legacy per-voxel chunks (e.g. from a z-varying fallback or fill3d).
    this.finalizeSlice();
    const writes: PaintChunkWrite[] = [...this.sliceWrites];
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
