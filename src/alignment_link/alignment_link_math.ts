/**
 * @license
 * Copyright 2026 Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Transform fitting for the annotation-linked view sync
 * (alignment_link_session.ts).
 *
 * Fits a 2D (xy) transform T with a constant z offset from line-annotation
 * correspondences, mapping leader-view positions to follower-view positions:
 *
 *   T(x) = M * [x, y] + t,   z' = z + dz
 *
 * Model cascade ("local"/"affine" -> "similarity" -> "translation"):
 *  - 1 pair (or coincident pairs): pure translation — behaves exactly like
 *    neuroglancer's built-in "relative" position link.
 *  - 2 pairs (or collinear pairs): similarity (rotation + uniform scale +
 *    translation), the conformal least-squares fit.
 *  - 3+ non-collinear pairs: full affine via weighted normal equations.
 *  - "local" model: inverse-square-distance weights centered on the current
 *    position, i.e. moving least squares. Nearby correspondences dominate, and
 *    the z term of the distance is scaled up so lines from other section pairs
 *    (other slab transitions) are effectively ignored.
 *
 * Fits implying a scale above ~100x (near-coincident leader endpoints with
 * far-apart follower endpoints) degrade to the next simpler model instead of
 * slinging the view across the volume.
 */

export interface AlignmentPair {
  /** Endpoint in the leader view's data, [x, y, z] voxel coordinates. */
  p: ArrayLike<number>;
  /** Corresponding endpoint in the follower view's data. */
  q: ArrayLike<number>;
}

export type AlignmentModel = "local" | "translation" | "similarity" | "affine";

export interface AlignmentFit {
  m00: number;
  m01: number;
  m10: number;
  m11: number;
  tx: number;
  ty: number;
  dz: number;
  mode: "translation" | "similarity" | "affine";
  count: number;
}

