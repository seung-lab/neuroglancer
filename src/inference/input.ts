/**
 * Native-grid image input for browser inference with dtype-maximum intensity
 * normalization. No rendering, interpolation, Python export, or ONNX runtime
 * dependency is involved.
 */
import type { CoordinateSpace } from "#src/coordinate_transform.js";
import { makeIdentityTransform } from "#src/coordinate_transform.js";
import type { ImageUserLayer } from "#src/layer/image/index.js";
import type { RenderLayerTransform } from "#src/render_coordinate_transform.js";
import { getRenderLayerTransform } from "#src/render_coordinate_transform.js";
import type { SliceViewSingleResolutionSource } from "#src/sliceview/frontend.js";
import { UncompressedVolumeChunk } from "#src/sliceview/uncompressed_chunk_format.js";
import type {
  VolumeChunk,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import { SliceViewVolumeRenderLayer } from "#src/sliceview/volume/renderlayer.js";
import { arraysEqual } from "#src/util/array.js";
import type { DataType } from "#src/util/data_type.js";
import { DATA_TYPE_ARRAY_CONSTRUCTOR } from "#src/util/data_type.js";
import { valueOrThrow } from "#src/util/error.js";
import { defaultDataTypeRange } from "#src/util/lerp.js";

type Triple<T> = readonly [T, T, T];

export interface InferenceInputSnapshot {
  /** Dimensions of chunk space corresponding to Z, Y, X. */
  readonly chunkDimensionsZYX: Triple<number>;
  /** Full-rank storage bounds (including the channel extent for rank 4). */
  readonly lowerBoundChunk: readonly number[];
  readonly upperBoundChunk: readonly number[];
  /** Zero-based index within the selected scale's clipped channel extent. */
  readonly inputChannel?: number;
  /** Backend request offset, NOT an additional offset to chunk-grid positions. */
  readonly baseVoxelOffset: readonly number[];
  readonly chunkToMultiscaleTransform: readonly number[];
  /** Selected-scale model-grid lower bound of the volume, in ZYX order. */
  readonly modelOriginZYX: Triple<number>;
}

export interface PreparedInferenceInput {
  readonly shapeZYX: number[];
  /** Selected-scale model-grid lower bound, for inference inputBounds (ZYX). */
  readonly originZYX: number[];
  /** Rank 4 only, including an all-zero vector for integer-aligned grids. Add
   * to integer patch-grid coordinates for physical placement, in selected-scale voxels. */
  readonly gridOffsetZYX?: readonly number[];
  readonly spacingZYX: number[];
  readonly axisNamesZYX: string[];
  readonly unitsZYX: string[];
  readonly validitySnapshot: InferenceInputSnapshot;
  /** Aborts on source/transform invalidation or disposal (not navigation). */
  readonly signal?: AbortSignal;
  isValid(): boolean;
  assertValid(): void;
  /**
   * Origin is in selected-scale model-grid ZYX coordinates, like inputBounds,
   * NOT viewer or backend coordinates. The full patch must be within bounds;
   * spec.fillValue applies only to legitimate absent chunks inside the dataset.
   * The owned Float32Array is contiguous ZYX (X fastest), for [1,1,Z,Y,X].
   * Integers are divided once by their positive dtype maximum before float32
   * conversion; FLOAT32 is unchanged. No shifting, clamping, or observed-data
   * min/max scaling is applied, so signed negatives remain negative.
   */
  readPatch(
    originZYX: readonly number[],
    shapeZYX: readonly number[],
    signal: AbortSignal,
  ): Promise<Float32Array>;
  /** Best-effort, non-blocking prefetch of a ZYX box clamped to source bounds. */
  prefetchVolume?(
    originZYX: readonly number[],
    shapeZYX: readonly number[],
    signal: AbortSignal,
  ): void;
  /** Idempotent; aborts outstanding reads and releases acquired source refs. */
  dispose(): void;
}

function triple<T>(values: ArrayLike<T>): Triple<T> {
  return Object.freeze([values[0], values[1], values[2]]);
}

function unsupported(message: string): never {
  throw new Error(`Unsupported inference input: ${message}`);
}

function checkIdentity(transform: ArrayLike<number>, rank: number) {
  if (
    transform.length !== (rank + 1) ** 2 ||
    Array.from(transform).some((x, i) => x !== (i % (rank + 2) === 0 ? 1 : 0))
  ) {
    unsupported(
      "model-to-layer transform must be exactly identity (no resampling)",
    );
  }
}

/** Map the native storage lattice to the selected-scale grid without resampling. */
function getChunkGrid(
  selected: SliceViewSingleResolutionSource<VolumeChunkSource>,
  {
    rank,
    modelDimensionsZYX,
    modelChannelDimension,
  }: ReturnType<typeof getNativeMetadata>,
) {
  const {
    chunkToMultiscaleTransform: transform,
    chunkSource: { spec },
  } = selected;
  if (spec.rank !== rank) unsupported("chunk and model ranks must match");
  const stride = rank + 1;
  if (
    transform.length !== stride ** 2 ||
    transform.some(
      (x, i) => i % stride === rank && x !== (i === stride ** 2 - 1 ? 1 : 0),
    )
  ) {
    unsupported(
      "source grid must be a homogeneous affine transform of the expected rank",
    );
  }
  const modelToChunk: number[] = [];
  const modelScales: number[] = [];
  for (let c = 0; c < rank; ++c) {
    let modelDimension = -1;
    for (let m = 0; m < rank; ++m) {
      const value = transform[c * stride + m];
      if (value === 0) continue;
      if (
        !(value > 0) ||
        !Number.isFinite(value) ||
        modelDimension !== -1 ||
        modelToChunk[m] !== undefined
      ) {
        unsupported(
          "source shear, reflection, or ambiguous axes (no resampling)",
        );
      }
      modelDimension = m;
      modelToChunk[m] = c;
      modelScales[m] = value;
    }
    if (modelDimension === -1) unsupported("singular source grid transform");
  }
  const origin = modelDimensionsZYX.map(
    (m) => transform[rank * stride + m] / modelScales[m],
  );
  // OME-Zarr may translate voxel centers by a fractional selected-scale voxel.
  // This does not resample the array: patch reads use the integer lattice and
  // output placement adds back the signed remainder in selected-scale units.
  const translationZYX = triple(origin.map((x) => Math.trunc(x) || 0));
  if (
    origin.some(
      (x, a) =>
        !Number.isFinite(x) ||
        !Number.isSafeInteger(translationZYX[a]) ||
        (rank === 3 && !Number.isInteger(x)),
    )
  ) {
    unsupported(
      "source origin must align to integer selected-scale voxels for rank 3 and be finite and safely indexable for rank 4",
    );
  }
  const gridOffsetZYX =
    rank === 4
      ? triple(origin.map((x, a) => x - translationZYX[a] || 0))
      : undefined;
  const lower = Array.from({ length: rank }, (_, d) =>
    Math.max(
      spec.lowerVoxelBound[d],
      selected.lowerClipBound?.[d] ?? -Infinity,
    ),
  );
  const upper = Array.from({ length: rank }, (_, d) =>
    Math.min(spec.upperVoxelBound[d], selected.upperClipBound?.[d] ?? Infinity),
  );
  const channelDim =
    modelChannelDimension === -1 ? -1 : modelToChunk[modelChannelDimension];
  const channelCount =
    channelDim === -1 ? 1 : upper[channelDim] - lower[channelDim];
  if (
    channelDim !== -1 &&
    (modelScales[modelChannelDimension] !== 1 ||
      !Number.isFinite(transform[rank * stride + modelChannelDimension]) ||
      !Number.isSafeInteger(lower[channelDim]) ||
      !Number.isSafeInteger(upper[channelDim]) ||
      !Number.isSafeInteger(channelCount) ||
      channelCount <= 0)
  )
    unsupported(
      "channel axis must have unit stride and a nonempty integer extent",
    );
  return {
    lower,
    upper,
    channelDim,
    channelCount,
    chunkDimensionsZYX: triple(modelDimensionsZYX.map((m) => modelToChunk[m])),
    chunkScalesZYX: triple(modelDimensionsZYX.map((m) => modelScales[m])),
    translationZYX,
    gridOffsetZYX,
  };
}

function getActiveVolume(layer: ImageUserLayer) {
  if (layer.type !== "image" || !layer.isReady || layer.wasDisposed) {
    unsupported("a ready, live ImageUserLayer is required");
  }
  const volumes = layer.renderLayers.filter(
    (r): r is SliceViewVolumeRenderLayer =>
      r instanceof SliceViewVolumeRenderLayer,
  );
  if (volumes.length !== 1)
    unsupported("expected exactly one active image volume");
  const renderLayer = volumes[0];
  const { rank } = renderLayer.multiscaleSource;
  if (rank !== 3 && rank !== 4)
    unsupported(
      "expected a rank-3 volume or rank-4 volume with one channel axis",
    );
  const matches = layer.dataSources.flatMap(({ loadState }) => {
    if (loadState === undefined || loadState.error !== undefined) return [];
    return loadState.subsources
      .filter(
        (s) =>
          s.enabled &&
          s.activated !== undefined &&
          s.subsourceEntry.subsource.volume === renderLayer.multiscaleSource,
      )
      .map((subsource) => ({ loadState, subsource }));
  });
  if (matches.length !== 1)
    unsupported("expected one active loaded source matching the image volume");
  if (matches[0].loadState.dataSource.modelTransform.inputSpace.rank !== rank)
    unsupported("model and volume ranks must match");
  return { renderLayer, ...matches[0] };
}

function getNativeMetadata(space: CoordinateSpace) {
  const { rank, names, scales, units } = space;
  const modelChannelDimension = names.findIndex(
    (name) => /^(c|channel)['^]?$/.test(name) || name.endsWith("^"),
  );
  if (
    (rank !== 3 && rank !== 4) ||
    names.length !== rank ||
    new Set(names).size !== rank ||
    (rank === 4 && modelChannelDimension === -1) ||
    !["x", "y", "z"].every((name) => names.includes(name))
  ) {
    unsupported(
      "spatial axes must be unambiguously named exactly x, y, z, with one explicit channel axis for rank 4",
    );
  }
  if (
    !space.valid ||
    names.some(
      (_, d) =>
        !(scales[d] > 0) ||
        !Number.isFinite(scales[d]) ||
        typeof units[d] !== "string" ||
        (d !== modelChannelDimension &&
          space.coordinateArrays[d] !== undefined),
    )
  ) {
    unsupported("missing, ambiguous, or non-uniform physical axis metadata");
  }
  const modelDimensionsZYX = ["z", "y", "x"].map((name) => names.indexOf(name));
  return {
    rank,
    modelChannelDimension,
    modelDimensionsZYX,
    spacingZYX: triple(modelDimensionsZYX.map((d) => scales[d])),
    unitsZYX: triple(modelDimensionsZYX.map((d) => units[d])),
  };
}

/** Native source metadata, even when a user transform prevents inference. */
export function getInferenceInputMetadata(
  layer: ImageUserLayer,
): Pick<PreparedInferenceInput, "spacingZYX" | "axisNamesZYX" | "unitsZYX"> {
  const { loadState } = getActiveVolume(layer);
  const metadata = getNativeMetadata(
    loadState.dataSource.modelTransform.inputSpace,
  );
  return {
    spacingZYX: Array.from(metadata.spacingZYX),
    unitsZYX: Array.from(metadata.unitsZYX),
    axisNamesZYX: ["z", "y", "x"],
  };
}

function getInputSources(
  multiscale: SliceViewVolumeRenderLayer["multiscaleSource"],
  modelChannelDimension: number,
) {
  // Project only the spatial model axes; a single channel is a fixed
  // coordinate, not a request to pack all channels into every chunk.
  const multiscaleToViewTransform = new Float32Array(multiscale.rank * 3);
  for (let d = 0, view = 0; d < multiscale.rank; ++d) {
    if (d !== modelChannelDimension)
      multiscaleToViewTransform[d * 3 + view++] = 1;
  }
  return multiscale.getSources({
    discreteValues: true,
    displayRank: 3,
    modelChannelDimensionIndices: [],
    multiscaleToViewTransform,
  });
}

function getScaledSpacing(
  nativeSpacingZYX: readonly number[],
  chunkScalesZYX: readonly number[],
) {
  const spacing = nativeSpacingZYX.map((x, a) => x * chunkScalesZYX[a]);
  if (spacing.some((x) => !(x > 0) || !Number.isFinite(x))) {
    unsupported("selected-scale physical spacing must be finite and positive");
  }
  return spacing;
}

/** Available source scales in one orientation, independent of user transforms. */
export function getInferenceInputScales(layer: ImageUserLayer): {
  scaleIndex: number;
  channelCount?: number;
  spacingZYX: number[];
  axisNamesZYX: string[];
  unitsZYX: string[];
}[] {
  const { renderLayer, loadState } = getActiveVolume(layer);
  const metadata = getNativeMetadata(
    loadState.dataSource.modelTransform.inputSpace,
  );
  const sources = getInputSources(
    renderLayer.multiscaleSource,
    metadata.modelChannelDimension,
  );
  try {
    if (sources.length !== 1 || sources[0].length === 0) {
      unsupported("expected one unambiguous native chunk orientation");
    }
    return sources[0].map((selected, scaleIndex) => {
      const { chunkScalesZYX, channelDim, channelCount } = getChunkGrid(
        selected,
        metadata,
      );
      return {
        scaleIndex,
        ...(channelDim === -1 ? {} : { channelCount }),
        spacingZYX: getScaledSpacing(metadata.spacingZYX, chunkScalesZYX),
        axisNamesZYX: ["z", "y", "x"],
        unitsZYX: Array.from(metadata.unitsZYX),
      };
    });
  } finally {
    for (const scales of sources) {
      for (const { chunkSource } of scales) chunkSource.dispose();
    }
  }
}

function getMetadata(
  layer: ImageUserLayer,
  transform: RenderLayerTransform,
  { loadState, subsource }: ReturnType<typeof getActiveVolume>,
) {
  const nativeSpace = loadState.dataSource.modelTransform.inputSpace;
  const metadata = getNativeMetadata(nativeSpace);
  const { rank, modelChannelDimension } = metadata;
  if (transform.rank !== rank || transform.unpaddedRank !== rank) {
    unsupported("render and model ranks must match without padding");
  }
  if (
    transform.channelToRenderLayerDimensions.some(
      (d) => d !== -1 && d !== modelChannelDimension,
    )
  ) {
    unsupported("spatial axes cannot be channel dimensions");
  }
  // Validate the raw user and internal subsource transforms as well: their
  // composition could otherwise hide a transform cancelled by another one.
  const raw = loadState.transform.value;
  if (raw.rank !== rank || raw.sourceRank !== rank)
    unsupported("source and model ranks must match");
  checkIdentity(raw.transform, rank);
  checkIdentity(subsource.subsourceToModelSubspaceTransform, rank);
  if (
    subsource.modelSubspaceDimensionIndices.length !== rank ||
    subsource.modelSubspaceDimensionIndices.some((d, i) => d !== i)
  )
    unsupported("subsource must use the native model dimensions in order");
  // The input grid remains native, but CoordinateSpaceCombiner binds output
  // scales to the viewer's coordinate space (converting translation only).
  for (const space of [raw.inputSpace, raw.outputSpace]) {
    const spaceMetadata = getNativeMetadata(space);
    if (
      space.rank !== rank ||
      !arraysEqual(
        spaceMetadata.modelDimensionsZYX,
        metadata.modelDimensionsZYX,
      ) ||
      (space === raw.inputSpace &&
        !arraysEqual(space.names, nativeSpace.names)) ||
      (space === raw.inputSpace &&
        !arraysEqual(space.scales, nativeSpace.scales)) ||
      !arraysEqual(space.units, nativeSpace.units)
    )
      unsupported(
        "model-to-layer transform must be exactly identity (no resampling)",
      );
  }
  const covered = new Set<number>();
  for (const [space, dimensions] of [
    [
      layer.managedLayer.localCoordinateSpace.value,
      transform.localToRenderLayerDimensions,
    ],
    [
      layer.managedLayer.manager.root.coordinateSpace.value,
      transform.globalToRenderLayerDimensions,
    ],
    [
      layer.channelCoordinateSpace.value,
      transform.channelToRenderLayerDimensions,
    ],
  ] as const) {
    dimensions.forEach((d, i) => {
      if (d === -1) return;
      if (
        !space.valid ||
        d < 0 ||
        d >= rank ||
        covered.has(d) ||
        space.names[i] !== raw.outputSpace.names[d] ||
        !(space.scales[i] > 0) ||
        !Number.isFinite(space.scales[i]) ||
        space.units[i] !== nativeSpace.units[d] ||
        (d !== modelChannelDimension && space.coordinateArrays[i] !== undefined)
      )
        unsupported(
          "missing, ambiguous, or non-uniform physical axis metadata",
        );
      if (raw.outputSpace.scales[d] !== space.scales[i])
        unsupported(
          "model-to-layer transform must use canonical viewer output spacing and exactly identity (no resampling)",
        );
      covered.add(d);
    });
  }
  if (covered.size !== rank)
    unsupported("physical spacing/units must be explicit for all source axes");
  // A raw identity is generally NOT a render-space identity: the viewer may
  // use a different physical voxel scale. Recompute exactly the same float32
  // normalization, without any user or subsource transform and without epsilon.
  const expected = valueOrThrow(
    getRenderLayerTransform(
      layer.managedLayer.manager.root.coordinateSpace.value,
      layer.managedLayer.localCoordinateSpace.value,
      // Relabeling c <-> c' <-> c^ changes how the viewer navigates the
      // channel axis but not its position on the native grid.
      { ...makeIdentityTransform(nativeSpace), outputSpace: raw.outputSpace },
      undefined,
      layer.channelCoordinateSpace.value,
    ),
  );
  if (
    !arraysEqual(transform.modelDimensionNames, expected.modelDimensionNames) ||
    !arraysEqual(transform.layerDimensionNames, expected.layerDimensionNames) ||
    !arraysEqual(
      transform.localToRenderLayerDimensions,
      expected.localToRenderLayerDimensions,
    ) ||
    !arraysEqual(
      transform.globalToRenderLayerDimensions,
      expected.globalToRenderLayerDimensions,
    ) ||
    !arraysEqual(
      transform.channelToRenderLayerDimensions,
      expected.channelToRenderLayerDimensions,
    ) ||
    !arraysEqual(
      transform.modelToRenderLayerTransform,
      expected.modelToRenderLayerTransform,
    )
  )
    unsupported(
      "model-to-layer transform must be exactly identity apart from native coordinate normalization (no resampling)",
    );
  return metadata;
}

function getNormalizationDivisor(dataType: DataType): number {
  if (
    !Number.isInteger(dataType) ||
    !Object.hasOwn(defaultDataTypeRange, dataType)
  ) {
    unsupported(`data type ${String(dataType)} cannot be normalized`);
  }
  // Use only the positive maximum, not invlerp (which would shift signed data).
  // FLOAT32's default maximum is 1; bigint maxima convert before division.
  return Number(defaultDataTypeRange[dataType][1]);
}

const UINT8_DIVISOR_255_LUT = (() => {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; ++i) lut[i] = i / 255;
  return lut;
})();

const MAX_CONCURRENT_PREFETCH_CHUNKS = 8;
const MAX_QUEUED_PREFETCH_CHUNKS = 128;

interface PrefetchEntry {
  readonly key: string;
  readonly grid: Float32Array;
  readonly callers: Set<AbortSignal>;
  readonly abort: AbortController;
  readonly cleanupCallers: Map<AbortSignal, () => void>;
  inFlight: boolean;
}

export interface ChunkToZYXPatchOptions {
  readonly dataType: DataType;
  readonly chunkOrigin: readonly number[];
  readonly chunkDimensionsZYX: readonly number[];
  /** Full-rank lower corner; the non-spatial dimension is one fixed voxel. */
  readonly patchLowerChunk: readonly number[];
  readonly patchShapeZYX: readonly number[];
  readonly lowerBoundChunk: readonly number[];
  readonly upperBoundChunk: readonly number[];
}

/** Packs raw storage or accessor values without retaining or mutating source data.
 * Call only inside fetchChunk's callback; the caller must ensure complete coverage. */
export function copyChunkToZYXPatch(
  chunk: Pick<VolumeChunk, "chunkDataSize" | "getValueAt">,
  options: ChunkToZYXPatchOptions,
  output: Float32Array,
): void {
  const {
    chunkOrigin,
    chunkDimensionsZYX: dims,
    patchLowerChunk: patchLower,
    patchShapeZYX: shape,
    lowerBoundChunk,
    upperBoundChunk,
  } = options;
  const divisor = getNormalizationDivisor(options.dataType);
  const lower = new Array<number>(3);
  const upper = new Array<number>(3);
  for (let a = 0; a < 3; ++a) {
    const d = dims[a];
    lower[a] = Math.max(chunkOrigin[d], patchLower[d], lowerBoundChunk[d]);
    upper[a] = Math.min(
      chunkOrigin[d] + chunk.chunkDataSize[d],
      patchLower[d] + shape[a],
      upperBoundChunk[d],
    );
  }
  const [dz, dy, dx] = dims;
  const size = chunk.chunkDataSize;
  const expectedConstructor = DATA_TYPE_ARRAY_CONSTRUCTOR[options.dataType];
  const channelDim =
    size.length === 4 ? size.findIndex((_, d) => !dims.includes(d)) : -1;
  const channelRel =
    channelDim === -1 ? 0 : patchLower[channelDim] - chunkOrigin[channelDim];
  const data =
    chunk.getValueAt === UncompressedVolumeChunk.prototype.getValueAt
      ? (chunk as UncompressedVolumeChunk).data
      : null;
  if (
    expectedConstructor !== undefined &&
    data instanceof expectedConstructor &&
    data.length === size.reduce((n, x) => n * x, 1)
  ) {
    // Strides use the actual edge chunk, including interleaved channels.
    const chunkStrides = [
      1,
      size[0],
      size[0] * size[1],
      size[0] * size[1] * size[2],
    ];
    const rawData =
      channelRel === 0
        ? data
        : data.subarray(channelRel * chunkStrides[channelDim]);
    const strideZ = chunkStrides[dz];
    const strideY = chunkStrides[dy];
    const strideX = chunkStrides[dx];
    const countX = upper[2] - lower[2];
    if (countX <= 0) return;
    const xStartRel = lower[2] - chunkOrigin[dx];
    const outXOffset = lower[2] - patchLower[dx];
    const shapeY = shape[1];
    const shapeX = shape[2];
    const patchLowerZ = patchLower[dz];
    const patchLowerY = patchLower[dy];
    const chunkOriginZ = chunkOrigin[dz];
    const chunkOriginY = chunkOrigin[dy];

    if (rawData instanceof Uint8Array && divisor === 255) {
      const lut = UINT8_DIVISOR_255_LUT;
      for (let z = lower[0]; z < upper[0]; ++z) {
        const zBase = (z - chunkOriginZ) * strideZ;
        const outZBase = (z - patchLowerZ) * shapeY;
        for (let y = lower[1]; y < upper[1]; ++y) {
          let idx = zBase + (y - chunkOriginY) * strideY + xStartRel * strideX;
          let offset = (outZBase + (y - patchLowerY)) * shapeX + outXOffset;
          for (let i = 0; i < countX; ++i) {
            output[offset++] = lut[rawData[idx]];
            idx += strideX;
          }
        }
      }
      return;
    }

    if (rawData instanceof Float32Array && divisor === 1) {
      if (strideX === 1) {
        for (let z = lower[0]; z < upper[0]; ++z) {
          const zBase = (z - chunkOriginZ) * strideZ;
          const outZBase = (z - patchLowerZ) * shapeY;
          for (let y = lower[1]; y < upper[1]; ++y) {
            const idx = zBase + (y - chunkOriginY) * strideY + xStartRel;
            const offset = (outZBase + (y - patchLowerY)) * shapeX + outXOffset;
            output.set(rawData.subarray(idx, idx + countX), offset);
          }
        }
        return;
      }
      for (let z = lower[0]; z < upper[0]; ++z) {
        const zBase = (z - chunkOriginZ) * strideZ;
        const outZBase = (z - patchLowerZ) * shapeY;
        for (let y = lower[1]; y < upper[1]; ++y) {
          let idx = zBase + (y - chunkOriginY) * strideY + xStartRel * strideX;
          let offset = (outZBase + (y - patchLowerY)) * shapeX + outXOffset;
          for (let i = 0; i < countX; ++i) {
            output[offset++] = rawData[idx];
            idx += strideX;
          }
        }
      }
      return;
    }

    if (rawData instanceof BigUint64Array) {
      for (let z = lower[0]; z < upper[0]; ++z) {
        const zBase = (z - chunkOriginZ) * strideZ;
        const outZBase = (z - patchLowerZ) * shapeY;
        for (let y = lower[1]; y < upper[1]; ++y) {
          let idx = zBase + (y - chunkOriginY) * strideY + xStartRel * strideX;
          let offset = (outZBase + (y - patchLowerY)) * shapeX + outXOffset;
          for (let i = 0; i < countX; ++i) {
            output[offset++] = Number(rawData[idx]) / divisor;
            idx += strideX;
          }
        }
      }
      return;
    }

    for (let z = lower[0]; z < upper[0]; ++z) {
      const zBase = (z - chunkOriginZ) * strideZ;
      const outZBase = (z - patchLowerZ) * shapeY;
      for (let y = lower[1]; y < upper[1]; ++y) {
        let idx = zBase + (y - chunkOriginY) * strideY + xStartRel * strideX;
        let offset = (outZBase + (y - patchLowerY)) * shapeX + outXOffset;
        for (let i = 0; i < countX; ++i) {
          output[offset++] = Number(rawData[idx]) / divisor;
          idx += strideX;
        }
      }
    }
    return;
  }
  const position = new Uint32Array(size.length);
  if (channelDim !== -1) position[channelDim] = channelRel;
  for (let z = lower[0]; z < upper[0]; ++z) {
    position[dz] = z - chunkOrigin[dz];
    for (let y = lower[1]; y < upper[1]; ++y) {
      position[dy] = y - chunkOrigin[dy];
      let offset =
        ((z - patchLower[dz]) * shape[1] + y - patchLower[dy]) * shape[2] +
        lower[2] -
        patchLower[dx];
      for (let x = lower[2]; x < upper[2]; ++x) {
        position[dx] = x - chunkOrigin[dx];
        const value: unknown = chunk.getValueAt(position);
        if (typeof value !== "number" && typeof value !== "bigint") {
          throw new Error(
            "Inference chunk accessor did not return a scalar number",
          );
        }
        output[offset++] = Number(value) / divisor;
      }
    }
  }
}

// Enumerate only the intersecting chunk grids, first storage dimension fastest.
// Never materialize a list proportional to the (possibly speculative) box.
function* chunkGridPositions(
  lower: number[],
  upper: number[],
  size: readonly number[],
) {
  const start = lower.map((x, d) => Math.floor(x / size[d]));
  const end = upper.map((x, d) => Math.ceil(x / size[d]));
  const grid = start.slice();
  while (true) {
    yield Float32Array.from(grid);
    let d = 0;
    while (++grid[d] === end[d]) {
      grid[d] = start[d];
      if (++d === grid.length) return;
    }
  }
}

/**
 * Select exactly one active image volume and one explicit scale/orientation.
 * inputChannel is relative to the selected scale's clipped channel lower bound,
 * independent of the viewer position. A rank-3 input has only channel zero.
 * Reject user/view transforms, ambiguous axes, fractional selected-grid bounds,
 * and grids requiring resampling rather than sampling rendered data.
 */
export function prepareInferenceInput(
  layer: ImageUserLayer,
  scaleIndex = 0,
  inputChannel = 0,
): PreparedInferenceInput {
  const active = getActiveVolume(layer);
  const { renderLayer, loadState, subsource } = active;
  const multiscale = renderLayer.multiscaleSource;
  const dataSource = loadState.dataSource;
  const transform = valueOrThrow(renderLayer.transform.value);
  const metadata = getMetadata(layer, transform, active);
  const {
    rank,
    modelDimensionsZYX,
    spacingZYX: nativeSpacingZYX,
    unitsZYX,
  } = metadata;
  const sources = getInputSources(multiscale, metadata.modelChannelDimension);
  try {
    if (sources.length !== 1 || sources[0].length === 0) {
      unsupported("expected one unambiguous native chunk orientation");
    }
    if (
      !Number.isSafeInteger(scaleIndex) ||
      scaleIndex < 0 ||
      scaleIndex >= sources[0].length
    ) {
      throw new RangeError("Inference input scaleIndex is out of range");
    }
    const selected = sources[0][scaleIndex];
    const source: VolumeChunkSource = selected.chunkSource;
    const { spec } = source;
    const { dataType } = spec;
    const divisor = getNormalizationDivisor(dataType);
    const {
      chunkDimensionsZYX: dims,
      chunkScalesZYX,
      translationZYX,
      gridOffsetZYX,
      lower,
      upper,
      channelDim,
      channelCount,
    } = getChunkGrid(selected, metadata);
    if (
      !Number.isSafeInteger(inputChannel) ||
      inputChannel < 0 ||
      inputChannel >= channelCount
    ) {
      throw new RangeError(
        `Inference inputChannel must be an integer from 0 to ${channelCount - 1}`,
      );
    }
    const spacingZYX = getScaledSpacing(nativeSpacingZYX, chunkScalesZYX);
    for (let d = 0; d < rank; ++d) {
      if (
        !Number.isSafeInteger(lower[d]) ||
        !Number.isSafeInteger(upper[d]) ||
        upper[d] <= lower[d] ||
        !Number.isSafeInteger(upper[d] - lower[d]) ||
        !Number.isSafeInteger(spec.baseVoxelOffset[d]) ||
        !Number.isSafeInteger(spec.chunkDataSize[d]) ||
        spec.chunkDataSize[d] <= 0
      )
        unsupported(
          "finite integer bounds, chunk sizes, and base voxel offsets are required",
        );
      // fetchChunk's grid position is Float32Array: do not silently round keys.
      for (const bound of [lower[d], upper[d] - 1]) {
        const grid = Math.floor(bound / spec.chunkDataSize[d]);
        if (
          Math.abs(grid) > 2 ** 24 ||
          !Number.isSafeInteger(grid * spec.chunkDataSize[d])
        )
          unsupported("chunk grid exceeds exact float32 indexing");
      }
    }
    const shapeZYX = triple(dims.map((d) => upper[d] - lower[d]));
    const validitySnapshot: InferenceInputSnapshot = Object.freeze({
      chunkDimensionsZYX: dims,
      lowerBoundChunk: Object.freeze(lower),
      upperBoundChunk: Object.freeze(upper),
      ...(channelDim === -1 ? {} : { inputChannel }),
      baseVoxelOffset: Object.freeze(Array.from(spec.baseVoxelOffset)),
      chunkToMultiscaleTransform: Object.freeze(
        Array.from(selected.chunkToMultiscaleTransform),
      ),
      modelOriginZYX: triple(dims.map((d, a) => lower[d] + translationZYX[a])),
    });
    if (
      validitySnapshot.modelOriginZYX.some(
        (x, a) =>
          !Number.isSafeInteger(x) || !Number.isSafeInteger(x + shapeZYX[a]),
      )
    ) {
      unsupported("model-grid bounds exceed safe integer range");
    }
    const chunkSize = Array.from(spec.chunkDataSize);
    // Start every patch/prefetch with a one-voxel channel extent; the three
    // spatial components are filled from the requested box by the caller.
    const fixedLower = lower.slice();
    if (channelDim !== -1) fixedLower[channelDim] += inputChannel;
    const fixedUpper = fixedLower.map((x) => x + 1);
    const fillValue = spec.fillValue;
    const lifetime = new AbortController();
    let disposed = false;
    const invalidate = () =>
      lifetime.abort(new Error("Inference input is stale; prepare it again"));
    // Root/local spaces also change when another layer contributes bounding
    // boxes. Snapshot values, not object references, and deliberately ignore
    // bounds, dimension ids, and timestamps: these do not change this grid.
    const coordinateMetadataChecks = [
      layer.managedLayer.localCoordinateSpace,
      layer.managedLayer.manager.root.coordinateSpace,
      layer.channelCoordinateSpace,
    ].map((watchable) => {
      const { valid, rank } = watchable.value;
      const names = Array.from(watchable.value.names);
      const scales = Array.from(watchable.value.scales);
      const units = Array.from(watchable.value.units);
      return () => {
        const current = watchable.value;
        return (
          current.valid === valid &&
          current.rank === rank &&
          arraysEqual(current.names, names) &&
          arraysEqual(current.scales, scales) &&
          arraysEqual(current.units, units)
        );
      };
    });
    const dimensionMappings = [
      transform.localToRenderLayerDimensions,
      transform.globalToRenderLayerDimensions,
      transform.channelToRenderLayerDimensions,
    ].map((mapping) => Array.from(mapping));
    const coordinatesUnchanged = () => {
      try {
        if (!coordinateMetadataChecks.every((check) => check())) return false;
        // Derived render transforms are also rebuilt on bounds-only updates.
        // Validate their contents rather than their object identity or signals.
        const current = valueOrThrow(renderLayer.transform.value);
        const active = getActiveVolume(layer);
        const metadata = getMetadata(layer, current, active);
        return (
          active.loadState === loadState &&
          active.loadState.dataSource === dataSource &&
          active.subsource === subsource &&
          arraysEqual(metadata.modelDimensionsZYX, modelDimensionsZYX) &&
          arraysEqual(metadata.spacingZYX, nativeSpacingZYX) &&
          arraysEqual(metadata.unitsZYX, unitsZYX) &&
          [
            current.localToRenderLayerDimensions,
            current.globalToRenderLayerDimensions,
            current.channelToRenderLayerDimensions,
          ].every((mapping, i) => arraysEqual(mapping, dimensionMappings[i]))
        );
      } catch {
        return false;
      }
    };
    const invalidateChangedCoordinates = () => {
      if (!coordinatesUnchanged()) invalidate();
    };
    // Other source/render-layer changes still conservatively invalidate.
    const removers = [
      layer.dataSourcesChanged.add(invalidate),
      layer.layersChanged.add(invalidate),
      layer.readyStateChanged.add(invalidate),
      renderLayer.transform.changed.add(invalidateChangedCoordinates),
      layer.managedLayer.localCoordinateSpace.changed.add(
        invalidateChangedCoordinates,
      ),
      layer.channelCoordinateSpace.changed.add(invalidateChangedCoordinates),
      layer.managedLayer.manager.root.coordinateSpace.changed.add(
        invalidateChangedCoordinates,
      ),
    ];
    const isValid = () =>
      !disposed &&
      !lifetime.signal.aborted &&
      !layer.wasDisposed &&
      !renderLayer.wasDisposed &&
      layer.isReady &&
      layer.renderLayers.includes(renderLayer) &&
      renderLayer.multiscaleSource === multiscale &&
      coordinatesUnchanged() &&
      layer.renderLayers.filter((r) => r instanceof SliceViewVolumeRenderLayer)
        .length === 1 &&
      source.spec === spec &&
      spec.rank === rank &&
      spec.dataType === dataType &&
      spec.fillValue === fillValue &&
      arraysEqual(spec.chunkDataSize, chunkSize) &&
      arraysEqual(spec.baseVoxelOffset, validitySnapshot.baseVoxelOffset) &&
      arraysEqual(
        selected.chunkToMultiscaleTransform,
        validitySnapshot.chunkToMultiscaleTransform,
      ) &&
      lower.every(
        (_, d) =>
          Math.max(
            spec.lowerVoxelBound[d],
            selected.lowerClipBound?.[d] ?? spec.lowerVoxelBound[d],
          ) === lower[d] &&
          Math.min(
            spec.upperVoxelBound[d],
            selected.upperClipBound?.[d] ?? spec.upperVoxelBound[d],
          ) === upper[d],
      );
    const assertValid = () => {
      if (!isValid())
        throw new Error(
          "Inference input is disposed or stale; prepare it again",
        );
    };
    source.addRef();
    const pendingPrefetch = new Map<string, PrefetchEntry>();
    const prefetchQueue: PrefetchEntry[] = [];
    let activePrefetchCount = 0;
    const cleanupEntryCallers = (entry: PrefetchEntry) => {
      for (const clean of entry.cleanupCallers.values()) clean();
      entry.cleanupCallers.clear();
      entry.callers.clear();
    };
    const attachPrefetchCaller = (
      entry: PrefetchEntry,
      callerSignal: AbortSignal,
    ) => {
      if (callerSignal.aborted || entry.callers.has(callerSignal)) return;
      entry.callers.add(callerSignal);
      const onCallerAbort = () => {
        entry.cleanupCallers.get(callerSignal)?.();
        entry.cleanupCallers.delete(callerSignal);
        entry.callers.delete(callerSignal);
        if (entry.callers.size !== 0) return;
        cleanupEntryCallers(entry);
        if (pendingPrefetch.get(entry.key) === entry) {
          pendingPrefetch.delete(entry.key);
        }
        if (!entry.inFlight) {
          const index = prefetchQueue.indexOf(entry);
          if (index !== -1) prefetchQueue.splice(index, 1);
        }
        entry.abort.abort(callerSignal.reason);
      };
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      entry.cleanupCallers.set(callerSignal, () =>
        callerSignal.removeEventListener("abort", onCallerAbort),
      );
    };
    const pumpPrefetchQueue = () => {
      while (
        activePrefetchCount < MAX_CONCURRENT_PREFETCH_CHUNKS &&
        prefetchQueue.length > 0 &&
        !lifetime.signal.aborted &&
        isValid()
      ) {
        const entry = prefetchQueue.shift()!;
        if (entry.abort.signal.aborted || entry.callers.size === 0) {
          cleanupEntryCallers(entry);
          pendingPrefetch.delete(entry.key);
          continue;
        }
        entry.inFlight = true;
        ++activePrefetchCount;
        void (async () => {
          const combinedSignal = AbortSignal.any([
            entry.abort.signal,
            lifetime.signal,
          ]);
          try {
            await source.fetchChunk(entry.grid, () => undefined, {
              signal: combinedSignal,
              retryTransientErrors: true,
            });
          } catch {
            // Swallow speculative prefetch errors; readPatch handles failures.
          } finally {
            cleanupEntryCallers(entry);
            if (pendingPrefetch.get(entry.key) === entry) {
              pendingPrefetch.delete(entry.key);
            }
            --activePrefetchCount;
            pumpPrefetchQueue();
          }
        })();
      }
    };
    return {
      signal: lifetime.signal,
      shapeZYX: Array.from(shapeZYX),
      originZYX: Array.from(validitySnapshot.modelOriginZYX),
      ...(gridOffsetZYX === undefined ? {} : { gridOffsetZYX }),
      spacingZYX: Array.from(spacingZYX),
      unitsZYX: Array.from(unitsZYX),
      axisNamesZYX: ["z", "y", "x"],
      validitySnapshot,
      isValid,
      assertValid,
      prefetchVolume(originZYX, patchShapeZYX, signal) {
        if (!isValid() || signal.aborted || lifetime.signal.aborted) return;
        if (originZYX.length !== 3 || patchShapeZYX.length !== 3) return;
        const patchLower = fixedLower.slice();
        const patchUpper = fixedUpper.slice();
        for (let a = 0; a < 3; ++a) {
          const volStart = validitySnapshot.modelOriginZYX[a];
          const volEnd = volStart + shapeZYX[a];
          const reqStart = Math.max(volStart, Math.floor(originZYX[a]));
          const reqEnd = Math.min(
            volEnd,
            Math.ceil(originZYX[a] + patchShapeZYX[a]),
          );
          if (!(reqStart < reqEnd)) return;
          const d = dims[a];
          patchLower[d] = reqStart - translationZYX[a];
          patchUpper[d] = reqEnd - translationZYX[a];
        }
        for (const grid of chunkGridPositions(
          patchLower,
          patchUpper,
          chunkSize,
        )) {
          const key = grid.join();
          const existing = pendingPrefetch.get(key);
          if (existing !== undefined) {
            attachPrefetchCaller(existing, signal);
            continue;
          }
          if (prefetchQueue.length >= MAX_QUEUED_PREFETCH_CHUNKS) {
            break;
          }
          const entry: PrefetchEntry = {
            key,
            grid,
            callers: new Set(),
            abort: new AbortController(),
            cleanupCallers: new Map(),
            inFlight: false,
          };
          pendingPrefetch.set(key, entry);
          prefetchQueue.push(entry);
          attachPrefetchCaller(entry, signal);
          if (activePrefetchCount < MAX_CONCURRENT_PREFETCH_CHUNKS) {
            pumpPrefetchQueue();
          }
        }
        pumpPrefetchQueue();
      },
      async readPatch(originZYX, patchShapeZYX, signal) {
        // The caller may reuse/mutate tile arrays while a chunk is in flight.
        originZYX = Array.from(originZYX);
        patchShapeZYX = Array.from(patchShapeZYX);
        assertValid();
        const failed = new AbortController();
        const combinedSignal = AbortSignal.any([
          signal,
          lifetime.signal,
          failed.signal,
        ]);
        combinedSignal.throwIfAborted();
        if (
          originZYX.length !== 3 ||
          patchShapeZYX.length !== 3 ||
          originZYX.some(
            (x, a) =>
              !Number.isSafeInteger(x) ||
              !Number.isSafeInteger(x + patchShapeZYX[a]),
          ) ||
          patchShapeZYX.some((x) => !Number.isSafeInteger(x) || x <= 0)
        )
          throw new RangeError(
            "Patch origin and positive shape must be three safe integers in ZYX order",
          );
        if (
          originZYX.some(
            (x, a) =>
              x < validitySnapshot.modelOriginZYX[a] ||
              x + patchShapeZYX[a] >
                validitySnapshot.modelOriginZYX[a] + shapeZYX[a],
          )
        ) {
          throw new RangeError(
            "Inference patch extends outside supported native volume bounds",
          );
        }
        const count = patchShapeZYX.reduce((a, b) => a * b, 1);
        if (!Number.isSafeInteger(count))
          throw new RangeError("Patch is too large");
        const output = new Float32Array(count);
        const fillNormalized = Number(fillValue) / divisor;
        if (fillNormalized !== 0 || Object.is(fillNormalized, -0)) {
          output.fill(fillNormalized);
        }
        const patchLower = fixedLower.slice();
        const patchUpper = fixedUpper.slice();
        for (let a = 0; a < 3; ++a) {
          const d = dims[a];
          patchLower[d] = originZYX[a] - translationZYX[a];
          patchUpper[d] = patchLower[d] + patchShapeZYX[a];
          if (
            !Number.isSafeInteger(patchLower[d]) ||
            !Number.isSafeInteger(patchUpper[d])
          ) {
            throw new RangeError("Patch coordinates exceed safe integer range");
          }
        }
        // Keep source I/O overlapped without an unbounded fan-out. Chunk copies
        // are synchronous and write disjoint parts of the patch.
        const grids = chunkGridPositions(patchLower, patchUpper, chunkSize);
        const fetchChunks = async () => {
          for (const grid of grids) {
            combinedSignal.throwIfAborted();
            assertValid();
            // baseVoxelOffset is applied by the backend, not here. Applying it
            // again would shift data (precomputed also encodes it in its transform).
            const chunkOrigin = Array.from(
              grid,
              (g, d) => g * spec.chunkDataSize[d],
            );
            const result = await source.fetchChunk(
              grid,
              (chunk) => {
                // Never throw out of a chunk requester: fetchChunk's async requester
                // resolves transform(chunk) without catching callback exceptions.
                try {
                  combinedSignal.throwIfAborted();
                  assertValid();
                  const volumeChunk = chunk as VolumeChunk;
                  if (volumeChunk.chunkDataSize.length !== rank) {
                    throw new Error(
                      `Inference chunk must have rank-${rank} data`,
                    );
                  }
                  for (let d = 0; d < rank; ++d) {
                    const requiredEnd = Math.min(
                      chunkOrigin[d] + spec.chunkDataSize[d],
                      patchUpper[d],
                    );
                    if (
                      volumeChunk.chunkDataSize[d] > spec.chunkDataSize[d] ||
                      chunkOrigin[d] + volumeChunk.chunkDataSize[d] <
                        requiredEnd
                    ) {
                      throw new Error(
                        "Inference chunk does not cover the requested in-bounds voxels",
                      );
                    }
                  }
                  copyChunkToZYXPatch(
                    volumeChunk,
                    {
                      dataType,
                      chunkOrigin,
                      chunkDimensionsZYX: dims,
                      patchLowerChunk: patchLower,
                      patchShapeZYX,
                      lowerBoundChunk: lower,
                      upperBoundChunk: upper,
                    },
                    output,
                  );
                  return { ok: true as const };
                } catch (error) {
                  return { ok: false as const, error };
                }
              },
              { signal: combinedSignal, retryTransientErrors: true },
            );
            if (!result.ok) throw result.error;
          }
        };
        const pending = Array.from({ length: 8 }, fetchChunks);
        try {
          await Promise.all(pending);
        } catch (error) {
          failed.abort(error);
          // Settle all requesters before releasing the patch/source on failure.
          await Promise.allSettled(pending);
          throw error;
        }
        combinedSignal.throwIfAborted();
        assertValid();
        return output;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const entry of pendingPrefetch.values()) {
          cleanupEntryCallers(entry);
          entry.abort.abort(new Error("Inference input disposed"));
        }
        pendingPrefetch.clear();
        prefetchQueue.length = 0;
        lifetime.abort(new Error("Inference input disposed"));
        for (const remove of removers) remove();
        source.dispose();
      },
    };
  } finally {
    // getSources returns owned refs, including unused scales/orientations.
    for (const scales of sources) {
      for (const { chunkSource } of scales) chunkSource.dispose();
    }
  }
}
