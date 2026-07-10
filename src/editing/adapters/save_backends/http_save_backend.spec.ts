/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { LayerId, LayerMetadata, SavedChunk } from "@zettaai/edit-session";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildCutoutParams,
  cutoutBbox,
  dataSourceUrlToCutoutPath,
  HttpSaveBackend,
  parseResolution,
} from "#src/editing/adapters/save_backends/http_save_backend.js";
import type { BackendClient } from "#src/editing/backend/backend_client.js";

// Stub `scaleFor` so a fake chunk resolves to a known scale (voxelOffset +
// chunkDataSize) without constructing real layer metadata. `vi.mock` and
// `vi.hoisted` are hoisted above the imports above, so the mock is registered
// before `@zettaai/edit-session` is loaded by the module under test.
const { scaleForSpy } = vi.hoisted(() => ({ scaleForSpy: vi.fn() }));
vi.mock("@zettaai/edit-session", () => ({ scaleFor: scaleForSpy }));

afterEach(() => {
  scaleForSpy.mockReset();
});

describe("cutout request helpers", () => {
  it("maps precomputed / calcada / plain URLs to a storage path", () => {
    expect(dataSourceUrlToCutoutPath("gs://b/p|precomputed:")).toBe("gs://b/p");
    expect(dataSourceUrlToCutoutPath("calcada://gs://b/p")).toBe("gs://b/p");
    expect(dataSourceUrlToCutoutPath("gs://b/p/")).toBe("gs://b/p");
    expect(dataSourceUrlToCutoutPath("")).toBeUndefined();
    expect(dataSourceUrlToCutoutPath(undefined)).toBeUndefined();
  });

  it("parses a resolution key and rejects malformed ones", () => {
    expect(parseResolution("8x8x40")).toEqual([8, 8, 40]);
    expect(() => parseResolution("8x8")).toThrow();
    expect(() => parseResolution("axbxc")).toThrow();
  });

  it("computes an absolute bbox from chunk grid coords + voxel offset", () => {
    expect(cutoutBbox({ x: 2, y: 0, z: 1 }, [64, 64, 8], [10, 20, 30])).toEqual(
      { start: [138, 20, 38], end: [202, 84, 46] },
    );
  });

  it("builds repeated-key cutout params", () => {
    const params = buildCutoutParams({
      path: "gs://b/p",
      resolution: [8, 8, 40],
      start: [0, 0, 5],
      end: [64, 64, 6],
    });
    expect(params.get("path")).toBe("gs://b/p");
    expect(params.getAll("resolution")).toEqual(["8", "8", "40"]);
    expect(params.getAll("bbox_start")).toEqual(["0", "0", "5"]);
    expect(params.getAll("bbox_end")).toEqual(["64", "64", "6"]);
  });
});

function fakeChunk(coord: { x: number; y: number; z: number }): SavedChunk {
  return {
    layerId: "layer-1" as LayerId,
    resolution: "8x8x40",
    chunkCoord: coord,
    bytes: { asView: () => new Uint8Array([1, 2, 3, 4]) },
  } as unknown as SavedChunk;
}

const metadata = {} as LayerMetadata;

function makeClient(request: BackendClient["request"]): BackendClient {
  return { request } as unknown as BackendClient;
}

describe("HttpSaveBackend.saveLayer", () => {
  it("posts each chunk to /painting/cutout with the derived bbox + gzipped body", async () => {
    scaleForSpy.mockReturnValue({
      chunkDataSize: [64, 64, 8],
      voxelOffset: [0, 0, 0],
    });
    const request = vi.fn(
      async (_path: string, _init?: RequestInit) =>
        new Response("", { status: 200 }),
    );
    const backend = new HttpSaveBackend({
      client: makeClient(request),
      resolveDataSourceUrl: () => "gs://b/p|precomputed:",
    });

    const result = await backend.saveLayer(
      "layer-1" as LayerId,
      [fakeChunk({ x: 1, y: 0, z: 2 })],
      metadata,
      new AbortController().signal,
    );

    expect(result).toEqual({
      status: "succeeded",
      layerId: "layer-1",
      chunkCount: 1,
    });
    const [path, init] = request.mock.calls[0];
    expect(path).toContain("/painting/cutout?");
    expect(path).toContain("path=gs%3A%2F%2Fb%2Fp");
    expect(path).toContain("bbox_start=64"); // 1 * 64 on x
    expect(path).toContain("bbox_end=128");
    expect((init as RequestInit).method).toBe("POST");
    // Body is gzip-compressed (magic bytes 0x1f 0x8b), not the raw chunk.
    const bodyBytes = new Uint8Array((init as RequestInit).body as ArrayBuffer);
    expect([bodyBytes[0], bodyBytes[1]]).toEqual([0x1f, 0x8b]);
  });

  it("skips a layer whose data-source URL cannot be resolved", async () => {
    const request = vi.fn();
    const backend = new HttpSaveBackend({
      client: makeClient(request),
      resolveDataSourceUrl: () => undefined,
    });
    const result = await backend.saveLayer(
      "layer-1" as LayerId,
      [fakeChunk({ x: 0, y: 0, z: 0 })],
      metadata,
      new AbortController().signal,
    );
    expect(result.status).toBe("skipped");
    expect(request).not.toHaveBeenCalled();
  });

  it("reports partial when some chunks fail", async () => {
    scaleForSpy.mockReturnValue({
      chunkDataSize: [64, 64, 8],
      voxelOffset: [0, 0, 0],
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockRejectedValueOnce(new Error("boom"));
    const backend = new HttpSaveBackend({
      client: makeClient(request),
      resolveDataSourceUrl: () => "gs://b/p",
    });
    const result = await backend.saveLayer(
      "layer-1" as LayerId,
      [fakeChunk({ x: 0, y: 0, z: 0 }), fakeChunk({ x: 1, y: 0, z: 0 })],
      metadata,
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      status: "partial",
      succeeded: 1,
      failed: 1,
    });
  });

  it("returns succeeded with zero chunks without calling the client", async () => {
    const request = vi.fn();
    const backend = new HttpSaveBackend({
      client: makeClient(request),
      resolveDataSourceUrl: () => "gs://b/p",
    });
    const result = await backend.saveLayer(
      "layer-1" as LayerId,
      [],
      metadata,
      new AbortController().signal,
    );
    expect(result).toEqual({
      status: "succeeded",
      layerId: "layer-1",
      chunkCount: 0,
    });
    expect(request).not.toHaveBeenCalled();
  });
});
