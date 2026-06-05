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
 * @file Per-edit-session, per-layer cache of the two GPU 3D textures that
 * back the patched-segment overlay: an RG32UI value texture (packed uint64
 * segment id, `(lo32, hi32)`) and an R8UI mask texture (the per-voxel
 * "patched" bit). One cache per writable segmentation layer, owned by the
 * `EditSessionHost`'s per-layer machinery and published into the layer's
 * `SliceViewSegmentationDisplayState.editPatchOverlay` watchable as the
 * `PatchedMaskProvider`. The base `SegmentationRenderLayer` is the sole
 * consumer — there is no separate patch render layer in v3.
 *
 * Lazy upload semantics: textures are created and uploaded on the first
 * `bindPatchValueTexture` / `bindPatchedMaskTexture` for each chunk. A
 * generation counter bumped on every `LocalPatchStore.changed` dispatch
 * forces re-upload on the next bind for any chunk whose generation lags;
 * unchanged chunks pay no upload cost.
 *
 * The value-texture path and mask-texture path each track their own
 * `uploadGeneration` map so a no-op redundant call (e.g. mask bound while
 * the value upload is still pending) doesn't trip over the other's
 * dirty state. Both gates are reset together when `patchStore.changed`
 * fires, so the visible mask and value at a fragment always reflect the
 * same overlay snapshot.
 *
 * `LocalPatchChunk.dirty` is kept as a hint flag for tests / non-render
 * inspectors; it's no longer load-bearing for the upload decision.
 */

import type { LocalPatchChunk } from "#src/editing/local_patch_chunk.js";
import { chunkGridKey } from "#src/editing/local_patch_source.js";
import type { LocalPatchStore } from "#src/editing/local_patch_store.js";
import type { PatchedMaskProvider } from "#src/editing/shaders/patched_mask_provider.js";
import { RefCounted } from "#src/util/disposable.js";
import { NullarySignal } from "#src/util/signal.js";
import type { GL } from "#src/webgl/context.js";

