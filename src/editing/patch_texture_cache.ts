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
 * @file Per-edit-session, per-layer cache of the two GPU textures that
 * back the patched-segment overlay: an RG32UI value texture (packed uint64
 * segment id, `(lo32, hi32)`) and an R8UI mask texture (the per-voxel
 * "patched" bit). One cache per writable segmentation layer, owned by the
 * `EditSessionHost`'s per-layer machinery and published into the layer's
 * `SliceViewSegmentationDisplayState.editPatchOverlay` watchable as the
 * `PatchedMaskProvider`. The base `SegmentationRenderLayer` is the sole
 * consumer — there is no separate patch render layer in v3.
 *
 * Texture dimensionality (TM-*): the overlay textures are laid out exactly
 * like neuroglancer's own volume chunk textures, via the shared
 * `TextureLayout`. A chunk is packed into a 2D OR 3D texture depending on
 * how many of its axes are non-trivial (`numDims >= 3 ? 3 : 2`, matching
 * `UncompressedChunkFormatHandler`). This is load-bearing: a naive 3D
 * texture of `chunkDataSize` overflows `gl.max3dTextureSize` (commonly
 * 2048) for datasets with large flat chunks — e.g. precomputed scales with
 * `chunk_sizes` like `[4096, 4096, 1]`. Such a chunk has only two
 * non-trivial axes and so is uploaded as a 4096×4096 2D texture (well
 * within `gl.maxTextureSize`), the same way the base segmentation layer
 * renders it. Without this, `texImage3D` failed silently, the mask sampler
 * read 0 everywhere, and painted/filled edits were stored but never drawn.
 *
 * For every chunk shape the base renderer can display, the `TextureLayout`
 * is "separable": each non-trivial chunk axis maps to its own texture axis
 * with stride 1, and the chunk's flat memory layout therefore equals the
 * texture's row-major layout. That lets us (a) upload `chunk.data` /
 * `chunk.patched` directly with no reordering, and (b) keep the sub-box
 * `texSubImage` optimization — a chunk-local voxel box maps to a contiguous
 * rectangular texel region. The rare non-separable case (only reachable by
 * chunk shapes the base renderer can't display either) falls back to a full
 * re-upload.
 *
 * The shader reads the layout-derived per-axis texel strides (`patchStrides`)
 * and the 2D/3D flag (`is3D`) as uniforms, computes the texel coordinate
 * `t = p.x*sx + p.y*sy + p.z*sz`, and samples the matching-dimensionality
 * sampler. Both a 2D and a 3D sampler are declared; the provider binds the
 * real texture to the matching unit and a 1-texel fallback to the other so
 * every declared sampler stays texture-complete regardless of which branch
 * the uniform selects.
 *
 * Lazy upload semantics: textures are created and fully uploaded on the
 * first `bindPatchValueTextures` / `bindPatchedMaskTextures` for each chunk.
 * After that, uploads are driven by the chunk's own `pendingUpload`
 * obligation (set by `PatchMirror` / voxel writes): chunks with no pending
 * upload skip GL work entirely on bind, and chunks with a pending sub-box
 * upload only that box via `texSubImage2D`/`texSubImage3D` (UNPACK_ROW_LENGTH
 * / UNPACK_SKIP_* address the sub-box directly inside the full CPU array — no
 * staging copy). This replaces the previous global generation counter,
 * which re-uploaded EVERY bound chunk's two full textures whenever ANY
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
import { TextureLayout } from "#src/sliceview/uncompressed_chunk_format.js";
import { RefCounted } from "#src/util/disposable.js";
import { NullarySignal } from "#src/util/signal.js";
import type { GL } from "#src/webgl/context.js";

/**
 * Layout describing how a chunk's `chunkDataSize` is packed into a GPU
 * texture, derived once per cache (all chunks in a session share a single
 * `chunkDataSize`). Computed from the shared {@link TextureLayout} so it
 * matches the base segmentation layer's texture exactly.
 */
interface PatchLayout {
  /** 2 or 3: number of texture dimensions. */
  textureDims: number;
  /** Texture extent along [dim0, dim1, dim2]; dim2 is 1 when `textureDims===2`. */
  textureShape: [number, number, number];
  /**
   * Per-chunk-axis texel strides, row-major `strides[axis * 3 + texDim]`,
   * padded to 3 texture dims. Fed to the shader as an `ivec3[3]` uniform so
   * the fragment program can map a chunk-local voxel position to a texel
   * coordinate identically to how it was uploaded.
   */
  strides: Int32Array;
  /** Chunk axis (0..2) feeding each texture dim, or -1 if none. */
  texDimAxis: number[];
  /**
   * True when each non-trivial chunk axis maps to a distinct texture axis
   * with stride 1 (the only layouts the base renderer can display). Sub-box
   * uploads are only attempted when separable; otherwise we full-upload.
   */
  separable: boolean;
}

/**
 * Compute the {@link PatchLayout} for `chunkDataSize` using the shared
 * neuroglancer `TextureLayout`. Mirrors `UncompressedChunkFormatHandler`'s
 * `textureDims = numDims >= 3 ? 3 : 2` choice so the overlay texture has the
 * same shape (and the same memory↔texture layout) as the base chunk.
 */
function computePatchLayout(
  gl: GL,
  chunkDataSize: ArrayLike<number>,
): PatchLayout {
  let numDims = 0;
  for (let i = 0; i < 3; ++i) if (chunkDataSize[i] > 1) ++numDims;
  const textureDims = numDims >= 3 ? 3 : 2;
  const sizes = Uint32Array.from([
    chunkDataSize[0],
    chunkDataSize[1],
    chunkDataSize[2],
  ]);
  // `TextureLayout.get` returns a gl-memoized, ref-counted instance (the get
  // hands back an owned reference). We only need its shape/strides, so copy
  // them into our own arrays and release the reference immediately.
  const layout = TextureLayout.get(gl, sizes, textureDims) as TextureLayout;
  const { textureShape, strides } = layout;
  const paddedShape: [number, number, number] = [1, 1, 1];
  for (let i = 0; i < textureDims; ++i) paddedShape[i] = textureShape[i];
  const paddedStrides = new Int32Array(9);
  const texDimAxis = new Array<number>(textureDims).fill(-1);
  let separable = true;
  for (let axis = 0; axis < 3; ++axis) {
    for (let dim = 0; dim < textureDims; ++dim) {
      const s = strides[axis * textureDims + dim];
      paddedStrides[axis * 3 + dim] = s;
      if (s !== 0) {
        if (texDimAxis[dim] !== -1 || s !== 1) {
          // Two axes share one texture dim, or a non-unit stride: the box→
          // texel mapping is no longer a simple rectangle.
          separable = false;
        } else {
          texDimAxis[dim] = axis;
        }
      }
    }
  }
  layout.dispose();
  return {
    textureDims,
    textureShape: paddedShape,
    strides: paddedStrides,
    texDimAxis,
    separable,
  };
}

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
  // One fallback per (mask|value) × (2D|3D); see file header for why both
  // dimensionalities must stay texture-complete.
  private valueFallback2D: WebGLTexture | undefined;
  private valueFallback3D: WebGLTexture | undefined;
  private maskFallback2D: WebGLTexture | undefined;
  private maskFallback3D: WebGLTexture | undefined;
  /**
   * Texture-packing layout for this cache's chunks, computed lazily from the
   * first chunk's `chunkDataSize` (single resolution per session). Undefined
   * until a chunk exists; while undefined, only fallbacks are bound and the
   * default `is3D`/`patchStrides` are never consulted (mask reads 0).
   */
  private layout: PatchLayout | undefined;
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

  get is3D(): boolean {
    return (this.layout?.textureDims ?? 3) === 3;
  }

  get patchStrides(): Int32Array {
    return this.layout?.strides ?? IDENTITY_STRIDES;
  }

  private ensureLayout(gl: GL, chunk: LocalPatchChunk): PatchLayout {
    let layout = this.layout;
    if (layout === undefined) {
      layout = this.layout = computePatchLayout(gl, chunk.chunkDataSize);
    }
    return layout;
  }

  bindPatchValueTextures(
    gl: GL,
    unit2D: number,
    unit3D: number,
    chunkGridPosition: ArrayLike<number>,
  ): void {
    const key = chunkGridKey(chunkGridPosition);
    const chunk = this.patchStore.source.chunks.get(key);
    if (chunk === undefined) {
      this.bindValueFallback(gl, unit2D, /* threeD */ false);
      this.bindValueFallback(gl, unit3D, /* threeD */ true);
      return;
    }
    const layout = this.ensureLayout(gl, chunk);
    if (layout.textureDims === 3) {
      this.bindValueFallback(gl, unit2D, /* threeD */ false);
      gl.activeTexture(WebGL2RenderingContext.TEXTURE0 + unit3D);
      this.ensureValueTexture(gl, key, chunk, layout);
    } else {
      gl.activeTexture(WebGL2RenderingContext.TEXTURE0 + unit2D);
      this.ensureValueTexture(gl, key, chunk, layout);
      this.bindValueFallback(gl, unit3D, /* threeD */ true);
    }
  }

  bindPatchedMaskTextures(
    gl: GL,
    unit2D: number,
    unit3D: number,
    chunkGridPosition: ArrayLike<number>,
  ): void {
    const key = chunkGridKey(chunkGridPosition);
    const chunk = this.patchStore.source.chunks.get(key);
    if (chunk === undefined) {
      this.bindMaskFallback(gl, unit2D, /* threeD */ false);
      this.bindMaskFallback(gl, unit3D, /* threeD */ true);
      return;
    }
    const layout = this.ensureLayout(gl, chunk);
    if (layout.textureDims === 3) {
      this.bindMaskFallback(gl, unit2D, /* threeD */ false);
      gl.activeTexture(WebGL2RenderingContext.TEXTURE0 + unit3D);
      this.ensureMaskTexture(gl, key, chunk, layout);
    } else {
      gl.activeTexture(WebGL2RenderingContext.TEXTURE0 + unit2D);
      this.ensureMaskTexture(gl, key, chunk, layout);
      this.bindMaskFallback(gl, unit3D, /* threeD */ true);
    }
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
    layout: PatchLayout,
  ): void {
    this.contexts.add(gl);
    const target =
      layout.textureDims === 3
        ? WebGL2RenderingContext.TEXTURE_3D
        : WebGL2RenderingContext.TEXTURE_2D;
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
    gl.bindTexture(target, texture);
    const pending = chunk.pendingUpload;
    if (!mustFullUpload && (pending === null || pending.valueDone)) return;
    const prof = paintProfiler.enabled;
    const t0 = prof ? performance.now() : 0;
    const u32 = new Uint32Array(
      chunk.data.buffer,
      chunk.data.byteOffset,
      chunk.data.length * 2,
    );
    const box =
      mustFullUpload || pending === null || !layout.separable
        ? null
        : pending.box;
    if (box === null) {
      const [tx, ty, tz] = layout.textureShape;
      uploadFull(
        gl,
        target,
        WebGL2RenderingContext.RG32UI,
        tx,
        ty,
        tz,
        WebGL2RenderingContext.RG_INTEGER,
        WebGL2RenderingContext.UNSIGNED_INT,
        u32,
      );
      applyTextureParams(gl, target);
      if (prof) {
        paintProfiler.count("gpu.upload.value.full", 1);
        paintProfiler.count("gpu.uploadBytes", tx * ty * tz * 8);
      }
    } else {
      uploadSubBox(
        gl,
        target,
        layout,
        box,
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

  private ensureMaskTexture(
    gl: GL,
    key: string,
    chunk: LocalPatchChunk,
    layout: PatchLayout,
  ): void {
    this.contexts.add(gl);
    const target =
      layout.textureDims === 3
        ? WebGL2RenderingContext.TEXTURE_3D
        : WebGL2RenderingContext.TEXTURE_2D;
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
    gl.bindTexture(target, texture);
    const pending = chunk.pendingUpload;
    if (!mustFullUpload && (pending === null || pending.maskDone)) return;
    const prof = paintProfiler.enabled;
    const t0 = prof ? performance.now() : 0;
    // R8UI rows are 1 byte/voxel; chunk widths are not guaranteed to be
    // 4-aligned, so pack rows tightly (neuroglancer's own upload helpers set
    // this per call too — see `webgl/texture_access.ts`).
    gl.pixelStorei(WebGL2RenderingContext.UNPACK_ALIGNMENT, 1);
    const box =
      mustFullUpload || pending === null || !layout.separable
        ? null
        : pending.box;
    if (box === null) {
      const [tx, ty, tz] = layout.textureShape;
      uploadFull(
        gl,
        target,
        WebGL2RenderingContext.R8UI,
        tx,
        ty,
        tz,
        WebGL2RenderingContext.RED_INTEGER,
        WebGL2RenderingContext.UNSIGNED_BYTE,
        chunk.patched,
      );
      applyTextureParams(gl, target);
      if (prof) {
        paintProfiler.count("gpu.upload.mask.full", 1);
        paintProfiler.count("gpu.uploadBytes", tx * ty * tz);
      }
    } else {
      uploadSubBox(
        gl,
        target,
        layout,
        box,
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
   * Bind a 1-texel zero RG32UI texture (2D or 3D) for chunks with no patches,
   * or for the off-dimensionality sampler. The base layer binds both the 2D
   * and 3D patch samplers unconditionally (WebGL2 forbids leaving a declared
   * sampler texture-incomplete), but the mask sampler reads 0 first so the
   * patch value is never consulted. This call sets `gl.activeTexture` itself.
   */
  private bindValueFallback(
    gl: GL,
    textureUnit: number,
    threeD: boolean,
  ): void {
    gl.activeTexture(WebGL2RenderingContext.TEXTURE0 + textureUnit);
    const target = threeD
      ? WebGL2RenderingContext.TEXTURE_3D
      : WebGL2RenderingContext.TEXTURE_2D;
    let tex = threeD ? this.valueFallback3D : this.valueFallback2D;
    if (tex === undefined) {
      this.contexts.add(gl);
      const newTex = gl.createTexture();
      if (newTex === null) {
        throw new Error("PatchTextureCache: failed to create value fallback");
      }
      tex = newTex;
      if (threeD) this.valueFallback3D = tex;
      else this.valueFallback2D = tex;
      gl.bindTexture(target, tex);
      uploadFull(
        gl,
        target,
        WebGL2RenderingContext.RG32UI,
        1,
        1,
        1,
        WebGL2RenderingContext.RG_INTEGER,
        WebGL2RenderingContext.UNSIGNED_INT,
        new Uint32Array(2),
      );
      applyTextureParams(gl, target);
    } else {
      gl.bindTexture(target, tex);
    }
  }

  /** Same idea as {@link bindValueFallback}, for the R8UI mask sampler. */
  private bindMaskFallback(gl: GL, textureUnit: number, threeD: boolean): void {
    gl.activeTexture(WebGL2RenderingContext.TEXTURE0 + textureUnit);
    const target = threeD
      ? WebGL2RenderingContext.TEXTURE_3D
      : WebGL2RenderingContext.TEXTURE_2D;
    let tex = threeD ? this.maskFallback3D : this.maskFallback2D;
    if (tex === undefined) {
      this.contexts.add(gl);
      const newTex = gl.createTexture();
      if (newTex === null) {
        throw new Error("PatchTextureCache: failed to create mask fallback");
      }
      tex = newTex;
      if (threeD) this.maskFallback3D = tex;
      else this.maskFallback2D = tex;
      gl.bindTexture(target, tex);
      uploadFull(
        gl,
        target,
        WebGL2RenderingContext.R8UI,
        1,
        1,
        1,
        WebGL2RenderingContext.RED_INTEGER,
        WebGL2RenderingContext.UNSIGNED_BYTE,
        new Uint8Array(1),
      );
      applyTextureParams(gl, target);
    } else {
      gl.bindTexture(target, tex);
    }
  }

  disposed(): void {
    for (const gl of this.contexts) {
      for (const tex of this.valueTextures.values()) gl.deleteTexture(tex);
      for (const tex of this.maskTextures.values()) gl.deleteTexture(tex);
      for (const tex of [
        this.valueFallback2D,
        this.valueFallback3D,
        this.maskFallback2D,
        this.maskFallback3D,
      ]) {
        if (tex !== undefined) gl.deleteTexture(tex);
      }
    }
    this.valueTextures.clear();
    this.maskTextures.clear();
    this.valueFallback2D = undefined;
    this.valueFallback3D = undefined;
    this.maskFallback2D = undefined;
    this.maskFallback3D = undefined;
    this.contexts.clear();
    super.disposed();
  }
}

/** Identity strides (texel coord == chunk coord) used before the layout is known. */
const IDENTITY_STRIDES = Int32Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]);

/** Upload a full texture (2D or 3D) of `tw × th × td` texels. */
function uploadFull(
  gl: GL,
  target: number,
  internalFormat: number,
  tw: number,
  th: number,
  td: number,
  format: number,
  type: number,
  data: ArrayBufferView,
): void {
  if (target === WebGL2RenderingContext.TEXTURE_3D) {
    gl.texImage3D(target, 0, internalFormat, tw, th, td, 0, format, type, data);
  } else {
    gl.texImage2D(target, 0, internalFormat, tw, th, 0, format, type, data);
  }
}

/**
 * Upload only `box` of a chunk's CPU array into the bound texture via
 * `texSubImage2D`/`texSubImage3D`. The box's chunk-local bounds are remapped
 * to texture-dim order through `layout.texDimAxis` (only reached for separable
 * layouts, where each non-trivial axis owns a texture axis with stride 1, so
 * the box is a contiguous texel rectangle and the chunk's flat memory layout
 * equals the texture's row-major layout). UNPACK_ROW_LENGTH /
 * UNPACK_IMAGE_HEIGHT / UNPACK_SKIP_* address the sub-box directly inside the
 * full-size array, so no staging copy is made; all five parameters are reset
 * to 0 afterwards (neuroglancer's other upload paths assume the defaults).
 */
function uploadSubBox(
  gl: GL,
  target: number,
  layout: PatchLayout,
  box: ChunkVoxelBox,
  format: number,
  type: number,
  data: ArrayBufferView,
  bytesPerVoxel: number,
  profCountName: string | undefined,
): void {
  const lo = [box.x0, box.y0, box.z0];
  const hi = [box.x1, box.y1, box.z1];
  // Per texture dim: offset (skip) and extent, derived from the chunk axis
  // feeding that dim. Texture dims with no axis (collapsed size-1) span [0,1).
  const off = [0, 0, 0];
  const ext = [1, 1, 1];
  for (let dim = 0; dim < layout.textureDims; ++dim) {
    const axis = layout.texDimAxis[dim];
    if (axis === -1) continue;
    off[dim] = lo[axis];
    ext[dim] = hi[axis] - lo[axis] + 1;
  }
  const [tx, ty] = layout.textureShape;
  gl.pixelStorei(WebGL2RenderingContext.UNPACK_ROW_LENGTH, tx);
  gl.pixelStorei(WebGL2RenderingContext.UNPACK_IMAGE_HEIGHT, ty);
  gl.pixelStorei(WebGL2RenderingContext.UNPACK_SKIP_PIXELS, off[0]);
  gl.pixelStorei(WebGL2RenderingContext.UNPACK_SKIP_ROWS, off[1]);
  gl.pixelStorei(WebGL2RenderingContext.UNPACK_SKIP_IMAGES, off[2]);
  if (target === WebGL2RenderingContext.TEXTURE_3D) {
    gl.texSubImage3D(
      target,
      0,
      off[0],
      off[1],
      off[2],
      ext[0],
      ext[1],
      ext[2],
      format,
      type,
      data,
      0,
    );
  } else {
    gl.texSubImage2D(
      target,
      0,
      off[0],
      off[1],
      ext[0],
      ext[1],
      format,
      type,
      data,
      0,
    );
  }
  gl.pixelStorei(WebGL2RenderingContext.UNPACK_ROW_LENGTH, 0);
  gl.pixelStorei(WebGL2RenderingContext.UNPACK_IMAGE_HEIGHT, 0);
  gl.pixelStorei(WebGL2RenderingContext.UNPACK_SKIP_PIXELS, 0);
  gl.pixelStorei(WebGL2RenderingContext.UNPACK_SKIP_ROWS, 0);
  gl.pixelStorei(WebGL2RenderingContext.UNPACK_SKIP_IMAGES, 0);
  if (profCountName !== undefined) {
    paintProfiler.count(profCountName, 1);
    paintProfiler.count(
      "gpu.uploadBytes",
      ext[0] * ext[1] * ext[2] * bytesPerVoxel,
    );
  }
}

function applyTextureParams(gl: GL, target: number) {
  gl.texParameteri(
    target,
    WebGL2RenderingContext.TEXTURE_MIN_FILTER,
    WebGL2RenderingContext.NEAREST,
  );
  gl.texParameteri(
    target,
    WebGL2RenderingContext.TEXTURE_MAG_FILTER,
    WebGL2RenderingContext.NEAREST,
  );
  gl.texParameteri(
    target,
    WebGL2RenderingContext.TEXTURE_WRAP_S,
    WebGL2RenderingContext.CLAMP_TO_EDGE,
  );
  gl.texParameteri(
    target,
    WebGL2RenderingContext.TEXTURE_WRAP_T,
    WebGL2RenderingContext.CLAMP_TO_EDGE,
  );
  if (target === WebGL2RenderingContext.TEXTURE_3D) {
    gl.texParameteri(
      target,
      WebGL2RenderingContext.TEXTURE_WRAP_R,
      WebGL2RenderingContext.CLAMP_TO_EDGE,
    );
  }
}
