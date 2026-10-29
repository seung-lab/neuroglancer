import { describe, expect, it, vi } from "vitest";
import {
  emptyValidCoordinateSpace,
  makeCoordinateSpace,
  makeIdentityTransform,
  WatchableCoordinateSpaceTransform,
} from "#src/coordinate_transform.js";
import {
  copyChunkToZYXPatch,
  getInferenceInputMetadata,
  getInferenceInputScales,
  prepareInferenceInput,
} from "#src/inference/input.js";
import type { ImageUserLayer } from "#src/layer/image/index.js";
import { getRenderLayerTransform } from "#src/render_coordinate_transform.js";
import type {
  VolumeChunk,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import { SliceViewVolumeRenderLayer } from "#src/sliceview/volume/renderlayer.js";
import { valueOrThrow } from "#src/util/error.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import { NullarySignal } from "#src/util/signal.js";

// Real layer construction requires a viewer/WebGL/worker; packing and source
// ownership are exercised with the same accessor/fetch callback contract.
vi.mock("#src/sliceview/volume/renderlayer.js", () => ({
  SliceViewVolumeRenderLayer: class {},
}));

function identity() {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

function watchable<T>(value: T) {
  return { value, changed: new NullarySignal() };
}

interface FixtureOptions {
  lower?: number[];
  upper?: number[];
  chunkSize?: number[];
  baseOffset?: number[];
  sourceTransform?: Float32Array;
  names?: string[];
  nativeScales?: number[];
  globalScales?: number[];
  absent?: string[];
  fillValue?: number | bigint;
}

function fixture(options: FixtureOptions = {}) {
  const {
    lower = [0, 0, 0],
    upper = [5, 4, 3],
    chunkSize = [3, 3, 2],
    baseOffset = [0, 0, 0],
    sourceTransform = identity(),
    names = ["x", "y", "z"],
    nativeScales = names.map((name) => ({ x: 2, y: 3, z: 5 })[name] ?? 1),
    globalScales = nativeScales,
    absent = [],
    fillValue = -7,
  } = options;
  const spec = {
    rank: 3,
    lowerVoxelBound: new Float32Array(lower),
    upperVoxelBound: new Float32Array(upper),
    chunkDataSize: new Uint32Array(chunkSize),
    baseVoxelOffset: new Float32Array(baseOffset),
    fillValue,
  };
  let inCallback = false;
  const cache = new Map<
    string,
    {
      chunkDataSize: Uint32Array;
      data: Float32Array | null;
      getValueAt(position: Uint32Array): number | bigint;
    }
  >();
  const source = {
    spec,
    refCount: 1,
    addRef: vi.fn(() => {
      ++source.refCount;
      return source;
    }),
    dispose: vi.fn(() => {
      --source.refCount;
    }),
    fetchChunk: vi.fn(
      async <T>(
        grid: Float32Array,
        copy: (chunk: VolumeChunk) => T,
        progress: Partial<ProgressOptions>,
      ): Promise<T> => {
        progress.signal?.throwIfAborted();
        const key = grid.join();
        let chunk = cache.get(key);
        if (chunk === undefined) {
          const origin = Array.from(grid, (g, d) => g * chunkSize[d]);
          const size = new Uint32Array(
            chunkSize.map((n, d) => Math.min(n, upper[d] - origin[d])),
          );
          const data = absent.includes(key)
            ? null
            : new Float32Array(size[0] * size[1] * size[2]);
          if (data !== null) {
            let i = 0;
            for (let c2 = 0; c2 < size[2]; ++c2) {
              for (let c1 = 0; c1 < size[1]; ++c1) {
                for (let c0 = 0; c0 < size[0]; ++c0) {
                  const p = [c0 + origin[0], c1 + origin[1], c2 + origin[2]];
                  const model = [0, 1, 2].map(
                    (m) =>
                      sourceTransform[12 + m] +
                      p.reduce(
                        (v, x, c) => v + x * sourceTransform[4 * c + m],
                        0,
                      ),
                  );
                  const xyz = ["x", "y", "z"].map(
                    (name) => model[names.indexOf(name)],
                  );
                  data[i++] = xyz[0] + 10 * xyz[1] + 100 * xyz[2];
                }
              }
            }
          }
          chunk = {
            chunkDataSize: size,
            data,
            getValueAt(p) {
              if (!inCallback)
                throw new Error("Source accessed outside fetchChunk callback");
              return this.data === null
                ? spec.fillValue
                : this.data[(p[2] * size[1] + p[1]) * size[0] + p[0]];
            },
          };
          cache.set(key, chunk);
        }
        inCallback = true;
        try {
          return copy(chunk as unknown as VolumeChunk);
        } finally {
          inCallback = false;
        }
      },
    ),
  };
  const nativeSpace = {
    ...makeCoordinateSpace({
      valid: true,
      names,
      scales: new Float64Array(nativeScales),
      units: ["m", "m", "m"],
    }),
    names: [...names],
    units: ["m", "m", "m"],
  };
  const globalSpace = watchable({
    ...nativeSpace,
    names: [...names],
    scales: new Float64Array(globalScales),
    units: [...nativeSpace.units],
    coordinateArrays: [...nativeSpace.coordinateArrays],
  });
  const localSpace = watchable({
    ...emptyValidCoordinateSpace,
    names: [] as string[],
  });
  const channelCoordinateSpace = watchable(emptyValidCoordinateSpace);
  const modelTransform = makeIdentityTransform(nativeSpace);
  const subsource = {
    enabled: true,
    activated: {} as object | undefined,
    subsourceToModelSubspaceTransform: identity(),
    modelSubspaceDimensionIndices: [0, 1, 2],
    subsourceEntry: { subsource: { volume: undefined as unknown } },
  };
  const currentTransform = new WatchableCoordinateSpaceTransform(
    modelTransform,
  );
  // CoordinateSpaceCombiner rebinds loaded transform output metadata to the
  // viewer's global grid. The setter converts translation, not linear terms.
  currentTransform.outputSpace.value = globalSpace.value;
  const transform = valueOrThrow(
    getRenderLayerTransform(
      globalSpace.value,
      localSpace.value,
      currentTransform.value,
      subsource,
      channelCoordinateSpace.value,
    ),
  );
  const selected = {
    chunkSource: source as unknown as VolumeChunkSource,
    chunkToMultiscaleTransform: sourceTransform,
    lowerClipBound: undefined as Float32Array | undefined,
    upperClipBound: undefined as Float32Array | undefined,
  };
  const multiscale = {
    rank: 3,
    getSources: vi.fn((_options: unknown) => [[selected]]),
  };
  subsource.subsourceEntry.subsource.volume = multiscale;
  const loadState = {
    error: undefined,
    dataSource: { modelTransform },
    transform: currentTransform,
    subsources: [subsource],
  };
  const renderLayer = Object.assign(
    Object.create(SliceViewVolumeRenderLayer.prototype) as object,
    {
      multiscaleSource: multiscale,
      transform: watchable(transform),
      wasDisposed: false,
    },
  );
  const layer = {
    type: "image",
    isReady: true,
    wasDisposed: false,
    renderLayers: [renderLayer],
    dataSources: [{ loadState }],
    channelCoordinateSpace,
    dataSourcesChanged: new NullarySignal(),
    layersChanged: new NullarySignal(),
    readyStateChanged: new NullarySignal(),
    managedLayer: {
      localCoordinateSpace: localSpace,
      manager: { root: { coordinateSpace: globalSpace } },
    },
  };
  const prepare = (scaleIndex = 0) =>
    prepareInferenceInput(layer as unknown as ImageUserLayer, scaleIndex);
  const scales = () =>
    getInferenceInputScales(layer as unknown as ImageUserLayer);
  const metadata = () =>
    getInferenceInputMetadata(layer as unknown as ImageUserLayer);
  const refreshTransform = () => {
    renderLayer.transform.value = valueOrThrow(
      getRenderLayerTransform(
        globalSpace.value,
        localSpace.value,
        loadState.transform.value,
        subsource,
        channelCoordinateSpace.value,
      ),
    );
  };
  return {
    layer,
    renderLayer,
    source,
    cache,
    selected,
    multiscale,
    transform,
    globalSpace,
    localSpace,
    nativeSpace,
    loadState,
    subsource,
    refreshTransform,
    metadata,
    scales,
    prepare,
  };
}

const signal = () => new AbortController().signal;

function codedPatch(origin: number[], shape: number[], scaleZYX = [1, 1, 1]) {
  const data = [];
  for (let z = origin[0]; z < origin[0] + shape[0]; ++z) {
    for (let y = origin[1]; y < origin[1] + shape[1]; ++y) {
      for (let x = origin[2]; x < origin[2] + shape[2]; ++x)
        data.push(
          x * scaleZYX[2] + 10 * y * scaleZYX[1] + 100 * z * scaleZYX[0],
        );
    }
  }
  return data;
}

// Each getSources call donates fresh refs; the fixtures retain their own refs.
function multiscaleFixture(coarseOptions: FixtureOptions = {}) {
  const fine = fixture({
    nativeScales: [16e-9, 16e-9, 45e-9],
    globalScales: [8e-9, 8e-9, 40e-9],
  });
  const t = identity();
  t[0] = t[5] = 2;
  const coarse = fixture({ sourceTransform: t, ...coarseOptions });
  fine.multiscale.getSources.mockImplementation(() => {
    fine.source.addRef();
    coarse.source.addRef();
    return [[fine.selected, coarse.selected]];
  });
  return { fine, coarse };
}

describe("selected multiscale inference input", () => {
  it("enumerates 16/16/45 and 32/32/45 nm scales and reads the actual coarse source", async () => {
    const { fine, coarse } = multiscaleFixture();
    expect(fine.scales()).toEqual([
      {
        scaleIndex: 0,
        spacingZYX: [45e-9, 16e-9, 16e-9],
        axisNamesZYX: ["z", "y", "x"],
        unitsZYX: ["m", "m", "m"],
      },
      {
        scaleIndex: 1,
        spacingZYX: [45e-9, 32e-9, 32e-9],
        axisNamesZYX: ["z", "y", "x"],
        unitsZYX: ["m", "m", "m"],
      },
    ]);
    expect(fine.source.refCount).toBe(1);
    expect(coarse.source.refCount).toBe(1);
    expect(fine.metadata().spacingZYX).toEqual([45e-9, 16e-9, 16e-9]);
    const input = fine.prepare(1);
    expect(input.spacingZYX).toEqual([45e-9, 32e-9, 32e-9]);
    expect(input.shapeZYX).toEqual([3, 4, 5]);
    expect(input.originZYX).toEqual([0, 0, 0]);
    expect(input.isValid()).toBe(true);
    expect(coarse.source.refCount).toBe(2);
    expect(
      Array.from(await input.readPatch([0, 1, 1], [3, 3, 4], signal())),
    ).toEqual(codedPatch([0, 1, 1], [3, 3, 4], [1, 2, 2]));
    expect(fine.source.fetchChunk).not.toHaveBeenCalled();
    expect(coarse.source.fetchChunk).toHaveBeenCalledTimes(8);
    input.dispose();
    input.dispose();
    expect(coarse.source.refCount).toBe(1);
    expect(fine.source.refCount).toBe(1);
  });

  it("normalizes translated origins in the selected grid, with permutation, clipping and backend offsets", async () => {
    // Chunk dimensions Z,X,Y; model dimensions Y,Z,X.
    const t = new Float32Array([
      0, 1, 0, 0, 0, 0, 2, 0, 2, 0, 0, 0, 60, 40, 20, 1,
    ]);
    const coarse = fixture({
      names: ["y", "z", "x"],
      sourceTransform: t,
      lower: [1, 2, 1],
      upper: [4, 7, 5],
      chunkSize: [2, 3, 3],
      baseOffset: [40, 10, 30],
    });
    // Source model axes and native metadata must agree, independent of storage.
    const model = fixture({
      names: ["y", "z", "x"],
      nativeScales: [16e-9, 45e-9, 16e-9],
      globalScales: [8e-9, 40e-9, 8e-9],
    });
    model.multiscale.getSources.mockImplementation(() => {
      model.source.addRef();
      coarse.source.addRef();
      return [[model.selected, coarse.selected]];
    });
    coarse.selected.lowerClipBound = new Float32Array([1, 3, 2]);
    coarse.selected.upperClipBound = new Float32Array([3, 6, 4]);
    expect(model.scales()[1].spacingZYX).toEqual([45e-9, 32e-9, 32e-9]);
    const input = model.prepare(1);
    expect(input.originZYX).toEqual([41, 32, 13]);
    expect(input.shapeZYX).toEqual([2, 2, 3]);
    expect(input.validitySnapshot.modelOriginZYX).toEqual([41, 32, 13]);
    expect(input.validitySnapshot.chunkDimensionsZYX).toEqual([0, 2, 1]);
    expect(input.validitySnapshot.baseVoxelOffset).toEqual([40, 10, 30]);
    expect(input.validitySnapshot.chunkToMultiscaleTransform).toEqual(
      Array.from(t),
    );
    expect(
      Array.from(await input.readPatch([41, 32, 13], [2, 2, 3], signal())),
    ).toEqual(codedPatch([41, 32, 13], [2, 2, 3], [1, 2, 2]));
    expect(
      coarse.source.fetchChunk.mock.calls.map(([grid]) => Array.from(grid)),
    ).toEqual([
      [0, 1, 0],
      [1, 1, 0],
      [0, 1, 1],
      [1, 1, 1],
    ]);
    await expect(
      input.readPatch([41, 32, 12], [1, 1, 1], signal()),
    ).rejects.toThrow(/outside/);
    expect(model.source.fetchChunk).not.toHaveBeenCalled();
    input.dispose();
    expect(coarse.source.refCount).toBe(1);
  });

  it("supports arbitrary positive per-axis scales with exactly integral normalized translation", async () => {
    const t = identity();
    t[0] = 0.5;
    t[5] = 2;
    t[10] = 3;
    t.set([0.5, -4, 9], 12);
    const f = fixture({ sourceTransform: t });
    const input = f.prepare();
    expect(input.spacingZYX).toEqual([15, 6, 1]);
    expect(input.originZYX).toEqual([3, -2, 1]);
    expect(
      Array.from(await input.readPatch([3, -2, 1], [3, 4, 5], signal())),
    ).toEqual(codedPatch([3, -2, 1], [3, 4, 5], [3, 2, 0.5]));
    input.dispose();
    expect(f.source.refCount).toBe(0);
  });

  it.each([-1, 2, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid scaleIndex %s and releases all donated refs",
    (scaleIndex) => {
      const { fine, coarse } = multiscaleFixture();
      expect(() => fine.prepare(scaleIndex)).toThrow(
        /scaleIndex.*out of range/,
      );
      expect(fine.source.refCount).toBe(1);
      expect(coarse.source.refCount).toBe(1);
      expect(fine.source.fetchChunk).not.toHaveBeenCalled();
      expect(coarse.source.fetchChunk).not.toHaveBeenCalled();
    },
  );

  it("exposes scale metadata despite invalid user/render transforms, without retaining refs", () => {
    const { fine, coarse } = multiscaleFixture();
    fine.loadState.transform.value.transform[0] = 2;
    fine.renderLayer.transform.value = {
      error: "invalid render transform",
    } as never;
    const scales = fine.scales();
    expect(scales[1].spacingZYX).toEqual([45e-9, 32e-9, 32e-9]);
    scales[1].spacingZYX[0] = 999;
    scales[1].unitsZYX[0] = "s";
    expect(fine.scales()[1]).toEqual({
      scaleIndex: 1,
      spacingZYX: [45e-9, 32e-9, 32e-9],
      unitsZYX: ["m", "m", "m"],
      axisNamesZYX: ["z", "y", "x"],
    });
    expect(() => fine.prepare(1)).toThrow();
    expect(fine.source.refCount).toBe(1);
    expect(coarse.source.refCount).toBe(1);
  });

  it.each([
    "shear",
    "fractionalAlignment",
    "reflection",
    "singular",
    "nonfinite",
  ])("rejects coarse source %s and balances refs in both APIs", (kind) => {
    const { fine, coarse } = multiscaleFixture();
    const t = coarse.selected.chunkToMultiscaleTransform;
    if (kind === "shear") t[1] = 0.25;
    if (kind === "fractionalAlignment") t[12] = 1;
    if (kind === "reflection") t[0] = -2;
    if (kind === "singular") t[0] = 0;
    if (kind === "nonfinite") t[0] = Infinity;
    expect(() => fine.prepare(1)).toThrow(/Unsupported inference input/);
    expect(fine.scales).toThrow(/Unsupported inference input/);
    expect(fine.source.refCount).toBe(1);
    expect(coarse.source.refCount).toBe(1);
  });

  it.each(["empty", "ambiguous"])(
    "rejects %s scale orientations and releases every ref",
    (kind) => {
      const f = fixture();
      f.multiscale.getSources.mockReturnValue(
        kind === "empty" ? [[]] : [[f.selected], [f.selected]],
      );
      f.source.refCount = kind === "empty" ? 0 : 2;
      expect(f.scales).toThrow(/one unambiguous native chunk orientation/);
      expect(f.source.refCount).toBe(0);
    },
  );

  it("retains coarse validity on bounds-only coordinate updates but snapshots source scaling", () => {
    const { fine, coarse } = multiscaleFixture();
    const input = fine.prepare(1);
    fine.globalSpace.value = {
      ...fine.globalSpace.value,
      scales: new Float64Array(fine.globalSpace.value.scales),
      ids: [10, 11, 12],
    };
    fine.refreshTransform();
    fine.globalSpace.changed.dispatch();
    fine.renderLayer.transform.changed.dispatch();
    expect(input.isValid()).toBe(true);
    expect(input.signal?.aborted).toBe(false);
    coarse.selected.chunkToMultiscaleTransform[0] = 4;
    expect(input.isValid()).toBe(false);
    expect(input.validitySnapshot.chunkToMultiscaleTransform[0]).toBe(2);
    input.dispose();
  });
});

describe("prepareInferenceInput", () => {
  it("admits native 16/16/45 nm input in an 8/8/40 nm global space without resampling", async () => {
    const f = fixture({
      nativeScales: [16e-9, 16e-9, 45e-9],
      globalScales: [8e-9, 8e-9, 40e-9],
    });
    expect(
      [0, 5, 10].map((i) => f.transform.modelToRenderLayerTransform[i]),
    ).toEqual([2, 2, 1.125]);
    expect(Array.from(f.loadState.transform.value.transform)).toEqual(
      Array.from(identity()),
    );
    expect(Array.from(f.loadState.transform.value.inputSpace.scales)).toEqual([
      16e-9, 16e-9, 45e-9,
    ]);
    expect(Array.from(f.loadState.transform.value.outputSpace.scales)).toEqual([
      8e-9, 8e-9, 40e-9,
    ]);
    const input = f.prepare();
    expect(input.spacingZYX).toEqual([45e-9, 16e-9, 16e-9]);
    expect(
      Array.from(await input.readPatch([0, 1, 1], [3, 3, 4], signal())),
    ).toEqual(codedPatch([0, 1, 1], [3, 3, 4]));
    expect(f.multiscale.getSources).toHaveBeenCalledWith(
      expect.objectContaining({
        multiscaleToViewTransform: new Float32Array([
          1, 0, 0, 0, 1, 0, 0, 0, 1,
        ]),
      }),
    );
    input.dispose();
  });

  it.each(["translation", "shear", "reflection", "scale"])(
    "rejects a real user %s transform despite native/global normalization, but exposes native metadata",
    (kind) => {
      const f = fixture({
        nativeScales: [16e-9, 16e-9, 45e-9],
        globalScales: [8e-9, 8e-9, 40e-9],
      });
      const matrix = f.loadState.transform.value.transform;
      if (kind === "translation") matrix[12] = 1;
      if (kind === "shear") matrix[4] = 0.25;
      if (kind === "reflection") matrix[0] = -1;
      if (kind === "scale") matrix[0] = 2;
      f.refreshTransform();
      expect(f.prepare).toThrow(/exactly identity/);
      expect(f.metadata()).toEqual({
        spacingZYX: [45e-9, 16e-9, 16e-9],
        unitsZYX: ["m", "m", "m"],
        axisNamesZYX: ["z", "y", "x"],
      });
      // This API is independent even of a failed render-transform calculation.
      f.renderLayer.transform.value = {
        error: "invalid render transform",
      } as never;
      expect(f.metadata().spacingZYX).toEqual([45e-9, 16e-9, 16e-9]);
      expect(f.multiscale.getSources).not.toHaveBeenCalled();
    },
  );

  it.each([0.5, 2])(
    "rejects user scale %s cancelled by global coordinate normalization",
    (scale) => {
      const f = fixture({
        nativeScales: [16e-9, 16e-9, 45e-9],
        globalScales: [16e-9 * scale, 16e-9, 45e-9],
      });
      f.loadState.transform.value.transform[0] = scale;
      f.refreshTransform();
      expect(f.renderLayer.transform.value.modelToRenderLayerTransform).toEqual(
        identity(),
      );
      expect(f.prepare).toThrow(/exactly identity/);
    },
  );

  it("rejects internal subsource transforms and cancellations, not native chunk storage transforms", () => {
    const f = fixture();
    f.subsource.subsourceToModelSubspaceTransform[12] = 1;
    f.refreshTransform();
    expect(f.prepare).toThrow(/exactly identity/);
    f.loadState.transform.value.transform[12] = -1;
    f.refreshTransform();
    expect(f.renderLayer.transform.value.modelToRenderLayerTransform).toEqual(
      identity(),
    );
    expect(f.prepare).toThrow(/exactly identity/);
    f.loadState.transform.value.transform[12] = 0;
    f.subsource.subsourceToModelSubspaceTransform[12] = 0;
    f.subsource.modelSubspaceDimensionIndices = [1, 0, 2];
    f.refreshTransform();
    expect(f.prepare).toThrow(/native model dimensions/);
  });

  it("rejects overridden raw input/output physical metadata", () => {
    const f = fixture();
    f.loadState.transform.value = {
      ...f.loadState.transform.value,
      inputSpace: { ...f.nativeSpace, scales: new Float64Array([4, 3, 5]) },
    };
    f.refreshTransform();
    expect(f.prepare).toThrow(/exactly identity/);
    expect(f.metadata().spacingZYX).toEqual([5, 3, 2]);
    f.loadState.transform.value = {
      ...f.loadState.transform.value,
      inputSpace: f.nativeSpace,
      outputSpace: { ...f.nativeSpace, scales: new Float64Array([4, 3, 5]) },
    };
    f.refreshTransform();
    expect(f.prepare).toThrow(/exactly identity/);
  });

  it.each([0, -1, Infinity, NaN])(
    "rejects invalid global spacing %s without losing known native metadata",
    (spacing) => {
      const f = fixture();
      f.globalSpace.value.scales[0] = spacing;
      f.refreshTransform();
      expect(f.prepare).toThrow(/physical axis metadata/);
      expect(f.metadata().spacingZYX).toEqual([5, 3, 2]);
    },
  );

  it.each(["missing", "disabled", "inactive", "wrongVolume", "ambiguous"])(
    "requires matching active source metadata (%s), without guessing from global space",
    (kind) => {
      const f = fixture();
      if (kind === "missing") f.layer.dataSources = [];
      if (kind === "disabled") f.subsource.enabled = false;
      if (kind === "inactive") f.subsource.activated = undefined;
      if (kind === "wrongVolume")
        f.subsource.subsourceEntry.subsource.volume = {};
      if (kind === "ambiguous")
        f.layer.dataSources.push(f.layer.dataSources[0]);
      expect(f.prepare).toThrow(/active loaded source/);
      expect(f.metadata).toThrow(/active loaded source/);
      expect(f.multiscale.getSources).not.toHaveBeenCalled();
    },
  );

  it("packs coordinate-coded native chunks across all axes and short edges, without touching cache", async () => {
    const f = fixture();
    const input = f.prepare();
    expect(input.shapeZYX).toEqual([3, 4, 5]);
    expect(input.originZYX).toEqual([0, 0, 0]);
    expect(input.spacingZYX).toEqual([5, 3, 2]);
    expect(input.axisNamesZYX).toEqual(["z", "y", "x"]);
    expect(input.unitsZYX).toEqual(["m", "m", "m"]);
    expect(f.multiscale.getSources).toHaveBeenCalledWith({
      discreteValues: true,
      displayRank: 3,
      modelChannelDimensionIndices: [],
      multiscaleToViewTransform: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    });
    const packed = await input.readPatch([0, 1, 1], [3, 3, 4], signal());
    expect(Array.from(packed)).toEqual(codedPatch([0, 1, 1], [3, 3, 4]));
    expect(f.source.fetchChunk).toHaveBeenCalledTimes(8);
    const cached = Array.from(f.cache.values(), (chunk) =>
      Array.from(chunk.data!),
    );
    packed.fill(999);
    const second = await input.readPatch([0, 1, 1], [3, 3, 4], signal());
    expect(Array.from(second)).toEqual(codedPatch([0, 1, 1], [3, 3, 4]));
    expect(
      Array.from(f.cache.values(), (chunk) => Array.from(chunk.data!)),
    ).toEqual(cached);
    expect(
      Array.from(f.cache.values()).every(
        (chunk) => chunk.data!.buffer.byteLength > 0,
      ),
    ).toBe(true);
    input.dispose();
    input.dispose();
    expect(f.source.refCount).toBe(0);
    expect(input.isValid()).toBe(false);
  });

  it("uses absolute model-grid origins and never adds baseVoxelOffset to chunk keys", async () => {
    const t = identity();
    t.set([20, 30, 40], 12);
    const f = fixture({
      lower: [2, 1, 1],
      upper: [7, 5, 4],
      baseOffset: [20, 30, 40],
      sourceTransform: t,
    });
    const input = f.prepare();
    expect(input.originZYX).toEqual([41, 31, 22]);
    expect(input.shapeZYX).toEqual([3, 4, 5]);
    expect(input.validitySnapshot.baseVoxelOffset).toEqual([20, 30, 40]);
    const patch = await input.readPatch([41, 31, 22], [3, 4, 5], signal());
    expect(Array.from(patch)).toEqual(codedPatch([41, 31, 22], [3, 4, 5]));
    expect(Array.from(f.source.fetchChunk.mock.calls[0][0])).toEqual([0, 0, 0]);
    input.dispose();
  });

  it("permutes native dimension-0-fastest storage into X-fastest NCDHW", async () => {
    // Chunk dimensions are Z,X,Y; model dimensions are X,Y,Z.
    const t = new Float32Array([
      0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 10, 20, 30, 1,
    ]);
    const f = fixture({
      upper: [3, 5, 4],
      chunkSize: [2, 3, 3],
      sourceTransform: t,
    });
    const input = f.prepare();
    expect(input.shapeZYX).toEqual([3, 4, 5]);
    expect(input.originZYX).toEqual([30, 20, 10]);
    expect(input.validitySnapshot.chunkDimensionsZYX).toEqual([0, 2, 1]);
    expect(
      Array.from(await input.readPatch([30, 21, 11], [3, 3, 4], signal())),
    ).toEqual(codedPatch([30, 21, 11], [3, 3, 4]));
    input.dispose();
  });

  it("infers exact x/y/z names regardless of model axis order", async () => {
    const f = fixture({ names: ["z", "y", "x"] });
    const input = f.prepare();
    expect(input.shapeZYX).toEqual([5, 4, 3]);
    expect(input.spacingZYX).toEqual([5, 3, 2]);
    expect(
      Array.from(await input.readPatch([1, 1, 0], [4, 3, 3], signal())),
    ).toEqual(codedPatch([1, 1, 0], [4, 3, 3]));
    input.dispose();
  });

  it("uses scalar accessors for legitimate absent chunks and fill values", async () => {
    const f = fixture({ upper: [5, 4, 3], absent: ["0,0,0"], fillValue: 123n });
    const input = f.prepare();
    const patch = await input.readPatch([0, 0, 0], [3, 4, 5], signal());
    const expected = codedPatch([0, 0, 0], [3, 4, 5]);
    for (let z = 0; z < 2; ++z) {
      for (let y = 0; y < 3; ++y) {
        for (let x = 0; x < 3; ++x) expected[(z * 4 + y) * 5 + x] = 123;
      }
    }
    expect(Array.from(patch)).toEqual(expected);
    expect(f.cache.get("0,0,0")!.data).toBeNull();
    input.dispose();
  });

  it("supports negative native bounds and integer clipping", async () => {
    const f = fixture({ lower: [-4, -2, -1], upper: [3, 4, 3] });
    f.selected.lowerClipBound = new Float32Array([-3, -1, -1]);
    f.selected.upperClipBound = new Float32Array([2, 3, 2]);
    const input = f.prepare();
    expect(input.originZYX).toEqual([-1, -1, -3]);
    expect(input.shapeZYX).toEqual([3, 4, 5]);
    expect(
      Array.from(await input.readPatch([-1, -1, -3], [3, 4, 5], signal())),
    ).toEqual(codedPatch([-1, -1, -3], [3, 4, 5]));
    input.dispose();
  });

  it.each([
    [
      [-1, 0, 0],
      [1, 1, 1],
    ],
    [
      [0, 0, 0],
      [4, 1, 1],
    ],
    [
      [3, 0, 0],
      [1, 1, 1],
    ],
    [
      [0, 0, 4],
      [1, 1, 2],
    ],
  ])(
    "rejects the full out-of-bounds patch %j %j before fetching",
    async (origin, shape) => {
      const f = fixture();
      const input = f.prepare();
      await expect(input.readPatch(origin, shape, signal())).rejects.toThrow(
        "outside supported native volume bounds",
      );
      expect(f.source.fetchChunk).not.toHaveBeenCalled();
      input.dispose();
    },
  );

  it.each([
    [
      [0, 0],
      [1, 1, 1],
    ],
    [
      [0, 0, 0],
      [1, 0, 1],
    ],
    [
      [0.5, 0, 0],
      [1, 1, 1],
    ],
    [
      [0, 0, 0],
      [1, 1, NaN],
    ],
  ])("rejects invalid patch coordinates %j %j", async (origin, shape) => {
    const f = fixture();
    const input = f.prepare();
    await expect(input.readPatch(origin, shape, signal())).rejects.toThrow(
      "safe integers",
    );
    expect(f.source.fetchChunk).not.toHaveBeenCalled();
    input.dispose();
  });

  it("balances owned getSources refs for unused scales and on selection errors", () => {
    const f = fixture();
    const unused = { ...f.source, refCount: 1, dispose: vi.fn() };
    f.multiscale.getSources.mockReturnValue([
      [
        f.selected,
        { ...f.selected, chunkSource: unused as unknown as VolumeChunkSource },
      ],
    ]);
    const input = f.prepare();
    expect(unused.dispose).toHaveBeenCalledOnce();
    expect(f.source.refCount).toBe(1);
    input.dispose();
    expect(f.source.refCount).toBe(0);
    const ambiguous = fixture();
    ambiguous.multiscale.getSources.mockReturnValue([
      [ambiguous.selected],
      [ambiguous.selected],
    ]);
    // Same source appears twice: getSources donates one ref per entry.
    ambiguous.source.refCount = 2;
    expect(ambiguous.prepare).toThrow(
      "one unambiguous native chunk orientation",
    );
    expect(ambiguous.source.refCount).toBe(0);
  });

  it.each([
    "data",
    "transform",
    "globalSpace",
    "localSpace",
    "removal",
    "disposed",
    "nativeTransformInPlace",
    "userTransformInPlace",
    "chunkSizeInPlace",
    "additionalVolume",
    "nativeSpacingInPlace",
    "loadedSourceReplacement",
    "subsourceDisabled",
    "subsourceDeactivated",
    "subsourceTransformInPlace",
    "rawUserTransformInPlace",
  ])("invalidates on %s changes", async (change) => {
    const f = fixture();
    const input = f.prepare();
    expect(input.isValid()).toBe(true);
    if (change === "data") f.layer.dataSourcesChanged.dispatch();
    if (change === "transform") {
      f.renderLayer.transform.value.modelToRenderLayerTransform[12] = 1;
      f.renderLayer.transform.changed.dispatch();
    }
    if (change === "globalSpace") {
      f.globalSpace.value.scales[0] *= 2;
      f.globalSpace.changed.dispatch();
    }
    if (change === "localSpace") {
      f.localSpace.value.valid = false;
      f.localSpace.changed.dispatch();
    }
    if (change === "removal") f.layer.renderLayers.length = 0;
    if (change === "disposed") f.layer.wasDisposed = true;
    if (change === "nativeTransformInPlace")
      f.selected.chunkToMultiscaleTransform[12] = 1;
    if (change === "userTransformInPlace")
      f.transform.modelToRenderLayerTransform[12] = 1;
    if (change === "chunkSizeInPlace") f.source.spec.chunkDataSize[0] = 1;
    if (change === "additionalVolume") f.layer.renderLayers.push(f.renderLayer);
    if (change === "nativeSpacingInPlace") {
      f.nativeSpace.scales[0] *= 2;
      f.refreshTransform();
    }
    if (change === "loadedSourceReplacement")
      f.layer.dataSources[0].loadState = { ...f.loadState };
    if (change === "subsourceDisabled") f.subsource.enabled = false;
    if (change === "subsourceDeactivated") f.subsource.activated = undefined;
    if (change === "subsourceTransformInPlace")
      f.subsource.subsourceToModelSubspaceTransform[12] = 1;
    if (change === "rawUserTransformInPlace")
      f.loadState.transform.value.transform[12] = 1;
    expect(input.isValid()).toBe(false);
    await expect(
      input.readPatch([0, 0, 0], [1, 1, 1], signal()),
    ).rejects.toThrow("disposed or stale");
    input.dispose();
    expect(f.source.refCount).toBe(0);
  });

  it.each(["coordinate-first", "transform-first"])(
    "preserves validity on bounding/ref updates with unchanged metadata (%s), but rejects a scale change",
    async (order) => {
      const f = fixture();
      const input = f.prepare();
      for (let update = 0; update < 2; ++update) {
        const previous = f.globalSpace.value;
        const next = {
          ...previous,
          names: [...previous.names],
          scales: new Float64Array(previous.scales),
          units: [...previous.units],
          coordinateArrays: [...previous.coordinateArrays],
          // Publishing a result changes aggregate bounds and may replace ids.
          ids: [10, 11, 12],
          timestamps: [update, update, update],
          bounds: {
            ...previous.bounds,
            lowerBounds: new Float64Array([-update, 0, 0]),
            upperBounds: new Float64Array([20 + update, 30, 40]),
          },
          boundingBoxes: [...previous.boundingBoxes],
        };
        f.globalSpace.value = next;
        f.localSpace.value = { ...f.localSpace.value, names: [] };
        f.renderLayer.transform.value = {
          ...f.transform,
          modelDimensionNames: [...f.transform.modelDimensionNames],
          layerDimensionNames: [...f.transform.layerDimensionNames],
          modelToRenderLayerTransform: identity(),
          localToRenderLayerDimensions: [
            ...f.transform.localToRenderLayerDimensions,
          ],
          globalToRenderLayerDimensions: [
            ...f.transform.globalToRenderLayerDimensions,
          ],
          channelToRenderLayerDimensions: [
            ...f.transform.channelToRenderLayerDimensions,
          ],
        };
        if (order === "coordinate-first") f.globalSpace.changed.dispatch();
        f.renderLayer.transform.changed.dispatch();
        if (order === "transform-first") f.globalSpace.changed.dispatch();
        f.localSpace.changed.dispatch();
        expect(input.isValid()).toBe(true);
        expect(() => input.assertValid()).not.toThrow();
      }
      expect(
        Array.from(await input.readPatch([0, 0, 0], [1, 1, 2], signal())),
      ).toEqual([0, 1]);
      f.globalSpace.value.scales[0] *= 2;
      f.globalSpace.changed.dispatch();
      expect(input.isValid()).toBe(false);
      await expect(
        input.readPatch([0, 0, 0], [1, 1, 1], signal()),
      ).rejects.toThrow("stale");
      input.dispose();
    },
  );

  it.each(["name", "unit"])(
    "invalidates meaningful coordinate %s changes",
    (field) => {
      const f = fixture();
      const input = f.prepare();
      if (field === "name") f.globalSpace.value.names[0] = "u";
      if (field === "unit") f.globalSpace.value.units[0] = "s";
      f.globalSpace.changed.dispatch();
      expect(input.isValid()).toBe(false);
      input.dispose();
    },
  );

  it("honors pre-abort and aborts outstanding fetches when disposed", async () => {
    const f = fixture();
    const input = f.prepare();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      input.readPatch([0, 0, 0], [1, 1, 1], controller.signal),
    ).rejects.toThrow("cancelled");
    expect(f.source.fetchChunk).not.toHaveBeenCalled();
    f.source.fetchChunk.mockImplementationOnce(
      async (_grid, _copy, progress) => {
        await new Promise<void>((_resolve, reject) => {
          progress.signal!.addEventListener(
            "abort",
            () => reject(progress.signal!.reason),
            { once: true },
          );
        });
        throw new Error("unreachable");
      },
    );
    const pending = input.readPatch([0, 0, 0], [1, 1, 1], signal());
    input.dispose();
    await expect(pending).rejects.toThrow("disposed");
    expect(f.source.refCount).toBe(0);
  });

  it("rejects short chunks that leave in-bounds voxels unavailable, rather than padding them", async () => {
    const f = fixture();
    const input = f.prepare();
    f.source.fetchChunk.mockImplementationOnce(async (_grid, copy) =>
      copy({
        chunkDataSize: new Uint32Array([1, 1, 1]),
        getValueAt() {
          return 0;
        },
      } as unknown as VolumeChunk),
    );
    await expect(
      input.readPatch([0, 0, 0], [1, 1, 2], signal()),
    ).rejects.toThrow("does not cover");
    input.dispose();
  });

  it("invalidates and aborts an outstanding read when the source transform changes", async () => {
    const f = fixture();
    const input = f.prepare();
    f.source.fetchChunk.mockImplementationOnce(
      async (_grid, _copy, progress) => {
        await new Promise<void>((_resolve, reject) => {
          progress.signal!.addEventListener(
            "abort",
            () => reject(progress.signal!.reason),
            { once: true },
          );
        });
        throw new Error("unreachable");
      },
    );
    const pending = input.readPatch([0, 0, 0], [1, 1, 1], signal());
    f.renderLayer.transform.value.modelToRenderLayerTransform[12] = 1;
    f.renderLayer.transform.changed.dispatch();
    expect(input.isValid()).toBe(false);
    await expect(pending).rejects.toThrow("stale");
    input.dispose();
  });

  it("snapshots caller coordinate arrays across asynchronous fetches", async () => {
    const f = fixture();
    const input = f.prepare();
    const fetch = f.source.fetchChunk.getMockImplementation()!;
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    f.source.fetchChunk.mockImplementationOnce(async (grid, copy, progress) => {
      await gate;
      return fetch(grid, copy, progress);
    });
    const origin = [0, 1, 1];
    const shape = [3, 3, 4];
    const pending = input.readPatch(origin, shape, signal());
    origin.fill(999);
    shape.fill(999);
    resume();
    expect(Array.from(await pending)).toEqual(codedPatch([0, 1, 1], [3, 3, 4]));
    input.dispose();
  });

  it("reports callback errors as a rejection rather than throwing from the chunk requester", async () => {
    const f = fixture();
    const input = f.prepare();
    f.source.fetchChunk.mockImplementationOnce(async (_grid, copy) => {
      // A requester is not permitted to throw even when its accessor fails.
      let result: ReturnType<typeof copy>;
      expect(() => {
        result = copy({
          chunkDataSize: new Uint32Array([3, 3, 2]),
          getValueAt() {
            throw new Error("decode failed");
          },
        } as unknown as VolumeChunk);
      }).not.toThrow();
      return result!;
    });
    await expect(
      input.readPatch([0, 0, 0], [1, 1, 1], signal()),
    ).rejects.toThrow("decode failed");
    input.dispose();
  });
});

describe("unsupported inference sources", () => {
  it.each([
    ["X", "y", "z"],
    ["x", "x", "z"],
    ["a", "b", "c"],
  ])("rejects ambiguous names %j", (...names) => {
    expect(fixture({ names }).prepare).toThrow(
      "unambiguously named exactly x, y, z",
    );
  });

  it.each(["scale", "translation", "shear", "reflection"])(
    "rejects user %s transforms",
    (kind) => {
      const f = fixture();
      if (kind === "scale") f.transform.modelToRenderLayerTransform[0] = 2;
      if (kind === "translation")
        f.transform.modelToRenderLayerTransform[12] = 1;
      if (kind === "shear") f.transform.modelToRenderLayerTransform[1] = 1;
      if (kind === "reflection")
        f.transform.modelToRenderLayerTransform[0] = -1;
      expect(f.prepare).toThrow("exactly identity");
      expect(f.multiscale.getSources).not.toHaveBeenCalled();
    },
  );

  it.each(["nonpositiveScale", "fractionalOrigin", "shear", "reflection"])(
    "rejects unsupported source %s",
    (kind) => {
      const t = identity();
      if (kind === "nonpositiveScale") t[0] = 0;
      if (kind === "fractionalOrigin") t[12] = 0.5;
      if (kind === "shear") t[1] = 1;
      if (kind === "reflection") t[0] = -1;
      const f = fixture({ sourceTransform: t });
      expect(f.prepare).toThrow("Unsupported inference input:");
      expect(f.source.refCount).toBe(0);
    },
  );

  it("rejects no volume, multiple volumes, non-rank3, channels, unknown spacing, and fractional bounds", () => {
    const none = fixture();
    none.layer.renderLayers = [];
    expect(none.prepare).toThrow("exactly one");
    const multi = fixture();
    multi.layer.renderLayers.push(multi.renderLayer);
    expect(multi.prepare).toThrow("exactly one");
    const rank4 = fixture();
    rank4.multiscale.rank = 4;
    expect(rank4.prepare).toThrow("rank-3");
    const channels = fixture();
    channels.transform.channelToRenderLayerDimensions = [0];
    expect(channels.prepare).toThrow("channel dimensions");
    const spacing = fixture();
    spacing.nativeSpace.scales[1] = 0;
    expect(spacing.prepare).toThrow("physical axis metadata");
    const bounds = fixture();
    bounds.selected.lowerClipBound = new Float32Array([0.5, 0, 0]);
    expect(bounds.prepare).toThrow("finite integer bounds");
    expect(bounds.source.refCount).toBe(0);
  });
});

describe("copyChunkToZYXPatch", () => {
  it("supports format-independent scalar accessors, float32 conversion, and actual edge strides", () => {
    const data = new Float64Array([1 / 3, 2 / 3, 3 / 7, 4 / 7]);
    const before = data.slice();
    const chunk = {
      chunkDataSize: new Uint32Array([2, 1, 2]),
      getValueAt(p: Uint32Array) {
        return data[p[0] + 2 * p[2]];
      },
    };
    const output = new Float32Array(4);
    copyChunkToZYXPatch(
      chunk,
      {
        chunkOrigin: [3, 3, 2],
        chunkDimensionsZYX: [2, 1, 0],
        patchLowerChunk: [3, 3, 2],
        patchShapeZYX: [2, 1, 2],
        lowerBoundChunk: [0, 0, 0],
        upperBoundChunk: [5, 4, 4],
      },
      output,
    );
    expect(output).toEqual(Float32Array.from(data));
    expect(data).toEqual(before);
    expect(output.buffer).not.toBe(data.buffer);
  });
});
