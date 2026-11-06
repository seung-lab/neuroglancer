import { describe, expect, it, vi } from "vitest";
import {
  emptyValidCoordinateSpace,
  makeCoordinateSpace,
  makeIdentityTransform,
  makeIdentityTransformedBoundingBox,
  WatchableCoordinateSpaceTransform,
} from "#src/coordinate_transform.js";
import type { ImageUserLayer } from "#src/layer/image/index.js";
import { getRenderLayerTransform } from "#src/render_coordinate_transform.js";
import { UncompressedVolumeChunk } from "#src/sliceview/uncompressed_chunk_format.js";
import type {
  VolumeChunk,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import { SliceViewVolumeRenderLayer } from "#src/sliceview/volume/renderlayer.js";
import { DataType } from "#src/util/data_type.js";
import { valueOrThrow } from "#src/util/error.js";
import * as matrix from "#src/util/matrix.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import { NullarySignal } from "#src/util/signal.js";
import { prepareAffinityInput } from "#src/watershed/input.js";

// The CPU accessor imports shader enum definitions, but never creates a GL context.
vi.hoisted(() => vi.stubGlobal("WebGL2RenderingContext", {}));

vi.mock("#src/sliceview/volume/renderlayer.js", () => ({
  SliceViewVolumeRenderLayer: class {},
}));

const signal = new AbortController().signal;
const identity = (rank = 4) => matrix.createIdentity(Float32Array, rank + 1);
function watchable<T>(value: T) {
  return { value, changed: new NullarySignal() };
}

interface FixtureOptions {
  names?: string[];
  lower?: number[];
  upper?: number[];
  chunkSize?: number[];
  baseOffset?: number[];
  sourceTransform?: Float32Array;
  nativeTransform?: Float64Array;
  nativeOrigin?: number[];
  globalScales?: number[];
  dataType?: DataType;
  value?: (p: number[]) => number;
  absent?: string[];
  fillValue?: number;
}

function fixture(options: FixtureOptions = {}) {
  const {
    names = ["x", "y", "z", "c^"],
    lower = [0, 0, 0, 0].slice(0, names.length),
    upper = [5, 4, 3, 5].slice(0, names.length),
    chunkSize = [3, 3, 2, 2].slice(0, names.length),
    baseOffset = [0, 0, 0, 0].slice(0, names.length),
    sourceTransform = identity(names.length),
    nativeOrigin = [0, 0, 0, 0].slice(0, names.length),
    dataType = DataType.FLOAT32,
    absent = [],
    fillValue = 0.25,
    value = (p) => (p[0] + 6 * p[1] + 30 * p[2] + 100 * (p[3] ?? 0)) / 1000,
  } = options;
  const rank = names.length;
  const channelDim = names.indexOf("c^");
  const spec = {
    rank,
    dataType,
    fillValue,
    lowerVoxelBound: Float32Array.from(lower),
    upperVoxelBound: Float32Array.from(upper),
    chunkDataSize: Uint32Array.from(chunkSize),
    baseVoxelOffset: Float32Array.from(baseOffset),
  };
  const cache = new Map<string, UncompressedVolumeChunk>();
  let inCallback = false,
    available = true;
  let callbackResult: unknown;
  let pending = 0,
    maxPending = 0;
  const source = {
    spec,
    refCount: 1,
    wasDisposed: false,
    cacheInvalidated: new NullarySignal(),
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
        ++pending;
        maxPending = Math.max(maxPending, pending);
        try {
          progress.signal?.throwIfAborted();
          const key = grid.join();
          let chunk = cache.get(key);
          if (chunk === undefined) {
            const origin = Array.from(grid, (g, d) => g * chunkSize[d]);
            const size = Uint32Array.from(chunkSize, (n, d) =>
              Math.min(n, upper[d] - origin[d]),
            );
            const count = size.reduce((a, b) => a * b, 1);
            const values = Float32Array.from({ length: count }, (_, i) => {
              let rem = i;
              const p = Array.from(size, (n, d) => {
                const v = rem % n;
                rem = Math.floor(rem / n);
                return origin[d] + v;
              });
              return value(p);
            });
            chunk = Object.assign(
              Object.create(UncompressedVolumeChunk.prototype),
              {
                source,
                chunkDataSize: size,
                data: absent.includes(key) ? null : values,
                getValueAt(p: Uint32Array) {
                  if (!inCallback)
                    throw new Error("Accessor used outside fetch callback");
                  return UncompressedVolumeChunk.prototype.getValueAt.call(
                    this,
                    p,
                  );
                },
              },
            ) as UncompressedVolumeChunk;
            cache.set(key, chunk);
          }
          inCallback = true;
          try {
            callbackResult = copy(chunk);
            return callbackResult as T;
          } finally {
            inCallback = false;
          }
        } finally {
          --pending;
        }
      },
    ),
  };
  const scales = names.map((n) => ({ x: 2, y: 3, z: 5 })[n] ?? 1);
  const units = names.map((n) => (n === "c^" ? "" : "m"));
  const nativeSpace = makeCoordinateSpace({
    names,
    units,
    scales: Float64Array.from(scales),
  });
  const modelTransform = makeIdentityTransform(nativeSpace);
  if (options.nativeTransform !== undefined) {
    modelTransform.transform.set(options.nativeTransform);
  } else {
    nativeOrigin.forEach((n, d) => {
      modelTransform.transform[rank * (rank + 1) + d] = n;
    });
  }
  const transform = new WatchableCoordinateSpaceTransform(modelTransform);
  const globalSpace = watchable(
    makeCoordinateSpace({
      names: names.filter((n) => n !== "c^"),
      units: ["m", "m", "m"],
      scales: Float64Array.from(
        options.globalScales ?? scales.filter((_, d) => names[d] !== "c^"),
      ),
    }),
  );
  const localSpace = watchable(emptyValidCoordinateSpace);
  const channelSpace = watchable(
    channelDim === -1
      ? emptyValidCoordinateSpace
      : makeCoordinateSpace({
          names: ["c^"],
          units: [""],
          scales: Float64Array.of(1),
          boundingBoxes: [
            makeIdentityTransformedBoundingBox({
              lowerBounds: Float64Array.of(0),
              upperBounds: Float64Array.of(upper[channelDim]),
            }),
          ],
        }),
  );
  // Simulate CoordinateSpaceCombiner rebinding output metadata to viewer scales.
  transform.outputSpace.value = makeCoordinateSpace({
    names,
    units,
    scales: Float64Array.from(names, (n) =>
      n === "c^"
        ? 1
        : globalSpace.value.scales[globalSpace.value.names.indexOf(n)],
    ),
  });
  const selected = {
    chunkSource: source as unknown as VolumeChunkSource,
    chunkToMultiscaleTransform: sourceTransform,
    lowerClipBound: undefined as Float32Array | undefined,
    upperClipBound: undefined as Float32Array | undefined,
  };
  const subsource = {
    enabled: true,
    activated: {} as object | undefined,
    subsourceToModelSubspaceTransform: identity(rank),
    modelSubspaceDimensionIndices: Array.from({ length: rank }, (_, d) => d),
    subsourceEntry: { subsource: { volume: undefined as unknown } },
  };
  const multiscale = {
    rank,
    getSources: vi.fn((_options: unknown) => {
      if (!available) throw new Error("Inference publication was deleted");
      source.addRef();
      return [[selected]];
    }),
  };
  subsource.subsourceEntry.subsource.volume = multiscale;
  const loadState = {
    error: undefined,
    dataSource: { modelTransform },
    transform,
    subsources: [subsource],
  };
  const renderLayer = Object.assign(
    Object.create(SliceViewVolumeRenderLayer.prototype),
    {
      multiscaleSource: multiscale,
      wasDisposed: false,
      transform: watchable(
        valueOrThrow(
          getRenderLayerTransform(
            globalSpace.value,
            localSpace.value,
            transform.value,
            subsource,
            channelSpace.value,
          ),
        ),
      ),
    },
  );
  const layer = {
    type: "image",
    isReady: true,
    wasDisposed: false,
    renderLayers: [renderLayer],
    dataSources: [{ loadState }],
    dataSourcesChanged: new NullarySignal(),
    layersChanged: new NullarySignal(),
    readyStateChanged: new NullarySignal(),
    channelCoordinateSpace: channelSpace,
    managedLayer: {
      localCoordinateSpace: localSpace,
      manager: { root: { coordinateSpace: globalSpace } },
    },
  };
  return {
    source,
    spec,
    cache,
    layer,
    renderLayer,
    loadState,
    subsource,
    selected,
    transform,
    modelTransform,
    globalSpace,
    channelSpace,
    multiscale,
    prepare: (scale = 0) =>
      prepareAffinityInput(layer as unknown as ImageUserLayer, scale),
    unavailable: () => {
      available = false;
    },
    callbackResult: () => callbackResult,
    maxPending: () => maxPending,
    refresh: () => {
      renderLayer.transform.value = valueOrThrow(
        getRenderLayerTransform(
          globalSpace.value,
          localSpace.value,
          transform.value,
          subsource,
          channelSpace.value,
        ),
      );
      renderLayer.transform.changed.dispatch();
    },
  };
}