export function fitAlignmentTransform(
  pairs: readonly AlignmentPair[],
  target: ArrayLike<number>,
  model: AlignmentModel,
  zWeight = 1000,
): AlignmentFit | null {
  const valid: AlignmentPair[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const { p, q } = pairs[i];
    if (!p || !q || p.length < 3 || q.length < 3) continue;
    let finite = true;
    for (let d = 0; d < 3; d++) {
      if (!Number.isFinite(p[d]) || !Number.isFinite(q[d])) finite = false;
    }
    if (finite) valid.push(pairs[i]);
  }
  if (valid.length === 0) return null;

  // Inverse-square-distance weights (moving least squares) for "local";
  // uniform weights otherwise. EPS bounds the weight at an exact hit so the
  // fit interpolates annotation endpoints almost exactly.
  const EPS = 1e-3;
  const weights: number[] = [];
  let wSum = 0;
  for (let i = 0; i < valid.length; i++) {
    let w = 1;
    if (model === "local") {
      const p = valid[i].p;
      const dx = p[0] - target[0];
      const dy = p[1] - target[1];
      const dzT = p[2] - target[2];
      w = 1 / (dx * dx + dy * dy + zWeight * dzT * dzT + EPS);
    }
    weights.push(w);
    wSum += w;
  }

  // Weighted centroids.
  let pcx = 0;
  let pcy = 0;
  let qcx = 0;
  let qcy = 0;
  let dz = 0;
  for (let i = 0; i < valid.length; i++) {
    const w = weights[i] / wSum;
    const { p, q } = valid[i];
    pcx += w * p[0];
    pcy += w * p[1];
    qcx += w * q[0];
    qcy += w * q[1];
    dz += w * (q[2] - p[2]);
  }

  // Centered second moments: A = sum w p^ p^T, B = sum w q^ p^T.
  let a00 = 0;
  let a01 = 0;
  let a11 = 0;
  let b00 = 0;
  let b01 = 0;
  let b10 = 0;
  let b11 = 0;
  let traceB = 0;
  for (let i = 0; i < valid.length; i++) {
    const w = weights[i] / wSum;
    const { p, q } = valid[i];
    const px = p[0] - pcx;
    const py = p[1] - pcy;
    const qx = q[0] - qcx;
    const qy = q[1] - qcy;
    a00 += w * px * px;
    a01 += w * px * py;
    a11 += w * py * py;
    b00 += w * qx * px;
    b01 += w * qx * py;
    b10 += w * qy * px;
    b11 += w * qy * py;
    traceB += w * (qx * qx + qy * qy);
  }

  let m00 = 1;
  let m01 = 0;
  let m10 = 0;
  let m11 = 1;
  let mode: AlignmentFit["mode"] = "translation";

  const wantAffine = model === "local" || model === "affine";
  const wantSimilarity = wantAffine || model === "similarity";
  const detA = a00 * a11 - a01 * a01;
  const traceA = a00 + a11;
  // Relative conditioning guard: near-collinear points make the affine
  // solution explode, so fall back to similarity below this threshold.
  const RCOND = 1e-6;
  // Scale cap: correspondences whose leader-side spread is tiny relative to
  // the follower-side spread (e.g. two lines drawn from almost the same
  // landmark) imply an absurd scale; degrade to a simpler model instead of
  // slinging the follower view across the volume.
  const MAX_SCALE_SQ = 1e4;

  if (wantAffine && detA > RCOND * traceA * traceA) {
    const inv00 = a11 / detA;
    const inv01 = -a01 / detA;
    const inv11 = a00 / detA;
    const c00 = b00 * inv00 + b01 * inv01;
    const c01 = b00 * inv01 + b01 * inv11;
    const c10 = b10 * inv00 + b11 * inv01;
    const c11 = b10 * inv01 + b11 * inv11;
    if (c00 * c00 + c01 * c01 + c10 * c10 + c11 * c11 <= MAX_SCALE_SQ) {
      m00 = c00;
      m01 = c01;
      m10 = c10;
      m11 = c11;
      mode = "affine";
    }
  }
  if (
    mode === "translation" &&
    wantSimilarity &&
    traceA > 1e-12 &&
    // Cauchy-Schwarz: sa^2 + sb^2 <= traceB / traceA, so this bounds the
    // fitted similarity scale by sqrt(MAX_SCALE_SQ).
    traceB <= MAX_SCALE_SQ * traceA
  ) {
    // Conformal least squares: minimize sum w |q^ - S p^|^2 over
    // S = [[a, -b], [b, a]].
    const sa = (b00 + b11) / traceA;
    const sb = (b10 - b01) / traceA;
    m00 = sa;
    m01 = -sb;
    m10 = sb;
    m11 = sa;
    mode = "similarity";
  }

  return {
    m00,
    m01,
    m10,
    m11,
    tx: qcx - (m00 * pcx + m01 * pcy),
    ty: qcy - (m10 * pcx + m11 * pcy),
    dz,
    mode,
    count: valid.length,
  };
}

export function applyAlignmentTransform(
  fit: AlignmentFit,
  pos: ArrayLike<number>,
): [number, number, number] {
  return [
    fit.m00 * pos[0] + fit.m01 * pos[1] + fit.tx,
    fit.m10 * pos[0] + fit.m11 * pos[1] + fit.ty,
    pos[2] + fit.dz,
  ];
}

/**
 * In-plane rotation angle (radians, about z) of the fit's linear part: the
 * angle of the closest rotation matrix in the polar decomposition. Exact for
 * similarity fits; for affine fits it is the best rigid approximation. Only
 * meaningful for orientation-preserving fits — for mirrored fits
 * (det(M) < 0) the closest-rotation objective is flat and callers should not
 * apply any rotation.
 */
export function alignmentRotationAngle(fit: AlignmentFit): number {
  return Math.atan2(fit.m10 - fit.m01, fit.m00 + fit.m11);
}

/** True when the fitted linear part contains a reflection (flipped section). */
export function alignmentIsMirrored(fit: AlignmentFit): boolean {
  return fit.m00 * fit.m11 - fit.m01 * fit.m10 < 0;
}
