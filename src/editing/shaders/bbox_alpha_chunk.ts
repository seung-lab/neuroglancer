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
 * @file Shared bbox-alpha shader hook.
 *
 * When an edit session is active, voxels outside the session bbox are
 * de-emphasized at fragment-shader time by multiplying the emitted alpha by
 * a small factor (default 0.25). Inside the bbox the alpha is unchanged.
 *
 * This module is imported by `SegmentationRenderLayer` (step 15),
 * `ImageRenderLayer` (step 16), and `PatchedSegmentationRenderLayer`
 * (step 17). The hook is *parameter-gated* — the integrating render layer
 * is expected to gate `defineUniforms` + `fragmentSnippet` behind an
 * `editBboxActive: boolean` shader parameter so that, when no session is
 * active, the shader source is byte-identical to its pre-hook form.
 *
 * The chunk-space coordinate of the fragment is assumed to be exposed as
 * the `vChunkPosition` varying (a `highp vec3` defined in
 * `src/sliceview/volume/renderlayer.ts`'s `defineVolumeShader`).
 *
 * See `docs/edit-session-integration/architecture/06-bbox-rendering.md`.
 */

import type { vec3 } from "#src/util/geom.js";
import type { GL } from "#src/webgl/context.js";
import type { ShaderBuilder, ShaderProgram } from "#src/webgl/shader.js";

const DEFAULT_OUTSIDE_ALPHA_MULTIPLIER = 0.25;

export interface BboxAlphaParams {
  /**
   * Voxel coordinates of the session bbox lower/upper corner in the layer's
   * chunk space. `undefined` means "no session active" — no dimming.
   */
  bbox: { loVoxel: vec3; hiVoxel: vec3 } | undefined;
  /**
   * Alpha multiplier for fragments outside the bbox. Defaults to 0.25.
   * Ignored when `bbox === undefined`.
   */
  outsideAlphaMultiplier?: number;
}

export interface BboxAlphaShaderHook {
  /**
   * Declares the uniforms the hook needs on the given `ShaderBuilder`.
   * Must only be called when the integrating render layer's shader is being
   * built in `editBboxActive === true` mode.
   */
  defineUniforms(builder: ShaderBuilder): void;

  /**
   * Binds the per-draw uniforms based on the current session state.
   *
   * If `params.bbox === undefined`, sets `u_editBboxActive = 0` and the
   * remaining uniforms to safe defaults. Otherwise sets the bbox lo/hi
   * voxels and the outside-alpha multiplier.
   */
  bind(gl: GL, shader: ShaderProgram, params: BboxAlphaParams): void;

  /**
   * Returns a glsl fragment-code snippet that defines a single function:
   *
   *   void emitWithBboxDim(vec4 rgba);
   *
   * Callers add this snippet via `builder.addFragmentCode(...)` and then
   * either replace their `emit(color)` calls with `emitWithBboxDim(color)`
   * or use the convenience helper `wrapFragmentMain`.
   */
  fragmentSnippet(): string;

  /**
   * Convenience: returns a glsl snippet defining the helper AND a `#define`
   * that re-routes `emit(rgba)` calls to `emitWithBboxDim(rgba)`. Use this
   * when you want the wrap to apply to the whole fragmentMain body without
   * editing existing source strings.
   *
   * The `#define emit` macro is intentionally NOT included by default
   * because it would conflict with the base layer's `void emit(vec4 color)`
   * function definition (the macro expansion would corrupt the function
   * declaration itself). Therefore use this only for downstream layers that
   * do not redefine `emit` themselves.
   */
  fragmentSnippetWithEmitMacro(): string;

  /**
   * Pure-function helper: takes the existing fragmentMain body source and
   * returns a new body where every `emit(<expr>)` call has been replaced by
   * `emitWithBboxDim(<expr>)` (default), or by a caller-specified target
   * function name (e.g. `"emitOnlyInsideBbox"` for the hard-clip variant
   * used by `PatchedSegmentationRenderLayer`). This avoids the
   * macro-trampoline trick at the cost of touching the fragmentMain source.
   *
   * The `targetName` overload is backwards-compatible: existing call sites
   * that pass only the main body continue to receive the `emitWithBboxDim`
   * wrapping unchanged.
   */
  wrapFragmentMain(originalMain: string, targetName?: string): string;
}

/**
 * Builds a fresh bbox-alpha shader hook. The hook is stateless across calls;
 * a single instance can be shared across multiple shader compiles for the
 * same render layer.
 */
export function createBboxAlphaShaderHook(): BboxAlphaShaderHook {
  return {
    defineUniforms(builder: ShaderBuilder) {
      builder.addUniform("highp vec3", "u_editBboxLoVoxel");
      builder.addUniform("highp vec3", "u_editBboxHiVoxel");
      builder.addUniform("highp float", "u_editBboxOutsideAlpha");
      // 0 = inactive (no dimming, byte-identical visual to no-session path),
      // 1 = active.
      builder.addUniform("highp int", "u_editBboxActive");
    },

    bind(gl: GL, shader: ShaderProgram, params: BboxAlphaParams) {
      const { bbox } = params;
      if (bbox === undefined) {
        // Inactive — keep uniforms at safe defaults so any stale value
        // doesn't leak through the `if (u_editBboxActive == 1)` guard.
        gl.uniform3f(shader.uniform("u_editBboxLoVoxel"), 0, 0, 0);
        gl.uniform3f(shader.uniform("u_editBboxHiVoxel"), 0, 0, 0);
        gl.uniform1f(shader.uniform("u_editBboxOutsideAlpha"), 1.0);
        gl.uniform1i(shader.uniform("u_editBboxActive"), 0);
        return;
      }
      const outsideAlpha =
        params.outsideAlphaMultiplier ?? DEFAULT_OUTSIDE_ALPHA_MULTIPLIER;
      gl.uniform3fv(shader.uniform("u_editBboxLoVoxel"), bbox.loVoxel);
      gl.uniform3fv(shader.uniform("u_editBboxHiVoxel"), bbox.hiVoxel);
      gl.uniform1f(shader.uniform("u_editBboxOutsideAlpha"), outsideAlpha);
      gl.uniform1i(shader.uniform("u_editBboxActive"), 1);
    },

    fragmentSnippet() {
      return BBOX_ALPHA_FRAGMENT_SNIPPET;
    },

    fragmentSnippetWithEmitMacro() {
      return (
        BBOX_ALPHA_FRAGMENT_SNIPPET +
        "\n#define emit(rgba) emitWithBboxDim(rgba)\n"
      );
    },

    wrapFragmentMain(
      originalMain: string,
      targetName: string = "emitWithBboxDim",
    ): string {
      // Replace whole-token `emit(` with `${targetName}(`. We restrict the
      // boundary character to ensure we don't accidentally rewrite a
      // similarly-prefixed identifier.
      return originalMain.replace(/\bemit\s*\(/g, `${targetName}(`);
    },
  };
}

/**
 * Fragment shader snippet defining `emitWithBboxDim`.
 *
 * Assumes the integrating shader exposes both `vChunkPosition` (a
 * `highp vec3`, chunk-LOCAL voxel coordinate in `[0, chunkDataSize)`) and
 * the `uTranslation` uniform (`highp vec3`, the chunk's origin in the
 * layer's chunk-grid frame; cf. `src/sliceview/volume/renderlayer.ts:99`).
 * Both are emitted by `defineVolumeShader` for every
 * `SliceViewVolumeRenderLayer`-derived shader.
 *
 * `vChunkPosition + uTranslation` is the fragment's voxel coordinate in the
 * layer's CHUNK-GRID frame (i.e., layer absolute voxel coord minus the
 * layer's `voxelOffset`). The bbox uniforms supplied via `bind()` MUST be
 * in this same chunk-grid frame; see `EditSessionHost.computeActiveRegion`,
 * which subtracts `voxelOffset` for exactly this purpose.
 *
 * Also assumes the base render layer has defined `void emit(vec4 color)`
 * before this snippet is added (true for `defineVolumeShader`-derived
 * shaders).
 */
const BBOX_ALPHA_FRAGMENT_SNIPPET = `
void emitWithBboxDim(vec4 rgba) {
  float dim = 1.0;
  if (u_editBboxActive == 1) {
    vec3 v = vChunkPosition + uTranslation;
    bool inside =
      v.x >= u_editBboxLoVoxel.x && v.x < u_editBboxHiVoxel.x &&
      v.y >= u_editBboxLoVoxel.y && v.y < u_editBboxHiVoxel.y &&
      v.z >= u_editBboxLoVoxel.z && v.z < u_editBboxHiVoxel.z;
    dim = inside ? 1.0 : u_editBboxOutsideAlpha;
  }
  emit(vec4(rgba.rgb, rgba.a * dim));
}
`;
