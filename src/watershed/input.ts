/** Bounded, native-grid affinity reads; no rendering, interpolation, or runtime. */
import type { CoordinateSpace } from "#src/coordinate_transform.js";
import {
  convertTransformOutputScales,
  isChannelDimension,
} from "#src/coordinate_transform.js";
import type { ImageUserLayer } from "#src/layer/image/index.js";
import {
  getRenderLayerTransform,
  renderLayerTransformsEqual,
} from "#src/render_coordinate_transform.js";
import type { VolumeChunk } from "#src/sliceview/volume/frontend.js";
import { SliceViewVolumeRenderLayer } from "#src/sliceview/volume/renderlayer.js";
import { arraysEqual } from "#src/util/array.js";
import { DataType } from "#src/util/data_type.js";
import { valueOrThrow } from "#src/util/error.js";
import * as matrix from "#src/util/matrix.js";
import { supportedUnits } from "#src/util/si_units.js";
import {
  isSafeWatershedPlacement,
  MAX_WATERSHED_VOXELS,
} from "#src/watershed/base.js";
const AXES = ["x", "y", "z"] as const;

export interface PreparedAffinityInput {
  /** Selected chunk voxel indices, mapped to XYZ (not viewer coordinates). */
  readonly lowerBoundXYZ: readonly number[];
  readonly upperBoundXYZ: readonly number[];
  readonly channelCount: number;
  readonly spacingXYZ: readonly number[];
  readonly unitsXYZ: readonly string[];
  /** Display translation in selected-grid voxels (possibly fractional); never a read offset. */
  readonly originXYZ: readonly number[];
  readonly signal: AbortSignal;
  isValid(): boolean;
  assertValid(): void;
  /**
   * Owned planar [N,Z,Y,X], X fastest, for 1..4 requested channels in order.
   * Repeats are allowed; scalar inputs expose only channel 0. No mapping is inferred.
   */
  readRegion(
    lowerXYZ: readonly number[],
    shapeXYZ: readonly number[],
    channelsXYZ: readonly number[],
    signal: AbortSignal,
  ): Promise<Float32Array>;
  /** Idempotent; aborts outstanding reads and releases the retained source. */
  dispose(): void;
}

function unsupported(message: string): never {
  throw new Error(`Unsupported affinity input: ${message}`);
}

function getAxes(space: CoordinateSpace) {
  const { rank, names, scales, units } = space;
  const channel = names.findIndex(isChannelDimension);
  if (
    !space.valid ||
    (rank !== 3 && rank !== 4) ||
    names.length !== rank ||
    new Set(names).size !== rank ||
    !AXES.every((name) => names.includes(name)) ||
    (rank === 4 && channel === -1)
  ) {
    unsupported(
      "expected rank-3 x, y, z or rank-4 x, y, z and one channel dimension",
    );
  }
  for (let d = 0; d < rank; ++d) {
    const unit = supportedUnits.get(units[d]);
    if (
      !(scales[d] > 0) ||
      !Number.isFinite(scales[d]) ||
      unit === undefined ||
      unit.exponent !== 0 ||
      space.coordinateArrays[d] !== undefined
    ) {
      unsupported("uniform positive spacing and canonical units are required");
    }
  }
  if (channel !== -1 && (scales[channel] !== 1 || units[channel] !== "")) {
    unsupported("channel coordinates must be unscaled and unitless");
  }
  return { xyz: AXES.map((name) => names.indexOf(name)), channel };
}

/** Row -> column mapping; translations are kept separate from fetch indices. */
function positiveGrid(transform: ArrayLike<number>, rank: number) {
  const stride = rank + 1;
  if (
    transform.length !== stride ** 2 ||
    Array.from({ length: rank }, (_, c) => transform[c * stride + rank]).some(
      (v) => v !== 0,
    ) ||
    transform[stride ** 2 - 1] !== 1
  ) {
    unsupported("expected a positive scaled axis permutation (no resampling)");
  }
  const dimensions = new Array<number>(rank).fill(-1);
  const scales = new Array<number>(rank);
  for (let c = 0; c < rank; ++c) {
    let row = -1;
    for (let r = 0; r < rank; ++r) {
      const v = transform[c * stride + r];
      if (v === 0) continue;
      if (!Number.isFinite(v) || v <= 0 || row !== -1 || dimensions[r] !== -1) {
        unsupported("shear, reflection, or ambiguous axes (no resampling)");
      }
      row = r;
      dimensions[r] = c;
      scales[r] = v;
    }
    if (row === -1) unsupported("singular native grid");
  }
  const translation = Array.from(
    { length: rank },
    (_, r) => transform[rank * stride + r],
  );
  if (!translation.every(Number.isFinite))
    unsupported("nonfinite native origin");
  return { dimensions, scales, translation };
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
  if (
    renderLayer.wasDisposed ||
    ![3, 4].includes(renderLayer.multiscaleSource.rank)
  ) {
    unsupported("expected a live rank-3 scalar or rank-4 affinity volume");
  }
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
    unsupported("expected one active loaded volume source");
  return { renderLayer, ...matches[0] };
}

