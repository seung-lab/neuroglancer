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
 * @file Orchestrates one z-extrapolation step: read the current slice's image +
 * mask and the next slice's image, propagate them through the backend, and write
 * the predicted segments into the next slice.
 *
 * The model runs at the IMAGE grid (max detail). When the segmentation layer is
 * at a different XY resolution, its mask is nearest-neighbor resampled onto the
 * image grid before being sent, and the predicted labels are resampled back onto
 * the mask grid before being written. Equal resolutions make both resamples an
 * identity, so one code path covers both cases. The Z (section) resolution must
 * match — the caller enforces that — so `currentZ`/`nextZ` are shared integers.
 *
 * This is a pure function of its injected collaborators (a live `Edit`, the
 * baseline chunk reader, the backend poster), so it can be exercised end-to-end
 * with fakes. The caller wraps it in `EditScope.runOperation` so the single
 * `writeRegion` becomes one native undo entry — the whole "Reset"/undo story.
 *
 * Coordinates are GLOBAL voxels at each layer's own resolution (the frame
 * `Edit.readRegion`/`writeRegion` and the chunk reader consume).
 */

import type {
  Edit,
  ChunkVoxelBuffer,
  LayerId,
  Resolution,
  ScaleMetadata,
  VoxelBox,
  VoxelDataType,
  WriteTarget,
} from "@zettaai/edit-session";

import { readBaselineImageSlice } from "#src/editing/raster/region_slice_reader.js";
import {
  resampleNearestXY,
  type Grid2D,
} from "#src/editing/raster/resample_slice.js";
import { imageScalarToUint8 } from "#src/editing/tool_runtimes/image_scalar_to_uint8.js";
import { clampToVoxelDataType } from "#src/editing/tool_runtimes/mask_coord.js";
import {
  buildLabelMap,
  delabelizeMaskSlice,
  labelizeMaskSlice,
} from "#src/editing/tool_runtimes/mask_label_codec.js";
import type { ReadChunkAt } from "#src/editing/tool_runtimes/painting_tools.js";
import {
  propagateMask,
  type MultipartPoster,
} from "#src/editing/tool_runtimes/propagate_mask_client.js";

/** The read-only image layer feeding the propagation. */
export interface ImageReadSpec {
  readonly layerId: LayerId;
  readonly resolution: Resolution;
  readonly scale: ScaleMetadata;
  readonly dataType: VoxelDataType;
}

/** The writable mask (segmentation) layer the prediction is written into. */
export interface MaskWriteSpec {
  readonly layerId: LayerId;
  readonly resolution: Resolution;
  readonly scale: ScaleMetadata;
  readonly dataType: VoxelDataType;
}

/**
 * A single-Z rectangular window (GLOBAL voxels at its layer's resolution) plus
 * the source and target Z. `currentZ` is where the user's mask lives; `nextZ` is
 * where the prediction is written (`currentZ ± 1`). Because the Z resolution is
 * shared, the image and mask windows carry the same `currentZ`/`nextZ`.
 */
export interface PropagateWindow {
  readonly originX: number;
  readonly originY: number;
  readonly width: number;
  readonly height: number;
  readonly currentZ: number;
  readonly nextZ: number;
}

export interface PropagateSliceContext {
  /** Live edit: reads the current mask through the overlay, writes the result. */
  readonly edit: Edit;
  /** Baseline chunk reader for the (read-only) image layer. */
  readonly readChunkAt: ReadChunkAt;
  /** Backend poster (the shared `BackendClient`). */
  readonly client: MultipartPoster;
  readonly image: ImageReadSpec;
  readonly mask: MaskWriteSpec;
  /** The propagation window in the IMAGE grid (the model runs here). */
  readonly imageWindow: PropagateWindow;
  /** The propagation window in the MASK grid (mask is read/written here). */
  readonly maskWindow: PropagateWindow;
  /** Real segment IDs to propagate; labelized 1..N for transport. */
  readonly trackedIds: readonly bigint[];
  readonly signal?: AbortSignal;
}

export interface PropagateSliceResult {
  /** Number of voxels the prediction wrote into the next slice. */
  readonly voxelsWritten: number;
}

