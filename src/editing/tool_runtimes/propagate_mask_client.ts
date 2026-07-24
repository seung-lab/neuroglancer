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
 * @file Request/response codec for the backend `propagate_mask` endpoint.
 *
 * Sends the current slice's image + labelized mask and the next slice's image
 * as a multipart body through the shared {@link BackendClient} (which owns the
 * endpoint URL, auth, subportal scoping, and 401 retry — this module never sees
 * them), then decodes the model's predicted label mask.
 *
 * Response framing (little-endian): a `uint32` header length, then that many
 * bytes of JSON (`{ mask_shape: [height, width] }`), then `height * width`
 * `uint8` label bytes. The body may arrive gzip-compressed (no
 * `Content-Encoding`, so the browser does not auto-inflate it); we detect the
 * gzip magic and inflate before parsing.
 */

import type { BackendClient } from "#src/editing/backend/backend_client.js";

/** Backend path for the propagate compute (relative to the endpoint root). */
export const PROPAGATE_MASK_PATH = "/segmentation/propagate_mask";

export interface PropagateMaskInput {
  /** Image slice at the current Z, `uint8`, x-fastest (`y * width + x`). */
  readonly currentImage: Uint8Array;
  /** Labelized mask slice at the current Z, same layout. */
  readonly maskLabels: Uint8Array;
  /** Image slice at the next Z (the propagation target), same layout. */
  readonly nextImage: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface PropagateMaskResult {
  /** Predicted mask shape `[height, width]` as reported by the backend. */
  readonly maskShape: readonly [number, number];
  /** Predicted label per voxel (0 = background, 1..N = tracked segment). */
  readonly predictedLabels: Uint8Array;
}

/** The slice of {@link BackendClient} this codec needs (eases testing). */
export type MultipartPoster = Pick<BackendClient, "postMultipart">;

/**
 * Run one propagation: POST the slices and decode the predicted label mask.
 * Rejects with whatever {@link BackendClient} surfaces (`HttpError`,
 * `BackendAuthExpiredError`, `BackendUnavailableError`) or an `AbortError` if
 * `signal` fires.
 */
export async function propagateMask(
  client: MultipartPoster,
  input: PropagateMaskInput,
  signal?: AbortSignal,
): Promise<PropagateMaskResult> {
  const response = await client.postMultipart(
    PROPAGATE_MASK_PATH,
    buildRequestForm(input),
    { headers: { Accept: "application/octet-stream" }, signal },
  );
  const body = await inflateIfGzipped(await response.arrayBuffer());
  return parseResponse(body);
}

function buildRequestForm(input: PropagateMaskInput): FormData {
  const metadata = JSON.stringify({
    height: input.height,
    width: input.width,
    mask_dtype: "uint8",
    image_dtype: "uint8",
  });
  const form = new FormData();
  form.append("metadata", new Blob([metadata], { type: "application/json" }));
  form.append("current-image-data", octetStreamBlob(input.currentImage));
  form.append("mask-data", octetStreamBlob(input.maskLabels));
  form.append("image-data", octetStreamBlob(input.nextImage));
  return form;
}

function octetStreamBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes], { type: "application/octet-stream" });
}

const GZIP_MAGIC_BYTE_0 = 0x1f;
const GZIP_MAGIC_BYTE_1 = 0x8b;

/**
 * Inflate `buffer` when it carries the gzip magic header, otherwise return it
 * unchanged. Falls back to the raw buffer if decompression throws, so a
 * false-positive magic match can never lose the response.
 */
async function inflateIfGzipped(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  const head = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength));
  const isGzipped =
    head.length === 2 &&
    head[0] === GZIP_MAGIC_BYTE_0 &&
    head[1] === GZIP_MAGIC_BYTE_1;
  if (!isGzipped) return buffer;
  try {
    const stream = new Response(buffer).body;
    if (stream === null) return buffer;
    const inflated = stream.pipeThrough(new DecompressionStream("gzip"));
    return await new Response(inflated).arrayBuffer();
  } catch {
    return buffer;
  }
}

function parseResponse(buffer: ArrayBuffer): PropagateMaskResult {
  const view = new DataView(buffer);
  const headerLength = view.getUint32(0, true);
  const headerBytes = new Uint8Array(buffer, 4, headerLength);
  const header = JSON.parse(new TextDecoder().decode(headerBytes)) as {
    mask_shape: [number, number];
  };
  const [height, width] = header.mask_shape;
  const maskByteOffset = 4 + headerLength;
  const maskSize = height * width;
  // Copy out of the (possibly larger) response buffer so the result owns its
  // bytes and the underlying ArrayBuffer can be released.
  const predictedLabels = new Uint8Array(
    buffer,
    maskByteOffset,
    maskSize,
  ).slice();
  return { maskShape: [height, width], predictedLabels };
}