/** Exclude bounds/ids/timestamps: unrelated viewer bounds updates are harmless. */
function spaceKey(space: CoordinateSpace) {
  return [
    space.valid,
    space.rank,
    [...space.names],
    [...space.scales],
    [...space.units],
  ];
}

function getNativeState(layer: ImageUserLayer) {
  const active = getActiveVolume(layer);
  const { loadState, subsource, renderLayer } = active;
  const native = loadState.dataSource.modelTransform;
  const rank = renderLayer.multiscaleSource.rank;
  const inputAxes = getAxes(native.inputSpace);
  const outputAxes = getAxes(native.outputSpace);
  if (
    native.rank !== rank ||
    native.sourceRank !== rank ||
    native.inputSpace.rank !== rank ||
    native.outputSpace.rank !== rank
  )
    unsupported("padded model dimensions");
  const grid = positiveGrid(native.transform, rank);
  if (
    (outputAxes.channel !== -1 &&
      (grid.dimensions[outputAxes.channel] !== inputAxes.channel ||
        grid.scales[outputAxes.channel] !== 1 ||
        grid.translation[outputAxes.channel] !== 0)) ||
    grid.dimensions.some(
      (c, r) => native.inputSpace.units[c] !== native.outputSpace.units[r],
    )
  ) {
    unsupported(
      "native transform must preserve spatial units and channel coordinates",
    );
  }
  const raw = loadState.transform.value;
  const expectedRaw = convertTransformOutputScales(
    native.transform,
    native.outputSpace.scales,
    raw.outputSpace.scales,
  );
  if (
    raw.rank !== rank ||
    raw.sourceRank !== rank ||
    JSON.stringify(spaceKey(raw.inputSpace)) !==
      JSON.stringify(spaceKey(native.inputSpace)) ||
    !arraysEqual(raw.outputSpace.names, native.outputSpace.names) ||
    !arraysEqual(raw.outputSpace.units, native.outputSpace.units) ||
    !arraysEqual(raw.transform, expectedRaw) ||
    !arraysEqual(
      subsource.modelSubspaceDimensionIndices,
      Array.from({ length: rank }, (_, d) => d),
    ) ||
    !arraysEqual(
      subsource.subsourceToModelSubspaceTransform,
      matrix.createIdentity(Float32Array, rank + 1),
    )
  ) {
    unsupported("user/subsource transforms must remain native (no resampling)");
  }
  getAxes(raw.outputSpace);
  const global = layer.managedLayer.manager.root.coordinateSpace.value;
  const local = layer.managedLayer.localCoordinateSpace.value;
  const channel = layer.channelCoordinateSpace.value;
  const current = valueOrThrow(renderLayer.transform.value);
  const expected = valueOrThrow(
    getRenderLayerTransform(global, local, raw, undefined, channel),
  );
  if (
    current.rank !== rank ||
    current.unpaddedRank !== rank ||
    !renderLayerTransformsEqual(current, expected) ||
    channel.rank !== (inputAxes.channel === -1 ? 0 : 1) ||
    (inputAxes.channel !== -1 &&
      (channel.names[0] !== native.outputSpace.names[outputAxes.channel] ||
        current.channelToModelDimensions[0] !== inputAxes.channel))
  )
    unsupported("ambiguous or non-native render-layer dimensions");
  // All native output axes must have explicit, compatible viewer metadata.
  const covered = new Set<number>();
  for (const [space, mapping] of [
    [global, current.globalToRenderLayerDimensions],
    [local, current.localToRenderLayerDimensions],
    [channel, current.channelToRenderLayerDimensions],
  ] as const) {
    mapping.forEach((d, i) => {
      if (d === -1) return;
      if (
        !space.valid ||
        covered.has(d) ||
        d < 0 ||
        d >= rank ||
        space.units[i] !== raw.outputSpace.units[d] ||
        space.scales[i] !== raw.outputSpace.scales[d] ||
        !(space.scales[i] > 0) ||
        !Number.isFinite(space.scales[i]) ||
        space.coordinateArrays[i] !== undefined
      )
        unsupported("missing or non-uniform viewer coordinate metadata");
      covered.add(d);
    });
  }
  if (covered.size !== rank) unsupported("incomplete native dimension mapping");
  return {
    ...active,
    rank,
    native,
    inputAxes,
    outputAxes,
    grid,
    key: JSON.stringify([
      ...[
        native.inputSpace,
        native.outputSpace,
        raw.inputSpace,
        raw.outputSpace,
        global,
        local,
        channel,
      ].map(spaceKey),
      [...native.transform],
      [...raw.transform],
      [...current.channelSpaceShape],
      current.globalToRenderLayerDimensions,
      current.localToRenderLayerDimensions,
      current.channelToRenderLayerDimensions,
    ]),
  };
}

