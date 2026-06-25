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
  ChunkCoord,
  ChunkId as ChunkIdType,
  ChunkVoxelBuffer,
  LayerMetadata,
  ReadonlyChunkVoxelBuffer,
  Resolution as ResolutionType,
  ScaleMetadata,
  VoxelDataType,
} from "@zettaai/edit-session";
import { ChunkId, scaleFor } from "@zettaai/edit-session";

import { applyMorphologyPipeline } from "#src/editing/tool_runtimes/mask_compute.js";
import {
  clampToVoxelDataType,
  imageChunksCovering,
  type VoxelTriple,
} from "#src/editing/tool_runtimes/mask_coord.js";
import type { MorphologyClient } from "#src/editing/tool_runtimes/morphology_client.js";
import type { MorphologyRequest } from "#src/editing/tool_runtimes/morphology_request.js";
import type {
  ImageSlab,
  PaintPipelineDataType,
  PaintPipelineRequest,
} from "#src/editing/tool_runtimes/paint_pipeline_request.js";
import { paintProfiler } from "#src/editing/tool_runtimes/paint_profiler.js";
import type {
  BrushApplyInput,
  BrushStrokeInput,
  FillInput,
  PaintChunkWrite,
  PaintCompute,
  PaintWriteBatch,
  StrokeFootprintMask,
} from "#src/editing/tool_runtimes/paint_types.js";
import { DEFAULT_COVERAGE_THRESHOLD } from "#src/editing/tool_runtimes/paint_types.js";

/**
 * Runs the post-threshold morphology pipeline (binary closing + component
 * filter) and returns the processed 1/0 mask data. Injected into
 * `stampDisk2DMasked` so the stamp logic is agnostic to whether morphology
 * runs in the pyodide worker (`PaintingCompute.runMorphology`) or, in tests,
 * synchronously in TS.
 */
type RunMorphology = (req: MorphologyRequest) => Promise<Uint8Array>;

/**
 * Whole-pipeline route (TM-317). When `ready`, the masked `useSlice` stamps
 * offload the ENTIRE compute (resample → threshold → footprint gate →
 * morphology) to `run` (the pyodide worker), instead of doing
 * slab-copy/threshold/sample-back on the main thread and round-tripping only
 * morphology. `ready` is a non-blocking flag: during the worker's cold-init
 * window it is `false`, so masked strokes stay on the original main-thread
 * path. `run` returns the footprint mask (1 = paint), and may reject — callers
 * fall back to the main-thread path on any failure.
 */
interface PipelineRoute {
  readonly ready: boolean;
  readonly run: (req: PaintPipelineRequest) => Promise<Uint8Array>;
}

