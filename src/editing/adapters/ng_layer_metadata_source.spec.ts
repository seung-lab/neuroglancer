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
 * @file Deterministic integration coverage for the metadata adapter's
 * error-surfacing and retry paths (TM-374). No browser needed: a minimal fake
 * `LayerManager`/data-source drives the real `resolve` / `reload` code so the
 * "aborted request → typed error surfaced → retry re-fetches → recovers" flow
 * is exercised without manual DevTools blocking.
 */

import { LayerMetadataUnavailableError } from "@zettaai/edit-session";
import { describe, expect, it } from "vitest";

import { NgLayerMetadataSource } from "#src/editing/adapters/ng_layer_metadata_source.js";
import { classifyMetadataError } from "#src/editing/ui/session_entry/layer_availability.js";
import type { LayerManager } from "#src/layer/index.js";
import { DataType } from "#src/util/data_type.js";
import { HttpError } from "#src/util/http_request.js";
import { NullarySignal } from "#src/util/signal.js";

const LAYER = "lyr";

/** A `loadState` in the error state, carrying the original typed error. */
function erroredLoadState(error: Error) {
  return { error };
}

/**
 * A minimal `loadState` that exposes a single-scale volumetric subsource — just
 * enough surface for `resolve` to build metadata with one resolution.
 */
function volumetricLoadState() {
  const source = {
    chunkSource: {
      spec: {
        rank: 3,
        baseVoxelOffset: [0, 0, 0],
        lowerVoxelBound: [0, 0, 0],
        upperVoxelBound: [64, 64, 64],
        chunkDataSize: [64, 64, 64],
      },
    },
    // Identity chunk→multiscale transform (stride = rank + 1 = 4).
    chunkToMultiscaleTransform: (() => {
      const m = new Float32Array(16);
      m[0] = m[5] = m[10] = m[15] = 1;
      return m;
    })(),
  };
  const volume = {
    dataType: DataType.UINT8,
    rank: 3,
    getSources: () => [[source]],
  };
  return {
    error: undefined,
    dataSource: {
      modelTransform: {
        outputSpace: {
          scales: [8e-9, 8e-9, 8e-9],
          units: ["m", "m", "m"],
        },
      },
    },
    subsources: [{ subsourceEntry: { subsource: { volume } } }],
  };
}

/** A `loadState` that loaded cleanly but exposes no volumetric subsource. */
function nonVolumetricLoadState() {
  return { error: undefined, subsources: [] };
}

/**
 * Build a fake `LayerManager` whose single data source walks `attempts`:
 * - `settle()` advances to the next attempt and dispatches (simulates the
 *   viewer's in-flight load completing), for the wait-for-settle path.
 * - re-assigning `spec` (the adapter's refetch primitive) goes pending then
 *   advances asynchronously, like the real loader.
 * An `undefined` attempt models a still-loading (unsettled) source.
 */
function makeManager(attempts: unknown[]) {
  const dataSourcesChanged = new NullarySignal();
  let index = 0;
  const advance = (dataSource: Record<string, unknown>) => {
    index = Math.min(index + 1, attempts.length - 1);
    dataSource.loadState = attempts[index];
    dataSourcesChanged.dispatch();
  };
  const dataSource: Record<string, unknown> = {
    loadState: attempts[0],
    _spec: { url: "gs://bucket/x" },
    get spec() {
      return this._spec;
    },
    set spec(value: unknown) {
      this._spec = value;
      // Re-resolution: goes pending, then settles on the next scripted attempt.
      this.loadState = undefined;
      queueMicrotask(() => advance(this));
      dataSourcesChanged.dispatch();
    },
  };
  const userLayer = { dataSources: [dataSource], dataSourcesChanged };
  const managed = { layer: userLayer, name: LAYER };
  const layerManager = {
    getLayerByName: (n: string) => (n === LAYER ? managed : undefined),
    layersChanged: new NullarySignal(),
  };
  return {
    manager: layerManager as unknown as LayerManager,
    /** Advance the source to its next scripted state (viewer load settling). */
    settle: () => advance(dataSource),
  };
}

const LID = LAYER as never;

describe("NgLayerMetadataSource.resolve — surfaces the original typed error", () => {
  it("re-throws the data source's HttpError instead of a generic no-metadata", async () => {
    const httpError = new HttpError(
      "gs://bucket/x/info",
      0,
      "Network or CORS error",
    );
    const source = new NgLayerMetadataSource(
      makeManager([erroredLoadState(httpError)]).manager,
    );
    // The original HttpError is surfaced verbatim…
    await expect(source.resolve(LID)).rejects.toBe(httpError);
    // …so the modal classifier can see it's a retriable transport failure.
    expect(classifyMetadataError(httpError)).toMatchObject({
      code: "fetch-failed",
      retriable: true,
    });
  });

  it("throws no-metadata only when sources loaded cleanly but expose no volume", async () => {
    const source = new NgLayerMetadataSource(
      makeManager([nonVolumetricLoadState()]).manager,
    );
    await expect(source.resolve(LID)).rejects.toBeInstanceOf(
      LayerMetadataUnavailableError,
    );
  });
});

describe("NgLayerMetadataSource.validate — one shared, race-free path", () => {
  it("waits for a still-loading source to settle before classifying (never premature no-metadata)", async () => {
    // Attempt 0 is `undefined` — the source is still loading. The premature
    // classification bug would resolve this as no-metadata; validate must wait.
    const { manager, settle } = makeManager([undefined, volumetricLoadState()]);
    const source = new NgLayerMetadataSource(manager);
    const pending = source.validate(LID);
    // The viewer's load completes: now the volume is available.
    settle();
    const metadata = await pending;
    expect(metadata.voxelDataType).toBe("uint8");
  });

  it("retry on a HEALTHY layer returns metadata, never no-metadata (the reported bug)", async () => {
    // Layer is already healthy behind the modal. A refetch must not re-run and
    // must not land in a terminal error.
    const source = new NgLayerMetadataSource(
      makeManager([volumetricLoadState()]).manager,
    );
    const metadata = await source.validate(LID, { refetch: true });
    expect(metadata.voxelDataType).toBe("uint8");
  });

  it("round trip: initial fetch-failed → retry still failing → retry succeeds → healthy", async () => {
    const err = new HttpError("gs://bucket/x/info", 0, "Network or CORS error");
    const source = new NgLayerMetadataSource(
      makeManager([
        erroredLoadState(err),
        erroredLoadState(err),
        volumetricLoadState(),
      ]).manager,
    );

    // Initial validation (no refetch): the surfaced transport error →
    // fetch-failed, identical to what a fresh modal open would classify.
    await expect(source.validate(LID)).rejects.toBe(err);
    expect(classifyMetadataError(err)).toMatchObject({
      code: "fetch-failed",
      retriable: true,
    });

    // Retry #1: still failing — stays a (retriable) transport error, NOT a
    // terminal no-metadata.
    await expect(
      source.validate(LID, { refetch: true }),
    ).rejects.toBeInstanceOf(HttpError);

    // Retry #2: recovers to healthy.
    const metadata = await source.validate(LID, { refetch: true });
    expect(metadata.voxelDataType).toBe("uint8");
    expect(metadata.scales.length).toBe(1);
  });

  it("reload is a refetch alias for validate", async () => {
    const err = new HttpError("gs://bucket/x/info", 0, "Network or CORS error");
    const source = new NgLayerMetadataSource(
      makeManager([erroredLoadState(err), volumetricLoadState()]).manager,
    );
    const metadata = await source.reload(LID);
    expect(metadata.voxelDataType).toBe("uint8");
  });
});
