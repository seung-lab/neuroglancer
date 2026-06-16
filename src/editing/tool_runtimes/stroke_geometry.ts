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
 * Deterministic stroke geometry (TM-318).
 *
 * The painting pipeline must define a stroke by its *geometry*, not by how the
 * OS happened to deliver pointer events (see `docs/brush-painting-design.md`
 * §"Stroke geometry"). Raw pointer samples are non-uniform in space and time;
 * this module turns them into a deterministic sequence of stamp positions by:
 *
 *  1. smoothing the raw samples with a **centripetal Catmull-Rom** spline, and
 *  2. resampling that spline by **arc length** at a fixed spacing (a fraction
 *     of the brush diameter).
 *
 * The result is a pure function of the raw samples: the same gesture replayed
 * from stored samples produces an identical stamp sequence, regardless of how
 * the samples were chunked into batches. That determinism is what lets undo use
 * replay-based redo (TM-319) and makes the geometry unit-testable.
 *
 * ## Why finalization lags one control point
 *
 * A centripetal Catmull-Rom segment between control points `P[k]` and `P[k+1]`
 * is shaped by the four-point stencil `P[k-1], P[k], P[k+1], P[k+2]`. A segment
 * therefore is not *final* — its stamps cannot be emitted without risking that
 * a later sample shifts them — until `P[k+2]` has arrived. So `drain()` emits
 * stamps only for segments whose stencil is complete, and the still-provisional
 * tail of the stroke is covered for the user by the caller's *head stamp* (the
 * live cursor position). `finish()` finalizes the remaining segments at
 * pointer-up using clamped endpoints.
 *
 * This module is pure (no I/O, no time) and 2D/3D-agnostic — it operates on
 * `[x, y, z]` voxel positions and never inspects the z component specially, so
 * a same-z stroke simply yields stamps with a constant z.
 */

export type Vec3 = readonly [number, number, number];

/**
 * Default stamp spacing as a fraction of brush diameter. Matches the worked
 * example in `docs/brush-painting-design.md` (10% of diameter). Kept as a
 * single named constant so it is trivial to retune once we have real strokes to
 * measure against.
 */
export const DEFAULT_SPACING_FRACTION = 0.1;

/**
 * Smallest stamp spacing we allow, in voxels. Spacing below one voxel buys no
 * extra coverage (the rasterizer is voxel-quantized) but multiplies the number
 * of capsule segments, so we clamp here.
 */
const MIN_SPACING_VOXELS = 1;

/**
 * Sub-steps per `spacing` unit when walking a segment's arc length. Higher =
 * more accurate arc-length placement at more cost; 4 keeps stamp positions
 * within ~¼ spacing of true arc length, which is well under one voxel for any
 * reasonable brush. Deterministic given (controls, spacing).
 */
const SUBSTEPS_PER_SPACING = 4;

/** Hard cap on sub-steps per segment so a huge coalesced jump can't blow up. */
const MAX_SUBSTEPS_PER_SEGMENT = 1024;

export interface StrokeGeometryOptions {
  /** Brush diameter in voxels at the target resolution (`2 * radius + 1`). */
  readonly diameterVoxels: number;
  /** Stamp spacing as a fraction of diameter. Defaults to {@link DEFAULT_SPACING_FRACTION}. */
  readonly spacingFraction?: number;
}

/** Resolve the spacing (in voxels) used by a stroke, clamped to a sane floor. */
export function resolveSpacingVoxels(opts: StrokeGeometryOptions): number {
  const fraction = opts.spacingFraction ?? DEFAULT_SPACING_FRACTION;
  return Math.max(MIN_SPACING_VOXELS, fraction * opts.diameterVoxels);
}

