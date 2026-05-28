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
 * @file Voxel-edit patch overlay render layer.
 *
 * DESIGN (v1, debug-first): a minimal SliceViewVolumeRenderLayer subclass
 * with a SIMPLE shader that ignores the segmentation rendering machinery
 * entirely. For each chunk it samples the patch texture. Patched voxels
 * emit BRIGHT RED (alpha=1). Unpatched voxels emit transparent.
 *
 * This deliberately bypasses the segment color hash, equivalence remap,
 * visibility check, and per-segment alpha that the segmentation render
 * layer applies — those were silently swallowing patches in earlier
 * iterations. Once we confirm patches render at all, we can graduate to
 * proper segment-color rendering.
 */

import type { LocalPatchChunk } from "#src/editing/local_patch_chunk.js";
import type { LocalPatchStore } from "#src/editing/local_patch_store.js";
import { chunkGridKey } from "#src/editing/local_patch_source.js";
import type { BboxAlphaShaderHook } from "#src/editing/shaders/bbox_alpha_chunk.js";
import { createBboxAlphaShaderHook } from "#src/editing/shaders/bbox_alpha_chunk.js";
import { SegmentColorShaderManager } from "#src/segment_color.js";
import type { SliceViewSegmentationDisplayState } from "#src/sliceview/volume/segmentation_renderlayer.js";
import type {
  MultiscaleVolumeChunkSource,
  VolumeChunk,
} from "#src/sliceview/volume/frontend.js";
import type { SliceView } from "#src/sliceview/frontend.js";
import { SliceViewVolumeRenderLayer } from "#src/sliceview/volume/renderlayer.js";
import {
  AggregateWatchableValue,
  constantWatchableValue,
  makeCachedDerivedWatchableValue,
} from "#src/trackable_value.js";
import type { GL } from "#src/webgl/context.js";
import type { ShaderBuilder, ShaderProgram } from "#src/webgl/shader.js";

const patchTextureUnitSymbol = Symbol(
  "PatchedSegmentationRenderLayer.patchTexture",
);

interface PatchShaderParameters {
  // Empty — but the framework requires SOMETHING parameterized so
  // shaderGetter has a parameters watchable to subscribe to. Use a literal
  // structure so encodeShaderParameters returns a stable JSON value.
  version: number;
  /**
   * Voxel-edit bbox-clip shader path gate. Defaults to `false`; flips to
   * `true` only while an edit session bbox is set for this layer. When
   * `false`, the bbox-clip uniforms/snippet are NOT added to the shader and
   * the compiled GLSL is byte-identical to the pre-hook implementation.
   *
   * Unlike `SegmentationRenderLayer`'s bbox-dim path (which fades
   * out-of-bbox fragments to 0.25x alpha), the patched layer uses a HARD
   * clip: out-of-bbox fragments are `discard`ed. Patches should by
   * definition only exist inside the session bbox; the discard is
   * defense-in-depth against any paint-time bugs that emit out-of-bbox
   * writes.
   */
  editBboxActive: boolean;
}

export class PatchedSegmentationRenderLayer extends SliceViewVolumeRenderLayer<PatchShaderParameters> {
  private patchTextureUnit: number | undefined;
  private patchTextures = new Map<string, WebGLTexture>();
  private patchFallbackTexture: WebGLTexture | undefined;
  private generationCounter = 0;
  private uploadedGeneration = new WeakMap<LocalPatchChunk, number>();
  private segmentColorShaderManager = new SegmentColorShaderManager(
    "segmentColorHash",
  );

  /**
   * Voxel-edit bbox-clip shader hook. Stateless across compiles; gated by
   * the `editBboxActive` shader parameter so that when no session bbox is
   * set for this layer the hook contributes NOTHING to the shader source
   * (no uniforms, no fragment code, no main-body wrapping).
   */
  private bboxAlphaHook: BboxAlphaShaderHook = createBboxAlphaShaderHook();