export async function propagateSlice(
  ctx: PropagateSliceContext,
): Promise<PropagateSliceResult> {
  const { edit, image, mask, imageWindow, maskWindow } = ctx;
  const imageGrid = gridOf(imageWindow, image.scale);
  const maskGrid = gridOf(maskWindow, mask.scale);
  const maskTarget: WriteTarget = {
    layerId: mask.layerId,
    resolution: mask.resolution,
  };

  // Encode the tracked IDs → labels once; both directions of the codec share it.
  const { idToLabel, labelToId } = buildLabelMap(ctx.trackedIds);

  // Current mask through the overlay (includes live paint), at the mask grid,
  // then labelized and resampled onto the image grid the model runs on.
  const maskRegion = await edit.readRegion(
    maskTarget,
    sliceBox(maskWindow, maskWindow.currentZ),
  );
  const maskLabels = resampleNearestXY(
    labelizeMaskSlice(maskRegion.data, idToLabel),
    maskGrid,
    imageGrid,
  );

  // Current + next image slices, read natively at the image grid.
  const currentImage = imageScalarToUint8(
    await readBaselineImageSlice(
      ctx.readChunkAt,
      image.layerId,
      image.resolution,
      image.scale,
      imageSlice(imageWindow, imageWindow.currentZ),
    ),
    image.dataType,
  );
  const nextImage = imageScalarToUint8(
    await readBaselineImageSlice(
      ctx.readChunkAt,
      image.layerId,
      image.resolution,
      image.scale,
      imageSlice(imageWindow, imageWindow.nextZ),
    ),
    image.dataType,
  );

  const { predictedLabels } = await propagateMask(
    ctx.client,
    {
      currentImage,
      maskLabels,
      nextImage,
      width: imageWindow.width,
      height: imageWindow.height,
    },
    ctx.signal,
  );
  assertSliceLength(
    predictedLabels.length,
    imageWindow.width * imageWindow.height,
  );

  // Resample the prediction back onto the mask grid, decode labels → real IDs
  // (+ write gate), and write only the predicted voxels.
  const predictedOnMask = resampleNearestXY(
    predictedLabels,
    imageGrid,
    maskGrid,
  );
  const { ids, valueMask } = delabelizeMaskSlice(predictedOnMask, labelToId);
  await edit.writeRegion(
    maskTarget,
    denseMaskBuffer(ids, mask.dataType),
    sliceBox(maskWindow, maskWindow.nextZ),
    { valueMask },
  );

  return { voxelsWritten: countSet(valueMask) };
}

/** The XY grid a window addresses, at its layer's voxel size. */
function gridOf(window: PropagateWindow, scale: ScaleMetadata): Grid2D {
  return {
    width: window.width,
    height: window.height,
    originX: window.originX,
    originY: window.originY,
    voxelSizeNmX: scale.voxelSizeNm[0],
    voxelSizeNmY: scale.voxelSizeNm[1],
  };
}

/** Single-Z `VoxelBox` for slice `z` of `window`. */
function sliceBox(window: PropagateWindow, z: number): VoxelBox {
  return {
    origin: [window.originX, window.originY, z],
    size: [window.width, window.height, 1],
  };
}

/** The `SliceWindow` the image reader consumes for slice `z` of `window`. */
function imageSlice(window: PropagateWindow, z: number) {
  return {
    originX: window.originX,
    originY: window.originY,
    z,
    width: window.width,
    height: window.height,
  };
}

const NUMERIC_VOXEL_ARRAY: Record<
  Exclude<VoxelDataType, "uint64">,
  | Uint8ArrayConstructor
  | Int8ArrayConstructor
  | Uint16ArrayConstructor
  | Int16ArrayConstructor
  | Uint32ArrayConstructor
  | Int32ArrayConstructor
  | Float32ArrayConstructor
> = {
  uint8: Uint8Array,
  int8: Int8Array,
  uint16: Uint16Array,
  int16: Int16Array,
  uint32: Uint32Array,
  int32: Int32Array,
  float32: Float32Array,
};

/**
 * Narrow decoded `bigint` IDs into a dense buffer of the mask layer's real data
 * type. `uint64` passes through as the `BigUint64Array` the decoder already
 * built; every other type is filled with the clamped numeric value.
 */
function denseMaskBuffer(
  ids: BigUint64Array,
  dataType: VoxelDataType,
): ChunkVoxelBuffer {
  if (dataType === "uint64") return ids;
  const dense = new NUMERIC_VOXEL_ARRAY[dataType](ids.length);
  for (let i = 0; i < ids.length; i++) {
    dense[i] = clampToVoxelDataType(dataType, ids[i]) as number;
  }
  return dense;
}

function countSet(mask: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 0) count++;
  }
  return count;
}

function assertSliceLength(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new Error(
      `propagate_mask returned ${actual} label voxels, expected ${expected} ` +
        `(width*height) — slice shape mismatch.`,
    );
  }
}