function divisorFor(dataType: DataType) {
  switch (dataType) {
    case DataType.FLOAT32:
      return 1;
    case DataType.UINT8:
      return 255;
    case DataType.UINT16:
      return 65535;
    default:
      return unsupported(
        "only FLOAT32, UINT8, and UINT16 affinities are supported",
      );
  }
}

export function prepareAffinityInput(
  layer: ImageUserLayer,
  scaleIndex = 0,
): PreparedAffinityInput {
  const state = getNativeState(layer);
  const { renderLayer, loadState, subsource, native, rank } = state;
  const multiscale = renderLayer.multiscaleSource;
  const getSources = () =>
    multiscale.getSources({
      discreteValues: true,
      displayRank: 3,
      modelChannelDimensionIndices:
        state.inputAxes.channel === -1 ? [] : [state.inputAxes.channel],
      multiscaleToViewTransform: matrix.createIdentity(Float32Array, 3),
    });
  const releaseSources = (sources: ReturnType<typeof getSources>) => {
    for (const scales of sources)
      for (const { chunkSource } of scales) chunkSource.dispose();
  };
  const sources = getSources();
  try {
    if (sources.length !== 1 || sources[0].length === 0)
      unsupported("ambiguous native source orientation");
    if (
      !Number.isSafeInteger(scaleIndex) ||
      scaleIndex < 0 ||
      scaleIndex >= sources[0].length
    ) {
      throw new RangeError("Affinity input scaleIndex is out of range");
    }
    const selected = sources[0][scaleIndex];
    const source = selected.chunkSource;
    if ("generation" in source) {
      unsupported(
        "mutable generation-based volumes cannot provide live watershed input; use a static affinity volume or ONNX publication",
      );
    }
    const { spec } = source;
    const { dataType } = spec;
    const divisor = divisorFor(dataType);
    const chunkGrid = positiveGrid(selected.chunkToMultiscaleTransform, rank);
    const channelDim =
      state.inputAxes.channel === -1
        ? -1
        : chunkGrid.dimensions[state.inputAxes.channel];
    if (
      channelDim !== -1 &&
      (chunkGrid.scales[state.inputAxes.channel] !== 1 ||
        chunkGrid.translation[state.inputAxes.channel] !== 0)
    )
      unsupported("source channel dimension must be unscaled and untranslated");
    const dims: number[] = [],
      spacing: number[] = [],
      origin: number[] = [];
    // An inference publication has local integer tiles. Its model transform,
    // not its chunk grid, carries the voxel-center to voxel-corner translation.
    const inferencePlacement =
      loadState.dataSource.canonicalUrl?.startsWith("inference://");
    for (const d of state.outputAxes.xyz) {
      const m = state.grid.dimensions[d];
      dims.push(chunkGrid.dimensions[m]);
      spacing.push(
        native.inputSpace.scales[m] *
          state.grid.scales[d] *
          chunkGrid.scales[m],
      );
      // The native translation is in native OUTPUT voxel units; source
      // translation is in MODEL voxels. Convert both to selected-grid units.
      // In particular, viewer-rebound raw.transform has the wrong origin units.
      let offset =
        (state.grid.translation[d] *
          (native.outputSpace.scales[d] /
            (native.inputSpace.scales[m] * state.grid.scales[d])) +
          chunkGrid.translation[m]) /
        chunkGrid.scales[m];
      if (!inferencePlacement) {
        // Other volume adapters still require selected-grid alignment.
        const nearest = Math.round(offset);
        const tolerance = Math.min(
          1e-7,
          8 * Number.EPSILON * Math.max(1, Math.abs(offset)),
        );
        if (Math.abs(offset - nearest) <= tolerance) offset = nearest;
        if (!Number.isSafeInteger(offset)) {
          unsupported("native origin must align to selected-grid integers");
        }
      }
      origin.push(offset);
    }
    if (spacing.some((s) => !(s > 0) || !Number.isFinite(s))) {
      unsupported("spacing must be finite and positive");
    }
    const lower: number[] = [],
      upper: number[] = [];
    if (
      spec.rank !== rank ||
      [
        spec.lowerVoxelBound,
        spec.upperVoxelBound,
        spec.chunkDataSize,
        spec.baseVoxelOffset,
      ].some((x) => x.length !== rank)
    ) {
      unsupported(`expected rank-${rank} chunk metadata`);
    }
    for (let d = 0; d < rank; ++d) {
      lower[d] = Math.max(
        spec.lowerVoxelBound[d],
        selected.lowerClipBound?.[d] ?? -Infinity,
      );
      upper[d] = Math.min(
        spec.upperVoxelBound[d],
        selected.upperClipBound?.[d] ?? Infinity,
      );
      if (
        !Number.isSafeInteger(lower[d]) ||
        !Number.isSafeInteger(upper[d]) ||
        upper[d] <= lower[d] ||
        !Number.isSafeInteger(upper[d] - lower[d]) ||
        !Number.isSafeInteger(spec.baseVoxelOffset[d]) ||
        !Number.isSafeInteger(spec.chunkDataSize[d]) ||
        spec.chunkDataSize[d] <= 0 ||
        spec.chunkDataSize[d] >= 2 ** 32
      )
        unsupported(
          "integer native bounds, chunk sizes, and backend offsets are required",
        );
      const size = spec.chunkDataSize[d];
      const grid = [lower[d], upper[d] - 1].map((b) => Math.floor(b / size));
      if (grid.some((v) => Math.abs(v) > 2 ** 24)) {
        unsupported("chunk grid exceeds exact float32 indexing");
      }
      for (const offset of [0, spec.baseVoxelOffset[d]]) {
        const first = grid[0] * size + offset;
        const last = grid[1] * size + offset;
        const quantum =
          2 **
          Math.max(
            0,
            Math.floor(Math.log2(Math.max(Math.abs(first), Math.abs(last)))) -
              23,
          );
        // Exact endpoints alone can hide rounded intermediate backend origins.
        if (
          !Number.isSafeInteger(first) ||
          !Number.isSafeInteger(last) ||
          Math.fround(first) !== first ||
          Math.fround(last) !== last ||
          (grid[0] !== grid[1] && size % quantum !== 0)
        ) {
          unsupported("backend chunk origins exceed exact float32 indexing");
        }
      }
    }
    if (
      channelDim !== -1 &&
      (lower[channelDim] !== 0 ||
        upper[channelDim] < 1 ||
        upper[channelDim] >= 2 ** 32)
    ) {
      unsupported(
        "channel bounds must start at zero and include at least one channel",
      );
    }
    const channelCount = channelDim === -1 ? 1 : upper[channelDim];
    const lowerBoundXYZ = Object.freeze(dims.map((d) => lower[d]));
    const upperBoundXYZ = Object.freeze(dims.map((d) => upper[d]));
    if (
      origin.some(
        (v, a) =>
          !isSafeWatershedPlacement(v, lowerBoundXYZ[a]) ||
          !isSafeWatershedPlacement(v, upperBoundXYZ[a]),
      )
    ) {
      unsupported("global output bounds exceed safe voxel placement precision");
    }
    const chunkSize = Array.from(spec.chunkDataSize);
    const specKey = () =>
      JSON.stringify(
        [
          spec.rank,
          spec.dataType,
          spec.fillValue,
          [...spec.lowerVoxelBound],
          [...spec.upperVoxelBound],
          [...spec.chunkDataSize],
          [...spec.baseVoxelOffset],
          [...selected.chunkToMultiscaleTransform],
          selected.lowerClipBound && [...selected.lowerClipBound],
          selected.upperClipBound && [...selected.upperClipBound],
        ],
        (_, value) => (typeof value === "bigint" ? String(value) : value),
      );
    const initialSpecKey = specKey();
    const lifetime = new AbortController();
    let disposed = false;
    const invalidate = () =>
      lifetime.abort(new Error("Affinity input is stale; prepare it again"));
    const isValid = () => {
      if (disposed || lifetime.signal.aborted) return false;
      try {
        const current = getNativeState(layer);
        if (
          current.renderLayer !== renderLayer ||
          current.loadState !== loadState ||
          current.subsource !== subsource ||
          current.native !== native ||
          current.key !== state.key ||
          renderLayer.multiscaleSource !== multiscale ||
          source.wasDisposed ||
          source.spec !== spec ||
          specKey() !== initialSpecKey
        )
          throw new Error("Changed affinity source");
        // getSources is also the source's availability check (notably for deleted
        // inference publications). Release ALL donated refs, including other scales.
        const now = getSources();
        try {
          const current = now[0]?.[scaleIndex];
          if (
            now.length !== 1 ||
            current === undefined ||
            current.chunkSource !== source ||
            !arraysEqual(
              current.chunkToMultiscaleTransform,
              selected.chunkToMultiscaleTransform,
            ) ||
            !arraysEqual(
              current.lowerClipBound ?? spec.lowerVoxelBound,
              selected.lowerClipBound ?? spec.lowerVoxelBound,
            ) ||
            !arraysEqual(
              current.upperClipBound ?? spec.upperVoxelBound,
              selected.upperClipBound ?? spec.upperVoxelBound,
            )
          )
            throw new Error("Replaced affinity source");
        } finally {
          releaseSources(now);
        }
        return true;
      } catch {
        invalidate();
        return false;
      }
    };
    const assertValid = () => {
      if (!isValid())
        throw new Error(
          "Affinity input is disposed or stale; prepare it again",
        );
    };
    const check = () => {
      isValid();
    };
    const removers = [
      layer.dataSourcesChanged,
      layer.layersChanged,
      layer.readyStateChanged,
      loadState.transform.changed,
      renderLayer.transform.changed,
      layer.channelCoordinateSpace.changed,
      layer.managedLayer.localCoordinateSpace.changed,
      layer.managedLayer.manager.root.coordinateSpace.changed,
    ].map((changed) => changed.add(check));
    removers.push(source.cacheInvalidated.add(invalidate));
    source.addRef();
    return {
      lowerBoundXYZ,
      upperBoundXYZ,
      channelCount,
      spacingXYZ: Object.freeze(spacing),
      unitsXYZ: Object.freeze(
        state.outputAxes.xyz.map((d) => native.outputSpace.units[d]),
      ),
      originXYZ: Object.freeze(origin),
      signal: lifetime.signal,
      isValid,
      assertValid,
      async readRegion(lowerXYZ, shapeXYZ, channelsXYZ, signal) {
        lowerXYZ = Array.from(lowerXYZ);
        shapeXYZ = Array.from(shapeXYZ);
        channelsXYZ = Array.from(channelsXYZ);
        assertValid();
        const combined = AbortSignal.any([signal, lifetime.signal]);
        combined.throwIfAborted();
        if (
          lowerXYZ.length !== 3 ||
          shapeXYZ.length !== 3 ||
          lowerXYZ.some(
            (v, a) =>
              !Number.isSafeInteger(v) ||
              !Number.isSafeInteger(v + shapeXYZ[a]),
          ) ||
          shapeXYZ.some((v) => !Number.isSafeInteger(v) || v <= 0)
        )
          throw new RangeError(
            "Region lower and positive shape must be three safe integers in XYZ order",
          );
        if (
          lowerXYZ.some(
            (v, a) =>
              v < lowerBoundXYZ[a] || v + shapeXYZ[a] > upperBoundXYZ[a],
          )
        ) {
          throw new RangeError(
            "Affinity region extends outside native bounds; padding is not supported",
          );
        }
        const count = shapeXYZ.reduce((a, b) => a * b, 1);
        if (!Number.isSafeInteger(count) || count > MAX_WATERSHED_VOXELS)
          throw new RangeError("Affinity region exceeds 2**26 voxels");
        if (
          channelsXYZ.length < 1 ||
          channelsXYZ.length > 4 ||
          channelsXYZ.some(
            (c) => !Number.isSafeInteger(c) || c < 0 || c >= channelCount,
          )
        )
          throw new RangeError(
            "Select 1..4 in-bounds affinity channels (repeats allowed)",
          );
        const output = new Float32Array(channelsXYZ.length * count);
        const gridLower = new Array<number>(rank),
          gridUpper = new Array<number>(rank);
        const regionLower = new Array<number>(rank),
          regionUpper = new Array<number>(rank);
        dims.forEach((d, a) => {
          regionLower[d] = lowerXYZ[a];
          regionUpper[d] = lowerXYZ[a] + shapeXYZ[a];
          gridLower[d] = Math.floor(regionLower[d] / chunkSize[d]);
          gridUpper[d] = Math.ceil(regionUpper[d] / chunkSize[d]);
        });
        // Fetch only selected channel chunks, once each. Do not iterate gaps.
        const channelGrids =
          channelDim === -1
            ? [0]
            : [
                ...new Set(
                  channelsXYZ.map((c) => Math.floor(c / chunkSize[channelDim])),
                ),
              ];
        const [dx, dy, dz] = dims;
        for (const gc of channelGrids) {
          const planes = channelsXYZ
            .map((_, a) => a)
            .filter(
              (a) =>
                channelDim === -1 ||
                Math.floor(channelsXYZ[a] / chunkSize[channelDim]) === gc,
            );
          for (let gz = gridLower[dz]; gz < gridUpper[dz]; ++gz) {
            for (let gy = gridLower[dy]; gy < gridUpper[dy]; ++gy) {
              for (let gx = gridLower[dx]; gx < gridUpper[dx]; ++gx) {
                combined.throwIfAborted();
                assertValid();
                const grid = new Float32Array(rank);
                grid[dx] = gx;
                grid[dy] = gy;
                grid[dz] = gz;
                if (channelDim !== -1) grid[channelDim] = gc;
                // baseVoxelOffset is backend-only, never added to this key.
                const chunkOrigin = Array.from(
                  grid,
                  (g, d) => g * chunkSize[d],
                );
                const result = await source.fetchChunk(
                  grid,
                  (chunk) => {
                    // Requester callbacks are not exception-safe: return tagged errors.
                    try {
                      combined.throwIfAborted();
                      assertValid();
                      const volume = chunk as VolumeChunk;
                      if (volume.chunkDataSize.length !== rank)
                        throw new Error(
                          `Affinity chunk must have rank-${rank} data`,
                        );
                      for (let d = 0; d < rank; ++d) {
                        const n = volume.chunkDataSize[d];
                        const end =
                          d === channelDim
                            ? Math.max(...planes.map((a) => channelsXYZ[a] + 1))
                            : Math.min(
                                chunkOrigin[d] + chunkSize[d],
                                regionUpper[d],
                              );
                        if (
                          !Number.isSafeInteger(n) ||
                          n <= 0 ||
                          n > chunkSize[d] ||
                          chunkOrigin[d] + n < end
                        ) {
                          throw new Error(
                            "Affinity chunk does not cover the requested in-bounds voxels",
                          );
                        }
                      }
                      const lo = dims.map((d) =>
                        Math.max(regionLower[d], chunkOrigin[d]),
                      );
                      const hi = dims.map((d) =>
                        Math.min(
                          regionUpper[d],
                          chunkOrigin[d] + volume.chunkDataSize[d],
                        ),
                      );
                      const position = new Uint32Array(rank);
                      for (const a of planes) {
                        if (channelDim !== -1)
                          position[channelDim] =
                            channelsXYZ[a] - chunkOrigin[channelDim];
                        for (let z = lo[2]; z < hi[2]; ++z) {
                          position[dz] = z - chunkOrigin[dz];
                          for (let y = lo[1]; y < hi[1]; ++y) {
                            position[dy] = y - chunkOrigin[dy];
                            let offset =
                              a * count +
                              ((z - lowerXYZ[2]) * shapeXYZ[1] +
                                y -
                                lowerXYZ[1]) *
                                shapeXYZ[0] +
                              lo[0] -
                              lowerXYZ[0];
                            for (let x = lo[0]; x < hi[0]; ++x) {
                              position[dx] = x - chunkOrigin[dx];
                              const raw: unknown = volume.getValueAt(position);
                              if (
                                typeof raw !== "number" ||
                                !Number.isFinite(raw) ||
                                raw < 0 ||
                                raw > divisor
                              ) {
                                throw new Error(
                                  "Affinity values must be finite and in [0,1] after dtype-maximum normalization",
                                );
                              }
                              output[offset++] = raw / divisor;
                            }
                          }
                        }
                      }
                      return { ok: true as const };
                    } catch (error) {
                      return { ok: false as const, error };
                    }
                  },
                  { signal: combined, retryTransientErrors: true },
                );
                if (!result.ok) throw result.error;
                combined.throwIfAborted();
                assertValid();
              }
            }
          }
        }
        return output;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        lifetime.abort(new Error("Affinity input disposed"));
        for (const remove of removers) remove();
        source.dispose();
      },
    };
  } finally {
    releaseSources(sources);
  }
}
