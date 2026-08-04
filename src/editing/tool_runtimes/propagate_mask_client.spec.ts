/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest";

import {
  propagateMask,
  PROPAGATE_MASK_PATH,
  type MultipartPoster,
  type PropagateMaskInput,
} from "#src/editing/tool_runtimes/propagate_mask_client.js";

interface CapturedRequest {
  path: string;
  form: FormData;
  init: RequestInit | undefined;
}

/** A fake poster that records the request and replays a canned response body. */
function fakePoster(responseBody: ArrayBuffer): {
  poster: MultipartPoster;
  captured: CapturedRequest[];
} {
  const captured: CapturedRequest[] = [];
  const poster: MultipartPoster = {
    postMultipart(path, form, init) {
      captured.push({ path, form, init });
      return Promise.resolve(new Response(responseBody));
    },
  };
  return { poster, captured };
}

/** Frame a predicted mask the way the backend does: [u32 len][json][labels]. */
function encodeResponse(
  height: number,
  width: number,
  labels: Uint8Array,
): ArrayBuffer {
  const headerBytes = new TextEncoder().encode(
    JSON.stringify({ mask_shape: [height, width] }),
  );
  const buffer = new ArrayBuffer(4 + headerBytes.length + labels.length);
  const view = new DataView(buffer);
  view.setUint32(0, headerBytes.length, true);
  new Uint8Array(buffer, 4, headerBytes.length).set(headerBytes);
  new Uint8Array(buffer, 4 + headerBytes.length).set(labels);
  return buffer;
}

async function gzip(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  const stream = new Response(buffer).body!.pipeThrough(
    new CompressionStream("gzip"),
  );
  return new Response(stream).arrayBuffer();
}

const INPUT: PropagateMaskInput = {
  currentImage: Uint8Array.from([10, 11, 12, 13]),
  maskLabels: Uint8Array.from([1, 0, 2, 0]),
  nextImage: Uint8Array.from([20, 21, 22, 23]),
  width: 2,
  height: 2,
};

function partBytes(form: FormData, name: string): Promise<Uint8Array> {
  // Read via FileReader: specs run under jsdom, whose Blob parts are not
  // recognized by node's (undici) Response/arrayBuffer, but ARE by jsdom's own
  // FileReader.
  const part = form.get(name) as Blob;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(part);
  });
}

describe("propagateMask request", () => {
  it("posts to the propagate path with an octet-stream Accept header", async () => {
    const { poster, captured } = fakePoster(
      encodeResponse(2, 2, Uint8Array.from([1, 1, 1, 1])),
    );
    const signal = new AbortController().signal;
    await propagateMask(poster, INPUT, signal);

    expect(captured).toHaveLength(1);
    expect(captured[0].path).toBe(PROPAGATE_MASK_PATH);
    const headers = new Headers(captured[0].init?.headers);
    expect(headers.get("Accept")).toBe("application/octet-stream");
    expect(captured[0].init?.signal).toBe(signal);
  });

  it("sends metadata plus the three slice parts", async () => {
    const { poster, captured } = fakePoster(
      encodeResponse(2, 2, Uint8Array.from([0, 0, 0, 0])),
    );
    await propagateMask(poster, INPUT);
    const form = captured[0].form;

    const metadata = JSON.parse(
      new TextDecoder().decode(await partBytes(form, "metadata")),
    );
    expect(metadata).toEqual({
      height: 2,
      width: 2,
      mask_dtype: "uint8",
      image_dtype: "uint8",
    });
    expect([...(await partBytes(form, "current-image-data"))]).toEqual([
      10, 11, 12, 13,
    ]);
    expect([...(await partBytes(form, "mask-data"))]).toEqual([1, 0, 2, 0]);
    expect([...(await partBytes(form, "image-data"))]).toEqual([
      20, 21, 22, 23,
    ]);
  });
});

describe("propagateMask response decode", () => {
  it("parses an uncompressed response", async () => {
    const labels = Uint8Array.from([1, 2, 0, 2]);
    const { poster } = fakePoster(encodeResponse(2, 2, labels));
    const result = await propagateMask(poster, INPUT);
    expect(result.maskShape).toEqual([2, 2]);
    expect([...result.predictedLabels]).toEqual([1, 2, 0, 2]);
  });

  it("inflates a gzip-compressed response", async () => {
    const labels = Uint8Array.from([3, 0, 1, 4]);
    const { poster } = fakePoster(await gzip(encodeResponse(2, 2, labels)));
    const result = await propagateMask(poster, INPUT);
    expect(result.maskShape).toEqual([2, 2]);
    expect([...result.predictedLabels]).toEqual([3, 0, 1, 4]);
  });

  it("returns exactly height*width label bytes", async () => {
    const labels = Uint8Array.from([5, 6, 7, 8, 9, 10]);
    const { poster } = fakePoster(encodeResponse(2, 3, labels));
    const result = await propagateMask(poster, INPUT);
    expect(result.predictedLabels).toHaveLength(6);
    expect([...result.predictedLabels]).toEqual([5, 6, 7, 8, 9, 10]);
  });
});