  constructor(
    multiscaleSource: MultiscaleVolumeChunkSource,
    public readonly displayState: SliceViewSegmentationDisplayState,
    public readonly patchStore: LocalPatchStore,
  ) {
    super(multiscaleSource, {
      shaderParameters: new AggregateWatchableValue((refCounted) => ({
        version: constantWatchableValue(1),
        // Voxel-edit bbox-clip gate. Derived from the optional
        // `editBboxLoHi` watchable on `displayState`: `true` iff a session
        // bbox is currently set for this layer. When `editBboxLoHi` is
        // undefined (the default for layers not participating in an edit
        // session) this resolves to a constant `false` and the bbox-clip
        // shader path is never compiled in — the GLSL remains
        // byte-identical to the pre-hook implementation.
        editBboxActive:
          displayState.editBboxLoHi === undefined
            ? constantWatchableValue(false)
            : refCounted.registerDisposer(
                makeCachedDerivedWatchableValue(
                  (bbox) => bbox !== undefined,
                  [displayState.editBboxLoHi],
                ),
              ),
      })),
      transform: displayState.transform,
      renderScaleTarget: displayState.renderScaleTarget,
      renderScaleHistogram: displayState.renderScaleHistogram,
      localPosition: displayState.localPosition,
    });
    this.registerDisposer(
      this.shaderParameters as AggregateWatchableValue<PatchShaderParameters>,
    );
    this.registerDisposer(
      this.patchStore.changed.add(() => {
        this.generationCounter++;
        this.redrawNeeded.dispatch();
      }),
    );
    // Re-render when the user changes the global color hash seed.
    this.registerDisposer(
      this.displayState.segmentColorHash.changed.add(
        this.redrawNeeded.dispatch,
      ),
    );
    // Redraw when the bbox lo/hi changes within an active session — value
    // changes don't flip the `editBboxActive` bit so they won't go through
    // `shaderParameters.changed`, but they DO need a fresh `bind()`.
    if (displayState.editBboxLoHi !== undefined) {
      this.registerDisposer(
        displayState.editBboxLoHi.changed.add(this.redrawNeeded.dispatch),
      );
    }
  }

  disposed() {
    const { gl } = this;
    for (const tex of this.patchTextures.values()) gl.deleteTexture(tex);
    this.patchTextures.clear();
    if (this.patchFallbackTexture !== undefined) {
      gl.deleteTexture(this.patchFallbackTexture);
      this.patchFallbackTexture = undefined;
    }
    super.disposed();
  }

  defineShader(builder: ShaderBuilder, parameters: PatchShaderParameters) {
    this.patchTextureUnit = builder.addTextureSampler(
      "usampler3D",
      "uPatchSampler",
      patchTextureUnitSymbol,
    );
    builder.addUniform("highp uint", "uHasPatch");
    this.segmentColorShaderManager.defineShader(builder);
    let fragmentMain = `
if (uHasPatch != 0u) {
  highp ivec3 p = ivec3(max(vec3(0.0, 0.0, 0.0), min(floor(vChunkPosition), uChunkDataSize - 1.0)));
  highp uvec4 raw = texelFetch(uPatchSampler, p, 0);
  if (raw.r != 0u || raw.g != 0u) {
    uint64_t patchVal; patchVal.value = uvec2(raw.r, raw.g);
    vec3 color = segmentColorHash(patchVal);
    emit(vec4(color, 1.0));
    return;
  }
}
emit(vec4(0.0, 0.0, 0.0, 0.0));
`;
    // Voxel-edit bbox-clip opt-in path: when a session bbox is set for this
    // layer, route every `emit(...)` call in the main body through
    // `emitOnlyInsideBbox(...)` so out-of-bbox fragments are hard-clipped
    // via `discard`. Gated on the `editBboxActive` shader parameter so when
    // no session is active this branch is NOT taken and the resulting GLSL
    // is byte-identical to the pre-hook shader.
    //
    // Hard clip (rather than the base layer's 0.25x dim) is intentional:
    // patches should by definition only exist inside the session bbox, so a
    // visible out-of-bbox patch indicates a bug in the paint compute path.
    // `discard` gives loud, unambiguous feedback rather than silently
    // attenuating the leak. See
    // `docs/edit-session-integration/architecture/06-bbox-rendering.md`.
    if (parameters.editBboxActive) {
      this.bboxAlphaHook.defineUniforms(builder);
      builder.addFragmentCode(EMIT_ONLY_INSIDE_BBOX_FRAGMENT_SNIPPET);
      fragmentMain = this.bboxAlphaHook.wrapFragmentMain(
        fragmentMain,
        "emitOnlyInsideBbox",
      );
    }
    builder.setFragmentMain(fragmentMain);
  }