/** Footprint geometry handed to the pyodide whole-pipeline path. */
interface PipelineGeometry {
  /** Swept-capsule polyline, ABSOLUTE target voxel coords `[x0,y0,x1,y1,…]`. */
  readonly points: Float64Array;
  /** Brush radius in target voxels (already `floor`ed). */
  readonly radius: number;
}

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
   * The compute honors `input.mask` whenever it is present. Suppressing the
   * mask for the eraser is the TOOL's concern (TM-315): the erase tool simply
   * omits `mask` from its compute call, so the compute no longer reaches back
   * to global active-tool state (the old `getActiveToolId` coupling, TM-297).
   *
   * @param morphology Optional pyodide morphology worker (TM-304). When
   *   provided, the masked brush offloads `binary_closing` + component
   *   filtering to scipy in the worker; on any worker failure it falls back to
   *   the in-process TS `applyMorphologyPipeline`. When omitted (e.g. unit
   *   tests), morphology always runs in TS, preserving prior behavior.
   */
  constructor(private readonly morphology?: MorphologyClient) {}

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
   * The whole-pipeline route for masked `useSlice` stamps (TM-317), or
   * `undefined` when no worker is configured (e.g. unit tests that exercise the
   * main-thread path). `ready` reflects the worker's non-blocking readiness, so
   * the cold-init window transparently uses the main-thread fallback.
   */
  private pipelineRoute(): PipelineRoute | undefined {
    const client = this.morphology;
    if (client === undefined) return undefined;
    return {
      ready: client.isReady(),
      run: (req: PaintPipelineRequest) => client.applyPipeline(req),
    };
  }

  async applyBrush(input: BrushApplyInput): Promise<PaintWriteBatch> {
    const builder = new PaintBatchBuilder(
      input.metadata,
      input.targetLayerId,
      input.targetResolution,
    );
    // Honor the mask whenever the caller supplies one. The eraser tool omits
    // `mask` from its input (TM-315), so no active-tool reach-back is needed.
    const maskCtx = resolveMaskContext(input, this.imageChunkCache);
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
        this.pipelineRoute(),
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
    const maskCtx = resolveMaskContext(input, this.imageChunkCache);
    const r = Math.max(0, Math.floor(input.radius));
    // The swept path `from → …via → to`. `via` is present when the host
    // coalesced pointer positions while the previous segment was still in
    // flight (latest-wins backpressure); rasterizing the whole polyline as ONE
    // footprint keeps morphology at one round-trip per delivered segment no
    // matter how many positions were coalesced. Consecutive duplicates add
    // nothing to the swept shape — drop them.
    const pts = dedupConsecutivePoints([
      input.from,
      ...(input.via ?? []),
      input.to,
    ]);
    const cz = Math.floor(pts[0][2]);
    const sameZ = pts.every((p) => Math.floor(p[2]) === cz);
    recordPaintContext(
      input.radius,
      maskCtx,
      r >= 1 && sameZ
        ? pts.length > 2
          ? `polyline(${pts.length - 1})`
          : "capsule"
        : sameZ
          ? "fallback(r0)"
          : "fallback(zvary)",
      input.metadata.voxelDataType,
    );

    // Fast path: when the path stays on one z-slice and the brush has a real
    // radius, rasterize its swept area as a single capsule (stadium) — or, for
    // a coalesced polyline, the union of its segments' capsules — instead of
    // many overlapping dabs. Each voxel — and the morphology over the whole
    // footprint — is computed exactly once, eliminating per-dab overlap
    // recompute and collapsing N morphology round-trips into one (TM-304).
    if (r >= 1 && sameZ) {
      if (pts.length <= 2) {
        const from = pts[0];
        const to = pts[pts.length - 1];
        if (maskCtx === undefined) {
          stampCapsule2D(builder, from, to, input.radius, input.value);
        } else {
          await stampCapsule2DMasked(
            builder,
            from,
            to,
            input.radius,
            input.value,
            maskCtx,
            this.runMorphology,
            this.pipelineRoute(),
          );
        }
      } else if (maskCtx === undefined) {
        stampPolyline2D(builder, pts, input.radius, input.value);
      } else {
        await stampPolyline2DMasked(
          builder,
          pts,
          input.radius,
          input.value,
          maskCtx,
          this.runMorphology,
          this.pipelineRoute(),
        );
      }
      return paintProfiler.time("3.build(cpu)", () => builder.build());
    }

    // Fallback: interpolate dabs along each consecutive pair of path points.
    // Used for a 1-voxel brush (r === 0) and z-varying segments (the swept
    // volume is a 3D capsule we don't rasterize directly). Spacing = radius/2
    // for gap-free coverage.
    const safeStep = Math.max(1, Math.floor(input.radius / 2));
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
    if (pts.length === 1) {
      // Degenerate path (all points identical): stamp the single position.
      await stamp(pts[0]);
      return paintProfiler.time("3.build(cpu)", () => builder.build());
    }
    for (let s = 0; s + 1 < pts.length; s++) {
      const [x0, y0, z0] = pts[s];
      const [x1, y1, z1] = pts[s + 1];
      const dx = x1 - x0;
      const dy = y1 - y0;
      const dz = z1 - z0;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // Always stamp the endpoint; if the segment is short, that's the only
      // stamp. Start at i = 1 so the segment start isn't re-stamped — the
      // previous pair (or brush call) already covered it.
      if (dist <= safeStep) {
        await stamp(pts[s + 1]);
        continue;
      }
      const steps = Math.ceil(dist / safeStep);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const px = x0 + dx * t;
        const py = y0 + dy * t;
        const pz = z0 + dz * t;
        await stamp([px, py, pz]);
      }
    }
    return paintProfiler.time("3.build(cpu)", () => builder.build());
  }

  /**
   * Worker-SAB route (TM-317 Phase B): compute the masked-brush footprint mask
   * for a stroke via the pyodide whole-pipeline and return it RAW (no batch
   * scatter), so the caller can stamp it into the overlay SAB slots off the main
   * thread. Returns `null` when the stroke is not eligible — no mask, 1-voxel
   * brush, z-varying path, the worker is not ready, or the worker call failed —
   * and the caller then falls back to `applyBrushStroke` + main-thread apply.
   *
   * Eligibility and footprint geometry mirror `applyBrushStrokeInner`'s capsule
   * / polyline branch EXACTLY (same dedup, same bbox, same `pathPoints`/radius),
   * and the mask is produced by the SAME `runFootprintMaskViaPipeline` the
   * scatter path uses — so the painted result is byte-identical.
   */
  async computeMaskedStrokeFootprint(
    input: BrushStrokeInput,
  ): Promise<StrokeFootprintMask | null> {
    const maskCtx = resolveMaskContext(input, this.imageChunkCache);
    if (maskCtx === undefined) return null;
    if (maskCtx.maskMetadata.voxelDataType === "uint64") return null;
    const pipeline = this.pipelineRoute();
    if (pipeline === undefined || !pipeline.ready) return null;

    const r = Math.max(0, Math.floor(input.radius));
    const pts = dedupConsecutivePoints([
      input.from,
      ...(input.via ?? []),
      input.to,
    ]);
    const cz = Math.floor(pts[0][2]);
    const sameZ = pts.every((p) => Math.floor(p[2]) === cz);
    // Only the capsule / polyline-union route (single z-slice, real radius) is
    // worker-stamped; the 1-voxel brush and z-varying paths stay on the
    // synchronous per-dab path (small footprints, not the measured bottleneck).
    if (r < 1 || !sameZ) return null;

    // Footprint bbox in target voxels — identical to `stampCapsule2DMasked` /
    // `stampPolyline2DMasked`. The pyodide path rebuilds the footprint from
    // `pathPoints`+radius via segment-distance, so we need only the bbox here
    // (no main-thread bitmap raster).
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const p of pts) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    const loTx = Math.floor(minX) - r;
    const loTy = Math.floor(minY) - r;
    const hiTx = Math.ceil(maxX) + r;
    const hiTy = Math.ceil(maxY) + r;
    const tShapeX = hiTx - loTx + 1;
    const tShapeY = hiTy - loTy + 1;
    const points = new Float64Array(pts.length * 2);
    for (let i = 0; i < pts.length; i++) {
      points[2 * i] = pts[i][0];
      points[2 * i + 1] = pts[i][1];
    }

    recordPaintContext(
      input.radius,
      maskCtx,
      pts.length > 2 ? `worker-mask(${pts.length - 1})` : "worker-mask",
      input.metadata.voxelDataType,
    );

    const mask = await runFootprintMaskViaPipeline(
      loTx,
      loTy,
      tShapeX,
      tShapeY,
      cz,
      maskCtx,
      pipeline.run,
      { points, radius: r },
    );
    if (mask === null) return null;
    return { loTx, loTy, maskW: tShapeX, maskH: tShapeY, cz, mask };
  }

  /**
   * Connected-component flood fill seeded at `seedVoxelPosition` (TM-269).
   *
   * - `mode === "2d"`: 4-connected flood confined to the seed's XY slice (Z
   *   fixed). Empty space enclosed on the slice is a finite component; an open
   *   region is walled by `bounds`.
   * - `mode === "3d"`: 6-connected flood across sections.
   *
   * Chunk-local, not per-voxel-async: each chunk is read once and scanned
   * synchronously with a typed-array view and a per-chunk visited mask;
   * cross-chunk steps are queued and resumed when their chunk loads. This
   * avoids the ~1M `await`s + string-keyed `Set` the old per-voxel BFS paid
   * (the source of the multi-second freeze).
   *
   * Progressive: every ~{@link FILL_FLUSH_INTERVAL_MS} of compute it hands the
   * voxels accumulated so far to `onFlush` and yields a frame, so the screen
   * updates and the UI stays responsive mid-fill. Cancelable via `signal`.
   */
  async fill(input: FillInput): Promise<PaintWriteBatch> {
    const scale = scaleFor(input.metadata, input.targetResolution);
    const csx = scale.chunkDataSize[0];
    const csy = scale.chunkDataSize[1];
    const csz = scale.chunkDataSize[2];
    const is3d = input.mode === "3d";

    const newBuilder = () =>
      new PaintBatchBuilder(
        input.metadata,
        input.targetLayerId,
        input.targetResolution,
      );

    const seedX = Math.floor(input.seedVoxelPosition[0]);
    const seedY = Math.floor(input.seedVoxelPosition[1]);
    const seedZ = Math.floor(input.seedVoxelPosition[2]);

    const { loX, loY, loZ, hiX, hiY, hiZ } = input.bounds; // hi exclusive
    const inBounds = (x: number, y: number, z: number) =>
      x >= loX && x < hiX && y >= loY && y < hiY && z >= loZ && z < hiZ;

    // Seed outside the session region → nothing to do.
    if (!inBounds(seedX, seedY, seedZ)) return newBuilder().build();

    // The flood is walled by `bounds` (the edit region) and cancelable via
    // `signal`, so it terminates naturally at the region edge — a fill covers
    // the ENTIRE region, not an arbitrary blob, and never truncates on a voxel
    // count (TM-269). The only backstop is memory pressure (see
    // `memoryExhausted` below), which stops the flood gracefully rather than
    // letting a pathologically large 3D region exhaust the tab's heap. An
    // explicit `maxVoxels` is still honored (tests), but the tool never sets it.
    const cap = input.maxVoxels ?? Number.POSITIVE_INFINITY;

    const throwIfAborted = () => {
      if (input.signal?.aborted) {
        throw (
          input.signal.reason ?? new DOMException("Fill aborted", "AbortError")
        );
      }
    };

    // Per-chunk view + visited mask, held for the whole flood so re-entering a
    // chunk from another face stays fully synchronous. For 2D the mask is a
    // single z-plane (csx*csy); for 3D it is the full chunk (csx*csy*csz).
    const views = new Map<string, ChunkVoxelBuffer | null>();
    const visitedMasks = new Map<string, Uint8Array>();
    // Bytes the flood itself holds for the duration (the per-chunk visited
    // bitmaps — ~1 byte per voxel touched). Used as the portable memory-pressure
    // signal where `performance.memory` is unavailable.
    let visitedBytes = 0;
    const loadView = async (
      cx: number,
      cy: number,
      cz: number,
    ): Promise<ChunkVoxelBuffer | null> => {
      const key = `${cx},${cy},${cz}`;
      let view = views.get(key);
      if (view === undefined) {
        try {
          const buf = await input.readChunk(
            ChunkId.fromCoord({ x: cx, y: cy, z: cz }),
          );
          view = buf.asView();
        } catch {
          view = null; // unreadable chunk → flood does not cross into it
        }
        views.set(key, view);
      }
      return view;
    };
    const visitedFor = (key: string): Uint8Array => {
      let m = visitedMasks.get(key);
      if (m === undefined) {
        m = new Uint8Array(is3d ? csx * csy * csz : csx * csy);
        visitedMasks.set(key, m);
        visitedBytes += m.length;
      }
      return m;
    };

    // Memory-pressure backstop: stop the flood before it can exhaust the heap.
    // Prefer Chrome's `performance.memory` (real heap usage); fall back to the
    // flood's own tracked allocation where it is unavailable.
    const selfBudget = input.memoryBudgetBytes ?? FILL_SELF_BUDGET_BYTES;
    const memoryExhausted = (): boolean => {
      const frac = heapUsageFraction();
      return frac !== undefined
        ? frac >= FILL_HEAP_WATERMARK
        : visitedBytes >= selfBudget;
    };

    // Seed value: read once. A no-op (seed already equals target) short-circuits.
    const seedCx = Math.floor(seedX / csx);
    const seedCy = Math.floor(seedY / csy);
    const seedCz = Math.floor(seedZ / csz);
    const seedView = await loadView(seedCx, seedCy, seedCz);
    if (seedView === null) return newBuilder().build();
    const seedValue =
      seedView[
        seedX -
          seedCx * csx +
          csx * (seedY - seedCy * csy + csy * (seedZ - seedCz * csz))
      ];
    if (seedValue === undefined) return newBuilder().build();
    if (voxelEqualsTarget(seedValue, input.value)) return newBuilder().build();

    // Progressive flushing only happens when the caller supplies a sink to
    // apply intermediate batches; otherwise a flush would `build()` + reset the
    // builder and DROP those voxels (they live only in the returned remainder).
    // Without `onFlush` we accumulate everything into one batch and return it.
    const progressive = input.onFlush !== undefined;
    const flushInterval = input.flushIntervalMs ?? FILL_FLUSH_INTERVAL_MS;
    let builder = newBuilder();
    let voxelsWritten = 0;
    let truncated = false;
    let outOfMemory = false;
    let deadline = performance.now() + flushInterval;

    const flush = async () => {
      const batch = builder.build();
      if (batch.chunks.length > 0) {
        await input.onFlush!(batch);
      }
      input.onProgress?.({ voxelsWritten });
      builder = newBuilder();
      // Macrotask yield so the viewer can repaint the just-applied voxels.
      await yieldToEventLoop();
      throwIfAborted();
      deadline = performance.now() + flushInterval;
    };

    // Outer frontier: cross-chunk entry voxels in GLOBAL coords.
    const frontierX: number[] = [seedX];
    const frontierY: number[] = [seedY];
    const frontierZ: number[] = [seedZ];
    let fhead = 0;

    outer: while (fhead < frontierX.length) {
      throwIfAborted();
      const ex = frontierX[fhead];
      const ey = frontierY[fhead];
      const ez = frontierZ[fhead];
      fhead++;
      const cx = Math.floor(ex / csx);
      const cy = Math.floor(ey / csy);
      const cz = Math.floor(ez / csz);
      const key = `${cx},${cy},${cz}`;
      const view = await loadView(cx, cy, cz);
      if (view === null) continue;
      const visited = visitedFor(key);
      const baseX = cx * csx;
      const baseY = cy * csy;
      const baseZ = cz * csz;

      // Intra-chunk DFS over local coords. Cross-chunk neighbors spill to the
      // outer frontier; in-chunk neighbors stay on this stack.
      const stackX: number[] = [ex - baseX];
      const stackY: number[] = [ey - baseY];
      const stackZ: number[] = [ez - baseZ];
      while (stackX.length > 0) {
        const lx = stackX.pop()!;
        const ly = stackY.pop()!;
        const lz = stackZ.pop()!;
        const mIdx = is3d ? lx + csx * (ly + csy * lz) : lx + csx * ly;
        if (visited[mIdx]) continue;
        visited[mIdx] = 1;
        const value = view[lx + csx * (ly + csy * lz)];
        if (value === undefined) continue;
        if (!voxelEqualsTarget(value, seedValue)) continue;

        const gx = baseX + lx;
        const gy = baseY + ly;
        const gz = baseZ + lz;
        builder.writeVoxel(gx, gy, gz, input.value);
        voxelsWritten++;
        if (voxelsWritten >= cap) {
          truncated = true;
          break outer;
        }

        // Enqueue a neighbor: dropped if out of bounds, kept local when it
        // stays in this chunk, else spilled to the outer frontier.
        const consider = (nx: number, ny: number, nz: number) => {
          if (!inBounds(nx, ny, nz)) return;
          if (
            Math.floor(nx / csx) === cx &&
            Math.floor(ny / csy) === cy &&
            Math.floor(nz / csz) === cz
          ) {
            stackX.push(nx - baseX);
            stackY.push(ny - baseY);
            stackZ.push(nz - baseZ);
          } else {
            frontierX.push(nx);
            frontierY.push(ny);
            frontierZ.push(nz);
          }
        };
        consider(gx + 1, gy, gz);
        consider(gx - 1, gy, gz);
        consider(gx, gy + 1, gz);
        consider(gx, gy - 1, gz);
        if (is3d) {
          consider(gx, gy, gz + 1);
          consider(gx, gy, gz - 1);
        }

        if (performance.now() >= deadline) {
          if (memoryExhausted()) {
            outOfMemory = true;
            break outer;
          }
          if (progressive) {
            await flush();
          } else {
            // No sink to apply to — just honor cancellation and keep going.
            throwIfAborted();
            deadline = performance.now() + flushInterval;
          }
        }
      }
    }

    input.onProgress?.({ voxelsWritten });
    return builder.build(
      outOfMemory
        ? { reason: "out-of-memory", voxelsWritten }
        : truncated
          ? { reason: "max-voxels", voxelsWritten }
          : undefined,
    );
  }
}

