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
  LayerId,
  LayerMetadata,
  LayerMetadataSource,
  Resolution,
  ScaleMetadata,
  VoxelDataType,
} from "@zettaai/edit-session";
import {
  LayerMetadataUnavailableError,
  Resolution as ResolutionFactory,
} from "@zettaai/edit-session";

import type { LayerManager, UserLayer } from "#src/layer/index.js";
import type {
  LayerDataSource,
  LoadedLayerDataSource,
} from "#src/layer/layer_data_source.js";
import type {
  SliceViewSingleResolutionSource,
  MultiscaleSliceViewChunkSource,
} from "#src/sliceview/frontend.js";
import type {
  VolumeChunkSpecification,
  VolumeSourceOptions,
} from "#src/sliceview/volume/base.js";
import type {
  VolumeChunkSource,
  MultiscaleVolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import { DataType } from "#src/util/data_type.js";

/**
 * Thrown by {@link NgLayerMetadataSource.validate} when a layer's data sources
 * never settle within the timeout — a transient, retriable state (the modal
 * classifies it as `fetch-failed`), distinct from a terminal error. A typed
 * class so classification stays type-based, never message-string matching.
 */
export class LayerMetadataTimeoutError extends Error {
  override readonly name = "LayerMetadataTimeoutError";
  constructor(
    public readonly layerId: LayerId,
    options?: { cause?: unknown },
  ) {
    super(`Timed out validating layer metadata for ${layerId}.`, options);
  }
}

/**
 * Adapter that translates a neuroglancer `UserLayer` into the library's
 * flat per-scale `LayerMetadata` shape.
 */
export class NgLayerMetadataSource implements LayerMetadataSource {
  constructor(private readonly layerManager: LayerManager) {}

  async resolve(layerId: LayerId): Promise<LayerMetadata> {
    const managedLayer = this.layerManager.getLayerByName(layerId);
    if (managedLayer === undefined) {
      throw new LayerMetadataUnavailableError(layerId, "layer-not-found");
    }
    const userLayer: UserLayer | null = managedLayer.layer;
    if (userLayer === null) {
      throw new LayerMetadataUnavailableError(layerId, "layer-not-found");
    }

    const found = findFirstVolumetricSubsource(userLayer);
    if (found === undefined) {
      // A data source that failed to load carries the ORIGINAL typed error
      // (HttpError with a status, NotFoundError, or a plain parse Error) on
      // its `loadState.error`. Surface it verbatim so the modal can classify
      // transport vs. absence vs. unparseable-format by type — collapsing all
      // of these into "no-volumetric-data-source" is exactly what made every
      // failure read as "No metadata" (TM-374). Only when the sources loaded
      // cleanly but expose no volume is this a genuine no-metadata layer.
      const loadError = firstDataSourceError(userLayer);
      if (loadError !== undefined) throw loadError;
      throw new LayerMetadataUnavailableError(
        layerId,
        "no-volumetric-data-source",
      );
    }
    const { volume, loadState } = found;

    const voxelDataType = mapDataType(volume.dataType);
    if (voxelDataType === undefined) {
      throw new LayerMetadataUnavailableError(layerId, "unsupported-data-type");
    }

    const modelResolutionNm = extractModelResolutionNm(loadState);

    const sources = collectAllScaleSources(volume);
    if (sources.length === 0) {
      throw new LayerMetadataUnavailableError(
        layerId,
        "no-volumetric-data-source",
      );
    }

    const scales: ScaleMetadata[] = sources.map((source) =>
      buildScaleMetadata(source, modelResolutionNm),
    );

    return {
      layerId,
      voxelDataType,
      channels: extractChannelCount(volume),
      scales,
    };
  }

  /**
   * Wait until a managed layer with `layerName` exists and exposes a
   * non-null `UserLayer`. Used by the edit-session restore flow before
   * touching layer-specific state — at viewer-startup time, URL-restored
   * layers may not have been instantiated yet, and `getLayerByName`
   * transiently returns `undefined`.
   *
   * Resolves once the layer is present. Rejects on timeout.
   */
  async waitForLayer(
    layerName: string,
    { timeoutMs = 30000 }: { timeoutMs?: number } = {},
  ): Promise<void> {
    if (this.findUserLayer(layerName) !== undefined) return;
    await this.subscribeUntil(
      () => this.findUserLayer(layerName) !== undefined,
      { trackPerLayer: false, timeoutMs, layerName },
    );
  }

  /**
   * Wait until the layer's data sources have settled enough that
   * `resolve(layerId)` would succeed — i.e. at least one
   * `LoadedLayerDataSource` exposes a volumetric subsource.
   *
   * Used by the edit-session restore flow because on page reload the
   * `editSession` URL block populates synchronously, but each layer's
   * data sources load asynchronously. Without this gate, restore races
   * data-source loading and clears the persisted session on a transient
   * "no-volumetric-data-source" error.
   *
   * Rejects if every data source on the layer has settled (some loaded,
   * some errored) with no volumetric subsource present — that's a
   * genuine reference failure, not a load race. Also rejects on timeout.
   */
  async waitForVolumetricReady(
    layerId: LayerId,
    { timeoutMs = 30000 }: { timeoutMs?: number } = {},
  ): Promise<void> {
    const check = (): { done: boolean; failure?: Error } => {
      const userLayer = this.findUserLayer(layerId);
      if (userLayer === undefined) return { done: false };
      if (findFirstVolumetricSubsource(userLayer) !== undefined) {
        return { done: true };
      }
      if (
        userLayer.dataSources.length > 0 &&
        userLayer.dataSources.every(allDataSourceSettled)
      ) {
        return {
          done: true,
          failure: new LayerMetadataUnavailableError(
            layerId,
            "no-volumetric-data-source",
          ),
        };
      }
      return { done: false };
    };
    const initial = check();
    if (initial.failure !== undefined) throw initial.failure;
    if (initial.done) return;
    await this.subscribeUntil(check, {
      trackPerLayer: true,
      timeoutMs,
      layerName: layerId,
    });
  }

  /**
   * The SINGLE classification path shared by the modal's initial validation,
   * reopen, and retry (TM-374) — so all three produce identical results.
   *
   * Always waits for the layer's data sources to settle before resolving, so a
   * still-loading layer is never snapshot mid-flight and misclassified as a
   * terminal error (the modal shows it as pending until this resolves).
   *
   * With `refetch: true` (retry) it first re-runs resolution for any errored
   * source: re-assigning a data source's spec disposes the failed attempt and
   * calls the datasource registry afresh. Combined with the async memoize no
   * longer caching rejections, this genuinely re-fetches rather than replaying
   * the cached error — so a layer that failed while offline recovers once the
   * network is back. Callers MUST serialize `refetch` calls per layer (no two
   * in flight at once): concurrent spec re-assignments race and can leave the
   * source transiently unsettled at resolve time.
   *
   * Defers to {@link resolve} once settled, so the fresh typed error surfaces
   * on repeated failure and the caller re-classifies. A hung load that never
   * settles throws {@link LayerMetadataTimeoutError} (a retriable transport
   * state), never a terminal error.
   */
  async validate(
    layerId: LayerId,
    {
      refetch = false,
      timeoutMs = 30000,
    }: { refetch?: boolean; timeoutMs?: number } = {},
  ): Promise<LayerMetadata> {
    const userLayer = this.findUserLayer(layerId);
    if (userLayer === undefined) {
      throw new LayerMetadataUnavailableError(layerId, "layer-not-found");
    }
    if (refetch) {
      for (const dataSource of userLayer.dataSources) {
        const loadState = dataSource.loadState;
        if (loadState !== undefined && loadState.error !== undefined) {
          // A shallow clone triggers the spec setter (which re-runs
          // resolution) without a self-assignment.
          dataSource.spec = { ...dataSource.spec };
        }
      }
    }
    try {
      await this.waitForSettled(layerId, { timeoutMs });
    } catch (cause) {
      // The sources never settled — a transient, retriable state, NOT a
      // terminal "no metadata". Surface it as a typed timeout the classifier
      // maps to `fetch-failed`.
      throw new LayerMetadataTimeoutError(layerId, { cause });
    }
    return this.resolve(layerId);
  }

  /** Back-compat alias for {@link validate} with a forced re-fetch. */
  reload(
    layerId: LayerId,
    { timeoutMs = 30000 }: { timeoutMs?: number } = {},
  ): Promise<LayerMetadata> {
    return this.validate(layerId, { refetch: true, timeoutMs });
  }

  /**
   * Resolve once every data source on the layer has settled (loaded or
   * errored) or a volumetric subsource is available. Unlike
   * {@link waitForVolumetricReady} this never rejects on a settled failure —
   * it just returns, leaving {@link resolve} to surface the typed error.
   */
  private async waitForSettled(
    layerId: LayerId,
    { timeoutMs = 30000 }: { timeoutMs?: number } = {},
  ): Promise<void> {
    const check = (): { done: boolean } => {
      const userLayer = this.findUserLayer(layerId);
      if (userLayer === undefined) return { done: true };
      if (findFirstVolumetricSubsource(userLayer) !== undefined) {
        return { done: true };
      }
      if (
        userLayer.dataSources.length > 0 &&
        userLayer.dataSources.every(allDataSourceSettled)
      ) {
        return { done: true };
      }
      return { done: false };
    };
    if (check().done) return;
    await this.subscribeUntil(check, {
      trackPerLayer: true,
      timeoutMs,
      layerName: layerId,
    });
  }

  private findUserLayer(layerName: string): UserLayer | undefined {
    const managed = this.layerManager.getLayerByName(layerName);
    if (managed === undefined) return undefined;
    return managed.layer ?? undefined;
  }

  private subscribeUntil(
    poll: () => boolean | { done: boolean; failure?: Error },
    {
      trackPerLayer,
      timeoutMs,
      layerName,
    }: { trackPerLayer: boolean; timeoutMs: number; layerName: string },
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cleanups: Array<() => void> = [];
      let settled = false;
      let perLayerDispose: (() => void) | undefined;
      let attachedTo: UserLayer | undefined;

      const finish = (failure?: Error) => {
        if (settled) return;
        settled = true;
        for (const c of cleanups) {
          try {
            c();
          } catch {
            // ignore disposer errors
          }
        }
        if (failure !== undefined) reject(failure);
        else resolve();
      };

      const runCheck = () => {
        if (settled) return;
        const result = poll();
        const normalized =
          typeof result === "boolean" ? { done: result } : result;
        if (normalized.done) finish(normalized.failure);
        else if (trackPerLayer) attachPerLayer();
      };

      const attachPerLayer = () => {
        const userLayer = this.findUserLayer(layerName);
        if (userLayer === attachedTo) return;
        if (perLayerDispose !== undefined) {
          perLayerDispose();
          perLayerDispose = undefined;
        }
        attachedTo = userLayer;
        if (userLayer !== undefined) {
          perLayerDispose = userLayer.dataSourcesChanged.add(runCheck);
        }
      };

      cleanups.push(this.layerManager.layersChanged.add(runCheck));
      if (trackPerLayer) {
        attachPerLayer();
        cleanups.push(() => {
          if (perLayerDispose !== undefined) perLayerDispose();
        });
      }

      const timeoutHandle = setTimeout(() => {
        finish(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for layer ${JSON.stringify(
              layerName,
            )} to load.`,
          ),
        );
      }, timeoutMs);
      cleanups.push(() => clearTimeout(timeoutHandle));

      runCheck();
    });
  }
}

function allDataSourceSettled(ds: LayerDataSource): boolean {
  return ds.loadState !== undefined;
}

/**
 * The first data-source load error on the layer, if any. Returns the ORIGINAL
 * thrown object (an `HttpError`, `NotFoundError`, or a plain parse `Error`) —
 * its runtime type is preserved on `loadState.error` even though the static
 * type is `Error`, so the caller can classify it by `instanceof`.
 */
function firstDataSourceError(userLayer: UserLayer): Error | undefined {
  for (const dataSource of userLayer.dataSources) {
    const loadState = dataSource.loadState;
    if (loadState !== undefined && loadState.error !== undefined) {
      return loadState.error;
    }
  }
  return undefined;
}

/**
 * Canonicalize a per-scale voxel size (in nm) using the library's
 * `Resolution.from(...)` factory. Shared between the metadata adapter and
 * the resolution-picker UI to guarantee identical resolution identities.
 */
export function resolutionFor(
  voxelSizeNm: readonly [number, number, number],
): Resolution {
  return ResolutionFactory.from(voxelSizeNm);
}

interface VolumetricFound {
  readonly volume: MultiscaleVolumeChunkSource;
  readonly loadState: LoadedLayerDataSource;
}

function findFirstVolumetricSubsource(
  userLayer: UserLayer,
): VolumetricFound | undefined {
  for (const layerDataSource of userLayer.dataSources) {
    const loadState = layerDataSource.loadState;
    if (loadState === undefined) continue;
    if ("error" in loadState && loadState.error !== undefined) continue;
    const loaded = loadState as LoadedLayerDataSource;
    for (const subsource of loaded.subsources) {
      const volume = subsource.subsourceEntry.subsource.volume;
      if (volume !== undefined) {
        return { volume, loadState: loaded };
      }
    }
  }
  return undefined;
}

function mapDataType(dataType: DataType): VoxelDataType | undefined {
  switch (dataType) {
    case DataType.UINT8:
      return "uint8";
    case DataType.INT8:
      return "int8";
    case DataType.UINT16:
      return "uint16";
    case DataType.INT16:
      return "int16";
    case DataType.UINT32:
      return "uint32";
    case DataType.INT32:
      return "int32";
    case DataType.UINT64:
      return "uint64";
    case DataType.FLOAT32:
      return "float32";
    default:
      return undefined;
  }
}

function extractModelResolutionNm(
  loadState: LoadedLayerDataSource,
): readonly [number, number, number] {
  const outputSpace = loadState.dataSource.modelTransform.outputSpace;
  const { scales, units } = outputSpace;
  const result: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3 && i < scales.length; ++i) {
    const scale = scales[i];
    const unit = units[i];
    result[i] = unit === "m" ? scale * 1e9 : scale;
  }
  return result;
}

function extractChannelCount(volume: MultiscaleVolumeChunkSource): number {
  const rank = volume.rank;
  if (rank <= 3) return 1;
  const channelDim = inferChannelDim(volume);
  if (channelDim === undefined) return 1;
  const dataSource = (volume as { info?: unknown }).info;
  if (dataSource === undefined) return 1;
  const upperBounds = (
    dataSource as {
      modelSpace?: {
        boundingBoxes?: ReadonlyArray<{
          box: { upperBounds: ArrayLike<number> };
        }>;
      };
    }
  ).modelSpace?.boundingBoxes?.[0]?.box.upperBounds;
  if (upperBounds === undefined) return 1;
  const value = upperBounds[channelDim];
  return typeof value === "number" && value > 0 ? Math.floor(value) : 1;
}

function inferChannelDim(
  volume: MultiscaleVolumeChunkSource,
): number | undefined {
  const info = (volume as { info?: unknown }).info as
    | {
        modelSpace?: { names?: readonly string[]; rank?: number };
      }
    | undefined;
  const names = info?.modelSpace?.names;
  if (names === undefined) return undefined;
  for (let i = 0; i < names.length; ++i) {
    if (names[i] === "c^" || names[i] === "c") return i;
  }
  return names.length > 3 ? 3 : undefined;
}

function collectAllScaleSources(
  volume: MultiscaleVolumeChunkSource,
): SliceViewSingleResolutionSource<VolumeChunkSource>[] {
  const rank = volume.rank;
  const displayRank = Math.min(rank, 3);
  const multiscaleToViewTransform = new Float32Array(displayRank * rank);
  for (let i = 0; i < displayRank; ++i) {
    multiscaleToViewTransform[i * displayRank + i] = 1;
  }
  const modelChannelDimensionIndices: number[] = rank > 3 ? [3] : [];
  const options: VolumeSourceOptions = {
    multiscaleToViewTransform,
    displayRank,
    modelChannelDimensionIndices,
  };
  const multiscale =
    volume as unknown as MultiscaleSliceViewChunkSource<VolumeChunkSource>;
  // `getSources` returns `result[orientation][scale]` — outer indexes
  // alternative chunk orientations (rare; typically 1), inner indexes
  // scales ordered by increasing voxel size. SliceView picks one
  // orientation and uses all of its scales, so we do the same: take the
  // first orientation's full scale list.
  const sourcesByOrientation = multiscale.getSources(options);
  return sourcesByOrientation[0] ?? [];
}

function buildScaleMetadata(
  source: SliceViewSingleResolutionSource<VolumeChunkSource>,
  modelResolutionNm: readonly [number, number, number],
): ScaleMetadata {
  const spec = source.chunkSource.spec;
  const voxelSizeNm = computeVoxelSizeNm(
    spec,
    source.chunkToMultiscaleTransform,
    modelResolutionNm,
  );
  // The voxel offset that places this scale's data in the GLOBAL voxel frame
  // (the same frame the viewer position, annotations, and the edit region live
  // in) is NG's `baseVoxelOffset` — for precomputed it is the `voxel_offset`
  // from `info`. `lowerVoxelBound` is the chunk-layout clip bound RELATIVE to
  // that offset (≈ 0 for the base scale), NOT the global origin. Reading the
  // offset from `lowerVoxelBound` (the old code) yielded 0 for any volume with a
  // non-zero `voxel_offset`, so the session's voxel bounds collapsed to
  // `[0, sizeVoxels]`. When the edit region sat above that (its global coords
  // include the offset), every paint write clipped to nothing — silently, with
  // no patch, no history, no dirty signal (TM-317 paint-not-drawing bug). The
  // global lower bound is `baseVoxelOffset + lowerVoxelBound`; the size is
  // `upperVoxelBound - lowerVoxelBound`, so the global upper bound
  // (`offset + size`) correctly becomes `baseVoxelOffset + upperVoxelBound`.
  return {
    resolution: resolutionFor(voxelSizeNm),
    voxelSizeNm,
    voxelOffset: addXYZ(spec.baseVoxelOffset, spec.lowerVoxelBound),
    sizeVoxels: subtractXYZ(spec.upperVoxelBound, spec.lowerVoxelBound),
    chunkDataSize: takeXYZUint(spec.chunkDataSize),
  };
}

function computeVoxelSizeNm(
  spec: VolumeChunkSpecification,
  chunkToMultiscaleTransform: Float32Array,
  modelResolutionNm: readonly [number, number, number],
): readonly [number, number, number] {
  const rank = spec.rank;
  const stride = rank + 1;
  const result: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; ++i) {
    const relativeScale = chunkToMultiscaleTransform[stride * i + i] || 1;
    result[i] = modelResolutionNm[i] * relativeScale;
  }
  return result;
}

function takeXYZUint(
  arr: ArrayLike<number>,
): readonly [number, number, number] {
  return [
    Math.floor(Number(arr[0]) || 0),
    Math.floor(Number(arr[1]) || 0),
    Math.floor(Number(arr[2]) || 0),
  ];
}

function subtractXYZ(
  upper: ArrayLike<number>,
  lower: ArrayLike<number>,
): readonly [number, number, number] {
  return [
    Math.floor((Number(upper[0]) || 0) - (Number(lower[0]) || 0)),
    Math.floor((Number(upper[1]) || 0) - (Number(lower[1]) || 0)),
    Math.floor((Number(upper[2]) || 0) - (Number(lower[2]) || 0)),
  ];
}

function addXYZ(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
): readonly [number, number, number] {
  return [
    Math.floor((Number(a[0]) || 0) + (Number(b[0]) || 0)),
    Math.floor((Number(a[1]) || 0) + (Number(b[1]) || 0)),
    Math.floor((Number(a[2]) || 0) + (Number(b[2]) || 0)),
  ];
}
