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
 * emit the colored segment id; unpatched voxels emit transparent.
 *
 * Bbox-clip policy: when an edit session is active (`displayState.editBboxLoHi`
 * is set), patches outside the current session bbox are HARD-CLIPPED via
 * the shared `emitWithBboxDim` snippet (which now `discard`s — see
 * `bbox_alpha_chunk.ts`). This matches the user-visible rule "during a
 * session, only the current bbox is visible"; committed patches from a
 * previous session reappear as soon as the session ends because
 * `editBboxLoHi` flips back to `undefined`.
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
  /**
   * Compile-time gate for the bbox-clip code path. When false, the shader
   * compiles without any bbox uniforms or `discard`s — patches render
   * everywhere. When true, fragments outside the session bbox are
   * discarded.
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