/**
 * Heap-usage fraction in [0, 1] from Chrome's non-standard `performance.memory`,
 * or `undefined` where it is unavailable (Firefox / Safari). Lets the fill stop
 * before the tab's heap is exhausted rather than at an arbitrary voxel count.
 */
interface ChromeMemoryInfo {
  readonly usedJSHeapSize: number;
  readonly jsHeapSizeLimit: number;
}
function heapUsageFraction(): number | undefined {
  const mem = (performance as { memory?: ChromeMemoryInfo }).memory;
  if (mem === undefined || !(mem.jsHeapSizeLimit > 0)) return undefined;
  return mem.usedJSHeapSize / mem.jsHeapSizeLimit;
}

/** Macrotask yield, letting the viewer repaint between progressive flushes. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Fill memory-pressure backstop
// ---------------------------------------------------------------------------

/**
 * Stop a fill when Chrome's reported heap usage crosses this fraction of the
 * heap limit. A fill is otherwise unbounded except by the edit region and the
 * user (Escape) — this guards a pathologically large 3D region from exhausting
 * the tab's memory. Chosen below 1.0 to leave headroom for the in-flight
 * allocation between checks (~12 ms apart).
 */
const FILL_HEAP_WATERMARK = 0.9;

/**
 * Portable fallback when `performance.memory` is unavailable: stop once the
 * flood's own visited bitmaps reach this many bytes (~1 byte per voxel
 * touched). ~1 GiB tolerates very large 2D slices while still bounding a runaway
 * 3D region.
 */