async function read(
  f: ReturnType<typeof fixture>,
  lower = [1, 1, 1],
  shape = [4, 3, 2],
  channels = [4, 0, 2],
) {
  const input = f.prepare();
  try {
    return await input.readRegion(lower, shape, channels, signal);
  } finally {
    input.dispose();
  }
}

function expected(
  lower: number[],
  shape: number[],
  channels: number[],
  value: (p: number[]) => number,
) {
  const out: number[] = [];
  for (const c of channels)
    for (let z = lower[2]; z < lower[2] + shape[2]; ++z) {
      for (let y = lower[1]; y < lower[1] + shape[1]; ++y)
        for (let x = lower[0]; x < lower[0] + shape[0]; ++x)
          out.push(value([x, y, z, c]));
    }
  return Float32Array.from(out);
}

describe("native affinity input", () => {
  it("packs actual accessor values across spatial AND channel chunks, in requested planar order", async () => {
    const value = (p: number[]) =>
      (p[0] + 6 * p[1] + 30 * p[2] + 100 * p[3]) / 1000;
    const f = fixture({ value });
    expect(await read(f)).toEqual(
      expected([1, 1, 1], [4, 3, 2], [4, 0, 2], value),
    );
    expect(f.source.fetchChunk).toHaveBeenCalledTimes(24);
    expect(f.maxPending()).toBe(1);
    expect(f.source.refCount).toBe(1);
    expect(f.multiscale.getSources.mock.calls[0][0]).toMatchObject({
      modelChannelDimensionIndices: [3],
      discreteValues: true,
    });
    expect(() =>
      f.cache.values().next().value!.getValueAt(new Uint32Array(4)),
    ).toThrow("outside fetch callback");
  });

  it.each([3, 4])(
    "reads genuine rank-%i single-channel chunks at nonzero bounds/origins and partial edges without refetching repeated planes",
    async (rank) => {
      const value = ([x, y, z]: number[]) =>
        (x + 10 * (y + 3) + 60 * (z - 3)) / 1000;
      const f = fixture({
        names: ["x", "y", "z", "c^"].slice(0, rank),
        lower: [1, -2, 3, 0].slice(0, rank),
        upper: [6, 3, 6, 1].slice(0, rank),
        chunkSize: [4, 3, 4, 1].slice(0, rank),
        baseOffset: [19, -11, 7, 0].slice(0, rank),
        nativeOrigin: [20, -12, 7, 0].slice(0, rank),
        globalScales: [8, 12, 20],
        value,
      });
      const input = f.prepare();
      try {
        expect(input.channelCount).toBe(1);
        expect(input.lowerBoundXYZ).toEqual([1, -2, 3]);
        expect(input.upperBoundXYZ).toEqual([6, 3, 6]);
        expect(input.originXYZ).toEqual([20, -12, 7]);
        expect(input.spacingXYZ).toEqual([2, 3, 5]);
        expect(input.unitsXYZ).toEqual(["m", "m", "m"]);
        const actual = await input.readRegion(
          [2, -1, 3],
          [4, 4, 3],
          [0, 0, 0],
          signal,
        );
        expect(actual).toEqual(
          expected([2, -1, 3], [4, 4, 3], [0, 0, 0], value),
        );
        const grids = f.source.fetchChunk.mock.calls.map(([grid]) =>
          grid.join(),
        );
        expect(grids).toHaveLength(8);
        expect(new Set(grids).size).toBe(8);
        expect(f.source.fetchChunk.mock.calls[0][0]).toEqual(
          Float32Array.from([0, -1, 0, 0].slice(0, rank)),
        );
        expect(f.multiscale.getSources.mock.calls[0][0]).toMatchObject({
          modelChannelDimensionIndices: rank === 3 ? [] : [3],
        });
        const edge = f.cache.get([1, 0, 1, 0].slice(0, rank).join())!;
        expect(edge.chunkDataSize).toEqual(
          Uint32Array.from([2, 3, 2, 1].slice(0, rank)),
        );
        for (const chunk of f.cache.values()) {
          expect(chunk.chunkDataSize).toHaveLength(rank);
          expect(actual.buffer).not.toBe(chunk.data!.buffer);
        }
        // Repeated planes share values, not storage, and the caller owns the output.
        const first = actual[0];
        actual[0] = -1;
        expect(actual[4 * 4 * 3]).toBe(first);
        expect(
          await input.readRegion([2, -1, 3], [1, 1, 1], [0], signal),
        ).toEqual(Float32Array.of(first));
      } finally {
        input.dispose();
      }
      expect(f.source.refCount).toBe(1);
    },
  );

  it.each([
    { channels: [0] },
    { channels: [4, 0] },
    { channels: [4, 0, 4] },
    { channels: [4, 4, 4, 4] },
    { channels: [4, 0, 4, 2] },
    { channels: [0, 1, 2, 3] },
  ])(
    "packs requested planes $channels, fetching each necessary channel/spatial chunk once",
    async ({ channels }) => {
      const value = ([x, y, z, c]: number[]) =>
        (x + 6 * y + 30 * z + 100 * c) / 1000;
      const f = fixture({ value });
      expect(await read(f, [1, 1, 1], [4, 3, 2], channels)).toEqual(
        expected([1, 1, 1], [4, 3, 2], channels, value),
      );
      const grids = f.source.fetchChunk.mock.calls.map(([grid]) => grid.join());
      expect(grids).toHaveLength(
        8 * new Set(channels.map((c) => Math.floor(c / 2))).size,
      );
      expect(new Set(grids).size).toBe(grids.length);
      expect(f.source.refCount).toBe(1);
    },
  );

  it.each([3, 4])(
    "accepts 1..4 repeated planes from a rank-%i scalar without implicit duplication",
    async (rank) => {
      const f = fixture({
        names: ["x", "y", "z", "c^"].slice(0, rank),
        upper: [5, 4, 3, 1].slice(0, rank),
        value: () => 0.75,
      });
      const input = f.prepare();
      try {
        for (let n = 1; n <= 4; ++n) {
          f.source.fetchChunk.mockClear();
          expect(
            await input.readRegion(
              [0, 0, 0],
              [1, 1, 1],
              new Array(n).fill(0),
              signal,
            ),
          ).toEqual(new Float32Array(n).fill(0.75));
          expect(f.source.fetchChunk).toHaveBeenCalledOnce();
        }
        f.source.fetchChunk.mockClear();
        await expect(
          input.readRegion([0, 0, 0], [1, 1, 1], [1], signal),
        ).rejects.toThrow("in-bounds affinity channels");
        expect(f.source.fetchChunk).not.toHaveBeenCalled();
      } finally {
        input.dispose();
      }
    },
  );

  it("allows two-channel sources and packs only the caller's chosen planes", async () => {
    const f = fixture({ upper: [5, 4, 3, 2], chunkSize: [3, 3, 2, 1] });
    const input = f.prepare();
    try {
      expect(input.channelCount).toBe(2);
      expect(
        await input.readRegion([0, 0, 0], [1, 1, 1], [1, 0, 1, 0], signal),
      ).toEqual(Float32Array.of(0.1, 0, 0.1, 0));
      expect(f.source.fetchChunk).toHaveBeenCalledTimes(2);
    } finally {
      input.dispose();
    }
  });

  it("supports scalar spatial permutations and scaled/translated native chunks without a channel dimension", async () => {
    // Chunk [z,x,y] -> model [y,z,x].
    const t = new Float32Array(16);
    t[15] = 1;
    t[1] = 4;
    t[6] = 2;
    t[8] = 3;
    t[12] = -9;
    t[13] = 20;
    t[14] = 14;
    const f = fixture({
      names: ["y", "z", "x"],
      upper: [3, 5, 4],
      chunkSize: [2, 3, 3],
      baseOffset: [100, -50, 20],
      sourceTransform: t,
    });
    const input = f.prepare();
    try {
      expect(input.channelCount).toBe(1);
      expect(input.upperBoundXYZ).toEqual([5, 4, 3]);
      expect(input.spacingXYZ).toEqual([4, 9, 20]);
      expect(input.originXYZ).toEqual([7, -3, 5]);
      expect(
        await input.readRegion([1, 1, 1], [4, 3, 2], [0, 0, 0], signal),
      ).toEqual(
        expected(
          [1, 1, 1],
          [4, 3, 2],
          [0, 0, 0],
          ([x, y, z]) => (z + 6 * x + 30 * y) / 1000,
        ),
      );
      expect(f.source.fetchChunk).toHaveBeenCalledTimes(8);
      expect(f.source.fetchChunk.mock.calls[0][0]).toEqual(
        Float32Array.of(0, 0, 0),
      );
    } finally {
      input.dispose();
    }
    expect(f.source.refCount).toBe(1);
  });

  it("supports spatial/channel permutations and scaled/translated precomputed grids without double backend offsets", async () => {
    // Chunk [z,c,x,y] -> model [y,z,c,x].
    const t = new Float32Array(25);
    t[24] = 1;
    t[1] = 4;
    t[5 + 2] = 1;
    t[10 + 3] = 2;
    t[15] = 3;
    t[20] = -9;
    t[21] = 20;
    t[23] = 14;
    const f = fixture({
      names: ["y", "z", "c^", "x"],
      upper: [3, 5, 5, 4],
      chunkSize: [2, 2, 3, 3],
      sourceTransform: t,
      baseOffset: [100, 0, -50, 20],
    });
    const input = f.prepare();
    expect(input.lowerBoundXYZ).toEqual([0, 0, 0]);
    expect(input.upperBoundXYZ).toEqual([5, 4, 3]);
    expect(input.spacingXYZ).toEqual([4, 9, 20]);
    expect(input.originXYZ).toEqual([7, -3, 5]);
    expect(input.unitsXYZ).toEqual(["m", "m", "m"]);
    const actual = await input.readRegion(
      [1, 1, 1],
      [4, 3, 2],
      [4, 0, 2],
      signal,
    );
    expect(actual).toEqual(
      expected(
        [1, 1, 1],
        [4, 3, 2],
        [4, 0, 2],
        ([x, y, z, c]) => (z + 6 * c + 30 * x + 100 * y) / 1000,
      ),
    );
    expect(f.source.fetchChunk.mock.calls[0][0]).toEqual(
      Float32Array.of(0, 2, 0, 0),
    );
    input.dispose();
    expect(f.source.refCount).toBe(1);
  });

  it("adds the native model-to-layer inference origin, not the viewer-normalized translation", () => {
    const f = fixture({
      nativeOrigin: [20, -12, 7, 0],
      globalScales: [8, 12, 20],
    });
    const input = f.prepare();
    expect(f.transform.value.transform[20]).toBe(5);
    expect(input.originXYZ).toEqual([20, -12, 7]);
    expect(input.spacingXYZ).toEqual([2, 3, 5]);
    input.dispose();
  });

  it.each([3, 4])(
    "composes a rank-%i native model-to-output positive axis permutation in physical units",
    async (rank) => {
      const stride = rank + 1;
      const t = new Float64Array(stride ** 2);
      t[stride ** 2 - 1] = 1;
      t[2] = 4; // Model X -> output Z.
      t[stride] = 2; // Model Y -> output X.
      t[2 * stride + 1] = 3; // Model Z -> output Y.
      if (rank === 4) t[3 * stride + 3] = 1;
      t[rank * stride] = 6;
      t[rank * stride + 1] = 10;
      t[rank * stride + 2] = 8;
      const f = fixture({
        names: ["x", "y", "z", "c^"].slice(0, rank),
        nativeTransform: t,
      });
      const channels = rank === 3 ? [0, 0, 0] : [4, 0, 2];
      const input = f.prepare();
      expect(input.upperBoundXYZ).toEqual([4, 3, 5]);
      expect(input.spacingXYZ).toEqual([6, 15, 8]);
      expect(input.originXYZ).toEqual([2, 2, 5]);
      expect(
        await input.readRegion([1, 1, 1], [3, 2, 4], channels, signal),
      ).toEqual(
        expected(
          [1, 1, 1],
          [3, 2, 4],
          channels,
          ([x, y, z, c]) => (z + 6 * x + 30 * y + 100 * c) / 1000,
        ),
      );
      input.dispose();
      expect(f.source.refCount).toBe(1);
    },
  );

  it("uses the selected non-default scale's spacing/origin but unshifted voxel keys", async () => {
    const f = fixture();
    const t = identity();
    t[0] = 2;
    t[6] = 3;
    t[12] = 4;
    t[20] = 14;
    t[21] = -9;
    t[22] = 20;
    const coarse = { ...f.selected, chunkToMultiscaleTransform: t };
    f.multiscale.getSources.mockImplementation(() => {
      f.source.addRef();
      f.source.addRef();
      return [[f.selected, coarse]];
    });
    const input = f.prepare(1);
    expect(input.spacingXYZ).toEqual([4, 9, 20]);
    expect(input.originXYZ).toEqual([7, -3, 5]);
    expect(
      await input.readRegion([0, 0, 0], [1, 1, 1], [4, 0, 2], signal),
    ).toEqual(Float32Array.of(0.4, 0, 0.2));
    expect(f.source.fetchChunk.mock.calls[0][0]).toEqual(
      Float32Array.of(0, 0, 0, 2),
    );
    input.dispose();
    expect(f.source.refCount).toBe(1);
  });

  it.each([
    [DataType.UINT8, 255],
    [DataType.UINT16, 65535],
    [DataType.FLOAT32, 1],
  ])("normalizes dtype %s only by its maximum", async (dataType, max) => {
    const f = fixture({ dataType, value: (p) => [0, max / 3, max][p[3] % 3] });
    expect(await read(f, [0, 0, 0], [1, 1, 1], [2, 0, 1, 2])).toEqual(
      Float32Array.of(1, 0, 1 / 3, 1),
    );
  });

  it.each([
    DataType.INT8,
    DataType.INT16,
    DataType.INT32,
    DataType.UINT32,
    DataType.UINT64,
  ])("rejects unsupported dtype %s and releases donated refs", (dataType) => {
    const f = fixture({ dataType });
    expect(f.prepare).toThrow("only FLOAT32, UINT8, and UINT16");
    expect(f.source.refCount).toBe(1);
  });

  it.each([NaN, Infinity, -0.01, 1.001])(
    "returns a tagged callback error for invalid affinity %s",
    async (v) => {
      const f = fixture({ value: () => v });
      await expect(read(f)).rejects.toThrow("Affinity values must be finite");
      expect(f.callbackResult()).toMatchObject({
        ok: false,
        error: expect.any(Error),
      });
      expect(f.source.refCount).toBe(1);
    },
  );

  it("preserves legitimate absent-chunk fill values, without outside padding", async () => {
    const f = fixture({ absent: ["0,0,0,0"], fillValue: 0.625 });
    expect(await read(f, [0, 0, 0], [1, 1, 1], [1, 0, 2])).toEqual(
      Float32Array.of(0.625, 0.625, 0.2),
    );
    const input = f.prepare();
    await expect(
      input.readRegion([-1, 0, 0], [1, 1, 1], [0, 1, 2], signal),
    ).rejects.toThrow("outside native bounds");
    input.dispose();
  });

  it.each([
    { dataType: DataType.UINT8, max: 255 },
    { dataType: DataType.UINT16, max: 65535 },
    { dataType: DataType.FLOAT32, max: 1 },
  ])(
    "normalizes scalar values and legitimate absent fills for dtype $dataType",
    async ({ dataType, max }) => {
      const f = fixture({
        names: ["x", "y", "z"],
        dataType,
        value: () => max,
        absent: ["0,0,0"],
        fillValue: max / 5,
      });
      expect(await read(f, [2, 0, 0], [3, 1, 1], [0, 0, 0, 0])).toEqual(
        Float32Array.from([0.2, 1, 1, 0.2, 1, 1, 0.2, 1, 1, 0.2, 1, 1]),
      );
      expect(f.source.fetchChunk).toHaveBeenCalledTimes(2);
      expect(f.source.refCount).toBe(1);
    },
  );

  it.each([NaN, Infinity, -0.01, 1.001])(
    "rejects invalid scalar value %s with a tagged callback error",
    async (value) => {
      const f = fixture({ names: ["x", "y", "z"], value: () => value });
      await expect(read(f, [0, 0, 0], [1, 1, 1], [0, 0, 0])).rejects.toThrow(
        "Affinity values must be finite",
      );
      expect(f.callbackResult()).toMatchObject({
        ok: false,
        error: expect.any(Error),
      });
      expect(f.source.refCount).toBe(1);
    },
  );

  it.each(["rank", "coverage"])(
    "rejects malformed scalar chunk %s without padding",
    async (kind) => {
      const f = fixture({ names: ["x", "y", "z"] });
      const original = f.source.fetchChunk.getMockImplementation()!;
      f.source.fetchChunk.mockImplementation((grid, copy, progress) =>
        original(
          grid,
          (chunk) => {
            chunk.chunkDataSize =
              kind === "rank"
                ? Uint32Array.of(3, 3, 2, 1)
                : Uint32Array.of(1, 3, 2);
            return copy(chunk);
          },
          progress,
        ),
      );
      await expect(read(f, [0, 0, 0], [2, 1, 1], [0, 0, 0])).rejects.toThrow(
        kind === "rank" ? "must have rank-3 data" : "does not cover",
      );
      expect(f.callbackResult()).toMatchObject({ ok: false });
      expect(f.source.refCount).toBe(1);
    },
  );

  it("rejects partial spatial or channel chunks instead of silently filling holes", async () => {
    for (const d of [0, 3]) {
      const f = fixture();
      const original = f.source.fetchChunk.getMockImplementation()!;
      f.source.fetchChunk.mockImplementation((grid, copy, progress) =>
        original(
          grid,
          (chunk) => {
            chunk.chunkDataSize = Uint32Array.from(chunk.chunkDataSize);
            chunk.chunkDataSize[d] = 1;
            return copy(chunk);
          },
          progress,
        ),
      );
      await expect(read(f, [0, 0, 0], [2, 1, 1], [0, 1, 2])).rejects.toThrow(
        "does not cover",
      );
      expect(f.callbackResult()).toMatchObject({ ok: false });
    }
  });

  it.each([
    [
      [0, 0],
      [1, 1, 1],
      [0, 1, 2],
    ],
    [
      [0.5, 0, 0],
      [1, 1, 1],
      [0, 1, 2],
    ],
    [
      [0, 0, 0],
      [1, 0, 1],
      [0, 1, 2],
    ],
    [[0, 0, 0], [1, 1, 1], []],
    [
      [0, 0, 0],
      [1, 1, 1],
      [0, 0, 0, 0, 0],
    ],
    [[0, 0, 0], [1, 1, 1], [-1]],
    [[0, 0, 0], [1, 1, 1], [NaN]],
    [
      [0, 0, 0],
      [1, 1, 1],
      [0, 1, 5],
    ],
    [
      [0, 0, 0],
      [1, 1, 1],
      [0, 1, 1.5],
    ],
  ])(
    "rejects invalid ROI/channel arguments before fetching",
    async (lower, shape, channels) => {
      const f = fixture();
      const input = f.prepare();
      await expect(
        input.readRegion(lower, shape, channels, signal),
      ).rejects.toBeInstanceOf(RangeError);
      expect(f.source.fetchChunk).not.toHaveBeenCalled();
      input.dispose();
    },
  );

  it.each<FixtureOptions>([
    { upper: [16777224, 4, 3, 5] },
    // Both endpoint origins are exact, but an intermediate 3-voxel step is not.
    { upper: [16777226, 4, 3, 5] },
    { lower: [-16777224, 0, 0, 0], upper: [-16777216, 4, 3, 5] },
    { upper: [7, 4, 3, 5], baseOffset: [2 ** 24, 0, 0, 0] },
    { names: ["x", "y", "z"], upper: [16777226, 4, 3] },
    {
      names: ["x", "y", "z"],
      lower: [-16777224, 0, 0],
      upper: [-16777216, 4, 3],
    },
    { names: ["x", "y", "z"], upper: [7, 4, 3], baseOffset: [2 ** 24, 0, 0] },
  ])("rejects rounded backend chunk origins before reads: %j", (options) => {
    const f = fixture(options);
    expect(f.prepare).toThrow("backend chunk origins exceed exact float32");
    expect(f.source.fetchChunk).not.toHaveBeenCalled();
    expect(f.source.refCount).toBe(1);
  });

  it.each<FixtureOptions>([
    {
      upper: [2 ** 28, 4, 3, 5],
      chunkSize: [64, 3, 2, 2],
      baseOffset: [2 ** 29, 0, 0, 0],
    },
    { lower: [16777224, 0, 0, 0], upper: [16777226, 4, 3, 5] },
    {
      names: ["x", "y", "z"],
      upper: [2 ** 28, 4, 3],
      chunkSize: [64, 3, 2],
      baseOffset: [2 ** 29, 0, 0],
    },
    {
      names: ["x", "y", "z"],
      lower: [16777224, 0, 0],
      upper: [16777226, 4, 3],
    },
  ])("accepts exactly indexed large or single-chunk grids: %j", (options) => {
    const f = fixture(options);
    const input = f.prepare();
    expect(input.upperBoundXYZ).toEqual(options.upper!.slice(0, 3));
    expect(f.source.fetchChunk).not.toHaveBeenCalled();
    input.dispose();
    expect(f.source.refCount).toBe(1);
  });

  it("caps reads at 2**26 spatial voxels before allocation/fetch", async () => {
    const f = fixture({ upper: [512, 512, 257, 5] });
    const input = f.prepare();
    await expect(
      input.readRegion([0, 0, 0], [512, 512, 257], [0, 1, 2], signal),
    ).rejects.toThrow("2**26");
    expect(f.source.fetchChunk).not.toHaveBeenCalled();
    input.dispose();
  });

  it("allows a 64 Mi-voxel shape through to channel validation without allocating", async () => {
    const f = fixture({ upper: [512, 512, 256, 5] });
    const input = f.prepare();
    await expect(
      input.readRegion([0, 0, 0], [512, 512, 256], [], signal),
    ).rejects.toThrow("Select 1..4 in-bounds affinity channels");
    expect(f.source.fetchChunk).not.toHaveBeenCalled();
    input.dispose();
  });

  it("uses native clip bounds, not backend offset or a shifted zero-based ROI", async () => {
    const f = fixture({
      lower: [-2, 0, 0, 0],
      upper: [5, 4, 3, 5],
      baseOffset: [22, -33, 10, 0],
    });
    f.selected.lowerClipBound = Float32Array.of(-1, 1, 0, 0);
    f.selected.upperClipBound = Float32Array.of(4, 3, 3, 5);
    const input = f.prepare();
    expect(input.lowerBoundXYZ).toEqual([-1, 1, 0]);
    expect(input.upperBoundXYZ).toEqual([4, 3, 3]);
    await input.readRegion([-1, 1, 0], [1, 1, 1], [0, 1, 2], signal);
    expect(f.source.fetchChunk.mock.calls[0][0][0]).toBe(-1);
    input.dispose();
  });

  it.each([
    "shear",
    "reflection",
    "fractional origin",
    "channel scaling",
    "fractional bounds",
  ])("rejects unsafe source grid: %s", (kind) => {
    const f = fixture();
    const t = f.selected.chunkToMultiscaleTransform;
    if (kind === "shear") t[1] = 0.1;
    if (kind === "reflection") t[0] = -1;
    if (kind === "fractional origin") t[20] = 0.5;
    if (kind === "channel scaling") t[18] = 2;
    if (kind === "fractional bounds") f.spec.lowerVoxelBound[0] = 0.5;
    expect(f.prepare).toThrow("Unsupported affinity input");
    expect(f.source.refCount).toBe(1);
  });

  it("rejects non-native user and subsource transforms", () => {
    const f = fixture();
    const t = new Float64Array(f.transform.value.transform);
    t[20] = 1;
    f.transform.transform = t;
    expect(f.prepare).toThrow("user/subsource transforms");
    f.transform.reset();
    f.subsource.subsourceToModelSubspaceTransform[0] = 2;
    expect(f.prepare).toThrow("user/subsource transforms");
  });

  it.each([
    "source shear",
    "source reflection",
    "source fractional origin",
    "native shear",
    "user transform",
    "subsource transform",
    "viewer metadata",
    "channel metadata",
    "chunk rank",
    "chunk grid precision",
  ])("keeps strict scalar native-grid guards: %s", (kind) => {
    const f = fixture({ names: ["x", "y", "z"] });
    if (kind === "source shear") f.selected.chunkToMultiscaleTransform[1] = 0.1;
    if (kind === "source reflection")
      f.selected.chunkToMultiscaleTransform[0] = -1;
    if (kind === "source fractional origin")
      f.selected.chunkToMultiscaleTransform[12] = 0.5;
    if (kind === "native shear") f.modelTransform.transform[1] = 0.1;
    if (kind === "user transform") {
      const t = new Float64Array(f.transform.value.transform);
      t[12] = 1;
      f.transform.transform = t;
    }
    if (kind === "subsource transform")
      f.subsource.subsourceToModelSubspaceTransform[0] = 2;
    if (kind === "viewer metadata") f.globalSpace.value.scales[0] = 0;
    if (kind === "channel metadata") {
      f.channelSpace.value = makeCoordinateSpace({
        names: ["c^"],
        units: [""],
        scales: Float64Array.of(1),
        boundingBoxes: [
          makeIdentityTransformedBoundingBox({
            lowerBounds: Float64Array.of(0),
            upperBounds: Float64Array.of(1),
          }),
        ],
      });
    }
    if (kind === "chunk rank") f.spec.rank = 4;
    if (kind === "chunk grid precision") {
      f.spec.chunkDataSize[0] = 1;
      f.spec.upperVoxelBound[0] = 2 ** 25;
    }
    expect(f.prepare).toThrow("Unsupported affinity input");
    expect(f.source.fetchChunk).not.toHaveBeenCalled();
    expect(f.source.refCount).toBe(1);
  });

  it("releases all getSources refs on bad scale/orientation and retains only its selected scale", () => {
    const f = fixture();
    expect(() => f.prepare(1)).toThrow("scaleIndex");
    expect(f.source.refCount).toBe(1);
    const second = {
      ...f.selected,
      chunkSource: {
        ...f.source,
        dispose: vi.fn(),
      } as unknown as VolumeChunkSource,
    };
    f.multiscale.getSources.mockImplementation(() => {
      f.source.addRef();
      return [[f.selected, second]];
    });
    const input = f.prepare();
    expect(second.chunkSource.dispose).toHaveBeenCalledTimes(1);
    expect(f.source.refCount).toBe(2);
    input.dispose();
    input.dispose();
    expect(f.source.refCount).toBe(1);
  });

  it("does not invalidate on unrelated viewer bounds, IDs, or timestamps", async () => {
    const f = fixture();
    const input = f.prepare();
    f.globalSpace.value = {
      ...f.globalSpace.value,
      ids: [91, 92, 93],
      timestamps: [10, 20, 30],
      boundingBoxes: [],
      bounds: {
        ...f.globalSpace.value.bounds,
        upperBounds: Float64Array.of(500, 600, 700),
      },
    };
    f.globalSpace.changed.dispatch();
    f.refresh();
    expect(input.isValid()).toBe(true);
    expect(input.signal.aborted).toBe(false);
    await input.readRegion([0, 0, 0], [1, 1, 1], [0, 1, 2], signal);
    input.dispose();
  });

  it.each([
    "transform",
    "deleted",
    "replaced",
    "chunk size",
    "source unavailable",
    "channel disabled",
  ])("detects stale %s state, aborts lifetime, and cleans refs", (kind) => {
    const f = fixture();
    const input = f.prepare();
    if (kind === "transform") f.transform.value.transform[20] = 2;
    if (kind === "deleted") f.layer.wasDisposed = true;
    if (kind === "replaced") f.layer.renderLayers = [];
    if (kind === "chunk size") f.spec.chunkDataSize[0] = 4;
    if (kind === "source unavailable") f.unavailable();
    if (kind === "channel disabled") f.subsource.enabled = false;
    expect(input.isValid()).toBe(false);
    expect(input.signal.aborted).toBe(true);
    expect(input.assertValid).toThrow("disposed or stale");
    input.dispose();
    expect(f.source.refCount).toBe(1);
  });

  it.each([3, 4])(
    "aborts rank-%i input on source cache invalidation without polling or another read",
    (rank) => {
      const f = fixture({ names: ["x", "y", "z", "c^"].slice(0, rank) });
      const input = f.prepare();
      expect(input.signal.aborted).toBe(false);
      f.source.cacheInvalidated.dispatch();
      expect(input.signal.aborted).toBe(true);
      expect(f.source.fetchChunk).not.toHaveBeenCalled();
      input.dispose();
      expect(f.source.refCount).toBe(1);
    },
  );

  it("rejects mutable generation-based sources rather than leaving warm output tiles stale", () => {
    const f = fixture();
    const source = Object.assign(f.source, { generation: 1 });
    expect(f.prepare).toThrow("mutable generation-based volumes");
    expect(source.fetchChunk).not.toHaveBeenCalled();
    expect(source.refCount).toBe(1);
  });

  it.each(
    ["caller", "dispose", "stale"].flatMap((kind) =>
      [3, 4].map((rank) => ({ kind, rank })),
    ),
  )(
    "aborts in-flight $kind cancellation for rank-$rank with no next fetch or leaked listeners/refs",
    async ({ kind, rank }) => {
      const f = fixture({ names: ["x", "y", "z", "c^"].slice(0, rank) });
      const input = f.prepare();
      const abort = new AbortController();
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      f.source.fetchChunk.mockImplementation(
        async (_grid, _copy, { signal }) => {
          entered();
          return new Promise((_resolve, reject) => {
            signal!.addEventListener("abort", () => reject(signal!.reason), {
              once: true,
            });
          });
        },
      );
      const pending = input.readRegion(
        [0, 0, 0],
        [4, 3, 2],
        rank === 3 ? [0, 0, 0] : [0, 1, 2],
        abort.signal,
      );
      const rejected = expect(pending).rejects.toThrow();
      await started;
      if (kind === "caller") abort.abort(new Error("Caller cancelled"));
      if (kind === "dispose") input.dispose();
      if (kind === "stale") {
        f.layer.renderLayers = [];
        f.layer.layersChanged.dispatch();
      }
      await rejected;
      expect(f.source.fetchChunk).toHaveBeenCalledTimes(1);
      if (kind === "caller") expect(input.isValid()).toBe(true);
      input.dispose();
      input.dispose();
      expect(f.source.refCount).toBe(1);
      // A disposed reader must not run validation on subsequent viewer events.
      const calls = f.multiscale.getSources.mock.calls.length;
      f.layer.layersChanged.dispatch();
      f.globalSpace.changed.dispatch();
      expect(f.multiscale.getSources.mock.calls.length).toBe(calls);
    },
  );

  it("snapshots caller ROI/channel arrays while a chunk is in flight", async () => {
    const f = fixture();
    const original = f.source.fetchChunk.getMockImplementation()!;
    const lower = [0, 0, 0],
      shape = [1, 1, 1],
      channels = [4, 0, 2];
    f.source.fetchChunk.mockImplementation(async (grid, copy, progress) => {
      lower.fill(999);
      shape.fill(999);
      channels.fill(999);
      return original(grid, copy, progress);
    });
    const input = f.prepare();
    expect(await input.readRegion(lower, shape, channels, signal)).toEqual(
      Float32Array.of(0.4, 0, 0.2),
    );
    input.dispose();
  });
});
