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
 * DESIGN (v2): renders ON TOP of the base segmentation layer. Two parallel
 * 3D textures per chunk:
 *   - `uPatchSampler` (RG32UI): the per-voxel patched value, packed as
 *     `(lo32, hi32)` of a uint64 segment id.
 *   - `uPatchedMaskSampler` (R8UI): per-voxel 0/1 patched bit — set when
 *     the user has explicitly written this voxel (paint OR erase).
 *
 * Per-fragment behavior:
 *   - patched == 0 → emit transparent (let the base layer render normally).
 *   - patched == 1, value != 0 → emit segment color at the user's chosen
 *     segmentation alpha (`displayState.selectedAlpha`), so paint-over
 *     composites uniformly with surrounding non-edited segmentation.
 *   - patched == 1, value == 0 → emit transparent. The base layer ALSO
 *     discards this fragment (via its `editPatchOverlay` hook, which
 *     samples the same mask texture), so the image layer behind shows
 *     through at its natural opacity — that's the actual erase.
 *
 * The mask texture is reused by the BASE segmentation render layer through
 * the `PatchedMaskProvider` interface this class implements. That hook is
 * what makes erase a real erase: with the base layer aware of the mask, it
 * discards fragments at edited voxels, so transparent emit from THIS layer
 * isn't shadowed by the original segment color from beneath.
 *
 * Bbox-clip policy: when an edit session is active (`displayState.editBboxLoHi`
 * is set), patches outside the current session bbox are HARD-CLIPPED via
 * the shared `emitWithBboxDim` snippet.
 */

import type { LocalPatchChunk } from "#src/editing/local_patch_chunk.js";
import type { LocalPatchStore } from "#src/editing/local_patch_store.js";
import { chunkGridKey } from "#src/editing/local_patch_source.js";
import type { BboxAlphaShaderHook } from "#src/editing/shaders/bbox_alpha_chunk.js";
import { createBboxAlphaShaderHook } from "#src/editing/shaders/bbox_alpha_chunk.js";
import type { PatchedMaskProvider } from "#src/editing/shaders/patched_mask_provider.js";
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
const patchedMaskTextureUnitSymbol = Symbol(
  "PatchedSegmentationRenderLayer.patchedMaskTexture",
);

interface PatchShaderParameters {
  /**
   * Compile-time gate for the bbox-clip code path. When false, the shader
   * compiles without any bbox uniforms or `discard`s — patches render
   * everywhere. When true, fragments outside the session bbox are
   * discarded.
   */
  editBboxActive: boolean;
}

