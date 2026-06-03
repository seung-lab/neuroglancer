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
 * sample the same per-voxel patched-mask texture that the edit session's
 * `PatchedSegmentationRenderLayer` already owns and uploads.
 *
 * The base layer reaches the provider through an OPTIONAL
 * `editPatchOverlay` watchable on `SliceViewSegmentationDisplayState`. When
 * the watchable's value is `undefined` (the default — no active session),
 * the base layer compiles a shader byte-identical to the pre-hook
 * implementation. When a provider is present, the base layer adds a single
 * `usampler3D` sampler and `discard`s fragments where the per-voxel mask
 * is non-zero — leaving the patch overlay as the sole source of truth for
 * the voxel's appearance (segment color, or "nothing visible" for erase).
 *
 * The interface is intentionally minimal so the base layer doesn't depend
 * on any types from `#src/editing/...`.
 */

import type { GL } from "#src/webgl/context.js";

export interface PatchedMaskProvider {
  /**
   * Bind the R8UI 3D texture holding the per-voxel patched mask for the
   * chunk at `chunkGridPosition` to `gl.TEXTURE0 + textureUnit`. The
   * provider is responsible for any lazy upload, dirty-state tracking, and
   * texture parameters; the caller's only contract is to consume the bound
   * sampler in the current shader program.
   *
   * Returns `true` if a chunk-specific texture was bound. Returns `false`
   * when no patches exist for the chunk; in that case the caller must
   * bind its OWN 1×1×1 zero fallback so the shader's discard branch is
   * never taken (the sampler can't be left unbound on WebGL2).
   *
   * The provider does NOT save/restore the active texture unit — callers
   * must set `gl.activeTexture` before calling, or restore it after.
   */
  bindPatchedMaskTexture(
    gl: GL,
    textureUnit: number,
    chunkGridPosition: ArrayLike<number>,
  ): boolean;
}