const FILL_SELF_BUDGET_BYTES = 1 << 30; // ~1 GiB

/**
 * Compute budget between progressive flushes (TM-269). After this many ms of
 * uninterrupted flooding, `fill` flushes the accumulated voxels and yields a
 * frame so the viewer repaints and the cancel signal is observed. ~12 ms keeps
 * the fill visibly advancing without thrashing the apply path.
 */
const FILL_FLUSH_INTERVAL_MS = 12;

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

/** Drop consecutive identical points; the swept shape is unchanged. */
function dedupConsecutivePoints(
  pts: readonly (readonly [number, number, number])[],
): readonly (readonly [number, number, number])[] {
  const out: (readonly [number, number, number])[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const prev = out[out.length - 1];
    const p = pts[i];
    if (p[0] === prev[0] && p[1] === prev[1] && p[2] === prev[2]) continue;
    out.push(p);
  }
  return out;
}

/**
 * Rasterized union of the capsules of every consecutive segment of `pts`, as a
 * dense Uint8 bitmap over the polyline's bbox (1 = inside). Each segment only
 * scans its own sub-bbox, and voxels already inside skip the distance test, so
 * the cost is the sum of the per-segment capsule bboxes — the same voxels the
 * old one-capsule-per-segment path would have touched — not
 * O(polyline bbox × segments).
 */
interface PolylineFootprint {
  readonly loTx: number;
  readonly loTy: number;
  readonly w: number;
  readonly h: number;
  readonly bitmap: Uint8Array;
}

function rasterizePolylineFootprint(
  pts: readonly (readonly [number, number, number])[],
  r: number,
): PolylineFootprint {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  const loTx = Math.floor(minX) - r;
  const loTy = Math.floor(minY) - r;
  const hiTx = Math.ceil(maxX) + r;
  const hiTy = Math.ceil(maxY) + r;
  const w = hiTx - loTx + 1;
  const h = hiTy - loTy + 1;
  const bitmap = new Uint8Array(w * h);
  const r2 = r * r;
  for (let s = 0; s + 1 < pts.length; s++) {
    const ax = pts[s][0];
    const ay = pts[s][1];
    const bx = pts[s + 1][0];
    const by = pts[s + 1][1];
    const sLoX = Math.max(loTx, Math.floor(Math.min(ax, bx)) - r);
    const sLoY = Math.max(loTy, Math.floor(Math.min(ay, by)) - r);
    const sHiX = Math.min(hiTx, Math.ceil(Math.max(ax, bx)) + r);
    const sHiY = Math.min(hiTy, Math.ceil(Math.max(ay, by)) + r);
    for (let vy = sLoY; vy <= sHiY; vy++) {
      const row = (vy - loTy) * w;
      for (let vx = sLoX; vx <= sHiX; vx++) {
        const idx = row + (vx - loTx);
        if (bitmap[idx] !== 0) continue;
        if (segmentDistanceSq(vx, vy, ax, ay, bx, by) <= r2) bitmap[idx] = 1;
      }
    }
  }
  return { loTx, loTy, w, h, bitmap };
}

