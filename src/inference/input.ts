/**
 * Native-grid image input for browser inference. No rendering, interpolation,
 * normalization, Python export, or ONNX runtime dependency is involved.
 */
import type { CoordinateSpace } from "#src/coordinate_transform.js";
import { makeIdentityTransform } from "#src/coordinate_transform.js";
import type { ImageUserLayer } from "#src/layer/image/index.js";
import type { RenderLayerTransform } from "#src/render_coordinate_transform.js";
import { getRenderLayerTransform } from "#src/render_coordinate_transform.js";
import type {
  VolumeChunk,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import { SliceViewVolumeRenderLayer } from "#src/sliceview/volume/renderlayer.js";
import { arraysEqual } from "#src/util/array.js";
import { valueOrThrow } from "#src/util/error.js";
import * as matrix from "#src/util/matrix.js";

type Triple<T> = readonly [T, T, T];

export interface InferenceInputSnapshot {
  /** Dimensions of chunk space corresponding to Z, Y, X. */
  readonly chunkDimensionsZYX: Triple<number>;
  readonly lowerBoundChunk: Triple<number>;
  readonly upperBoundChunk: Triple<number>;
  /** Backend request offset, NOT an additional offset to chunk-grid positions. */
  readonly baseVoxelOffset: Triple<number>;
  readonly chunkToMultiscaleTransform: readonly number[];
  /** Selected-scale model-grid lower bound of the volume, in ZYX order. */
  readonly modelOriginZYX: Triple<number>;
}

export interface PreparedInferenceInput {
  readonly shapeZYX: number[];
  /** Selected-scale model-grid lower bound, for inference inputBounds (ZYX). */
  readonly originZYX: number[];
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
   * Numeric conversion to float32 is intentional; no intensity scaling occurs.
   */
  readPatch(
    originZYX: readonly number[],
    shapeZYX: readonly number[],
    signal: AbortSignal,
  ): Promise<Float32Array>;
  /** Idempotent; aborts outstanding reads and releases acquired source refs. */
  dispose(): void;
}

function triple<T>(values: ArrayLike<T>): Triple<T> {
  return Object.freeze([values[0], values[1], values[2]]);
}

function unsupported(message: string): never {
  throw new Error(`Unsupported inference input: ${message}`);
}

function checkIdentity(transform: ArrayLike<number>) {
  if (
    transform.length !== 16 ||
    Array.from(transform).some((x, i) => x !== (i % 5 === 0 ? 1 : 0))
  ) {
    unsupported(
      "model-to-layer transform must be exactly identity (no resampling)",
    );
  }
}

/** Storage scale/permutation and aligned selected-grid origins; no resampling. */
function getChunkGrid(
  transform: ArrayLike<number>,
  modelDimensionsZYX: number[],
) {
  if (
    transform.length !== 16 ||
    transform[3] !== 0 ||
    transform[7] !== 0 ||
    transform[11] !== 0 ||
    transform[15] !== 1
  ) {
    unsupported(
      "source grid requires a positive scaled axis permutation and integer origin",
    );
  }
  const modelToChunk: number[] = [];
  const modelScales: number[] = [];
  for (let c = 0; c < 3; ++c) {
    let modelDimension = -1;
    for (let m = 0; m < 3; ++m) {
      const value = transform[c * 4 + m];
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
  const translationZYX = triple(
    modelDimensionsZYX.map((m) => transform[12 + m] / modelScales[m]),
  );
  if (translationZYX.some((x) => !Number.isSafeInteger(x))) {
    unsupported("source origin must align to integer selected-scale voxels");
  }
  return {
    chunkDimensionsZYX: triple(modelDimensionsZYX.map((m) => modelToChunk[m])),
    chunkScalesZYX: triple(modelDimensionsZYX.map((m) => modelScales[m])),
    translationZYX,
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
  if (renderLayer.multiscaleSource.rank !== 3)
    unsupported("only rank-3 volumes are supported");
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
  return { renderLayer, ...matches[0] };
}

function getNativeMetadata(space: CoordinateSpace) {
  if (space.rank !== 3) unsupported("only rank-3 scalar volumes are supported");
  const { names, scales, units } = space;
  if (
    names.length !== 3 ||
    new Set(names).size !== 3 ||
    !["x", "y", "z"].every((name) => names.includes(name))
  ) {
    unsupported(
      "axes must be unambiguously named exactly x, y, z in model and layer space",
    );
  }
  if (
    !space.valid ||
    [0, 1, 2].some(
      (d) =>
        !(scales[d] > 0) ||
        !Number.isFinite(scales[d]) ||
        typeof units[d] !== "string" ||
        space.coordinateArrays[d] !== undefined,
    )
  ) {
    unsupported("missing, ambiguous, or non-uniform physical axis metadata");
  }
  const modelDimensionsZYX = ["z", "y", "x"].map((name) => names.indexOf(name));
  return {
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
) {
  return multiscale.getSources({
    discreteValues: true,
    displayRank: 3,
    modelChannelDimensionIndices: [],
    multiscaleToViewTransform: matrix.createIdentity(Float32Array, 3),
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
  spacingZYX: number[];
  axisNamesZYX: string[];
  unitsZYX: string[];
}[] {
  const { renderLayer, loadState } = getActiveVolume(layer);
  const metadata = getNativeMetadata(
    loadState.dataSource.modelTransform.inputSpace,
  );
  const sources = getInputSources(renderLayer.multiscaleSource);
  try {
    if (sources.length !== 1 || sources[0].length === 0) {
      unsupported("expected one unambiguous native chunk orientation");
    }
    return sources[0].map((selected, scaleIndex) => {
      if (selected.chunkSource.spec.rank !== 3)
        unsupported("only rank-3 chunks are supported");
      const { chunkScalesZYX } = getChunkGrid(
        selected.chunkToMultiscaleTransform,
        metadata.modelDimensionsZYX,
      );
      return {
        scaleIndex,
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

function getMetadata(layer: ImageUserLayer, transform: RenderLayerTransform) {
  const { loadState, subsource } = getActiveVolume(layer);
  const nativeSpace = loadState.dataSource.modelTransform.inputSpace;
  const metadata = getNativeMetadata(nativeSpace);
  if (transform.rank !== 3 || transform.unpaddedRank !== 3) {
    unsupported("only rank-3 scalar volumes are supported");
  }
  if (transform.channelToRenderLayerDimensions.some((d) => d !== -1)) {
    unsupported("channel dimensions are not supported");
  }
  // Validate the raw user and internal subsource transforms as well: their
  // composition could otherwise hide a transform cancelled by another one.
  const raw = loadState.transform.value;
  if (raw.rank !== 3 || raw.sourceRank !== 3)
    unsupported("only rank-3 scalar volumes are supported");
  checkIdentity(raw.transform);
  checkIdentity(subsource.subsourceToModelSubspaceTransform);
  if (!arraysEqual(subsource.modelSubspaceDimensionIndices, [0, 1, 2]))
    unsupported("subsource must use the native model dimensions in order");
  // The input grid remains native, but CoordinateSpaceCombiner binds output
  // scales to the viewer's coordinate space (converting translation only).
  for (const space of [raw.inputSpace, raw.outputSpace]) {
    getNativeMetadata(space);
    if (
      !arraysEqual(space.names, nativeSpace.names) ||
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
  ] as const) {
    dimensions.forEach((d, i) => {
      if (d === -1) return;
      if (
        !space.valid ||
        d < 0 ||
        d >= 3 ||
        covered.has(d) ||
        space.names[i] !== nativeSpace.names[d] ||
        !(space.scales[i] > 0) ||
        !Number.isFinite(space.scales[i]) ||
        space.units[i] !== nativeSpace.units[d] ||
        space.coordinateArrays[i] !== undefined
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
  if (covered.size !== 3)
    unsupported("physical spacing/units must be explicit for all three axes");
  // A raw identity is generally NOT a render-space identity: the viewer may
  // use a different physical voxel scale. Recompute exactly the same float32
  // normalization, without any user or subsource transform and without epsilon.
  const expected = valueOrThrow(
    getRenderLayerTransform(
      layer.managedLayer.manager.root.coordinateSpace.value,
      layer.managedLayer.localCoordinateSpace.value,
      makeIdentityTransform(nativeSpace),
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

export interface ChunkToZYXPatchOptions {
  readonly chunkOrigin: readonly number[];
  readonly chunkDimensionsZYX: readonly number[];
  readonly patchLowerChunk: readonly number[];
  readonly patchShapeZYX: readonly number[];
  readonly lowerBoundChunk: readonly number[];
  readonly upperBoundChunk: readonly number[];
}

/**
 * Pure packing helper. Reads via the format-independent accessor; does not
 * retain, mutate, or transfer source data. Call ONLY inside fetchChunk's callback.
 * Only overlaps are written; the caller must ensure complete patch coverage.
 */
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
  const position = new Uint32Array(3);
  const [dz, dy, dx] = dims;
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
        output[offset++] = Number(value);
      }
    }
  }
}

/**
 * Select exactly one active image volume and one explicit scale/orientation.
 * Reject user/view transforms, ambiguous axes, fractional selected-grid bounds,
 * and grids requiring resampling rather than sampling rendered data.
 */
export function prepareInferenceInput(
  layer: ImageUserLayer,
  scaleIndex = 0,
): PreparedInferenceInput {
  const { renderLayer, loadState, subsource } = getActiveVolume(layer);
  const multiscale = renderLayer.multiscaleSource;
  const dataSource = loadState.dataSource;
  const transform = valueOrThrow(renderLayer.transform.value);
  const {
    modelDimensionsZYX,
    spacingZYX: nativeSpacingZYX,
    unitsZYX,
  } = getMetadata(layer, transform);
  const sources = getInputSources(multiscale);
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
    if (spec.rank !== 3) unsupported("only rank-3 chunks are supported");
    const {
      chunkDimensionsZYX: dims,
      chunkScalesZYX,
      translationZYX,
    } = getChunkGrid(selected.chunkToMultiscaleTransform, modelDimensionsZYX);
    const spacingZYX = getScaledSpacing(nativeSpacingZYX, chunkScalesZYX);
    const lower = [0, 1, 2].map((d) =>
      Math.max(
        spec.lowerVoxelBound[d],
        selected.lowerClipBound?.[d] ?? spec.lowerVoxelBound[d],
      ),
    );
    const upper = [0, 1, 2].map((d) =>
      Math.min(
        spec.upperVoxelBound[d],
        selected.upperClipBound?.[d] ?? spec.upperVoxelBound[d],
      ),
    );
    for (let d = 0; d < 3; ++d) {
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
      lowerBoundChunk: triple(lower),
      upperBoundChunk: triple(upper),
      baseVoxelOffset: triple(spec.baseVoxelOffset),
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
    const chunkSize = triple(spec.chunkDataSize);
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
        const metadata = getMetadata(layer, current);
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
      spec.fillValue === fillValue &&
      arraysEqual(spec.chunkDataSize, chunkSize) &&
      arraysEqual(spec.baseVoxelOffset, validitySnapshot.baseVoxelOffset) &&
      arraysEqual(
        selected.chunkToMultiscaleTransform,
        validitySnapshot.chunkToMultiscaleTransform,
      ) &&
      [0, 1, 2].every(
        (d) =>
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
    return {
      signal: lifetime.signal,
      shapeZYX: Array.from(shapeZYX),
      originZYX: Array.from(validitySnapshot.modelOriginZYX),
      spacingZYX: Array.from(spacingZYX),
      unitsZYX: Array.from(unitsZYX),
      axisNamesZYX: ["z", "y", "x"],
      validitySnapshot,
      isValid,
      assertValid,
      async readPatch(originZYX, patchShapeZYX, signal) {
        // The caller may reuse/mutate tile arrays while a chunk is in flight.
        originZYX = Array.from(originZYX);
        patchShapeZYX = Array.from(patchShapeZYX);
        assertValid();
        const combinedSignal = AbortSignal.any([signal, lifetime.signal]);
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
        output.fill(Number(spec.fillValue));
        const patchLower = new Array<number>(3);
        const gridLower = new Array<number>(3);
        const gridUpper = new Array<number>(3);
        for (let a = 0; a < 3; ++a) {
          const d = dims[a];
          patchLower[d] = originZYX[a] - translationZYX[a];
          if (
            !Number.isSafeInteger(patchLower[d]) ||
            !Number.isSafeInteger(patchLower[d] + patchShapeZYX[a])
          ) {
            throw new RangeError("Patch coordinates exceed safe integer range");
          }
          const start = Math.max(lower[d], patchLower[d]);
          const end = Math.min(upper[d], patchLower[d] + patchShapeZYX[a]);
          if (end <= start) return output;
          gridLower[d] = Math.floor(start / spec.chunkDataSize[d]);
          gridUpper[d] = Math.ceil(end / spec.chunkDataSize[d]);
        }
        // Sequential fetches bound outstanding chunk requests and memory usage.
        for (let g2 = gridLower[2]; g2 < gridUpper[2]; ++g2) {
          for (let g1 = gridLower[1]; g1 < gridUpper[1]; ++g1) {
            for (let g0 = gridLower[0]; g0 < gridUpper[0]; ++g0) {
              combinedSignal.throwIfAborted();
              assertValid();
              const grid = new Float32Array([g0, g1, g2]);
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
                    if (volumeChunk.chunkDataSize.length !== 3) {
                      throw new Error("Inference chunk must have rank-3 data");
                    }
                    for (let a = 0; a < 3; ++a) {
                      const d = dims[a];
                      const requiredEnd = Math.min(
                        chunkOrigin[d] + spec.chunkDataSize[d],
                        patchLower[d] + patchShapeZYX[a],
                        upper[d],
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
                { signal: combinedSignal },
              );
              if (!result.ok) throw result.error;
            }
          }
        }
        combinedSignal.throwIfAborted();
        assertValid();
        return output;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
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
