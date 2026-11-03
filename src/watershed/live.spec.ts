/**
 * @license
 * Copyright 2026 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { raceWithAbort } from "#src/util/abort.js";
import {
  DEFAULT_WATERSHED_OPTIONS,
  type WatershedResult,
} from "#src/watershed/base.js";
import type { PreparedAffinityInput } from "#src/watershed/input.js";
import { LiveWatershed } from "#src/watershed/live.js";
import { computeWatershed } from "#src/watershed/run.js";

vi.mock("#src/watershed/run.js", () => ({ computeWatershed: vi.fn() }));
const compute = vi.mocked(computeWatershed);
const signal = new AbortController().signal;

function fixture(shape = [140, 100, 70]) {
  const changed = new AbortController();
  const input: PreparedAffinityInput = {
    lowerBoundXYZ: [10, 20, -3],
    upperBoundXYZ: shape.map((n, i) => n + [10, 20, -3][i]),
    originXYZ: [100, -200, 2],
    spacingXYZ: [4e-9, 4e-9, 40e-9],
    unitsXYZ: ["m", "m", "m"],
    channelCount: 4,
    signal: changed.signal,
    isValid: () => !changed.signal.aborted,
    assertValid: () => changed.signal.throwIfAborted(),
    readRegion: vi.fn(),
    dispose: vi.fn(() => changed.abort(new Error("Input disposed"))),
  };
  return { input, changed };
}

function result(shape: readonly number[], value = 7): WatershedResult {
  return {
    data: new Uint32Array(shape.reduce((n, x) => n * x, 1)).fill(value),
    shapeXYZ: shape,
    offsetXYZ: [0, 0, 0],
    spacingXYZ: [1, 1, 1],
    unitsXYZ: ["", "", ""],
  };
}

beforeEach(() => {
  compute.mockReset();
  compute.mockImplementation(async (_input, _lower, shape) => result(shape));
});

describe("live demand-driven watershed", () => {
  it("publishes the entire native domain without reading or computing at creation", () => {
    const { input } = fixture([4096, 4096, 1]);
    const live = new LiveWatershed(input);
    expect(live.info).toEqual({
      shapeXYZ: [4096, 4096, 1],
      offsetXYZ: [110, -180, -1],
      spacingXYZ: [4e-9, 4e-9, 40e-9],
      unitsXYZ: ["m", "m", "m"],
      chunkShapeXYZ: [64, 64, 32],
    });
    expect(Object.isFrozen(live.info.shapeXYZ)).toBe(true);
    expect(input.readRegion).not.toHaveBeenCalled();
    expect(compute).not.toHaveBeenCalled();
    live.dispose();
  });

  it("reads a clipped halo and crops the correct XYZ core before namespacing labels", async () => {
    const { input } = fixture();
    compute.mockImplementation(async (_input, lower, shape) => {
      const value = result(shape, 0);
      let i = 0;
      for (let z = 0; z < shape[2]; ++z)
        for (let y = 0; y < shape[1]; ++y)
          for (let x = 0; x < shape[0]; ++x, ++i)
            if (lower[0] + x >= 100 && lower[1] + y >= 90 && lower[2] + z >= 40)
              value.data[i] = 29;
      return value;
    });
    const live = new LiveWatershed(input, [2, 0, 3]);
    const data = await live.readTile([64, 64, 32], [64, 36, 32], signal);
    expect(compute).toHaveBeenCalledWith(
      input,
      [66, 76, 21],
      [80, 44, 46],
      [2, 0, 3],
      DEFAULT_WATERSHED_OPTIONS,
      expect.any(AbortSignal),
    );
    expect(data).toBeInstanceOf(BigUint64Array);
    // Grid [1,1,1] in a [3,2,3] grid, first owned nonzero at [26,6,11].
    const id = 10n * 131072n + BigInt((11 * 36 + 6) * 64 + 26) + 1n;
    const expected = BigUint64Array.from({ length: 64 * 36 * 32 }, (_, i) => {
      const x = i % 64,
        y = Math.floor(i / 64) % 36,
        z = Math.floor(i / (64 * 36));
      return x >= 26 && y >= 6 && z >= 11 ? id : 0n;
    });
    expect(data).toEqual(expected);
    live.dispose();
  });

  it("preserves background and distinct basins even when native IDs are sparse", async () => {
    const { input } = fixture([4, 1, 1]);
    compute.mockResolvedValue({
      ...result([4, 1, 1]),
      data: Uint32Array.of(0, 900, 2, 900),
    });
    const live = new LiveWatershed(input);
    expect(await live.readTile([0, 0, 0], [4, 1, 1], signal)).toEqual(
      BigUint64Array.of(0n, 2n, 3n, 2n),
    );
    live.dispose();
  });

  it("keeps IDs stable across request order, local renumbering and recomputation without an output cache", async () => {
    const { input } = fixture();
    let label = 0;
    compute.mockImplementation(async (_input, _lower, shape) =>
      result(shape, ++label),
    );
    const live = new LiveWatershed(input);
    const second = await live.readTile([64, 0, 0], [64, 64, 32], signal);
    const first = await live.readTile([0, 0, 0], [64, 64, 32], signal);
    const revisit = await live.readTile([64, 0, 0], [64, 64, 32], signal);
    expect(first.every((n) => n === 1n)).toBe(true);
    expect(second.every((n) => n === 131073n)).toBe(true);
    expect(revisit).toEqual(second);
    expect(revisit.buffer).not.toBe(second.buffer);
    expect(compute).toHaveBeenCalledTimes(3);
    live.dispose();
  });

  it("preserves exact UINT64 IDs above Number.MAX_SAFE_INTEGER", async () => {
    const { input } = fixture([2 ** 24, 2 ** 24, 64]);
    const live = new LiveWatershed(input);
    const data = await live.readTile(
      [2 ** 24 - 64, 2 ** 24 - 64, 32],
      [64, 64, 32],
      signal,
    );
    const expected = (2n ** 37n - 1n) * 131072n + 1n;
    expect(expected).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    expect(BigInt(Number(expected))).not.toBe(expected);
    expect(data.every((n) => n === expected)).toBe(true);
    live.dispose();
  });

  it("clips the final partial block and both halos at volume boundaries", async () => {
    const { input } = fixture();
    const live = new LiveWatershed(input);
    const data = await live.readTile([128, 64, 64], [12, 36, 6], signal);
    expect(compute.mock.calls[0].slice(1, 3)).toEqual([
      [130, 76, 53],
      [20, 44, 14],
    ]);
    expect(data.length).toBe(12 * 36 * 6);
    expect(data.every((n) => n === 17n * 131072n + 1n)).toBe(true);
    live.dispose();
  });

  it("snapshots channel/options vectors and caller request arrays", async () => {
    const { input } = fixture([4, 1, 1]);
    const channels = [2, 0, 3],
      options = { ...DEFAULT_WATERSHED_OPTIONS };
    const live = new LiveWatershed(input, channels, options);
    channels.fill(999);
    options.lowThreshold = 0.8;
    const lower = [0, 0, 0],
      size = [4, 1, 1];
    const pending = live.readTile(lower, size, signal);
    lower.fill(999);
    size.fill(999);
    expect(await pending).toEqual(new BigUint64Array(4).fill(1n));
    expect(compute.mock.calls[0].slice(1, 5)).toEqual([
      [10, 20, -3],
      [4, 1, 1],
      [2, 0, 3],
      DEFAULT_WATERSHED_OPTIONS,
    ]);
    live.dispose();
  });

  it.each([
    [0, 0, 1],
    [-1, 1, 2],
    [0, 1, 4],
    [0, 1],
    [0, 1, 1.5],
  ])(
    "rejects invalid channels %j without taking input ownership",
    (...channels) => {
      const { input } = fixture();
      expect(() => new LiveWatershed(input, channels)).toThrow(
        "three distinct",
      );
      expect(input.dispose).not.toHaveBeenCalled();
      expect(compute).not.toHaveBeenCalled();
    },
  );

  it("rejects invalid thresholds and a UINT64 namespace overflow before publication", () => {
    const { input } = fixture();
    expect(
      () =>
        new LiveWatershed(input, [0, 1, 2], {
          ...DEFAULT_WATERSHED_OPTIONS,
          highThreshold: 0.5,
          lowThreshold: 0.5,
        }),
    ).toThrow("0 <= low < high");
    const huge = fixture([2 ** 27, 2 ** 27, 2 ** 20]);
    expect(() => new LiveWatershed(huge.input)).toThrow(
      "UINT64 block namespace",
    );
    expect(input.dispose).not.toHaveBeenCalled();
    expect(huge.input.dispose).not.toHaveBeenCalled();
  });

  it.each([
    { lower: [1, 0, 0], size: [64, 64, 32] },
    { lower: [-64, 0, 0], size: [64, 64, 32] },
    { lower: [192, 0, 0], size: [64, 64, 32] },
    { lower: [0, 0, 0], size: [32, 64, 32] },
    { lower: [128, 0, 0], size: [64, 64, 32] },
    { lower: [0, 0], size: [64, 64, 32] },
    { lower: [0, 0, NaN], size: [64, 64, 32] },
  ])(
    "rejects unaligned or unclipped tile $lower/$size without work",
    ({ lower, size }) => {
      const { input } = fixture();
      const live = new LiveWatershed(input);
      expect(() => live.readTile(lower, size, signal)).toThrow(
        "aligned, clipped",
      );
      expect(compute).not.toHaveBeenCalled();
      live.dispose();
    },
  );

  it("serializes work and removes canceled queued jobs before reading affinities", async () => {
    const { input } = fixture([140, 1, 1]);
    const gate = Promise.withResolvers<WatershedResult>();
    compute.mockImplementationOnce(async () => gate.promise);
    const live = new LiveWatershed(input);
    const first = live.readTile([0, 0, 0], [64, 1, 1], signal);
    const abort = new AbortController();
    const queued = live.readTile([64, 0, 0], [64, 1, 1], abort.signal);
    const rejected = expect(queued).rejects.toThrow("Offscreen");
    abort.abort(new Error("Offscreen"));
    await rejected;
    expect(compute).toHaveBeenCalledTimes(1);
    gate.resolve(result([72, 1, 1]));
    await first;
    expect(compute).toHaveBeenCalledTimes(1);
    live.dispose();
  });

  it("rejects active cancellation immediately and discards an uninterruptible late result", async () => {
    const { input } = fixture([140, 1, 1]);
    const late = Promise.withResolvers<WatershedResult>();
    compute.mockImplementationOnce(async () => late.promise);
    const onError = vi.fn();
    const live = new LiveWatershed(
      input,
      [0, 1, 2],
      DEFAULT_WATERSHED_OPTIONS,
      onError,
    );
    const abort = new AbortController();
    const first = live.readTile([0, 0, 0], [64, 1, 1], abort.signal);
    const rejected = expect(first).rejects.toThrow("Offscreen");
    const next = live.readTile([64, 0, 0], [64, 1, 1], signal);
    abort.abort(new Error("Offscreen"));
    await rejected;
    expect(compute).toHaveBeenCalledTimes(1);
    late.resolve(result([72, 1, 1], 999));
    expect((await next).every((n) => n === 131073n)).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    live.dispose();
  });

  it("source invalidation aborts active and queued reads, releases input once, and rejects late data", async () => {
    const { input, changed } = fixture([140, 1, 1]);
    const gate = Promise.withResolvers<WatershedResult>();
    compute.mockImplementation(async (...args) =>
      raceWithAbort(gate.promise, args[5]),
    );
    const onError = vi.fn();
    const live = new LiveWatershed(
      input,
      [0, 1, 2],
      DEFAULT_WATERSHED_OPTIONS,
      onError,
    );
    const first = live.readTile([0, 0, 0], [64, 1, 1], signal);
    const queued = live.readTile([64, 0, 0], [64, 1, 1], signal);
    const firstRejected = expect(first).rejects.toThrow("stopped");
    const queuedRejected = expect(queued).rejects.toThrow("stopped");
    changed.abort(new Error("Source replaced"));
    await Promise.all([firstRejected, queuedRejected]);
    gate.resolve(result([72, 1, 1]));
    expect(live.signal.aborted).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(input.dispose).toHaveBeenCalledTimes(1);
    live.dispose();
    expect(input.dispose).toHaveBeenCalledTimes(1);
    expect(() => live.readTile([0, 0, 0], [64, 1, 1], signal)).toThrow(
      "stopped",
    );
  });

  it("surfaces a tile failure and continues later demand rather than silently swallowing it", async () => {
    const { input } = fixture([140, 1, 1]);
    compute.mockRejectedValueOnce(new Error("Invalid affinity probabilities"));
    const onError = vi.fn();
    const live = new LiveWatershed(
      input,
      [0, 1, 2],
      DEFAULT_WATERSHED_OPTIONS,
      onError,
    );
    await expect(live.readTile([0, 0, 0], [64, 1, 1], signal)).rejects.toThrow(
      "Invalid affinity",
    );
    expect((await live.readTile([64, 0, 0], [64, 1, 1], signal))[0]).toBe(
      131073n,
    );
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Invalid affinity probabilities" }),
    );
    live.dispose();
  });

  it("bounds queued metadata and reclaims canceled slots while active work is blocked", async () => {
    const { input } = fixture([4, 1, 1]);
    const gate = Promise.withResolvers<WatershedResult>();
    compute.mockImplementation(async (...args) =>
      raceWithAbort(gate.promise, args[5]),
    );
    const live = new LiveWatershed(input);
    const abort = new AbortController();
    const pending = Array.from({ length: 128 }, () =>
      live.readTile([0, 0, 0], [4, 1, 1], abort.signal).catch((error) => error),
    );
    expect(() => live.readTile([0, 0, 0], [4, 1, 1], signal)).toThrow(
      "Too many pending",
    );
    abort.abort(new Error("Navigation changed"));
    const errors = await Promise.all(pending);
    expect(
      errors.every((error) => error.message === "Navigation changed"),
    ).toBe(true);
    expect(compute).toHaveBeenCalledTimes(1);
    compute.mockImplementation(async (_input, _lower, shape) => result(shape));
    expect(await live.readTile([0, 0, 0], [4, 1, 1], signal)).toEqual(
      new BigUint64Array(4).fill(1n),
    );
    live.dispose();
  });
});