export class PatchedSegmentationRenderLayer
  extends SliceViewVolumeRenderLayer<PatchShaderParameters>
  implements PatchedMaskProvider
{
  private patchTextureUnit: number | undefined;
  private patchedMaskTextureUnit: number | undefined;
  private patchTextures = new Map<string, WebGLTexture>();
  // Single owner of the per-chunk patched-mask R8UI textures. Exposed via
  // the `PatchedMaskProvider` interface so the base `SegmentationRenderLayer`
  // can sample the SAME texture handle from its own sampler unit.
  private patchedMaskTextures = new Map<string, WebGLTexture>();
  private patchFallbackTexture: WebGLTexture | undefined;
  private patchedMaskFallbackTexture: WebGLTexture | undefined;
  private generationCounter = 0;
  // Tracks per-chunk upload state INDEPENDENTLY for the value texture
  // (RG32UI) and the mask texture (R8UI). We can't piggyback on a single
  // `dirty` bit because the mask texture may be uploaded from EITHER this
  // layer's `onBeginChunk` OR the base layer's `onBeginChunk` (via
  // `bindPatchedMaskTexture` below), whichever runs first per frame.
  private valueUploadGeneration = new WeakMap<LocalPatchChunk, number>();
  private maskUploadGeneration = new WeakMap<LocalPatchChunk, number>();
  private segmentColorShaderManager = new SegmentColorShaderManager(
    "segmentColorHash",
  );
  private bboxAlphaHook: BboxAlphaShaderHook = createBboxAlphaShaderHook();

  constructor(
    multiscaleSource: MultiscaleVolumeChunkSource,
    public readonly displayState: SliceViewSegmentationDisplayState,
    public readonly patchStore: LocalPatchStore,
  ) {
    super(multiscaleSource, {
      shaderParameters: new AggregateWatchableValue((refCounted) => ({
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
      allowedSourcePredicate: displayState.allowedSourcePredicate,
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
    // Re-render when the segmentation alpha changes (we read it from
    // displayState in `initializeShader`, see `uSelectedAlpha` below).
    this.registerDisposer(
      this.displayState.selectedAlpha.changed.add(this.redrawNeeded.dispatch),
    );
    // Redraw when the bbox lo/hi changes within an active session — the
    // value change doesn't flip the `editBboxActive` bit, but it DOES
    // require a fresh `bind()`.
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
    for (const tex of this.patchedMaskTextures.values()) gl.deleteTexture(tex);
    this.patchedMaskTextures.clear();
    if (this.patchFallbackTexture !== undefined) {
      gl.deleteTexture(this.patchFallbackTexture);
      this.patchFallbackTexture = undefined;
    }
    if (this.patchedMaskFallbackTexture !== undefined) {
      gl.deleteTexture(this.patchedMaskFallbackTexture);
      this.patchedMaskFallbackTexture = undefined;
    }
    super.disposed();
  }

  defineShader(builder: ShaderBuilder, parameters: PatchShaderParameters) {
    this.patchTextureUnit = builder.addTextureSampler(
      "usampler3D",
      "uPatchSampler",
      patchTextureUnitSymbol,
    );
    this.patchedMaskTextureUnit = builder.addTextureSampler(
      "usampler3D",
      "uPatchedMaskSampler",
      patchedMaskTextureUnitSymbol,
    );
    builder.addUniform("highp uint", "uHasPatch");
    builder.addUniform("highp float", "uSelectedAlpha");
    this.segmentColorShaderManager.defineShader(builder);
    // Gate on the patched mask, NOT on `raw != 0`. An erased voxel has
    // `raw == 0` but `patched == 1`; we emit transparent in both the
    // unpatched case AND the erased case, but the base layer discards
    // erased fragments (via the same mask we expose) so the image layer
    // behind shows through at full opacity rather than the original
    // segment color bleeding through.
    let fragmentMain = `
if (uHasPatch != 0u) {
  highp ivec3 p = ivec3(max(vec3(0.0, 0.0, 0.0), min(floor(vChunkPosition), uChunkDataSize - 1.0)));
  uint patched = texelFetch(uPatchedMaskSampler, p, 0).r;
  if (patched != 0u) {
    highp uvec4 raw = texelFetch(uPatchSampler, p, 0);
    if (raw.r != 0u || raw.g != 0u) {
      uint64_t patchVal; patchVal.value = uvec2(raw.r, raw.g);
      vec3 color = segmentColorHash(patchVal);
      emit(vec4(color, uSelectedAlpha));
    } else {
      // Erase: transparent. The base layer ALSO discards this fragment
      // (via its editPatchOverlay hook), so the image layer beneath
      // shows through at its natural opacity.
      emit(vec4(0.0, 0.0, 0.0, 0.0));
    }
    return;
  }
}
emit(vec4(0.0, 0.0, 0.0, 0.0));
`;
    if (parameters.editBboxActive) {
      this.bboxAlphaHook.defineUniforms(builder);
      builder.addFragmentCode(this.bboxAlphaHook.fragmentSnippet());
      fragmentMain = this.bboxAlphaHook.wrapFragmentMain(fragmentMain);
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
    this.gl.uniform1f(
      shader.uniform("uSelectedAlpha"),
      this.displayState.selectedAlpha.value,
    );
    if (parameters.editBboxActive) {
      this.bboxAlphaHook.bind(this.gl, shader, {
        bboxNm: this.displayState.editBboxLoHi?.value,
      });
    }
  }

  protected override onBeginChunk(
    gl: GL,
    shader: ShaderProgram,
    chunk: VolumeChunk,
  ) {
    if (
      this.patchTextureUnit === undefined ||
      this.patchedMaskTextureUnit === undefined
    ) {
      return;
    }
    const prevActive = gl.getParameter(
      WebGL2RenderingContext.ACTIVE_TEXTURE,
    ) as number;
    const key = chunkGridKey(chunk.chunkGridPosition);
    const patchChunk = this.patchStore.source.chunks.get(key);
    if (patchChunk !== undefined) {
      this.ensurePatchTexture(gl, key, patchChunk);
      // The mask texture may already have been uploaded by the BASE
      // segmentation layer's `onBeginChunk` (it calls
      // `bindPatchedMaskTexture` on us). That's fine — the upload is
      // idempotent within a generation.
      this.bindPatchedMaskTexture(
        gl,
        this.patchedMaskTextureUnit,
        chunk.chunkGridPosition,
      );
      gl.uniform1ui(shader.uniform("uHasPatch"), 1);
    } else {
      gl.activeTexture(
        WebGL2RenderingContext.TEXTURE0 + this.patchTextureUnit,
      );
      this.bindPatchFallback(gl);
      gl.activeTexture(
        WebGL2RenderingContext.TEXTURE0 + this.patchedMaskTextureUnit,
      );
      this.bindPatchedMaskFallback(gl);
      gl.uniform1ui(shader.uniform("uHasPatch"), 0);
    }
    gl.activeTexture(prevActive);
  }

  // -- PatchedMaskProvider --------------------------------------------------

  /**
   * Bind the per-chunk patched-mask R8UI 3D texture to `textureUnit`. The
   * base `SegmentationRenderLayer` calls this from its own `onBeginChunk`
   * to sample the SAME texture handle we use for our own discard logic —
   * one upload, two consumers.
   */
  bindPatchedMaskTexture(
    gl: GL,
    textureUnit: number,
    chunkGridPosition: ArrayLike<number>,
  ): boolean {
    gl.activeTexture(WebGL2RenderingContext.TEXTURE0 + textureUnit);
    const key = chunkGridKey(chunkGridPosition);
    const patchChunk = this.patchStore.source.chunks.get(key);
    if (patchChunk === undefined) {
      return false;
    }
    this.ensurePatchedMaskTexture(gl, key, patchChunk);
    return true;
  }

  // -- Internal: per-chunk texture management -------------------------------

  private bindPatchFallback(gl: GL) {
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

  private bindPatchedMaskFallback(gl: GL) {
    let tex = this.patchedMaskFallbackTexture;
    if (tex === undefined) {
      const newTex = gl.createTexture();
      if (newTex === null) {
        throw new Error("Failed to create patched-mask fallback texture");
      }
      tex = newTex;
      this.patchedMaskFallbackTexture = tex;
      gl.bindTexture(WebGL2RenderingContext.TEXTURE_3D, tex);
      gl.texImage3D(
        WebGL2RenderingContext.TEXTURE_3D,
        0,
        WebGL2RenderingContext.R8UI,
        1,
        1,
        1,
        0,
        WebGL2RenderingContext.RED_INTEGER,
        WebGL2RenderingContext.UNSIGNED_BYTE,
        new Uint8Array(1),
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
    if (this.patchTextureUnit === undefined) return;
    gl.activeTexture(
      WebGL2RenderingContext.TEXTURE0 + this.patchTextureUnit,
    );
    let texture = this.patchTextures.get(key);
    const stored = this.valueUploadGeneration.get(patchChunk);
    const needsUpload =
      texture === undefined || stored !== this.generationCounter;
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
      this.valueUploadGeneration.set(patchChunk, this.generationCounter);
    }
  }

  private ensurePatchedMaskTexture(
    gl: GL,
    key: string,
    patchChunk: LocalPatchChunk,
  ) {
    let texture = this.patchedMaskTextures.get(key);
    const stored = this.maskUploadGeneration.get(patchChunk);
    const needsUpload =
      texture === undefined || stored !== this.generationCounter;
    if (texture === undefined) {
      const newTex = gl.createTexture();
      if (newTex === null) {
        throw new Error("Failed to create patched-mask texture");
      }
      texture = newTex;
      this.patchedMaskTextures.set(key, texture);
    }
    gl.bindTexture(WebGL2RenderingContext.TEXTURE_3D, texture);
    if (needsUpload) {
      const [sx, sy, sz] = patchChunk.chunkDataSize;
      gl.texImage3D(
        WebGL2RenderingContext.TEXTURE_3D,
        0,
        WebGL2RenderingContext.R8UI,
        sx,
        sy,
        sz,
        0,
        WebGL2RenderingContext.RED_INTEGER,
        WebGL2RenderingContext.UNSIGNED_BYTE,
        patchChunk.patched,
      );
      applyTextureParams(gl);
      // Clearing `patchChunk.dirty` here is no longer load-bearing for
      // the texture path — uploads are gated on per-cache generation —
      // but we keep the flip so any non-render reader (tests, debug
      // tooling) observes the same "dirty since last GPU sync" semantic
      // as before.
      patchChunk.dirty = false;
      this.maskUploadGeneration.set(patchChunk, this.generationCounter);
    }
  }
}

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
