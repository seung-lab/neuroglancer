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
 * Lazy upload semantics: textures are created and fully uploaded on the
 * first `bindPatchValueTexture` / `bindPatchedMaskTexture` for each chunk.
 * After that, uploads are driven by the chunk's own `pendingUpload`
 * obligation (set by `PatchMirror` / voxel writes): chunks with no pending
 * upload skip GL work entirely on bind, and chunks with a pending sub-box
 * upload only that box via `texSubImage3D` (UNPACK_ROW_LENGTH /
 * UNPACK_SKIP_* address the sub-box directly inside the full CPU array — no
 * staging copy). This replaces the previous global generation counter,
 * which re-uploaded EVERY bound chunk's two full 3D textures whenever ANY
 * chunk changed — the dominant frame cost while painting with large
 * brushes.
 *
 * The obligation's `valueDone` / `maskDone` flags are cleared together on
 * every new write and the box is released only when both textures have
 * consumed it, so the visible mask and value at a fragment always reflect
 * the same overlay snapshot.
 *
 * `LocalPatchChunk.dirty` is kept as a hint flag for tests / non-render
 * inspectors; it's not load-bearing for the upload decision.
 */

import type {
  ChunkVoxelBox,
  LocalPatchChunk,
} from "#src/editing/local_patch_chunk.js";
import { chunkGridKey } from "#src/editing/local_patch_source.js";
import type { LocalPatchStore } from "#src/editing/local_patch_store.js";
import type { PatchedMaskProvider } from "#src/editing/shaders/patched_mask_provider.js";
import { paintProfiler } from "#src/editing/tool_runtimes/paint_profiler.js";
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
  // Tracks every GL context we've created textures in, so `disposed()` can
  // free them. In practice this is always one context (neuroglancer has a
  // single shared GL context per viewer), but we don't enforce that.
  private contexts = new Set<GL>();

  constructor(private readonly patchStore: LocalPatchStore) {
    super();
    this.registerDisposer(
      this.patchStore.changed.add(() => {
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
    let mustFullUpload = false;
    if (texture === undefined) {
      const newTex = gl.createTexture();
      if (newTex === null) {
        throw new Error("PatchTextureCache: failed to create value texture");
      }
      texture = newTex;
      this.valueTextures.set(key, texture);
      mustFullUpload = true;
    }
    gl.bindTexture(WebGL2RenderingContext.TEXTURE_3D, texture);
    const pending = chunk.pendingUpload;
    if (!mustFullUpload && (pending === null || pending.valueDone)) return;
    const prof = paintProfiler.enabled;
    const t0 = prof ? performance.now() : 0;
    const [sx, sy, sz] = chunk.chunkDataSize;
    const u32 = new Uint32Array(
      chunk.data.buffer,
      chunk.data.byteOffset,
      chunk.data.length * 2,
    );
    const box = mustFullUpload || pending === null ? null : pending.box;
    if (box === null) {
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
      if (prof) {
        paintProfiler.count("gpu.upload.value.full", 1);
        paintProfiler.count("gpu.uploadBytes", sx * sy * sz * 8);
      }
    } else {
      uploadSubBox(
        gl,
        box,
        sx,
        sy,
        WebGL2RenderingContext.RG_INTEGER,
        WebGL2RenderingContext.UNSIGNED_INT,
        u32,
        /* bytesPerVoxel */ 8,
        prof ? "gpu.upload.value.sub" : undefined,
      );
    }
    if (prof) {
      paintProfiler.record("6.gpu.upload(value)", performance.now() - t0);
    }
    this.consumePendingUpload(chunk, "value");
  }

  private ensureMaskTexture(gl: GL, key: string, chunk: LocalPatchChunk): void {
    this.contexts.add(gl);
    let texture = this.maskTextures.get(key);
    let mustFullUpload = false;
    if (texture === undefined) {
      const newTex = gl.createTexture();
      if (newTex === null) {
        throw new Error("PatchTextureCache: failed to create mask texture");
      }
      texture = newTex;
      this.maskTextures.set(key, texture);
      mustFullUpload = true;
    }
    gl.bindTexture(WebGL2RenderingContext.TEXTURE_3D, texture);
    const pending = chunk.pendingUpload;
    if (!mustFullUpload && (pending === null || pending.maskDone)) return;
    const prof = paintProfiler.enabled;
    const t0 = prof ? performance.now() : 0;
    const [sx, sy, sz] = chunk.chunkDataSize;
    // R8UI rows are 1 byte/voxel; chunk widths are not guaranteed to be
    // 4-aligned, so pack rows tightly (neuroglancer's own upload helpers set
    // this per call too — see `webgl/texture_access.ts`).
    gl.pixelStorei(WebGL2RenderingContext.UNPACK_ALIGNMENT, 1);
    const box = mustFullUpload || pending === null ? null : pending.box;
    if (box === null) {
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
      if (prof) {
        paintProfiler.count("gpu.upload.mask.full", 1);
        paintProfiler.count("gpu.uploadBytes", sx * sy * sz);
      }
    } else {
      uploadSubBox(
        gl,
        box,
        sx,
        sy,
        WebGL2RenderingContext.RED_INTEGER,
        WebGL2RenderingContext.UNSIGNED_BYTE,
        chunk.patched,
        /* bytesPerVoxel */ 1,
        prof ? "gpu.upload.mask.sub" : undefined,
      );
    }
    gl.pixelStorei(WebGL2RenderingContext.UNPACK_ALIGNMENT, 4);
    if (prof) {
      paintProfiler.record("6.gpu.upload(mask)", performance.now() - t0);
    }
    // Kept for legacy inspectors (tests); no longer gates upload.
    chunk.dirty = false;
    this.consumePendingUpload(chunk, "mask");
  }

  /**
   * Mark one texture's side of the chunk's upload obligation consumed;
   * release the obligation once both have caught up.
   */
  private consumePendingUpload(
    chunk: LocalPatchChunk,
    side: "value" | "mask",
  ): void {
    const pending = chunk.pendingUpload;
    if (pending === null) return;
    if (side === "value") pending.valueDone = true;
    else pending.maskDone = true;
    if (pending.valueDone && pending.maskDone) chunk.pendingUpload = null;
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
      if (this.valueFallback !== undefined)
        gl.deleteTexture(this.valueFallback);
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

/**
 * Upload only `box` of a chunk's CPU array into the bound 3D texture via
 * `texSubImage3D`. UNPACK_ROW_LENGTH / UNPACK_IMAGE_HEIGHT / UNPACK_SKIP_*
 * address the sub-box directly inside the full-size array, so no staging
 * copy is made; all five parameters are reset to 0 afterwards (neuroglancer's
 * other upload paths assume the defaults).
 */
function uploadSubBox(
  gl: GL,
  box: ChunkVoxelBox,
  sx: number,
  sy: number,
  format: number,
  type: number,
  data: ArrayBufferView,
  bytesPerVoxel: number,
  profCountName: string | undefined,
): void {
  const w = box.x1 - box.x0 + 1;
  const h = box.y1 - box.y0 + 1;
  const d = box.z1 - box.z0 + 1;
  gl.pixelStorei(WebGL2RenderingContext.UNPACK_ROW_LENGTH, sx);
  gl.pixelStorei(WebGL2RenderingContext.UNPACK_IMAGE_HEIGHT, sy);
  gl.pixelStorei(WebGL2RenderingContext.UNPACK_SKIP_PIXELS, box.x0);
  gl.pixelStorei(WebGL2RenderingContext.UNPACK_SKIP_ROWS, box.y0);
  gl.pixelStorei(WebGL2RenderingContext.UNPACK_SKIP_IMAGES, box.z0);
  gl.texSubImage3D(
    WebGL2RenderingContext.TEXTURE_3D,
    0,
    box.x0,
    box.y0,
    box.z0,
    w,
    h,
    d,
    format,
    type,
    data,
    0,
  );
  gl.pixelStorei(WebGL2RenderingContext.UNPACK_ROW_LENGTH, 0);
  gl.pixelStorei(WebGL2RenderingContext.UNPACK_IMAGE_HEIGHT, 0);
  gl.pixelStorei(WebGL2RenderingContext.UNPACK_SKIP_PIXELS, 0);
  gl.pixelStorei(WebGL2RenderingContext.UNPACK_SKIP_ROWS, 0);
  gl.pixelStorei(WebGL2RenderingContext.UNPACK_SKIP_IMAGES, 0);
  if (profCountName !== undefined) {
    paintProfiler.count(profCountName, 1);
    paintProfiler.count("gpu.uploadBytes", w * h * d * bytesPerVoxel);
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
