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
 * @file Cross-layer hook contract: lets the base `SegmentationRenderLayer`
 * sample the per-voxel patched value AND patched mask textures owned by
 * the edit session's `PatchTextureCache`.
 *
 * The base layer reaches the provider through an OPTIONAL
 * `editPatchOverlay` watchable on `SliceViewSegmentationDisplayState`. When
 * the watchable's value is `undefined` (the default — no active session),
 * the base layer compiles a shader byte-identical to the pre-hook
 * implementation. When a provider is present, the base layer's
 * `getUint64DataValue` becomes patch-aware: at every fragment, it samples
 * the mask first and substitutes the patch value when the user has edited
 * that voxel. The rest of the segmentation shader (hover highlight,
 * selected-segment highlight, equivalences, stated colors, `hideSegmentZero`)
 * then runs uniformly across baseline and patched voxels — that's why erase
 * (value 0) shows the image layer through at full opacity (it goes through
 * the existing `hideSegmentZero` path) and paint-over composes at the
 * user's segmentation alpha (same uniform branch as a baseline voxel).
 *
 * The interface is intentionally minimal so the base layer doesn't depend
 * on any types from `#src/editing/...`.
 */

import type { NullarySignal } from "#src/util/signal.js";
import type { GL } from "#src/webgl/context.js";

export interface PatchedMaskProvider {
  /**
   * Fires whenever the patched mask / value snapshot the provider exposes
   * changes — e.g. a paint stroke or erase mutated the underlying
   * `LocalPatchStore`. The base `SegmentationRenderLayer` subscribes to
   * this to schedule a redraw; without it, paint strokes would not
   * become visible until something else (camera move, layer toggle)
   * triggered a redraw incidentally.
   */
  readonly changed: NullarySignal;

  /**
   * Whether the overlay textures for this layer are 3D (`true`) or 2D
   * (`false`). Chunks are packed into a 2D or 3D texture exactly like
   * neuroglancer's base volume chunks — a large flat chunk (e.g.
   * `[4096, 4096, 1]`) becomes a 2D texture because a 3D texture of that
   * extent overflows `gl.max3dTextureSize`. The base layer sets the
   * `uPatchIs3D` uniform from this so the shader samples the matching
   * sampler. Constant for the life of the provider once a chunk exists.
   */
  readonly is3D: boolean;

  /**
   * Per-chunk-axis texel strides, packed for an `ivec3[3]` uniform
   * (`strides[axis * 3 + texDim]`), so the shader can map a chunk-local
   * voxel position `p` to a texel coordinate
   * `t = p.x*strides[0] + p.y*strides[1] + p.z*strides[2]`. Matches how the
   * provider laid the data out on upload. Constant for the life of the
   * provider once a chunk exists.
   */
  readonly patchStrides: Int32Array;

  /**
   * Bind the R8UI patched-mask texture for the chunk at `chunkGridPosition`.
   * The real texture (2D or 3D per {@link is3D}) is bound to its matching
   * unit; a 1-texel fallback is bound to the other so BOTH declared samplers
   * stay texture-complete. Chunks with no patches get the zero fallback on
   * both units (so the shader reads patched=0 and falls through to the
   * baseline value path).
   *
   * The provider sets `gl.activeTexture` itself for each unit; callers should
   * save/restore the previously-active unit around the call.
   */
  bindPatchedMaskTextures(
    gl: GL,
    unit2D: number,
    unit3D: number,
    chunkGridPosition: ArrayLike<number>,
  ): void;

  /**
   * Bind the RG32UI patched-VALUE texture (packed `(lo32, hi32)` of a uint64
   * segment id) for the chunk at `chunkGridPosition`. Same 2D/3D + fallback
   * semantics as {@link bindPatchedMaskTextures}. The value and mask textures
   * are upload-synchronized so the mask and value seen at the same fragment
   * always come from the same overlay snapshot.
   */
  bindPatchValueTextures(
    gl: GL,
    unit2D: number,
    unit3D: number,
    chunkGridPosition: ArrayLike<number>,
  ): void;

  /**
   * CPU-side counterpart to the GPU samplers: returns the per-voxel
   * patched value at `chunkGridPosition` + `localOffset`, or `undefined`
   * when no patch exists at that voxel (caller falls through to the
   * baseline chunk source).
   *
   * Why this lives on the provider: in slice view, the segmentation
   * render layer does NOT participate in the GPU picking framebuffer.
   * Hover values are resolved CPU-side by
   * `SliceViewVolumeRenderLayer.getValueAt(globalPosition)`, which calls
   * `source.getValueAt(...)` — that reads the baseline only and is
   * unaware of patches. Without this method, hovering an edited voxel
   * picks the BASELINE segment id, the highlight uniform points at
   * baseline, and the patched fragment fails its
   * `value == uSelectedSegment` test so it doesn't light up.
   *
   * `0n` is a valid return value (erase-to-zero is a real edit). Callers
   * must distinguish `undefined` (no patch — fall through) from `0n` (the
   * user erased this voxel).
   */
  getPatchedValueAt(
    chunkGridPosition: ArrayLike<number>,
    localOffset: readonly [number, number, number],
  ): bigint | undefined;
}