/**
 * Unmasked polyline stamp: rasterize the union of the per-segment capsules of
 * `pts` (a coalesced pointer path on a single z-slice) and write each covered
 * voxel exactly once. The polyline analogue of `stampCapsule2D`. Caller
 * guarantees all points share a z-slice and `pts.length >= 3` (a 2-point path
 * routes through `stampCapsule2D` to skip the bitmap pass).
 */
function stampPolyline2D(
  builder: PaintBatchBuilder,
  pts: readonly (readonly [number, number, number])[],
  radius: number,
  value: number | bigint,
): void {
  const r = Math.max(0, Math.floor(radius));
  const cz = Math.floor(pts[0][2]);
  const fp = rasterizePolylineFootprint(pts, r);
  builder.beginSliceStamp(
    fp.loTx,
    fp.loTy,
    fp.loTx + fp.w - 1,
    fp.loTy + fp.h - 1,
    cz,
  );
  for (let j = 0; j < fp.h; j++) {
    const row = j * fp.w;
    const vy = fp.loTy + j;
    for (let i = 0; i < fp.w; i++) {
      if (fp.bitmap[row + i] === 1) {
        builder.writeVoxel(fp.loTx + i, vy, cz, value);
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
  // The image layer's metadata enumerates its FULL datasource pyramid, so
  // `scaleFor` below would happily resolve a finer scale the session never
  // pinned — triggering a cold full-resolution EM read per stamp. Reject a
  // resolution the host didn't open for this session and fall back to an
  // unmasked stroke (TM-350; the host also repairs this at restore time).
  if (
    input.maskAllowedResolutions !== undefined &&
    !input.maskAllowedResolutions.includes(input.mask.imageResolution)
  ) {
    warnOncePerStroke(
      `advanced brush: image resolution "${input.mask.imageResolution}" is not one of ` +
        `the session's opened resolutions for layer "${input.mask.imageLayerId}"; ` +
        `falling back to unmasked stroke.`,
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
  // Whole-pipeline route (TM-317) + the footprint geometry it needs. Present
  // only for the `useSlice` callers (click/capsule/polyline); when the route is
  // ready the entire compute runs in pyodide and the main-thread path below is
  // skipped. Absent / not-ready / on failure → the main-thread path runs.
  pipeline?: PipelineRoute,
  geometry?: PipelineGeometry,
): Promise<void> {
  if (tShapeX <= 0 || tShapeY <= 0) return;

  // Primary path (TM-317): offload the whole masked compute to the pyodide
  // worker. Only for `useSlice` stamps with a ready worker and a non-uint64
  // image (uint64 is rejected upstream, but defend in depth). On any failure,
  // fall through to the unchanged main-thread path below — painting never
  // hard-breaks.
  if (
    useSlice &&
    pipeline?.ready === true &&
    geometry !== undefined &&
    ctx.maskMetadata.voxelDataType !== "uint64"
  ) {
    const handled = await stampViaPipeline(
      builder,
      loTx,
      loTy,
      tShapeX,
      tShapeY,
      cz,
      value,
      ctx,
      pipeline.run,
      geometry,
    );
    if (handled) return;
  }

  if (useSlice) {
    builder.beginSliceStamp(
      loTx,
      loTy,
      loTx + tShapeX - 1,
      loTy + tShapeY - 1,
      cz,
    );
  }

  // Per-target-voxel image coord mapping. Uses physical nm ratio so any
  // anisotropic ratio works (matches reference's `scale = image_size/target_size`
  // when both buffers cover the same physical extent).
  const sxRatio = ctx.targetVoxelSizeNm[0] / ctx.imageVoxelSizeNm[0];
  const syRatio = ctx.targetVoxelSizeNm[1] / ctx.imageVoxelSizeNm[1];
  const szRatio = ctx.targetVoxelSizeNm[2] / ctx.imageVoxelSizeNm[2];
  const imageZ = Math.floor(cz * szRatio);
  // Per-target-voxel image BLOCK extents (TM-339): a target voxel at absolute
  // coord `v` covers image voxels `[floor(v·ratio), ceil((v+1)·ratio) - 1]`. At
  // ratio ≤ 1 the block is a single voxel (lo === hi) and the coverage test
  // below reduces bit-for-bit to the legacy nearest-neighbour sample. The slab
  // must span every covered voxel, so its bounds come from the block lo/hi.
  const imgXLo = new Int32Array(tShapeX);
  const imgXHi = new Int32Array(tShapeX);
  const imgYLo = new Int32Array(tShapeY);
  const imgYHi = new Int32Array(tShapeY);
  let minIx = Number.POSITIVE_INFINITY;
  let maxIx = Number.NEGATIVE_INFINITY;
  let minIy = Number.POSITIVE_INFINITY;
  let maxIy = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < tShapeX; i++) {
    const lo = Math.floor((loTx + i) * sxRatio);
    const hi = Math.ceil((loTx + i + 1) * sxRatio) - 1;
    imgXLo[i] = lo;
    imgXHi[i] = hi;
    if (lo < minIx) minIx = lo;
    if (hi > maxIx) maxIx = hi;
  }
  for (let j = 0; j < tShapeY; j++) {
    const lo = Math.floor((loTy + j) * syRatio);
    const hi = Math.ceil((loTy + j + 1) * syRatio) - 1;
    imgYLo[j] = lo;
    imgYHi[j] = hi;
    if (lo < minIy) minIy = lo;
    if (hi > maxIy) maxIy = hi;
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
    // `coord` is offset-anchored (see `imageChunksCovering`), so the chunk's
    // GLOBAL voxel origin adds the image's `voxelOffset` back. Without this the
    // local index `ix - cox` would address the wrong row of EM data.
    const ivo = ctx.imageScale.voxelOffset;
    const cox = coord.x * ics[0] + ivo[0];
    const coy = coord.y * ics[1] + ivo[1];
    const coz = coord.z * ics[2] + ivo[2];
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
  // While building, track the tight bounding box of set bytes — the threshold
  // mask is typically much sparser than the footprint bbox (the band rejects
  // most of it), and morphology cost scales with the ARRAY size, not the set
  // size, so cropping to this bbox before the worker call is a large win.
  const tMaskShape: VoxelTriple = [tShapeX, tShapeY, 1];
  const tMaskData = new Uint8Array(tShapeX * tShapeY);
  const low = ctx.mask.thresholdLow;
  const high = ctx.mask.thresholdHigh;
  const coverage = ctx.mask.coverageThreshold ?? DEFAULT_COVERAGE_THRESHOLD;
  const tMask = prof ? performance.now() : 0;
  let mMinI = tShapeX;
  let mMaxI = -1;
  let mMinJ = tShapeY;
  let mMaxJ = -1;
  for (let j = 0; j < tShapeY; j++) {
    const vy = loTy + j;
    const iy0 = imgYLo[j] - loImage[1];
    const iy1 = imgYHi[j] - loImage[1];
    let rowHasSet = false;
    for (let i = 0; i < tShapeX; i++) {
      if (!inShape(loTx + i, vy)) continue;
      const ix0 = imgXLo[i] - loImage[0];
      const ix1 = imgXHi[i] - loImage[0];
      // Coverage: paint iff ≥ `minPass` of the block's image voxels are in-band.
      // `minPass = clamp(ceil(coverage·total), 1, total)` — identical arithmetic
      // in `paint_pipeline_ts.ts` and `python_painter.py`.
      const total = (ix1 - ix0 + 1) * (iy1 - iy0 + 1);
      let minPass = Math.ceil(coverage * total);
      if (minPass < 1) minPass = 1;
      if (minPass > total) minPass = total;
      let pass = 0;
      for (let iy = iy0; iy <= iy1; iy++) {
        const rowBase = iShapeX * iy;
        for (let ix = ix0; ix <= ix1; ix++) {
          const v = imageValues[ix + rowBase];
          if (v >= low && v <= high) pass++;
        }
      }
      if (pass >= minPass) {
        tMaskData[i + tShapeX * j] = 1;
        rowHasSet = true;
        if (i < mMinI) mMinI = i;
        if (i > mMaxI) mMaxI = i;
      }
    }
    if (rowHasSet) {
      if (j < mMinJ) mMinJ = j;
      mMaxJ = j;
    }
  }
  if (prof)
    paintProfiler.record("2a.maskBuild(cpu)", performance.now() - tMask);
  const maskEmpty = mMaxJ < 0;

  // Apply binary closing + component filter in TARGET voxel space, via the
  // injected runner (pyodide worker in production, TS pipeline in tests/
  // fallback). A planar `[w, h, 1]` shape makes the morphology degrade to
  // 4-connected planar ops — same as scipy's default in the reference.
  //
  // Short-circuits:
  //  - No morphology requested (the default: closing 0, minComponentSize 0):
  //    the pipeline is an identity transform, so calling the worker would
  //    round-trip to compute nothing — a pure latency hit on the live-paint
  //    path. Stamp the raw threshold mask directly.
  //  - Empty threshold mask: closing and component filtering of an all-zero
  //    mask are identity too — skip the round-trip.
  const needsMorphology =
    !maskEmpty && (ctx.mask.binaryClosing > 0 || ctx.mask.minComponentSize > 1);
  let processed: Uint8Array = tMaskData;
  if (needsMorphology) {
    // Crop the worker input to the set-byte bbox padded by the closing reach.
    // Binary closing is dilation^k ∘ erosion^k: nothing it produces can extend
    // more than `k` voxels past the input set, and with one extra guard
    // row/column every neighborhood the erosion reads is identical to the
    // full-footprint array's (all zeros beyond the set), so the cropped result
    // is bit-identical inside the window and zero outside — exactly what the
    // uncropped call would return. The component filter only ever clears
    // voxels, so it cannot escape the window either.
    const pad = ctx.mask.binaryClosing + 1;
    const cLoI = Math.max(0, mMinI - pad);
    const cHiI = Math.min(tShapeX - 1, mMaxI + pad);
    const cLoJ = Math.max(0, mMinJ - pad);
    const cHiJ = Math.min(tShapeY - 1, mMaxJ + pad);
    const cw = cHiI - cLoI + 1;
    const ch = cHiJ - cLoJ + 1;
    const useCrop = cw * ch < tShapeX * tShapeY;
    if (prof) {
      paintProfiler.count("voxels.morphInput", cw * ch);
      paintProfiler.count("voxels.morphInputFull", tShapeX * tShapeY);
    }
    if (useCrop) {
      const cropped = new Uint8Array(cw * ch);
      for (let j = 0; j < ch; j++) {
        const srcStart = (cLoJ + j) * tShapeX + cLoI;
        cropped.set(tMaskData.subarray(srcStart, srcStart + cw), j * cw);
      }
      const processedCrop = await paintProfiler.timeAsync(
        "2b.morphology(worker)",
        () =>
          runMorphology({
            mask: cropped,
            shape: [cw, ch, 1],
            binaryClosing: ctx.mask.binaryClosing,
            minComponentSize: ctx.mask.minComponentSize,
            filterComponentsFirst: ctx.mask.filterComponentsFirst,
          }),
      );
      // Paste the processed window back over its source region. Outside the
      // window `tMaskData` is all zero by construction (the window covers
      // every set byte plus the closing reach), so the patched buffer IS the
      // full-size result.
      for (let j = 0; j < ch; j++) {
        tMaskData.set(
          processedCrop.subarray(j * cw, (j + 1) * cw),
          (cLoJ + j) * tShapeX + cLoI,
        );
      }
      processed = tMaskData;
    } else {
      processed = await paintProfiler.timeAsync("2b.morphology(worker)", () =>
        runMorphology({
          mask: tMaskData,
          shape: tMaskShape,
          binaryClosing: ctx.mask.binaryClosing,
          minComponentSize: ctx.mask.minComponentSize,
          filterComponentsFirst: ctx.mask.filterComponentsFirst,
        }),
      );
    }
  }

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

/**
 * Whole-pipeline masked stamp (TM-317). Assembles a footprint-bounded,
 * native-dtype EM image slab (one contiguous row-memcpy per covering chunk),
 * hands the entire compute — resample, threshold, footprint gate, morphology —
 * to the pyodide worker, then scatters the returned footprint mask into the
 * builder via the SAME `beginSliceStamp`/`writeVoxel` calls the main-thread
 * path uses, so the resulting batch is byte-identical.
 *
 * Returns `true` when the worker computed and the result was scattered; returns
 * `false` if the worker call failed (the caller then runs the main-thread
 * fallback). The slice stamp is only begun AFTER the worker resolves, so a
 * failed call leaves the builder untouched and the fallback cannot double-write.
 */
async function stampViaPipeline(
  builder: PaintBatchBuilder,
  loTx: number,
  loTy: number,
  tShapeX: number,
  tShapeY: number,
  cz: number,
  value: number | bigint,
  ctx: MaskContext,
  run: (req: PaintPipelineRequest) => Promise<Uint8Array>,
  geometry: PipelineGeometry,
): Promise<boolean> {
  const mask = await runFootprintMaskViaPipeline(
    loTx,
    loTy,
    tShapeX,
    tShapeY,
    cz,
    ctx,
    run,
    geometry,
  );
  if (mask === null) return false;

  // Scatter: identical to the main-thread sample-back, but driven by the
  // worker's footprint mask. `beginSliceStamp` fixes the per-chunk dense grid;
  // only painted voxels set `valueMask`, so the emitted batch matches the
  // main-thread path exactly.
  const prof = paintProfiler.enabled;
  const tWrite = prof ? performance.now() : 0;
  builder.beginSliceStamp(
    loTx,
    loTy,
    loTx + tShapeX - 1,
    loTy + tShapeY - 1,
    cz,
  );
  let painted = 0;
  for (let j = 0; j < tShapeY; j++) {
    const rowBase = tShapeX * j;
    const vy = loTy + j;
    for (let i = 0; i < tShapeX; i++) {
      if (mask[rowBase + i] === 1) {
        builder.writeVoxel(loTx + i, vy, cz, value);
        painted++;
      }
    }
  }
  if (prof) {
    paintProfiler.record("P.write(cpu)", performance.now() - tWrite);
    paintProfiler.count("voxels.footprintBbox", tShapeX * tShapeY);
    paintProfiler.count("voxels.painted", painted);
  }
  return true;
}

/**
 * Run the pyodide whole-pipeline for a single-slice footprint and return the
 * raw footprint mask (`1` = paint) over `[loTx, loTx+tShapeX) × [loTy,
 * loTy+tShapeY)` at `cz`, or `null` if the worker call failed. Shared by the
 * main-thread scatter path (`stampViaPipeline`) and the worker-SAB apply route
 * (`PaintingCompute.computeMaskedStrokeFootprint`), so both compute the SAME
 * mask — the apply route is byte-identical to the scatter route, it just writes
 * the mask off-thread instead of into a `PaintWriteBatch`.
 */
async function runFootprintMaskViaPipeline(
  loTx: number,
  loTy: number,
  tShapeX: number,
  tShapeY: number,
  cz: number,
  ctx: MaskContext,
  run: (req: PaintPipelineRequest) => Promise<Uint8Array>,
  geometry: PipelineGeometry,
): Promise<Uint8Array | null> {
  const sxRatio = ctx.targetVoxelSizeNm[0] / ctx.imageVoxelSizeNm[0];
  const syRatio = ctx.targetVoxelSizeNm[1] / ctx.imageVoxelSizeNm[1];
  const szRatio = ctx.targetVoxelSizeNm[2] / ctx.imageVoxelSizeNm[2];
  const imageZ = Math.floor(cz * szRatio);
  // Image-voxel region the footprint projects to. Each target voxel covers the
  // image BLOCK `[floor(v·ratio), ceil((v+1)·ratio) - 1]` (TM-339 area-aware
  // coverage); both bounds are monotonic in `v` (ratio > 0), so the slab extent
  // is the first voxel's block-lo to the last voxel's block-hi — exactly the
  // voxels the worker / TS twin gather, so the slab spans them with no clipping.
  // At ratio ≤ 1 block-hi === block-lo, recovering the legacy 1-voxel slab.
  const minIx = Math.floor(loTx * sxRatio);
  const maxIx = Math.ceil((loTx + tShapeX) * sxRatio) - 1;
  const minIy = Math.floor(loTy * syRatio);
  const maxIy = Math.ceil((loTy + tShapeY) * syRatio) - 1;
  const iSx = maxIx - minIx + 1;
  const iSy = maxIy - minIy + 1;

  const dataType = ctx.maskMetadata.voxelDataType as PaintPipelineDataType;
  // `assembleImageSlabNative` splits its own io (chunkRead await) vs cpu (row
  // memcpy) timing into `P.chunkRead(io)` / `P.slabCopy(cpu)`.
  const slab = await assembleImageSlabNative(
    ctx,
    dataType,
    minIx,
    minIy,
    imageZ,
    iSx,
    iSy,
  );

  try {
    return await paintProfiler.timeAsync("P.pipeline(worker)", () =>
      run({
        image: slab,
        imageShape: [iSx, iSy],
        imageDataType: dataType,
        loImageX: minIx,
        loImageY: minIy,
        loTx,
        loTy,
        targetShape: [tShapeX, tShapeY],
        sxRatio,
        syRatio,
        szRatio,
        thresholdLow: ctx.mask.thresholdLow,
        thresholdHigh: ctx.mask.thresholdHigh,
        coverageThreshold:
          ctx.mask.coverageThreshold ?? DEFAULT_COVERAGE_THRESHOLD,
        pathPoints: geometry.points,
        radius: geometry.radius,
        binaryClosing: ctx.mask.binaryClosing,
        minComponentSize: ctx.mask.minComponentSize,
        filterComponentsFirst: ctx.mask.filterComponentsFirst,
      }),
    );
  } catch (e) {
    warnPipelineFallback(e);
    return null;
  }
}

/**
 * Copy the footprint's EM data into a contiguous native-dtype slab over the
 * image-voxel region `[minIx, minIx+iSx) × [minIy, minIy+iSy)` on slice
 * `imageZ`. Unlike the main-thread `Float64Array` slab (per-voxel scalar copy),
 * this is one `TypedArray.set` row-memcpy per chunk row — much cheaper — and in
 * the image's native dtype so the worker can `np.frombuffer` it directly. uint64
 * is never reached here (rejected upstream), so every dtype is a numeric typed
 * array.
 */
async function assembleImageSlabNative(
  ctx: MaskContext,
  dataType: PaintPipelineDataType,
  minIx: number,
  minIy: number,
  imageZ: number,
  iSx: number,
  iSy: number,
): Promise<ImageSlab> {
  const slab = allocateVoxelBuffer(dataType, iSx * iSy) as ImageSlab;
  const loImage: VoxelTriple = [minIx, minIy, imageZ];
  const hiImage: VoxelTriple = [minIx + iSx, minIy + iSy, imageZ + 1];
  const chunks = imageChunksCovering(loImage, hiImage, ctx.imageScale);
  const ics = ctx.imageScale.chunkDataSize;
  // Split the per-chunk `readChunk` AWAIT (io, yields the main thread) from the
  // row memcpy (cpu, blocks it) so the profiler doesn't lump a cache miss into
  // the copy bucket — mirrors the old split path's `1a.chunkRead`/`1b.slabCopy`.
  const prof = paintProfiler.enabled;
  let readMs = 0;
  let copyMs = 0;
  for (const coord of chunks) {
    let t = prof ? performance.now() : 0;
    const chunkBuf = await ctx.reader.readChunk(coord);
    if (prof) readMs += performance.now() - t;
    if (chunkBuf === undefined) continue;
    const view = chunkBuf.asView() as Exclude<ChunkVoxelBuffer, BigUint64Array>;
    // `coord` is offset-anchored (see `imageChunksCovering`); add the image's
    // `voxelOffset` to get the chunk's GLOBAL voxel origin so `x0 - cox` indexes
    // the correct EM row.
    const ivo = ctx.imageScale.voxelOffset;
    const cox = coord.x * ics[0] + ivo[0];
    const coy = coord.y * ics[1] + ivo[1];
    const coz = coord.z * ics[2] + ivo[2];
    const x0 = Math.max(minIx, cox);
    const y0 = Math.max(minIy, coy);
    const x1 = Math.min(minIx + iSx, cox + ics[0]);
    const y1 = Math.min(minIy + iSy, coy + ics[1]);
    const lz = imageZ - coz;
    const rowLen = x1 - x0;
    if (rowLen <= 0) continue;
    if (prof) t = performance.now();
    for (let iy = y0; iy < y1; iy++) {
      const ly = iy - coy;
      const srcStart = x0 - cox + ics[0] * (ly + ics[1] * lz);
      const dstStart = x0 - minIx + iSx * (iy - minIy);
      // Both `slab` and `view` are the SAME concrete dtype at runtime, so the
      // `Float32Array` cast is a TS-only convenience: the real prototype's
      // `set`/`subarray` (e.g. Uint16Array's) runs and copies element values
      // correctly. Never cast ACROSS dtypes — that would reinterpret bytes.
      (slab as Float32Array).set(
        (view as Float32Array).subarray(srcStart, srcStart + rowLen),
        dstStart,
      );
    }
    if (prof) copyMs += performance.now() - t;
  }
  if (prof) {
    paintProfiler.record("P.chunkRead(io)", readMs);
    paintProfiler.record("P.slabCopy(cpu)", copyMs);
  }
  return slab;
}

let pipelineFallbackWarned = false;
function warnPipelineFallback(e: unknown): void {
  if (pipelineFallbackWarned) return;
  pipelineFallbackWarned = true;
  console.warn(
    "[painting] pyodide whole-pipeline worker call failed — falling back to " +
      "the main-thread masked compute for this stamp. Brush results stay " +
      "correct. First failure:",
    e,
  );
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
  pipeline?: PipelineRoute,
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
    pipeline,
    // Capsule (incl. degenerate single click, from === to) = one segment.
    { points: new Float64Array([ax, ay, bx, by]), radius: r },
  );
}

/**
 * Mask-aware polyline stamp: the polyline analogue of `stampCapsule2DMasked`.
 * Rasterizes the union of the per-segment capsules of `pts` into a footprint
 * bitmap, then delegates to the shared masked-stamp core with a bitmap-lookup
 * shape predicate — so thresholding runs once over the union and morphology is
 * ONE worker round-trip for the whole coalesced path. Caller guarantees all
 * points share a z-slice and `pts.length >= 3`.
 */
function stampPolyline2DMasked(
  builder: PaintBatchBuilder,
  pts: readonly (readonly [number, number, number])[],
  radius: number,
  value: number | bigint,
  ctx: MaskContext,
  runMorphology: RunMorphology,
  pipeline?: PipelineRoute,
): Promise<void> {
  const r = Math.max(0, Math.floor(radius));
  const cz = Math.floor(pts[0][2]);
  const fp = paintProfiler.time("cmp.footprint(cpu)", () =>
    rasterizePolylineFootprint(pts, r),
  );
  // Flatten the polyline's xy points for the worker. Its segment-distance
  // footprint is the exact union the `fp.bitmap` predicate encodes (both use
  // `segmentDistanceSq` per segment), so the pyodide and main-thread footprints
  // agree voxel-for-voxel.
  const points = new Float64Array(pts.length * 2);
  for (let i = 0; i < pts.length; i++) {
    points[2 * i] = pts[i][0];
    points[2 * i + 1] = pts[i][1];
  }
  return stampShape2DMasked(
    builder,
    fp.loTx,
    fp.loTy,
    fp.w,
    fp.h,
    cz,
    value,
    ctx,
    runMorphology,
    (vx, vy) => fp.bitmap[vx - fp.loTx + fp.w * (vy - fp.loTy)] === 1,
    // Single polyline stamp per builder → safe to use the fast slice path.
    /* useSlice */ true,
    pipeline,
    { points, radius: r },
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
    this.sliceCells = new Array<SliceCell | undefined>(this.sliceNcols * nrows);
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
      if (c === undefined || vx < c.x0 || vx > c.x1 || vy < c.y0 || vy > c.y1) {
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
  // Clamp to the dtype range so an out-of-range value (e.g. from the +/-
  // hotkeys, which aren't dtype-aware) is pinned to the nearest bound rather
  // than silently wrapping via typed-array truncation.
  const clamped = clampToVoxelDataType(type, value);
  if (type === "uint64") {
    (buffer as BigUint64Array)[index] = clamped as bigint;
    return;
  }
  (buffer as Exclude<ChunkVoxelBuffer, BigUint64Array>)[index] =
    clamped as number;
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