  initializeShader(
    _sliceView: SliceView,
    shader: ShaderProgram,
    parameters: PatchShaderParameters,
  ) {
    this.segmentColorShaderManager.enable(
      this.gl,
      shader,
      this.displayState.segmentColorHash.value,
    );
    // Bbox-clip uniforms are bound only when the bbox-clip shader path was
    // compiled (`editBboxActive === true`). Otherwise the uniforms don't
    // exist on the shader at all. We pass `outsideAlphaMultiplier: 1.0` for
    // consistency (the uniform exists but is unused by the hard-clip
    // snippet, which `discard`s instead of attenuating).
    if (parameters.editBboxActive) {
      const bbox = this.displayState.editBboxLoHi?.value;
      this.bboxAlphaHook.bind(this.gl, shader, {
        bbox,
        outsideAlphaMultiplier: 1.0,
      });
    }
  }

  protected override onBeginChunk(
    gl: GL,
    shader: ShaderProgram,
    chunk: VolumeChunk,
  ) {
    if (this.patchTextureUnit === undefined) return;
    const prevActive = gl.getParameter(
      WebGL2RenderingContext.ACTIVE_TEXTURE,
    ) as number;
    gl.activeTexture(
      WebGL2RenderingContext.TEXTURE0 + this.patchTextureUnit,
    );
    const key = chunkGridKey(chunk.chunkGridPosition);
    const patchChunk = this.patchStore.source.chunks.get(key);
    if (patchChunk !== undefined) {
      this.ensurePatchTexture(gl, key, patchChunk);
      gl.uniform1ui(shader.uniform("uHasPatch"), 1);
    } else {
      this.bindFallback(gl);
      gl.uniform1ui(shader.uniform("uHasPatch"), 0);
    }
    gl.activeTexture(prevActive);
  }

  private bindFallback(gl: GL) {
    let tex = this.patchFallbackTexture;
    if (tex === undefined) {
      const newTex = gl.createTexture();
      if (newTex === null) {
        throw new Error("Failed to create patch fallback texture");
      }
      tex = newTex;
      this.patchFallbackTexture = tex;
      gl.bindTexture(WebGL2RenderingContext.TEXTURE_3D, tex);
      gl.texImage3D(
        WebGL2RenderingContext.TEXTURE_3D,
        0,
        WebGL2RenderingContext.RG32UI,
        1,
        1,
        1,
        0,
        WebGL2RenderingContext.RG_INTEGER,
        WebGL2RenderingContext.UNSIGNED_INT,
        new Uint32Array(2),
      );
      applyTextureParams(gl);
    } else {
      gl.bindTexture(WebGL2RenderingContext.TEXTURE_3D, tex);
    }
  }

