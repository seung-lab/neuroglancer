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
const identity = () => matrix.createIdentity(Float32Array, 5);
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
    lower = [0, 0, 0, 0],
    upper = [5, 4, 3, 5],
    chunkSize = [3, 3, 2, 2],
    baseOffset = [0, 0, 0, 0],
    sourceTransform = identity(),
    nativeOrigin = [0, 0, 0, 0],
    dataType = DataType.FLOAT32,
    absent = [],
    fillValue = 0.25,
    value = (p) => (p[0] + 6 * p[1] + 30 * p[2] + 100 * p[3]) / 1000,
  } = options;
  const spec = {
    rank: 4,
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
      modelTransform.transform[20 + d] = n;
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
    makeCoordinateSpace({
      names: ["c^"],
      units: [""],
      scales: Float64Array.of(1),
      boundingBoxes: [
        makeIdentityTransformedBoundingBox({
          lowerBounds: Float64Array.of(0),
          upperBounds: Float64Array.of(upper[names.indexOf("c^")]),
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
    subsourceToModelSubspaceTransform: identity(),
    modelSubspaceDimensionIndices: [0, 1, 2, 3],
    subsourceEntry: { subsource: { volume: undefined as unknown } },
  };
  const multiscale = {
    rank: 4,
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

  it("composes a native model-to-output positive axis permutation in physical units", async () => {
    const t = new Float64Array(25);
    t[24] = 1;
    t[2] = 4; // Model X -> output Z.
    t[5] = 2; // Model Y -> output X.
    t[11] = 3; // Model Z -> output Y.
    t[18] = 1;
    t[20] = 6;
    t[21] = 10;
    t[22] = 8;
    const f = fixture({ nativeTransform: t });
    const input = f.prepare();
    expect(input.upperBoundXYZ).toEqual([4, 3, 5]);
    expect(input.spacingXYZ).toEqual([6, 15, 8]);
    expect(input.originXYZ).toEqual([2, 2, 5]);
    expect(
      await input.readRegion([1, 1, 1], [3, 2, 4], [4, 0, 2], signal),
    ).toEqual(
      expected(
        [1, 1, 1],
        [3, 2, 4],
        [4, 0, 2],
        ([x, y, z, c]) => (z + 6 * x + 30 * y + 100 * c) / 1000,
      ),
    );
    input.dispose();
    expect(f.source.refCount).toBe(1);
  });

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
    expect(await read(f, [0, 0, 0], [1, 1, 1], [2, 0, 1])).toEqual(
      Float32Array.of(1, 0, 1 / 3),
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
    [
      [0, 0, 0],
      [1, 1, 1],
      [0, 0, 2],
    ],
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

  it("caps reads at 2**21 spatial voxels before allocation/fetch", async () => {
    const f = fixture({ upper: [2097153, 1, 1, 5] });
    const input = f.prepare();
    await expect(
      input.readRegion([0, 0, 0], [2097153, 1, 1], [0, 1, 2], signal),
    ).rejects.toThrow("2**21");
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

  it("rejects mutable generation-based sources rather than leaving warm output tiles stale", () => {
    const f = fixture();
    const source = Object.assign(f.source, { generation: 1 });
    expect(f.prepare).toThrow("mutable generation-based volumes");
    expect(source.fetchChunk).not.toHaveBeenCalled();
    expect(source.refCount).toBe(1);
  });

  it.each(["caller", "dispose", "stale"])(
    "aborts in-flight %s cancellation with no next fetch or leaked listeners/refs",
    async (kind) => {
      const f = fixture();
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
        [0, 1, 2],
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