export class PatchTextureCache
  extends RefCounted
  implements PatchedMaskProvider
{
  /**
   * Re-dispatched from `LocalPatchStore.changed` so the consuming render
   * layer (currently the base `SegmentationRenderLayer`) can subscribe to
   * a single provider-level "things changed" signal instead of reaching
   * past the interface into the underlying patch store.
   */
  readonly changed = new NullarySignal();
  private valueTextures = new Map<string, WebGLTexture>();
  private maskTextures = new Map<string, WebGLTexture>();
  private valueFallback: WebGLTexture | undefined;
  private maskFallback: WebGLTexture | undefined;
  private generationCounter = 0;
  private valueUploadGeneration = new WeakMap<LocalPatchChunk, number>();
  private maskUploadGeneration = new WeakMap<LocalPatchChunk, number>();
  // Tracks every GL context we've created textures in, so `disposed()` can
  // free them. In practice this is always one context (neuroglancer has a
  // single shared GL context per viewer), but we don't enforce that.
  private contexts = new Set<GL>();

  constructor(private readonly patchStore: LocalPatchStore) {
    super();
    this.registerDisposer(
      this.patchStore.changed.add(() => {
        this.generationCounter++;
        this.changed.dispatch();
      }),
    );
  }

  // -- PatchedMaskProvider --------------------------------------------------

  bindPatchValueTexture(
    gl: GL,
    textureUnit: number,
    chunkGridPosition: ArrayLike<number>,
  ): void {
    gl.activeTexture(WebGL2RenderingContext.TEXTURE0 + textureUnit);
    const key = chunkGridKey(chunkGridPosition);
    const chunk = this.patchStore.source.chunks.get(key);
    if (chunk === undefined) {
      this.bindValueFallback(gl);
      return;
    }
    this.ensureValueTexture(gl, key, chunk);
  }

  bindPatchedMaskTexture(
    gl: GL,
    textureUnit: number,
    chunkGridPosition: ArrayLike<number>,
  ): void {
    gl.activeTexture(WebGL2RenderingContext.TEXTURE0 + textureUnit);
    const key = chunkGridKey(chunkGridPosition);
    const chunk = this.patchStore.source.chunks.get(key);
    if (chunk === undefined) {
      this.bindMaskFallback(gl);
      return;
    }
    this.ensureMaskTexture(gl, key, chunk);
  }

  getPatchedValueAt(
    chunkGridPosition: ArrayLike<number>,
    localOffset: readonly [number, number, number],
  ): bigint | undefined {
    const chunk = this.patchStore.source.chunks.get(
      chunkGridKey(chunkGridPosition),
    );
    if (chunk === undefined) return undefined;
    if (!chunk.hasPatchAt(localOffset[0], localOffset[1], localOffset[2])) {
      return undefined;
    }
    return chunk.getVoxel(localOffset[0], localOffset[1], localOffset[2]);
  }

  // -- Internal: per-chunk texture management -------------------------------

  private ensureValueTexture(
    gl: GL,
    key: string,
    chunk: LocalPatchChunk,
  ): void {
    this.contexts.add(gl);
    let texture = this.valueTextures.get(key);
    const stored = this.valueUploadGeneration.get(chunk);
    const needsUpload =
      texture === undefined || stored !== this.generationCounter;
    if (texture === undefined) {
      const newTex = gl.createTexture();
      if (newTex === null) {
        throw new Error("PatchTextureCache: failed to create value texture");
      }
      texture = newTex;
      this.valueTextures.set(key, texture);
    }
    gl.bindTexture(WebGL2RenderingContext.TEXTURE_3D, texture);
    if (needsUpload) {
      const [sx, sy, sz] = chunk.chunkDataSize;
      const u32 = new Uint32Array(
        chunk.data.buffer,
        chunk.data.byteOffset,
        chunk.data.length * 2,
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
      this.valueUploadGeneration.set(chunk, this.generationCounter);
    }
  }

  private ensureMaskTexture(
    gl: GL,
    key: string,
    chunk: LocalPatchChunk,
  ): void {
    this.contexts.add(gl);
    let texture = this.maskTextures.get(key);
    const stored = this.maskUploadGeneration.get(chunk);
    const needsUpload =
      texture === undefined || stored !== this.generationCounter;
    if (texture === undefined) {
      const newTex = gl.createTexture();
      if (newTex === null) {
        throw new Error("PatchTextureCache: failed to create mask texture");
      }
      texture = newTex;
      this.maskTextures.set(key, texture);
    }
    gl.bindTexture(WebGL2RenderingContext.TEXTURE_3D, texture);
    if (needsUpload) {
      const [sx, sy, sz] = chunk.chunkDataSize;
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
        chunk.patched,
      );
      applyTextureParams(gl);
      // Kept for legacy inspectors (tests); no longer gates upload.
      chunk.dirty = false;
      this.maskUploadGeneration.set(chunk, this.generationCounter);
    }
  }

  /**
   * 1×1×1 zero RG32UI texture for chunks with no patches. The base layer
   * still binds the patch sampler unconditionally (WebGL2 forbids leaving
   * a sampler unbound), but the mask sampler reads 0 first so the patch
   * value is never consulted. Caller is responsible for setting
   * `gl.activeTexture` before this call.
   */
  private bindValueFallback(gl: GL): void {
    let tex = this.valueFallback;
    if (tex === undefined) {
      this.contexts.add(gl);
      const newTex = gl.createTexture();
      if (newTex === null) {
        throw new Error("PatchTextureCache: failed to create value fallback");
      }
      tex = newTex;
      this.valueFallback = tex;
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

  /** Same idea as {@link bindValueFallback}, for the R8UI mask sampler. */
  private bindMaskFallback(gl: GL): void {
    let tex = this.maskFallback;
    if (tex === undefined) {
      this.contexts.add(gl);
      const newTex = gl.createTexture();
      if (newTex === null) {
        throw new Error("PatchTextureCache: failed to create mask fallback");
      }
      tex = newTex;
      this.maskFallback = tex;
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

  disposed(): void {
    for (const gl of this.contexts) {
      for (const tex of this.valueTextures.values()) gl.deleteTexture(tex);
      for (const tex of this.maskTextures.values()) gl.deleteTexture(tex);
      if (this.valueFallback !== undefined) gl.deleteTexture(this.valueFallback);
      if (this.maskFallback !== undefined) gl.deleteTexture(this.maskFallback);
    }
    this.valueTextures.clear();
    this.maskTextures.clear();
    this.valueFallback = undefined;
    this.maskFallback = undefined;
    this.contexts.clear();
    super.disposed();
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
