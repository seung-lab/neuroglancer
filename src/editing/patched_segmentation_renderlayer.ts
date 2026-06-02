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
 * DESIGN: subclass of `SegmentationRenderLayer` that injects patch sampling
 * into the existing segmentation read path via the
 * `defineGetUint64DataValue` extension point. When a voxel has a patch entry
 * the override returns the patch value; otherwise it falls through to the
 * base data. All Render-tab configuration (opacity, color seed, stated
 * colors, hide-segment-0, base segment coloring, saturation, equivalences,
 * highlight, visible-segments filtering) and the bbox-clip shader hook are
 * inherited from the base layer — there is no second shader path here.
 */

import type { LocalPatchChunk } from "#src/editing/local_patch_chunk.js";
import type { LocalPatchStore } from "#src/editing/local_patch_store.js";
import { chunkGridKey } from "#src/editing/local_patch_source.js";
import type { SliceViewSegmentationDisplayState } from "#src/sliceview/volume/segmentation_renderlayer.js";
import { SegmentationRenderLayer } from "#src/sliceview/volume/segmentation_renderlayer.js";
import type {
  MultiscaleVolumeChunkSource,
  VolumeChunk,
} from "#src/sliceview/volume/frontend.js";
import type { GL } from "#src/webgl/context.js";
import type { ShaderBuilder, ShaderProgram } from "#src/webgl/shader.js";

const patchTextureUnitSymbol = Symbol(
  "PatchedSegmentationRenderLayer.patchTexture",
);

export class PatchedSegmentationRenderLayer extends SegmentationRenderLayer {
  private patchTextureUnit: number | undefined;
  private patchTextures = new Map<string, WebGLTexture>();
  private patchFallbackTexture: WebGLTexture | undefined;
  private generationCounter = 0;
  private uploadedGeneration = new WeakMap<LocalPatchChunk, number>();

  constructor(
    multiscaleSource: MultiscaleVolumeChunkSource,
    displayState: SliceViewSegmentationDisplayState,
    public readonly patchStore: LocalPatchStore,
  ) {
    super(multiscaleSource, displayState);
    this.registerDisposer(
      this.patchStore.changed.add(() => {
        this.generationCounter++;
        this.redrawNeeded.dispatch();
      }),
    );
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

  protected override defineGetUint64DataValue(builder: ShaderBuilder) {
    this.patchTextureUnit = builder.addTextureSampler(
      "usampler3D",
      "uPatchSampler",
      patchTextureUnitSymbol,
    );
    builder.addUniform("highp uint", "uHasPatch");
    builder.addFragmentCode(`
uint64_t getUint64DataValue() {
  if (uHasPatch != 0u) {
    highp ivec3 p = ivec3(max(vec3(0.0, 0.0, 0.0), min(floor(vChunkPosition), uChunkDataSize - 1.0)));
    highp uvec4 raw = texelFetch(uPatchSampler, p, 0);
    if (raw.r != 0u || raw.g != 0u) {
      uint64_t patchVal; patchVal.value = uvec2(raw.r, raw.g);
      return patchVal;
    }
  }
  return toUint64(getDataValue());
}
`);
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
