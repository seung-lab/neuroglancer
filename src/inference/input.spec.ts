import { describe, expect, it, vi } from "vitest";
import {
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
import { UncompressedVolumeChunk } from "#src/sliceview/uncompressed_chunk_format.js";
import type {
  VolumeChunk,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import { SliceViewVolumeRenderLayer } from "#src/sliceview/volume/renderlayer.js";
import type { TypedArray } from "#src/util/array.js";
import { DataType } from "#src/util/data_type.js";
import { valueOrThrow } from "#src/util/error.js";
import * as matrix from "#src/util/matrix.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import { NullarySignal } from "#src/util/signal.js";

// Real layer construction requires a viewer/WebGL/worker; packing and source
// ownership are exercised with the same accessor/fetch callback contract.
vi.mock("#src/sliceview/volume/renderlayer.js", () => ({
  SliceViewVolumeRenderLayer: class {},
}));
vi.mock("#src/sliceview/uncompressed_chunk_format.js", () => ({
  UncompressedVolumeChunk: class UncompressedVolumeChunk {
    declare chunkDataSize: Uint32Array;
    declare data: TypedArray | null;
    declare source: { spec: { fillValue: number | bigint } };
    getValueAt(dataPosition: Uint32Array): number | bigint {
      const { data } = this;
      if (data === null) {
        return this.source.spec.fillValue;
      }
      const { chunkDataSize } = this;
      let index = 0;
      let stride = 1;
      const rank = dataPosition.length;
      for (let i = 0; i < rank; ++i) {
        index += stride * dataPosition[i];
        stride *= chunkDataSize[i];
      }
      return data[index];
    }
  },
}));

function identity(rank = 3) {
  return matrix.createIdentity(Float32Array, rank + 1);
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
  outputNames?: string[];
  uint16?: boolean;
  uncompressed?: boolean;
  nativeScales?: number[];
  globalScales?: number[];
  absent?: string[];
  fillValue?: number | bigint;
}

function fixture(options: FixtureOptions = {}) {
  const {
    names = ["x", "y", "z"],
    outputNames = names,
    lower = names.map(() => 0),
    upper = [5, 4, 3],
    chunkSize = [3, 3, 2],
    baseOffset = names.map(() => 0),
    sourceTransform = identity(names.length),
    uint16 = false,
    uncompressed = false,
    nativeScales = names.map((name) => ({ x: 2, y: 3, z: 5 })[name] ?? 1),
    globalScales = nativeScales,
    absent = [],
    fillValue = -7,
  } = options;
  const rank = names.length;
  const spec = {
    rank,
    dataType: uint16 ? DataType.UINT16 : DataType.FLOAT32,
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
      data: Float32Array | Uint16Array | null;
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
          const ArrayType = uint16 ? Uint16Array : Float32Array;
          const data = absent.includes(key)
            ? null
            : new ArrayType(size.reduce((n, x) => n * x, 1));
          if (data !== null) {
            for (let i = 0; i < data.length; ++i) {
              let index = i;
              const p = origin.map((x, d) => {
                const offset = index % size[d];
                index = Math.floor(index / size[d]);
                return x + offset;
              });
              const model = names.map((_, m) =>
                p.reduce(
                  (v, x, c) => v + x * sourceTransform[(rank + 1) * c + m],
                  sourceTransform[(rank + 1) * rank + m],
                ),
              );
              data[i] = names.reduce(
                (v, name, m) =>
                  v + model[m] * ({ x: 1, y: 10, z: 100 }[name] ?? 4096),
                0,
              );
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
                : this.data[
                    p.reduceRight((index, x, d) => index * size[d] + x, 0)
                  ];
            },
          };
          if (uncompressed)
            Object.assign(chunk, {
              getValueAt: UncompressedVolumeChunk.prototype.getValueAt,
              source,
            });
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
  const units = names.map((name) =>
    ["x", "y", "z"].includes(name) ? "m" : "",
  );
  const nativeSpace = makeCoordinateSpace({
    names,
    units,
    scales: new Float64Array(nativeScales),
  });
  const outputSpace = makeCoordinateSpace({
    names: outputNames,
    units,
    scales: new Float64Array(globalScales),
  });
  function viewerSpace(filter: (name: string) => boolean) {
    const dims = outputNames
      .map((_, d) => d)
      .filter((d) => filter(outputNames[d]));
    const names = dims.map((d) => outputNames[d]);
    const units = dims.map((d) => outputSpace.units[d]);
    return watchable({
      ...makeCoordinateSpace({
        names,
        units,
        scales: Float64Array.from(dims, (d) => globalScales[d]),
      }),
      names,
      units,
    });
  }
  const globalSpace = viewerSpace(
    (name) => !name.endsWith("'") && !name.endsWith("^"),
  );
  const localSpace = viewerSpace((name) => name.endsWith("'"));
  const channelCoordinateSpace = viewerSpace((name) => name.endsWith("^"));
  // Shader-channel render transforms require a finite zero-based channel space.
  channelCoordinateSpace.value.bounds.lowerBounds.fill(0);
  channelCoordinateSpace.value.bounds.upperBounds.fill(8);
  const modelTransform = makeIdentityTransform(nativeSpace);
  const subsource = {
    enabled: true,
    activated: {} as object | undefined,
    subsourceToModelSubspaceTransform: identity(rank),
    modelSubspaceDimensionIndices: names.map((_, i) => i),
    subsourceEntry: { subsource: { volume: undefined as unknown } },
  };
  const currentTransform = new WatchableCoordinateSpaceTransform(
    modelTransform,
  );
  // CoordinateSpaceCombiner rebinds loaded transform output metadata to the
  // viewer's global grid. The setter converts translation, not linear terms.
  currentTransform.outputSpace.value = outputSpace;
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
    rank,
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
  const prepare = (scaleIndex = 0, inputChannel = 0) =>
    prepareInferenceInput(
      layer as unknown as ImageUserLayer,
      scaleIndex,
      inputChannel,
    );
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

function scalarFixture(dataType: DataType, values: TypedArray) {
  const f = fixture({
    upper: [values.length, 1, 1],
    chunkSize: [values.length, 1, 1],
  });
  f.source.spec.dataType = dataType;
  const chunk = {
    chunkDataSize: new Uint32Array([values.length, 1, 1]),
    getValueAt: vi.fn((position: Uint32Array) => values[position[0]]),
  };
  f.source.fetchChunk.mockImplementation(async (_grid, copy, progress) => {
    progress.signal?.throwIfAborted();
    return copy(chunk as unknown as VolumeChunk);
  });
  return { ...f, chunk };
}

const normalizationCases = [
  {
    dataType: DataType.UINT8,
    maximum: 255,
    values: new Uint8Array([0, 1, 64, 127, 128, 254, 255]),
    fillValue: 64,
  },
  {
    dataType: DataType.INT8,
    maximum: 127,
    values: new Int8Array([-128, -127, -64, -1, 0, 1, 63, 64, 126, 127]),
    fillValue: -64,
  },
  {
    dataType: DataType.UINT16,
    maximum: 65535,
    values: new Uint16Array([0, 1, 16384, 32767, 32768, 65534, 65535]),
    fillValue: 32768,
  },
  {
    dataType: DataType.INT16,
    maximum: 32767,
    values: new Int16Array([
      -32768, -32767, -16384, -1, 0, 1, 16383, 16384, 32766, 32767,
    ]),
    fillValue: -16384,
  },
  {
    dataType: DataType.UINT32,
    maximum: 4294967295,
    values: new Uint32Array([
      0, 1, 1073741824, 2147483647, 2147483648, 4294967294, 4294967295,
    ]),
    fillValue: 2147483648,
  },
  {
    dataType: DataType.INT32,
    maximum: 2147483647,
    values: new Int32Array([
      -2147483648, -2147483647, -1073741824, -1, 0, 1, 1073741823, 1073741824,
      2147483646, 2147483647,
    ]),
    fillValue: -1073741824,
  },
  {
    dataType: DataType.UINT64,
    maximum: 0xffffffffffffffffn,
    values: new BigUint64Array([
      0n,
      1n,
      0x4000000000000000n,
      0x7fffffffffffffffn,
      0x8000000000000000n,
      0xfffffffffffffffen,
      0xffffffffffffffffn,
    ]),
    fillValue: 0x8000000000000000n,
  },
  {
    dataType: DataType.FLOAT32,
    maximum: 1,
    values: new Float32Array([-3.5, -0, 0, 0.25, 0.5, 1.5, 3, 1]),
    fillValue: -3.5,
  },
].map((test) => ({ ...test, name: DataType[test.dataType] }));

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

describe("inference input intensity normalization", () => {
  it.each(normalizationCases)(
    "packs $name endpoints, zero and midpoints as normalized float32 without mutating source data",
    async ({ dataType, maximum, values }) => {
      const before = values.slice();
      const f = scalarFixture(dataType, values);
      const input = f.prepare();
      const shape = [1, 1, values.length];
      const expected = Float32Array.from(
        [...values],
        (value) => Number(value) / Number(maximum),
      );
      const output = await input.readPatch([0, 0, 0], shape, signal());
      expect(output).toBeInstanceOf(Float32Array);
      expect(output).toEqual(expected);
      expect(output.at(-1)).toBe(1);
      expect(output.buffer).not.toBe(values.buffer);
      expect(f.chunk.getValueAt).toHaveBeenCalledTimes(values.length);
      expect(f.chunk.getValueAt).toHaveReturnedWith(values[values.length - 1]);
      expect(values).toEqual(before);
      expect(values.buffer.byteLength).toBe(before.buffer.byteLength);
      output.fill(99);
      expect(await input.readPatch([0, 0, 0], shape, signal())).toEqual(
        expected,
      );
      expect(await input.readPatch([0, 0, 2], [1, 1, 2], signal())).toEqual(
        expected.slice(2, 4),
      );
      expect(values).toEqual(before);
      input.dispose();
      expect(f.source.refCount).toBe(0);
    },
  );

  it.each(normalizationCases)(
    "uses the $name dtype maximum, not the observed data maximum",
    async ({ dataType, maximum, values }) => {
      const partialValues = values.subarray(2, 4);
      const f = scalarFixture(dataType, partialValues);
      const input = f.prepare();
      const output = await input.readPatch([0, 0, 0], [1, 1, 2], signal());
      expect(output).toEqual(
        Float32Array.from(
          [...partialValues],
          (value) => Number(value) / Number(maximum),
        ),
      );
      expect(output).not.toContain(1);
      input.dispose();
    },
  );

  it.each(normalizationCases)(
    "scales legitimate sparse $name fill values exactly like accessor values",
    async ({ dataType, maximum, fillValue }) => {
      const f = fixture({
        upper: [5, 1, 1],
        chunkSize: [3, 1, 1],
        absent: ["0,0,0", "1,0,0"],
        fillValue,
      });
      f.source.spec.dataType = dataType;
      const input = f.prepare();
      const output = await input.readPatch([0, 0, 0], [1, 1, 5], signal());
      expect(output).toEqual(
        new Float32Array(5).fill(Number(fillValue) / Number(maximum)),
      );
      expect(f.source.fetchChunk).toHaveBeenCalledTimes(2);
      expect([...f.cache.values()].every((chunk) => chunk.data === null)).toBe(
        true,
      );
      expect(f.source.spec.fillValue).toBe(fillValue);
      input.dispose();
    },
  );

  it("normalizes integer input only once and passes normalized Float32 input through unchanged", async () => {
    const integer = scalarFixture(
      DataType.UINT8,
      new Uint8Array([0, 64, 128, 255]),
    ).prepare();
    const normalized = await integer.readPatch([0, 0, 0], [1, 1, 4], signal());
    expect(normalized).toEqual(new Float32Array([0, 64 / 255, 128 / 255, 1]));
    const float = scalarFixture(DataType.FLOAT32, normalized).prepare();
    const output = await float.readPatch([0, 0, 0], [1, 1, 4], signal());
    expect(output).toEqual(normalized);
    expect(output.buffer).not.toBe(normalized.buffer);
    float.dispose();
    integer.dispose();
  });
});

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
    for (const [, , progress] of coarse.source.fetchChunk.mock.calls) {
      expect(progress).toMatchObject({ retryTransientErrors: true });
    }
    input.dispose();
    input.dispose();
    expect(coarse.source.refCount).toBe(1);
    expect(fine.source.refCount).toBe(1);
  });

  it("uses and snapshots the selected scale's dtype for intensity normalization", async () => {
    const { fine, coarse } = multiscaleFixture({
      absent: ["0,0,0"],
      fillValue: 32768,
    });
    coarse.source.spec.dataType = DataType.UINT16;
    const input = fine.prepare(1);
    expect(await input.readPatch([0, 0, 0], [1, 1, 2], signal())).toEqual(
      new Float32Array([32768 / 65535, 32768 / 65535]),
    );
    fine.source.spec.dataType = DataType.UINT8;
    expect(input.isValid()).toBe(true);
    coarse.source.spec.dataType = DataType.UINT8;
    expect(input.isValid()).toBe(false);
    await expect(
      input.readPatch([0, 0, 0], [1, 1, 2], signal()),
    ).rejects.toThrow("disposed or stale");
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
    "dataTypeInPlace",
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
    if (change === "dataTypeInPlace") f.source.spec.dataType = DataType.UINT8;
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

  it("overlaps at most eight chunk reads and packs out-of-order completions exactly", async () => {
    const f = fixture({ upper: [6, 4, 2], chunkSize: [1, 1, 1] });
    const input = f.prepare();
    const fetch = f.source.fetchChunk.getMockImplementation()!;
    const release: (() => void)[] = [];
    let active = 0;
    let maximum = 0;
    let started = 0;
    f.source.fetchChunk.mockImplementation(async (grid, copy, progress) => {
      maximum = Math.max(maximum, ++active);
      const index = started++;
      try {
        if (index < 8) {
          await new Promise<void>((resolve) => {
            release[index] = resolve;
          });
        }
        return await fetch(grid, copy, progress);
      } finally {
        --active;
      }
    });
    const pending = input.readPatch([0, 0, 0], [2, 4, 6], signal());
    expect(started).toBe(8);
    release[7]();
    // One free slot keeps progressing while seven earlier requests are stalled.
    await vi.waitFor(() => expect(started).toBe(48));
    expect(active).toBe(7);
    for (let i = 6; i >= 0; --i) release[i]();
    expect(Array.from(await pending)).toEqual(codedPatch([0, 0, 0], [2, 4, 6]));
    expect(maximum).toBe(8);
    expect(active).toBe(0);
    input.dispose();
    expect(f.source.refCount).toBe(0);
  });

  it("aborts every concurrent requester when the input is disposed", async () => {
    const f = fixture({ upper: [6, 4, 2], chunkSize: [1, 1, 1] });
    const input = f.prepare();
    let aborted = 0;
    f.source.fetchChunk.mockImplementation(
      async (_grid, _copy, progress) =>
        new Promise<never>((_resolve, reject) => {
          progress.signal!.addEventListener(
            "abort",
            () => {
              ++aborted;
              reject(progress.signal!.reason);
            },
            { once: true },
          );
        }),
    );
    const pending = input.readPatch([0, 0, 0], [2, 4, 6], signal());
    expect(f.source.fetchChunk).toHaveBeenCalledTimes(8);
    input.dispose();
    await expect(pending).rejects.toThrow("disposed");
    expect(aborted).toBe(8);
    expect(f.source.fetchChunk).toHaveBeenCalledTimes(8);
    expect(f.source.refCount).toBe(0);
  });

  it("cancels sibling requests on fetch failure without invalidating the input", async () => {
    const f = fixture({ upper: [6, 4, 2], chunkSize: [1, 1, 1] });
    const input = f.prepare();
    const fetch = f.source.fetchChunk.getMockImplementation()!;
    let fail!: (reason: Error) => void;
    let aborted = 0;
    f.source.fetchChunk.mockImplementationOnce(
      async () =>
        new Promise<never>((_resolve, reject) => {
          fail = reject;
        }),
    );
    f.source.fetchChunk.mockImplementation(
      async (_grid, _copy, progress) =>
        new Promise<never>((_resolve, reject) => {
          progress.signal!.addEventListener(
            "abort",
            () => {
              ++aborted;
              reject(progress.signal!.reason);
            },
            { once: true },
          );
        }),
    );
    const pending = input.readPatch([0, 0, 0], [2, 4, 6], signal());
    fail(new Error("network failed"));
    await expect(pending).rejects.toThrow("network failed");
    expect(aborted).toBe(7);
    expect(f.source.fetchChunk).toHaveBeenCalledTimes(8);
    expect(input.isValid()).toBe(true);
    f.source.fetchChunk.mockImplementation(fetch);
    expect(
      Array.from(await input.readPatch([0, 0, 0], [2, 4, 6], signal())),
    ).toEqual(codedPatch([0, 0, 0], [2, 4, 6]));
    input.dispose();
  });

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

  it("rejects an in-flight read if the selected dtype changes before packing", async () => {
    const f = scalarFixture(DataType.UINT8, new Uint8Array([128, 255]));
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
    const pending = input.readPatch([0, 0, 0], [1, 1, 2], signal());
    f.source.spec.dataType = DataType.UINT16;
    expect(input.isValid()).toBe(false);
    resume();
    await expect(pending).rejects.toThrow("disposed or stale");
    expect(f.chunk.getValueAt).not.toHaveBeenCalled();
    input.dispose();
    expect(f.source.refCount).toBe(0);
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

describe("rank-4 single-channel inference input", () => {
  // Zarr-like CZYX native model, independently permuted/interleaved storage
  // C,X,Z,Y (C fastest). Scale/translation apply on the selected spatial grid.
  function channelFixture(
    native = "c'",
    output = native,
    uncompressed = false,
  ) {
    const transform = new Float32Array([
      1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 3, 0, 0, 0, 0, 0, 2, 0, 0, 1, 6, 4, 2, 1,
    ]);
    const f = fixture({
      names: [native, "z", "y", "x"],
      outputNames: [output, "z", "y", "x"],
      sourceTransform: transform,
      upper: [8, 5, 3, 4],
      chunkSize: [3, 3, 2, 3],
      baseOffset: [32, 0, 0, 0],
      uint16: true,
      uncompressed,
    });
    // Extent starts inside a channel chunk, and the final chunk is short.
    f.selected.lowerClipBound = new Float32Array([2, 0, 0, 0]);
    f.multiscale.getSources.mockImplementation(() => {
      f.source.addRef();
      return [[f.selected]];
    });
    return f;
  }

  it.each([
    { native: "c'", output: "c'", uncompressed: true }, // OME-Zarr local channel
    { native: "c", output: "c'", uncompressed: false }, // Output renamed by layer
    { native: "c^", output: "c^", uncompressed: false }, // Shader channel
  ])(
    "reads and prefetches only selected channel ($native -> $output, raw=$uncompressed)",
    async ({ native, output, uncompressed }) => {
      const f = channelFixture(native, output, uncompressed);
      expect(f.scales()).toEqual([
        {
          scaleIndex: 0,
          channelCount: 6,
          spacingZYX: [15, 6, 4],
          unitsZYX: ["m", "m", "m"],
          axisNamesZYX: ["z", "y", "x"],
        },
      ]);
      expect(f.multiscale.getSources).toHaveBeenCalledWith(
        expect.objectContaining({
          modelChannelDimensionIndices: [],
          multiscaleToViewTransform: new Float32Array([
            0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1,
          ]),
        }),
      );
      const selected = f.prepare(0, 5);
      expect(selected.originZYX).toEqual([2, 2, 1]);
      expect(selected.gridOffsetZYX).toEqual([0, 0, 0]);
      expect(selected.shapeZYX).toEqual([3, 4, 5]);
      expect(selected.validitySnapshot.inputChannel).toBe(5);
      // Clamp the speculative box to the same spatial volume, never requesting
      // neighbor channel chunks. Use the actual short-edge strides for packing.
      const grids = () =>
        f.source.fetchChunk.mock.calls.map(([grid]) => grid.join()).sort();
      const expectedGrids = [0, 1]
        .flatMap((y) =>
          [0, 1].flatMap((z) => [0, 1].map((x) => `2,${x},${z},${y}`)),
        )
        .sort();
      selected.prefetchVolume!([-3, -3, -3], [16, 16, 16], signal());
      expect(grids()).toEqual(expectedGrids);
      f.source.fetchChunk.mockClear();
      const expected = (modelChannel: number) =>
        Float32Array.from(
          codedPatch(selected.originZYX, selected.shapeZYX, [3, 2, 2]),
          (v) => (4096 * modelChannel + v) / 65535,
        );
      expect(
        await selected.readPatch(
          selected.originZYX,
          selected.shapeZYX,
          signal(),
        ),
      ).toEqual(expected(8));
      expect(grids()).toEqual(expectedGrids);
      // Channel zero is the first clipped channel, not the viewer position or
      // backend offset. A separate preparation cannot reuse another channel's tiles.
      const first = f.prepare();
      expect(first.validitySnapshot.inputChannel).toBe(0);
      expect(
        await first.readPatch(first.originZYX, first.shapeZYX, signal()),
      ).toEqual(expected(3));
      f.selected.lowerClipBound![0] = 1;
      expect(selected.isValid()).toBe(false);
      first.dispose();
      selected.dispose();
      expect(f.source.refCount).toBe(1);
    },
  );

  it.each([
    {
      translation: [-0.5, -0.5, -0.5, -0.5],
      integer: [0, 0, 0],
      offset: [-0.5, -0.25, -0.25],
    },
    {
      translation: [-0.5, -1.25, 3, -1],
      integer: [-1, 1, 0],
      offset: [-0.25, 0.5, -0.5],
    },
  ])(
    "preserves OME voxel-center placement ($translation) without shifting storage reads",
    async ({ translation, integer, offset }) => {
      // Real source at scale 1: XYZC storage -> C'ZYX model, X/Y downsampled
      // by two, with translation in model voxels, not selected-scale voxels.
      const perm = new Float32Array([
        0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0,
        1,
      ]);
      const f = fixture({
        names: ["c'", "z", "y", "x"],
        sourceTransform: perm,
        upper: [5, 4, 3, 3],
        chunkSize: [3, 3, 2, 2],
        uint16: true,
        uncompressed: true,
      });
      // Keep voxel values independent of their physical translation.
      f.selected.chunkToMultiscaleTransform = perm.slice();
      f.selected.chunkToMultiscaleTransform.set(translation, 20);
      const input = f.prepare(0, 1);
      expect(input.originZYX).toEqual(integer);
      expect(input.gridOffsetZYX).toEqual(offset);
      expect(input.shapeZYX).toEqual([3, 4, 5]);
      expect(input.spacingZYX).toEqual([5, 6, 4]);
      expect(await input.readPatch(integer, input.shapeZYX, signal())).toEqual(
        Float32Array.from(
          codedPatch([0, 0, 0], input.shapeZYX, [1, 2, 2]),
          (v) => (v + 4096) / 65535,
        ),
      );
      expect(
        f.source.fetchChunk.mock.calls.every(
          ([grid]) => grid.length === 4 && grid[3] === 0,
        ),
      ).toBe(true);
      input.dispose();
    },
  );

  it("resolves the extent and index against the requested scale, not the first", () => {
    const f = channelFixture();
    f.multiscale.getSources.mockImplementation(() => {
      f.source.addRef();
      f.source.addRef();
      return [
        [
          f.selected,
          { ...f.selected, upperClipBound: new Float32Array([4, 5, 3, 4]) },
        ],
      ];
    });
    expect(f.scales().map((s) => s.channelCount)).toEqual([6, 2]);
    expect(() => f.prepare(1, 2)).toThrow(RangeError);
    const input = f.prepare(1, 1);
    input.dispose();
    expect(f.source.refCount).toBe(1);
  });

  it.each([-1, 0.5, NaN, Infinity, 6])(
    "rejects invalid channel %s before any fetch",
    (channel) => {
      const f = channelFixture();
      expect(() => f.prepare(0, channel)).toThrow(RangeError);
      expect(f.source.fetchChunk).not.toHaveBeenCalled();
      expect(f.source.refCount).toBe(1);
    },
  );

  it("allows only channel zero on rank 3 without adding channel metadata", () => {
    const f = fixture();
    expect(f.scales()[0]).not.toHaveProperty("channelCount");
    expect(() => f.prepare(0, 1)).toThrow(RangeError);
    const g = fixture();
    const input = g.prepare();
    expect(input.validitySnapshot).not.toHaveProperty("inputChannel");
    expect(input).not.toHaveProperty("gridOffsetZYX");
    input.dispose();
  });

  it.each(["t", "t'", "w"])(
    "does not guess an unknown fourth dimension %s is a channel",
    (name) => {
      const f = channelFixture(name);
      expect(f.scales).toThrow(/channel axis/);
      expect(f.prepare).toThrow(/channel axis/);
    },
  );

  it.each(["scale", "nonfinite origin", "fractional extent", "empty extent"])(
    "rejects a channel grid with %s",
    (kind) => {
      const f = channelFixture();
      if (kind === "scale") f.selected.chunkToMultiscaleTransform[0] = 2;
      if (kind === "nonfinite origin")
        f.selected.chunkToMultiscaleTransform[20] = Infinity;
      if (kind === "fractional extent") f.selected.lowerClipBound![0] = 0.5;
      if (kind === "empty extent") f.selected.lowerClipBound![0] = 8;
      expect(f.scales).toThrow(/channel axis/);
      expect(f.prepare).toThrow(/channel axis/);
      expect(f.source.refCount).toBe(1);
    },
  );

  it("rejects an edge chunk that does not contain the selected channel", async () => {
    const f = channelFixture();
    const input = f.prepare(0, 5);
    f.source.fetchChunk.mockImplementationOnce(async (_grid, copy) =>
      copy({
        chunkDataSize: new Uint32Array([1, 3, 2, 3]),
      } as unknown as VolumeChunk),
    );
    await expect(
      input.readPatch(input.originZYX, [1, 1, 1], signal()),
    ).rejects.toThrow("does not cover");
    input.dispose();
  });
});

describe("unsupported inference sources", () => {
  it.each([
    undefined,
    null,
    -1,
    8,
    0.5,
    NaN,
    Infinity,
    "uint8",
    "0",
    "toString",
  ])(
    "rejects missing or unknown dtype %s without retaining source refs",
    (dataType) => {
      const f = fixture();
      f.source.spec.dataType = dataType as unknown as DataType;
      expect(f.prepare).toThrow(
        `Unsupported inference input: data type ${String(dataType)} cannot be normalized`,
      );
      expect(f.source.fetchChunk).not.toHaveBeenCalled();
      expect(f.source.refCount).toBe(0);
    },
  );

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

  it("rejects no volume, multiple volumes, mismatched rank, spatial channel axes, unknown spacing, and fractional bounds", () => {
    const none = fixture();
    none.layer.renderLayers = [];
    expect(none.prepare).toThrow("exactly one");
    const multi = fixture();
    multi.layer.renderLayers.push(multi.renderLayer);
    expect(multi.prepare).toThrow("exactly one");
    const rank4 = fixture();
    rank4.multiscale.rank = 4;
    expect(rank4.prepare).toThrow("model and volume ranks must match");
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
        dataType: DataType.FLOAT32,
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

  const axisPermutations: [number, number, number][] = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];

  it.each(normalizationCases)(
    "matches generic getValueAt bit-for-bit on UncompressedVolumeChunk across all 6 axis permutations for $name",
    ({ dataType, values, fillValue }) => {
      const chunkDataSize = new Uint32Array([4, 3, 2]);
      const total = 24;
      const Ctor = values.constructor as {
        new (length: number): TypedArray;
      };
      const raw = new Ctor(total);
      for (let i = 0; i < total; ++i) {
        raw[i] = values[i % values.length] as never;
      }

      for (const dims of axisPermutations) {
        const fastChunk = Object.assign(
          Object.create(
            UncompressedVolumeChunk.prototype,
          ) as UncompressedVolumeChunk,
          {
            chunkDataSize,
            data: raw,
            source: { spec: { fillValue } } as never,
          },
        );
        const genericChunk = {
          chunkDataSize,
          getValueAt: (p: Uint32Array) =>
            UncompressedVolumeChunk.prototype.getValueAt.call(fastChunk, p),
        };
        const options = {
          dataType,
          chunkOrigin: [2, 4, 6],
          chunkDimensionsZYX: dims,
          patchLowerChunk: [1, 3, 5],
          patchShapeZYX: [5, 6, 7],
          lowerBoundChunk: [2, 4, 6],
          upperBoundChunk: [5, 7, 8],
        };
        const fastOut = new Float32Array(5 * 6 * 7).fill(-123.456);
        const genericOut = new Float32Array(5 * 6 * 7).fill(-123.456);
        copyChunkToZYXPatch(fastChunk, options, fastOut);
        copyChunkToZYXPatch(genericChunk, options, genericOut);
        expect(Array.from(new Uint32Array(fastOut.buffer))).toEqual(
          Array.from(new Uint32Array(genericOut.buffer)),
        );
      }
    },
  );

  it("falls back to getValueAt for subclass prototype overrides, own overrides, null fill chunks, and mismatched raw data", () => {
    const chunkDataSize = new Uint32Array([2, 2, 2]);
    const raw = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    const options = {
      dataType: DataType.UINT8,
      chunkOrigin: [0, 0, 0],
      chunkDimensionsZYX: [2, 1, 0],
      patchLowerChunk: [0, 0, 0],
      patchShapeZYX: [2, 2, 2],
      lowerBoundChunk: [0, 0, 0],
      upperBoundChunk: [2, 2, 2],
    };

    class SubclassOverrideChunk extends UncompressedVolumeChunk {
      calls = 0;
      override getValueAt(dataPosition: Uint32Array): number | bigint {
        ++this.calls;
        return Number(super.getValueAt(dataPosition)) + 5;
      }
    }
    const subChunk = Object.assign(
      Object.create(SubclassOverrideChunk.prototype) as SubclassOverrideChunk,
      {
        calls: 0,
        chunkDataSize,
        data: raw,
        source: { spec: { fillValue: 0 } } as never,
      },
    );
    const subOut = new Float32Array(8);
    copyChunkToZYXPatch(subChunk, options, subOut);
    expect(subChunk.calls).toBe(8);
    expect(subOut).toEqual(Float32Array.from(raw, (v) => (v + 5) / 255));

    let ownCalls = 0;
    const ownOverrideChunk = Object.assign(
      Object.create(
        UncompressedVolumeChunk.prototype,
      ) as UncompressedVolumeChunk,
      {
        chunkDataSize,
        data: raw,
        source: { spec: { fillValue: 0 } } as never,
        getValueAt(p: Uint32Array) {
          ++ownCalls;
          return (
            Number(UncompressedVolumeChunk.prototype.getValueAt.call(this, p)) +
            3
          );
        },
      },
    );
    const ownOut = new Float32Array(8);
    copyChunkToZYXPatch(ownOverrideChunk, options, ownOut);
    expect(ownCalls).toBe(8);
    expect(ownOut).toEqual(Float32Array.from(raw, (v) => (v + 3) / 255));

    const fillChunk = Object.assign(
      Object.create(
        UncompressedVolumeChunk.prototype,
      ) as UncompressedVolumeChunk,
      {
        chunkDataSize,
        data: null,
        source: { spec: { fillValue: 51 } } as never,
      },
    );
    const fillOut = new Float32Array(8);
    copyChunkToZYXPatch(fillChunk, options, fillOut);
    expect(fillOut).toEqual(new Float32Array(8).fill(51 / 255));

    const shortChunk = Object.assign(
      Object.create(
        UncompressedVolumeChunk.prototype,
      ) as UncompressedVolumeChunk,
      {
        chunkDataSize,
        data: raw.subarray(0, 7),
        source: { spec: { fillValue: 0 } } as never,
      },
    );
    const shortOut = new Float32Array(8);
    expect(() => copyChunkToZYXPatch(shortChunk, options, shortOut)).toThrow(
      "Inference chunk accessor did not return a scalar number",
    );
  });

  it("prefetchVolume deduplicates in-flight/queued grid coordinates, bounds concurrency, and retries after completion", async () => {
    const f = fixture({ upper: [20, 20, 20], chunkSize: [2, 2, 2] });
    const prepared = prepareInferenceInput(f.layer as never);
    let inFlight = 0;
    let maxInFlight = 0;
    const seenGrids: string[] = [];
    const resolvers: (() => void)[] = [];
    f.source.fetchChunk = vi.fn(
      (grid, _transform, progressOptions: Partial<ProgressOptions>) =>
        new Promise<void>((resolve, reject) => {
          ++inFlight;
          maxInFlight = Math.max(maxInFlight, inFlight);
          seenGrids.push(Array.from(grid).join(","));
          progressOptions.signal?.addEventListener(
            "abort",
            () => {
              --inFlight;
              reject(progressOptions.signal?.reason);
            },
            { once: true },
          );
          resolvers.push(() => {
            --inFlight;
            resolve();
          });
        }) as never,
    );
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    // Overlapping calls while in flight are deduplicated and globally capped at 8 active.
    prepared.prefetchVolume?.([0, 0, 0], [4, 4, 4], firstAbort.signal);
    prepared.prefetchVolume?.([0, 0, 0], [4, 4, 4], secondAbort.signal);
    expect(maxInFlight).toBeLessThanOrEqual(8);
    const countWhileInFlight = seenGrids.length;
    expect(countWhileInFlight).toBe(8);
    // Aborting only one caller keeps shared chunks alive until all callers abort or finish.
    firstAbort.abort();
    expect(inFlight).toBe(8);
    while (resolvers.length > 0) resolvers.shift()!();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(inFlight).toBe(0);
    // After completion, revisiting can re-request (relying on source cache rather than permanent set).
    prepared.prefetchVolume?.([0, 0, 0], [2, 2, 2], secondAbort.signal);
    expect(seenGrids.length).toBeGreaterThan(countWhileInFlight);
    while (resolvers.length > 0) resolvers.shift()!();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    prepared.dispose();
  });
});

describe("bounded speculative source queue", () => {
  it("caps all calls at eight active plus 128 queued and aborts outstanding fetches on disposal", async () => {
    const f = fixture({ upper: [20, 20, 20], chunkSize: [2, 2, 2] });
    const prepared = prepareInferenceInput(f.layer as never);
    const pending = new Set<() => void>();
    let started = 0,
      active = 0,
      peak = 0,
      aborted = 0;
    f.source.fetchChunk = vi.fn(
      (_grid, _transform, options: Partial<ProgressOptions>) =>
        new Promise<void>((resolve, reject) => {
          ++started;
          ++active;
          peak = Math.max(peak, active);
          let done = false;
          const finish = (error?: unknown) => {
            if (done) return;
            done = true;
            --active;
            pending.delete(succeed);
            options.signal?.removeEventListener("abort", onAbort);
            if (error === undefined) resolve();
            else reject(error);
          };
          const succeed = () => finish();
          const onAbort = () => {
            ++aborted;
            finish(options.signal?.reason);
          };
          pending.add(succeed);
          options.signal?.addEventListener("abort", onAbort, { once: true });
        }) as never,
    );
    try {
      const caller = new AbortController();
      // Each box intersects 1000 chunks, but repeated calls cannot grow the queue.
      for (let i = 0; i < 5; ++i)
        prepared.prefetchVolume?.([0, 0, 0], [20, 20, 20], caller.signal);
      expect(started).toBe(8);
      for (let i = 0; i < 30 && pending.size; ++i) {
        for (const finish of Array.from(pending)) finish();
        await Promise.resolve();
        await Promise.resolve();
      }
      expect(active).toBe(0);
      expect(started).toBe(136);
      expect(peak).toBe(8);
      prepared.prefetchVolume?.([0, 0, 0], [20, 20, 20], caller.signal);
      expect(active).toBe(8);
      prepared.dispose();
      await Promise.resolve();
      expect(active).toBe(0);
      expect(aborted).toBe(8);
    } finally {
      prepared.dispose();
    }
  });
});

describe("shared prefetch caller cleanup", () => {
  it("releases each aborted caller immediately while a long-lived caller keeps the fetch", () => {
    const f = fixture({ upper: [20, 20, 20], chunkSize: [2, 2, 2] });
    const prepared = prepareInferenceInput(f.layer as never);
    f.source.fetchChunk = vi.fn(
      (_grid, _transform, options: Partial<ProgressOptions>) =>
        new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        }) as never,
    );
    try {
      const keep = new AbortController();
      prepared.prefetchVolume?.([0, 0, 0], [2, 2, 2], keep.signal);
      for (let i = 0; i < 100; ++i) {
        const churn = new AbortController();
        const remove = vi.spyOn(churn.signal, "removeEventListener");
        prepared.prefetchVolume?.([0, 0, 0], [2, 2, 2], churn.signal);
        churn.abort();
        expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      }
      expect(f.source.fetchChunk).toHaveBeenCalledTimes(1);
    } finally {
      prepared.dispose();
    }
  });
});

describe("speculative prefetch lifecycle", () => {
  const flush = async () => {
    for (let i = 0; i < 8; ++i) await Promise.resolve();
  };
  function gated() {
    const f = fixture({ upper: [1000, 1000, 1000], chunkSize: [1, 1, 1] });
    const original = f.source.fetchChunk.getMockImplementation()!;
    let active = 0;
    let peak = 0;
    const calls: {
      key: string;
      settled: boolean;
      signal: AbortSignal;
      finish: (error?: unknown) => void;
    }[] = [];
    f.source.fetchChunk.mockImplementation(
      (grid, _copy, options) =>
        new Promise((resolve, reject) => {
          ++active;
          peak = Math.max(peak, active);
          const request = {
            key: grid.join(),
            settled: false,
            signal: options.signal!,
            finish(error?: unknown) {
              if (request.settled) return;
              request.settled = true;
              --active;
              options.signal!.removeEventListener("abort", abort);
              if (error === undefined) resolve(undefined);
              else reject(error);
            },
          };
          const abort = () => request.finish(options.signal!.reason);
          options.signal!.addEventListener("abort", abort, { once: true });
          calls.push(request);
          if (options.signal!.aborted) abort();
        }) as never,
    );
    const input = f.prepare();
    return {
      f,
      original,
      input,
      calls,
      active: () => active,
      peak: () => peak,
      async drain() {
        for (let round = 0; round < 200; ++round) {
          await flush();
          const current = calls.filter((call) => !call.settled);
          if (!current.length) return;
          for (const call of current) call.finish();
        }
        throw new Error("prefetch failed to drain within bounded work");
      },
    };
  }

  it("enforces eight active and 128 queued total across disjoint huge calls", async () => {
    const g = gated();
    const a = new AbortController();
    const b = new AbortController();
    g.input.prefetchVolume!([0, 0, 0], [1000, 1000, 1000], a.signal);
    expect(g.calls).toHaveLength(8);
    for (let i = 0; i < 16; ++i) {
      g.input.prefetchVolume!([500 + i, 500, 500], [20, 20, 20], b.signal);
    }
    expect(g.calls).toHaveLength(8);
    await g.drain();
    expect(g.calls).toHaveLength(136);
    expect(new Set(g.calls.map((call) => call.key)).size).toBe(136);
    expect(g.peak()).toBe(8);
    expect(g.active()).toBe(0);
    g.input.dispose();
  });

  it("last-caller cancellation drops queued work and a same-turn revisit survives old finally cleanup", async () => {
    const g = gated();
    const a = new AbortController();
    const b = new AbortController();
    const c = new AbortController();
    g.input.prefetchVolume!([0, 0, 0], [1, 1, 20], a.signal);
    g.input.prefetchVolume!([0, 0, 0], [1, 1, 20], b.signal);
    a.abort();
    expect(g.active()).toBe(8);
    b.abort();
    expect(g.active()).toBe(0);
    g.input.prefetchVolume!([0, 0, 0], [1, 1, 20], c.signal);
    await flush();
    expect(g.active()).toBe(8);
    await g.drain();
    expect(g.calls).toHaveLength(28);
    expect(g.peak()).toBe(8);
    expect(g.calls.filter((call) => call.key === "0,0,0")).toHaveLength(2);
    expect(g.calls.filter((call) => call.key === "19,0,0")).toHaveLength(1);
    g.input.dispose();
  });

  it("fetch failures do not strand the queue or poison later speculative and real reads", async () => {
    const g = gated();
    const a = new AbortController();
    g.input.prefetchVolume!([0, 0, 0], [1, 1, 16], a.signal);
    g.calls[0].finish(new Error("speculative network failure"));
    await g.drain();
    expect(g.calls).toHaveLength(16);
    g.input.prefetchVolume!([0, 0, 0], [1, 1, 1], a.signal);
    expect(g.calls).toHaveLength(17);
    await g.drain();
    g.f.source.fetchChunk.mockImplementation(g.original);
    expect(await g.input.readPatch([0, 0, 0], [1, 1, 3], a.signal)).toEqual(
      new Float32Array([0, 1, 2]),
    );
    g.input.dispose();
  });

  it("dispose aborts all eight active requests and drops 128 queued requests", async () => {
    const g = gated();
    g.input.prefetchVolume!([0, 0, 0], [1000, 1000, 1000], signal());
    expect(g.active()).toBe(8);
    g.input.dispose();
    await flush();
    expect(g.active()).toBe(0);
    expect(g.calls).toHaveLength(8);
    expect(g.calls.every((call) => call.signal.aborted)).toBe(true);
    g.input.prefetchVolume!([0, 0, 0], [1, 1, 20], signal());
    await flush();
    expect(g.calls).toHaveLength(8);
  });
});
