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
 * @file Shared bbox-clip shader hook.
 *
 * When an edit session is active, voxels outside the session bbox are
 * HARD-CLIPPED (the shader `discard`s the fragment). Used by
 * `SegmentationRenderLayer`, `ImageRenderLayer`, and
 * `PatchedSegmentationRenderLayer` so the user only sees data inside the
 * current bbox while a session is open.
 *
 * The bbox is expressed in the viewer's DISPLAY coordinate space — the
 * same frame as `viewer.position.value` and what the annotation render
 * layer uses to draw bbox annotations. The fragment's chunk-grid voxel
 * position is converted to display coords via the `uChunkToGlobal`
 * uniform that `defineVolumeShader` declares and `beginSource` binds per
 * source to `chunkLayout.transform`. Using display coords (not nm and
 * not the session's chosen layer-scale chunk-grid voxels) keeps the
 * comparison resolution-independent — the shader works regardless of
 * which scale the viewer actually picked to render.
 *
 * The hook is *parameter-gated*: the integrating render layer gates
 * `defineUniforms` + `fragmentSnippet` behind an `editBboxActive: boolean`
 * shader parameter so that when no session is active the shader source is
 * byte-identical to its pre-hook form (no cost, no behavior change).
 *
 * See `docs/edit-session-integration/architecture/06-bbox-rendering.md`.
 */

import type { vec3 } from "#src/util/geom.js";
import type { GL } from "#src/webgl/context.js";
import type { ShaderBuilder, ShaderProgram } from "#src/webgl/shader.js";

export interface BboxAlphaParams {
  /**
   * Lower/upper corner of the session bbox in the viewer's DISPLAY
   * coordinate space (same frame as `chunkLayout.transform`'s output and
   * `viewer.position.value`). `undefined` means "no session active" —
   * uniforms are bound to safe defaults and the shader's `editBboxActive`
   * gate keeps the discard path inactive.
   */
  bboxNm: { lo: vec3; hi: vec3 } | undefined;
}

export interface BboxAlphaShaderHook {
  /**
   * Declares the uniforms the hook needs on the given `ShaderBuilder`.
   * Must only be called when the integrating render layer's shader is being
   * built in `editBboxActive === true` mode. (The `uChunkToGlobal` uniform
   * itself is declared by `defineVolumeShader` and is always present in
   * volume render layer shaders, so we don't redeclare it here.)
   */
  defineUniforms(builder: ShaderBuilder): void;

  /**
   * Binds the per-draw uniforms based on the current session state.
   *
   * If `params.bboxNm === undefined`, sets `u_editBboxActive = 0` and the
   * remaining uniforms to safe defaults. Otherwise sets the bbox lo/hi in
   * the layer's global (nm) frame.
   */
  bind(gl: GL, shader: ShaderProgram, params: BboxAlphaParams): void;

  /**
   * Returns a glsl fragment-code snippet that defines a single function:
   *
   *   void emitWithBboxDim(vec4 rgba);
   *
   * Despite the name (retained for historical reasons), the snippet now
   * HARD-CLIPS (discards) fragments outside the bbox; it does not dim.
   */
  fragmentSnippet(): string;

  /**
   * Convenience: returns a glsl snippet defining the helper AND a `#define`
   * that re-routes `emit(rgba)` calls to `emitWithBboxDim(rgba)`.
   */
  fragmentSnippetWithEmitMacro(): string;

  /**
   * Pure-function helper: takes the existing fragmentMain body source and
   * returns a new body where every `emit(<expr>)` call has been replaced by
   * `emitWithBboxDim(<expr>)` (default), or by a caller-specified target
   * function name.
   */
  wrapFragmentMain(originalMain: string, targetName?: string): string;
}

/**
 * Builds a fresh bbox-clip shader hook. The hook is stateless across calls;
 * a single instance can be shared across multiple shader compiles for the
 * same render layer.
 */
export function createBboxAlphaShaderHook(): BboxAlphaShaderHook {
  return {
    defineUniforms(builder: ShaderBuilder) {
      builder.addUniform("highp vec3", "u_editBboxLoNm");
      builder.addUniform("highp vec3", "u_editBboxHiNm");
      // 0 = inactive (no clipping, byte-identical visual to no-session path),
      // 1 = active.
      builder.addUniform("highp int", "u_editBboxActive");
    },

    bind(gl: GL, shader: ShaderProgram, params: BboxAlphaParams) {
      const { bboxNm } = params;
      if (bboxNm === undefined) {
        gl.uniform3f(shader.uniform("u_editBboxLoNm"), 0, 0, 0);
        gl.uniform3f(shader.uniform("u_editBboxHiNm"), 0, 0, 0);
        gl.uniform1i(shader.uniform("u_editBboxActive"), 0);
        return;
      }
      gl.uniform3fv(shader.uniform("u_editBboxLoNm"), bboxNm.lo);
      gl.uniform3fv(shader.uniform("u_editBboxHiNm"), bboxNm.hi);
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
      return originalMain.replace(/\bemit\s*\(/g, `${targetName}(`);
    },
  };
}

/**
 * Fragment shader snippet defining `emitWithBboxDim`.
 *
 * The snippet relies on uniforms declared elsewhere:
 *   - `uChunkToGlobal` (mat4, per source) — declared in
 *     `defineVolumeShader`, bound in `beginSource` to `chunkLayout.transform`.
 *     Converts chunk-grid voxel coords to the layer's global frame (nm).
 *   - `u_editBboxLoNm`, `u_editBboxHiNm`, `u_editBboxActive` — declared by
 *     this hook's `defineUniforms`, bound by `bind()`.
 *
 * Assumes the integrating shader exposes `vChunkPosition` (chunk-LOCAL voxel
 * coord in `[0, chunkDataSize)`) and `uTranslation` (chunk's origin in
 * chunk-grid voxels), both from `defineVolumeShader`.
 *
 * Despite the historical name, the snippet HARD-CLIPS (discards) outside
 * the bbox — see the file-level docstring.
 */
const BBOX_ALPHA_FRAGMENT_SNIPPET = `
void emitWithBboxDim(vec4 rgba) {
  if (u_editBboxActive == 1) {
    vec4 globalNm4 = uChunkToGlobal * vec4(vChunkPosition + uTranslation, 1.0);
    vec3 globalNm = globalNm4.xyz / globalNm4.w;
    bool inside =
      globalNm.x >= u_editBboxLoNm.x && globalNm.x < u_editBboxHiNm.x &&
      globalNm.y >= u_editBboxLoNm.y && globalNm.y < u_editBboxHiNm.y &&
      globalNm.z >= u_editBboxLoNm.z && globalNm.z < u_editBboxHiNm.z;
    if (!inside) {
      discard;
    }
  }
  emit(rgba);
}
`;
