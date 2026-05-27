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
} from "@zetta-ai/edit-session";
import {
  LayerMetadataUnavailableError,
  Resolution as ResolutionFactory,
} from "@zetta-ai/edit-session";

import type { LayerManager, UserLayer } from "#src/layer/index.js";
import type { LoadedLayerDataSource } from "#src/layer/layer_data_source.js";
import type {
  SliceViewSingleResolutionSource,
  MultiscaleSliceViewChunkSource,
} from "#src/sliceview/frontend.js";
import type {
  VolumeChunkSource,
  MultiscaleVolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import type {
  VolumeChunkSpecification,
  VolumeSourceOptions,
} from "#src/sliceview/volume/base.js";
import { DataType } from "#src/util/data_type.js";

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
  const sourcesByOrientation = multiscale.getSources(options);
  const flat: SliceViewSingleResolutionSource<VolumeChunkSource>[] = [];
  for (const perScale of sourcesByOrientation) {
    if (perScale.length > 0) flat.push(perScale[0]);
  }
  return flat;
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
  return {
    resolution: resolutionFor(voxelSizeNm),
    voxelSizeNm,
    voxelOffset: takeXYZ(spec.lowerVoxelBound),
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

function takeXYZ(
  arr: ArrayLike<number>,
): readonly [number, number, number] {
  return [Number(arr[0]) || 0, Number(arr[1]) || 0, Number(arr[2]) || 0];
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
