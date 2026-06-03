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
   * Bind the R8UI 3D texture holding the per-voxel patched mask for the
   * chunk at `chunkGridPosition` to `gl.TEXTURE0 + textureUnit`. The
   * provider is responsible for any lazy upload, dirty-state tracking,
   * and texture parameters; it ALSO binds a 1×1×1 zero fallback texture
   * for chunks with no patches (so the shader can read patched=0 and
   * fall through to the baseline value path). The caller's only contract
   * is to consume the bound sampler in the current shader program — it
   * never has to manage a fallback itself.
   *
   * The provider does NOT save/restore the active texture unit — callers
   * must set `gl.activeTexture` before calling, or restore it after.
   */
  bindPatchedMaskTexture(
    gl: GL,
    textureUnit: number,
    chunkGridPosition: ArrayLike<number>,
  ): void;

  /**
   * Bind the RG32UI 3D texture holding the per-voxel patched VALUE for
   * the chunk at `chunkGridPosition` (packed `(lo32, hi32)` of a uint64
   * segment id). Same fallback semantics as `bindPatchedMaskTexture`:
   * binds a zero RG32UI texture when no patches exist for the chunk —
   * the value would never be consulted in that case anyway because the
   * mask sampler reads 0 first, but the sampler still must be bound
   * (WebGL2 forbids leaving samplers unbound).
   *
   * The two textures are upload-synchronized — a single per-chunk
   * generation counter gates both — so the mask and value seen at the
   * same fragment always come from the same overlay snapshot.
   */
  bindPatchValueTexture(
    gl: GL,
    textureUnit: number,
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