function eq(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function dist(a: Vec3, b: Vec3): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Evaluate a centripetal Catmull-Rom segment `p1 → p2` at `u ∈ [0, 1]`, with
 * neighbours `p0` and `p3`. Centripetal parameterization (α = 0.5) avoids the
 * cusps and self-intersections uniform Catmull-Rom produces on sharp turns.
 */
function catmullRom(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, u: number): Vec3 {
  // Knot sequence with α = 0.5 (centripetal): t_{i+1} = t_i + |P_{i+1}-P_i|^0.5.
  const t0 = 0;
  const t1 = t0 + Math.sqrt(dist(p0, p1)) || t0 + 1e-6;
  const t2 = t1 + (Math.sqrt(dist(p1, p2)) || 1e-6);
  const t3 = t2 + (Math.sqrt(dist(p2, p3)) || 1e-6);
  const t = t1 + u * (t2 - t1);

  const lerp = (a: Vec3, b: Vec3, ta: number, tb: number): Vec3 => {
    // Guard against coincident knots (already nudged above, but be safe).
    const d = tb - ta || 1e-6;
    const w = (t - ta) / d;
    return [
      a[0] + (b[0] - a[0]) * w,
      a[1] + (b[1] - a[1]) * w,
      a[2] + (b[2] - a[2]) * w,
    ];
  };

  const a1 = lerp(p0, p1, t0, t1);
  const a2 = lerp(p1, p2, t1, t2);
  const a3 = lerp(p2, p3, t2, t3);
  const b1 = lerp(a1, a2, t0, t2);
  const b2 = lerp(a2, a3, t1, t3);
  return lerp(b1, b2, t1, t2);
}

/**
 * Accumulates raw pointer samples for one stroke and emits a deterministic,
 * evenly arc-length-spaced sequence of canonical stamp positions along a
 * centripetal Catmull-Rom spline through them.
 *
 * Lifecycle (one instance per stroke):
 *  - `pushSamples([...via, to])` on every delivered segment;
 *  - `drain()` to pull the canonical stamps finalized so far;
 *  - `head()` for the live cursor (the caller paints a provisional head stamp
 *    there each batch — idempotent under the overlay's overwrite semantics);
 *  - `finish()` on pointer-up to finalize and pull the trailing stamps;
 *  - `canonical()` for the full emitted sequence (replay-based redo, TM-319).
 */
export class StrokeGeometry {
  private readonly spacing: number;
  /** Deduped raw samples — the spline's control points. */
  private readonly controls: Vec3[] = [];
  /** All canonical stamps emitted so far (returned incrementally by `drain`). */
  private readonly emitted: Vec3[] = [];
  /** Index of the next segment to finalize (segments `< finalizedSegment` done). */
  private finalizedSegment = 0;
  /** Arc length travelled since the last emitted stamp, within finalized span. */
  private distSinceStamp = 0;
  /** The last emitted stamp position (the resample anchor). */
  private lastStamp: Vec3 | undefined;

  constructor(opts: StrokeGeometryOptions) {
    this.spacing = resolveSpacingVoxels(opts);
  }

  /** Spacing (in voxels) this stroke resamples at. */
  get spacingVoxels(): number {
    return this.spacing;
  }

  /** The live cursor — the most recent raw sample, or undefined before any. */
  head(): Vec3 | undefined {
    return this.controls.length === 0
      ? undefined
      : this.controls[this.controls.length - 1];
  }

  /** Every canonical stamp emitted so far. Stable: never reorders or moves. */
  canonical(): readonly Vec3[] {
    return this.emitted;
  }

  /** Append raw samples (consecutive duplicates are dropped). */
  pushSamples(points: readonly Vec3[]): void {
    for (const p of points) {
      const last = this.controls[this.controls.length - 1];
      if (last !== undefined && eq(last, p)) continue;
      // The very first control point is itself the first canonical stamp: it is
      // exactly where the stroke begins and the resample anchor for everything
      // after it.
      this.controls.push([p[0], p[1], p[2]]);
      if (this.lastStamp === undefined) {
        this.lastStamp = this.controls[0];
        this.emitted.push(this.controls[0]);
      }
    }
  }

  /**
   * Emit canonical stamps for every segment whose Catmull-Rom stencil is now
   * complete (i.e. `P[k+2]` exists). Returns only the stamps newly emitted by
   * this call; never re-emits or moves an earlier stamp.
   */
  drain(): Vec3[] {
    // Segment k uses P[k-1..k+2]; it is final once P[k+2] exists, i.e. while
    // k + 2 <= controls.length - 1  ⇔  k < controls.length - 2.
    return this.finalizeUpTo(this.controls.length - 2);
  }

  /**
   * Finalize the remaining segments at pointer-up (clamping the missing far
   * neighbour to the last control point) and return the trailing stamps, plus a
   * terminal stamp at the exact stroke end so the canonical path reaches it.
   */
  finish(): Vec3[] {
    const out = this.finalizeUpTo(this.controls.length - 1);
    const end = this.head();
    if (
      end !== undefined &&
      (this.lastStamp === undefined || !eq(this.lastStamp, end))
    ) {
      this.lastStamp = end;
      this.emitted.push(end);
      out.push(end);
    }
    return out;
  }

  /**
   * Walk and resample finalized segments in `[finalizedSegment, segEnd)`,
   * appending evenly arc-length-spaced stamps. `segEnd` is exclusive; for a
   * normal `drain` it is `controls.length - 2`, for `finish` it is
   * `controls.length - 1` (the final segment, with the far neighbour clamped).
   */
  private finalizeUpTo(segEnd: number): Vec3[] {
    const out: Vec3[] = [];
    for (let k = this.finalizedSegment; k < segEnd; k++) {
      const p1 = this.controls[k];
      const p2 = this.controls[k + 1];
      // Neighbours, clamped at the ends (P[-1]=P[0], P[n]=P[n-1]).
      const p0 = this.controls[k - 1] ?? p1;
      const p3 = this.controls[k + 2] ?? p2;
      this.walkSegment(p0, p1, p2, p3, out);
    }
    this.finalizedSegment = Math.max(this.finalizedSegment, segEnd);
    return out;
  }

  /**
   * Subdivide one CR segment finely, accumulate arc length along the polyline of
   * sub-points, and emit a stamp each time the running distance since the last
   * stamp crosses `spacing` (placed by linear interpolation between the two
   * straddling sub-points for arc-length accuracy).
   */
  private walkSegment(
    p0: Vec3,
    p1: Vec3,
    p2: Vec3,
    p3: Vec3,
    out: Vec3[],
  ): void {
    const chord = dist(p1, p2);
    const sub = Math.min(
      MAX_SUBSTEPS_PER_SEGMENT,
      Math.max(2, Math.ceil((chord / this.spacing) * SUBSTEPS_PER_SPACING)),
    );
    // The resample anchor is carried in `this.distSinceStamp` / `this.lastStamp`
    // across segments; within a segment we measure arc length from sub-point to
    // sub-point starting at the segment's own start (`p1`), which the previous
    // segment ended at (the curve is continuous).
    let prevPoint: Vec3 = p1;
    for (let i = 1; i <= sub; i++) {
      const u = i / sub;
      const cur = catmullRom(p0, p1, p2, p3, u);
      let segLen = dist(prevPoint, cur);
      // Emit as many stamps as fit on this sub-step (handles spacing < sub-step).
      while (this.distSinceStamp + segLen >= this.spacing) {
        const need = this.spacing - this.distSinceStamp;
        const w = segLen > 0 ? need / segLen : 0;
        const stamp: Vec3 = [
          prevPoint[0] + (cur[0] - prevPoint[0]) * w,
          prevPoint[1] + (cur[1] - prevPoint[1]) * w,
          prevPoint[2] + (cur[2] - prevPoint[2]) * w,
        ];
        this.emitted.push(stamp);
        out.push(stamp);
        this.lastStamp = stamp;
        // Continue measuring the remainder of this sub-step from the stamp.
        prevPoint = stamp;
        segLen = dist(prevPoint, cur);
        this.distSinceStamp = 0;
      }
      this.distSinceStamp += segLen;
      prevPoint = cur;
    }
  }
}
