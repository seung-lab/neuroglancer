/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type {
  ChunkContentRef,
  LayerId,
  LayerMetadata,
  ReadonlyChunkVoxelBuffer,
  SavedChunk,
  SavePayload,
} from "@zettaai/edit-session";
import { Resolution, layerId, sessionId } from "@zettaai/edit-session";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import type { NgLayerMetadataSource } from "#src/editing/adapters/ng_layer_metadata_source.js";
import { NgSaveTarget } from "#src/editing/adapters/ng_save_target.js";
import type {
  SaveBackend,
  SaveBackendResult,
} from "#src/editing/adapters/save_backend.js";
import {
  registerSaveBackend,
  unregisterSaveBackend,
} from "#src/editing/adapters/save_backend.js";

import { FakeLayerManager } from "#tests/editing/fixtures/fake_layer_manager.js";
import { FakeLogger } from "#tests/editing/fixtures/fake_logger.js";

const RESOLUTION = Resolution.from([8, 8, 40]);

function fakeContentRef(): ChunkContentRef {
  return {
    hash: "abc",
    byteLength: 4,
    async retain(): Promise<ReadonlyChunkVoxelBuffer> {
      const view = new Uint8Array(4);
      return { byteLength: 4, asView: () => view };
    },
  };
}

function chunk(layerName: string): SavedChunk {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  return {
    layerId: layerId(layerName),
    resolution: RESOLUTION,
    chunkId: "0,0,0",
    chunkCoord: { x: 0, y: 0, z: 0 },
    contentRef: fakeContentRef(),
    bytes: { byteLength: bytes.byteLength, asView: () => bytes },
  };
}

function payload(layerNames: readonly string[]): SavePayload {
  return {
    sessionId: sessionId("test-session"),
    savedAt: 0,
    layerIds: layerNames.map((n) => layerId(n)),
    chunks: layerNames.map((n) => chunk(n)),
  };
}

function fakeMetadataSource(): NgLayerMetadataSource {
  return {
    async resolve(id: LayerId): Promise<LayerMetadata> {
      return {
        layerId: id,
        voxelDataType: "uint64",
        channels: 1,
        scales: [
          {
            resolution: RESOLUTION,
            voxelSizeNm: [8, 8, 40],
            voxelOffset: [0, 0, 0],
            sizeVoxels: [64, 64, 64],
            chunkDataSize: [64, 64, 64],
          },
        ],
      };
    },
  } as unknown as NgLayerMetadataSource;
}

describe("NgSaveTarget", () => {
  // Unique scheme per test to avoid registry pollution between cases.
  const usedSchemes: string[] = [];

  afterEach(() => {
    for (const scheme of usedSchemes) unregisterSaveBackend(scheme);
    usedSchemes.length = 0;
  });

  let logger: FakeLogger;
  beforeEach(() => {
    logger = new FakeLogger();
  });

  it("unknown data-source kind reports save-skipped per layer", async () => {
    const layers = new FakeLayerManager([
      { name: "L1", canonicalUrl: "mystery-scheme://example/" },
    ]);
    const target = new NgSaveTarget(
      layers.asLayerManager(),
      fakeMetadataSource(),
      logger.asNgLogger(),
    );
    const result = await target.save(payload(["L1"]));
    expect(result.overall).toBe("all-failed");
    expect(result.outcomes).toHaveLength(1);
    const outcome = result.outcomes[0];
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error.code).toBe("save-skipped");
      expect(outcome.error.message).toMatch(/no-save-backend-for-datasource/);
    }
  });

  it("layer with no data source loaded also reports skipped", async () => {
    const layers = new FakeLayerManager([{ name: "L1", nullUserLayer: true }]);
    const target = new NgSaveTarget(
      layers.asLayerManager(),
      fakeMetadataSource(),
      logger.asNgLogger(),
    );
    const result = await target.save(payload(["L1"]));
    expect(result.overall).toBe("all-failed");
    const outcome = result.outcomes[0];
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error.code).toBe("save-skipped");
      expect(outcome.error.message).toMatch(/no-data-source-loaded/);
    }
  });

  it("registered backend success path returns succeeded outcome", async () => {
    const scheme = "fake-scheme-success";
    usedSchemes.push(scheme);
    const backend: SaveBackend = {
      async saveLayer(id): Promise<SaveBackendResult> {
        return { status: "succeeded", layerId: id, chunkCount: 1 };
      },
    };
    registerSaveBackend(scheme, backend);

    const layers = new FakeLayerManager([
      { name: "L1", canonicalUrl: `${scheme}://example/` },
    ]);
    const target = new NgSaveTarget(
      layers.asLayerManager(),
      fakeMetadataSource(),
      logger.asNgLogger(),
    );

    const result = await target.save(payload(["L1"]));
    expect(result.overall).toBe("all-succeeded");
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].status).toBe("succeeded");
  });

  it("backend throw is caught and converted to a failed outcome", async () => {
    const scheme = "fake-scheme-throw";
    usedSchemes.push(scheme);
    const backend: SaveBackend = {
      async saveLayer(): Promise<SaveBackendResult> {
        throw new Error("network down");
      },
    };
    registerSaveBackend(scheme, backend);

    const layers = new FakeLayerManager([
      { name: "L1", canonicalUrl: `${scheme}://example/` },
    ]);
    const target = new NgSaveTarget(
      layers.asLayerManager(),
      fakeMetadataSource(),
      logger.asNgLogger(),
    );

    const result = await target.save(payload(["L1"]));
    expect(result.overall).toBe("all-failed");
    const outcome = result.outcomes[0];
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error.code).toBe("save-failed");
      expect(outcome.error.message).toMatch(/network down/);
    }
    // Logger should have captured the error.
    expect(
      logger.logs.some(
        (l) => l.level === "error" && /Save failed for layer/.test(l.message),
      ),
    ).toBe(true);
  });

  it("computes a 'partial' overall when some layers succeed and others fail", async () => {
    const successScheme = "fake-partial-ok";
    const failScheme = "fake-partial-bad";
    usedSchemes.push(successScheme, failScheme);
    registerSaveBackend(successScheme, {
      async saveLayer(id): Promise<SaveBackendResult> {
        return { status: "succeeded", layerId: id, chunkCount: 1 };
      },
    });
    registerSaveBackend(failScheme, {
      async saveLayer(id): Promise<SaveBackendResult> {
        return { status: "failed", layerId: id, error: "boom" };
      },
    });

    const layers = new FakeLayerManager([
      { name: "L1", canonicalUrl: `${successScheme}://x` },
      { name: "L2", canonicalUrl: `${failScheme}://x` },
    ]);
    const target = new NgSaveTarget(
      layers.asLayerManager(),
      fakeMetadataSource(),
      logger.asNgLogger(),
    );

    const result = await target.save(payload(["L1", "L2"]));
    expect(result.overall).toBe("partial");
    expect(result.outcomes.map((o) => o.status)).toEqual([
      "succeeded",
      "failed",
    ]);
  });
});