  private ensurePatchTexture(
    gl: GL,
    key: string,
    patchChunk: LocalPatchChunk,
  ) {
    let texture = this.patchTextures.get(key);
    const stored = this.uploadedGeneration.get(patchChunk);
    const needsUpload =
      texture === undefined ||
      patchChunk.dirty ||
      stored !== this.generationCounter;
    if (texture === undefined) {
      const newTex = gl.createTexture();
      if (newTex === null) throw new Error("Failed to create patch texture");
      texture = newTex;
      this.patchTextures.set(key, texture);
    }
    gl.bindTexture(WebGL2RenderingContext.TEXTURE_3D, texture);
    if (needsUpload) {
      const [sx, sy, sz] = patchChunk.chunkDataSize;
      const u32 = new Uint32Array(
        patchChunk.data.buffer,
        patchChunk.data.byteOffset,
        patchChunk.data.length * 2,
      );
      gl.texImage3D(
        WebGL2RenderingContext.TEXTURE_3D,
        0,
        WebGL2RenderingContext.RG32UI,
        sx,
        sy,
        sz,
        0,
        WebGL2RenderingContext.RG_INTEGER,
        WebGL2RenderingContext.UNSIGNED_INT,
        u32,
      );
      applyTextureParams(gl);
      patchChunk.dirty = false;
      this.uploadedGeneration.set(patchChunk, this.generationCounter);
    }
  }
}

/**
 * Fragment shader snippet defining `emitOnlyInsideBbox`. Hard-clip variant
 * of `emitWithBboxDim` (see `src/editing/shaders/bbox_alpha_chunk.ts`):
 * fragments outside the bbox are `discard`ed rather than dimmed. Patches
 * outside the session bbox are by definition a bug, so this gives loud
 * visual feedback rather than silently attenuating the leak.
 *
 * Compares against `vChunkPosition + uTranslation` (the chunk-grid voxel
 * position; `vChunkPosition` alone is chunk-local in `[0, chunkDataSize)`
 * and would never match a layer-wide bbox). The bbox uniforms supplied via
 * `BboxAlphaShaderHook.bind()` MUST be in the same chunk-grid frame; see
 * `EditSessionHost.computeActiveRegion`, which subtracts the layer's
 * `voxelOffset` for this purpose.
 *
 * Assumes the uniforms `u_editBboxLoVoxel`, `u_editBboxHiVoxel`, and
 * `u_editBboxActive` have been declared via
 * `BboxAlphaShaderHook.defineUniforms(builder)`, and that `uTranslation`
 * (the chunk's chunk-grid-frame origin) is available — true for all
 * `SliceViewVolumeRenderLayer`-derived shaders.
 */
const EMIT_ONLY_INSIDE_BBOX_FRAGMENT_SNIPPET = `
void emitOnlyInsideBbox(vec4 rgba) {
  if (u_editBboxActive == 1) {
    vec3 v = vChunkPosition + uTranslation;
    if (v.x < u_editBboxLoVoxel.x || v.x >= u_editBboxHiVoxel.x ||
        v.y < u_editBboxLoVoxel.y || v.y >= u_editBboxHiVoxel.y ||
        v.z < u_editBboxLoVoxel.z || v.z >= u_editBboxHiVoxel.z) {
      discard;
    }
  }
  emit(rgba);
}
`;

function applyTextureParams(gl: GL) {
  gl.texParameteri(
    WebGL2RenderingContext.TEXTURE_3D,
    WebGL2RenderingContext.TEXTURE_MIN_FILTER,
    WebGL2RenderingContext.NEAREST,
  );
  gl.texParameteri(
    WebGL2RenderingContext.TEXTURE_3D,
    WebGL2RenderingContext.TEXTURE_MAG_FILTER,
    WebGL2RenderingContext.NEAREST,
  );
  gl.texParameteri(
    WebGL2RenderingContext.TEXTURE_3D,
    WebGL2RenderingContext.TEXTURE_WRAP_S,
    WebGL2RenderingContext.CLAMP_TO_EDGE,
  );
  gl.texParameteri(
    WebGL2RenderingContext.TEXTURE_3D,
    WebGL2RenderingContext.TEXTURE_WRAP_T,
    WebGL2RenderingContext.CLAMP_TO_EDGE,
  );
  gl.texParameteri(
    WebGL2RenderingContext.TEXTURE_3D,
    WebGL2RenderingContext.TEXTURE_WRAP_R,
    WebGL2RenderingContext.CLAMP_TO_EDGE,
  );
}
