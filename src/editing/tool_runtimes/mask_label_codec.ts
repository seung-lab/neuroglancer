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
 * @file Label codec for the z-extrapolation `propagate_mask` protocol.
 *
 * The backend model works in a compact LABEL space: the mask it receives and
 * the mask it returns hold small integers 1..N (0 = background), never real
 * segment IDs. This module owns the bijection between the tracked segment IDs
 * (real, `bigint`) and those labels:
 *  - {@link buildLabelMap} derives it once per run,
 *  - {@link labelizeMaskSlice} encodes the outgoing mask slice,
 *  - {@link delabelizeMaskSlice} decodes the model's prediction back into real
 *    IDs plus a per-voxel write gate.
 *
 * Labels travel as `uint8`, so at most {@link MAX_TRACKED_SEGMENTS} segments can
 * be tracked in one run; {@link buildLabelMap} enforces that with a typed error
 * the panel surfaces. Because the whole protocol lives in label space, it is
 * agnostic to the mask layer's real voxel data type.
 */

/** Maximum tracked segments in one propagation (labels must fit in `uint8`). */
export const MAX_TRACKED_SEGMENTS = 255;

export interface LabelMap {
  /** Real segment ID → its label (1..N). */
  readonly idToLabel: ReadonlyMap<bigint, number>;
  /** Label (1..N) → its real segment ID. */
  readonly labelToId: ReadonlyMap<number, bigint>;
}

/** Thrown when more than {@link MAX_TRACKED_SEGMENTS} segments are tracked. */
export class TooManyTrackedSegmentsError extends Error {
  constructor(readonly requested: number) {
    super(
      `Z-extrapolation can track at most ${MAX_TRACKED_SEGMENTS} segments per ` +
        `run, but ${requested} were selected.`,
    );
    this.name = "TooManyTrackedSegmentsError";
  }
}

/**
 * Build the label bijection for `trackedIds`. Background (`0n`) and duplicate
 * IDs are dropped; the surviving IDs are numbered 1..N in first-seen order so a
 * stable selection yields a stable encoding.
 *
 * @throws {TooManyTrackedSegmentsError} if more than 255 distinct IDs remain.
 */
export function buildLabelMap(trackedIds: readonly bigint[]): LabelMap {
  const idToLabel = new Map<bigint, number>();
  const labelToId = new Map<number, bigint>();
  for (const id of trackedIds) {
    if (id === 0n || idToLabel.has(id)) continue;
    const label = idToLabel.size + 1;
    idToLabel.set(id, label);
    labelToId.set(label, id);
  }
  if (idToLabel.size > MAX_TRACKED_SEGMENTS) {
    throw new TooManyTrackedSegmentsError(idToLabel.size);
  }
  return { idToLabel, labelToId };
}

/**
 * Encode a mask slice into labels. Each voxel's value is matched against the
 * tracked IDs; a tracked voxel becomes its label (1..N), every other voxel
 * becomes 0. Numeric inputs (a `uint8`/`uint16`/`uint32` mask read as a numeric
 * typed array) are widened to `bigint` for the lookup, so every integer mask
 * data type is handled uniformly alongside the `uint64` (`bigint`) case.
 */
export function labelizeMaskSlice(
  values: ArrayLike<number | bigint>,
  idToLabel: ReadonlyMap<bigint, number>,
): Uint8Array {
  const labels = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const raw = values[i];
    const id = typeof raw === "bigint" ? raw : BigInt(raw);
    const label = idToLabel.get(id);
    if (label !== undefined) labels[i] = label;
  }
  return labels;
}

export interface DecodedMaskSlice {
  /** Predicted segment ID per voxel (`0n` where nothing was predicted). */
  readonly ids: BigUint64Array;
  /** Write gate: 1 where a segment was predicted, 0 elsewhere. */
  readonly valueMask: Uint8Array;
}

/**
 * Decode the model's predicted label mask back into real segment IDs. A voxel
 * whose label maps to a tracked ID yields that ID and a set write-gate bit;
 * label 0 — and any label the map does not know — yields `0n` and a clear bit,
 * so the caller's `writeRegion` leaves those voxels untouched rather than
 * erasing them. IDs are returned as `bigint`; the write path narrows them to the
 * mask layer's real data type.
 */
export function delabelizeMaskSlice(
  labels: ArrayLike<number>,
  labelToId: ReadonlyMap<number, bigint>,
): DecodedMaskSlice {
  const ids = new BigUint64Array(labels.length);
  const valueMask = new Uint8Array(labels.length);
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (label === 0) continue;
    const id = labelToId.get(label);
    if (id === undefined) continue;
    ids[i] = id;
    valueMask[i] = 1;
  }
  return { ids, valueMask };
}
