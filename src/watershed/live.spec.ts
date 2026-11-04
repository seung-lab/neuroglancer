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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  vi.useFakeTimers();
  compute.mockReset();
  compute.mockImplementation(async (_input, _lower, shape) => result(shape));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function settle() {
  await vi.advanceTimersByTimeAsync(150);
}

describe("whole-viewport live watershed", () => {
  it("publishes full-domain metadata but display requests never initiate watershed", async () => {
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
    expect(await live.readTile([0, 0, 0], [64, 64, 1], signal)).toEqual(
      new BigUint64Array(64 * 64),
    );
    await settle();
    expect(input.readRegion).not.toHaveBeenCalled();
    expect(compute).not.toHaveBeenCalled();
    live.dispose();
  });

  it("runs one watershed for the full region and preserves a connected label across display chunks", async () => {
    const { input } = fixture([140, 1, 1]);
    const live = new LiveWatershed(input);
    const changed = vi.fn();
    live.changed.add(changed);
    live.setRegion([10, 20, -3], [140, 1, 1]);
    expect(await live.readTile([0, 0, 0], [64, 1, 1], signal)).toEqual(
      new BigUint64Array(64),
    );
    await settle();
    for (const [lower, shape] of [
      [
        [0, 0, 0],
        [64, 1, 1],
      ],
      [
        [64, 0, 0],
        [64, 1, 1],
      ],
      [
        [128, 0, 0],
        [12, 1, 1],
      ],
    ]) {
      expect(await live.readTile(lower, shape, signal)).toEqual(
        new BigUint64Array(shape[0]).fill(7n),
      );
    }
    expect(compute).toHaveBeenCalledExactlyOnceWith(
      input,
      [10, 20, -3],
      [140, 1, 1],
      [0, 1, 2],
      DEFAULT_WATERSHED_OPTIONS,
      expect.any(AbortSignal),
    );
    expect(changed).toHaveBeenCalledTimes(2);
    live.dispose();
  });

  it("copies XYZ intersections from one halo tensor, with zeros outside it", async () => {
    const { input } = fixture();
    compute.mockImplementation(async (_input, _lower, shape) => ({
      ...result(shape),
      data: Uint32Array.from(
        { length: shape.reduce((a, b) => a * b) },
        (_, i) => i + 1,
      ),
    }));
    const live = new LiveWatershed(input);
    live.setRegion([80, 70, 30], [20, 10, 12]);
    await settle();
    expect(compute.mock.calls[0].slice(1, 3)).toEqual([
      [72, 62, 22],
      [36, 26, 28],
    ]);
    const data = await live.readTile([64, 64, 32], [64, 36, 32], signal);
    const expected = BigUint64Array.from({ length: 64 * 36 * 32 }, (_, i) => {
      const x = (i % 64) + 74,
        y = (Math.floor(i / 64) % 36) + 84,
        z = Math.floor(i / (64 * 36)) + 29;
      if (x < 72 || x >= 108 || y < 62 || y >= 88 || z < 22 || z >= 50)
        return 0n;
      return BigInt(((z - 22) * 26 + y - 62) * 36 + x - 72 + 1);
    });
    expect(data).toEqual(expected);
    expect(compute).toHaveBeenCalledTimes(1);
    live.dispose();
  });

  it("clips the region halo at native bounds rather than adding padding", async () => {
    const { input } = fixture();
    const live = new LiveWatershed(input);
    live.setRegion([145, 118, 65], [5, 2, 2]);
    await settle();
    expect(compute.mock.calls[0].slice(1, 3)).toEqual([
      [137, 110, 57],
      [13, 10, 10],
    ]);
    const edge = await live.readTile([128, 64, 64], [12, 36, 6], signal);
    expect(edge[0]).toBe(0n);
    expect(edge.at(-1)).toBe(7n);
    live.dispose();
  });

  it("keeps native basin IDs and background, returning private display copies without recomputation", async () => {
    const { input } = fixture([4, 1, 1]);
    const native = Uint32Array.of(0, 900, 0xffffffff, 900);
    compute.mockResolvedValue({ ...result([4, 1, 1]), data: native });
    const live = new LiveWatershed(input);
    live.setRegion([10, 20, -3], [4, 1, 1]);
    await settle();
    const first = await live.readTile([0, 0, 0], [4, 1, 1], signal);
    expect(first).toEqual(BigUint64Array.of(0n, 900n, 0xffffffffn, 900n));
    first.fill(123n);
    for (let i = 0; i < 140; ++i)
      expect(await live.readTile([0, 0, 0], [4, 1, 1], signal)).toEqual(
        BigUint64Array.of(0n, 900n, 0xffffffffn, 900n),
      );
    expect(native).toEqual(Uint32Array.of(0, 900, 0xffffffff, 900));
    expect(compute).toHaveBeenCalledTimes(1);
    live.dispose();
  });

  it.each([1, 2])(
    "retains automatic scalar duplication for %s input channels",
    async (channelCount) => {
      const { input } = fixture([4, 1, 1]);
      const live = new LiveWatershed({ ...input, channelCount });
      live.setRegion([10, 20, -3], [4, 1, 1]);
      await settle();
      expect(compute.mock.calls[0][3]).toEqual([0, 0, 0]);
      expect(await live.readTile([0, 0, 0], [4, 1, 1], signal)).toEqual(
        new BigUint64Array(4).fill(7n),
      );
      live.dispose();
    },
  );

  it("snapshots channels, optional mask options and region vectors", async () => {
    const { input } = fixture([140, 1, 1]);
    const channels = [2, 0, 1],
      options = { ...DEFAULT_WATERSHED_OPTIONS, maskThreshold: 0.3 };
    const live = new LiveWatershed(input, channels, options);
    channels.fill(999);
    options.maskThreshold = 1;
    const lower = [74, 20, -3],
      shape = [8, 1, 1];
    live.setRegion(lower, shape);
    lower.fill(999);
    shape.fill(999);
    await settle();
    expect(compute.mock.calls[0].slice(1, 5)).toEqual([
      [66, 20, -3],
      [24, 1, 1],
      [2, 0, 1],
      { ...DEFAULT_WATERSHED_OPTIONS, maskThreshold: 0.3 },
    ]);
    live.dispose();
  });

  it("debounces navigation and ignores unchanged bounds without aborting active work", async () => {
    const { input } = fixture([140, 1, 1]);
    const gate = Promise.withResolvers<WatershedResult>();
    compute.mockImplementationOnce(async () => gate.promise);
    const live = new LiveWatershed(input);
    live.setRegion([10, 20, -3], [8, 1, 1]);
    await vi.advanceTimersByTimeAsync(100);
    live.setRegion([74, 20, -3], [8, 1, 1]);
    await vi.advanceTimersByTimeAsync(149);
    expect(compute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    live.setRegion([74, 20, -3], [8, 1, 1]);
    await settle();
    expect(compute).toHaveBeenCalledTimes(1);
    expect(compute.mock.calls[0][5].aborted).toBe(false);
    gate.resolve(result([24, 1, 1]));
    await vi.advanceTimersByTimeAsync(0);
    live.setRegion([74, 20, -3], [8, 1, 1]);
    await settle();
    expect(compute).toHaveBeenCalledTimes(1);
    live.dispose();
  });

  it.each([0, 1, 2])(
    "reuses completed labels while moving to either halo boundary on axis %s",
    async (axis) => {
      const { input } = fixture([64, 64, 64]);
      const live = new LiveWatershed(input);
      const changed = vi.fn();
      live.changed.add(changed);
      const lower = [34, 44, 21],
        shape = [8, 8, 1];
      live.setRegion(lower, shape);
      await settle();
      const labels = await live.readTile([0, 0, 0], [64, 64, 32], signal);
      expect(labels.some((x) => x === 7n)).toBe(true);
      for (const delta of [-8, 8, 0]) {
        const next = [...lower];
        next[axis] += delta;
        live.setRegion(next, shape);
        const retained = await live.readTile([0, 0, 0], [64, 64, 32], signal);
        expect(retained.every((n, i) => n === labels[i])).toBe(true);
        await settle();
        expect(compute).toHaveBeenCalledTimes(1);
        expect(compute.mock.calls[0][5].aborted).toBe(false);
        expect(changed).toHaveBeenCalledTimes(2);
      }
      live.dispose();
    },
  );

  it.each([0, 1, 2])(
    "recomputes when the visible region extends beyond either halo boundary on axis %s",
    async (axis) => {
      for (const delta of [-9, 9]) {
        compute.mockClear();
        const { input } = fixture([64, 64, 64]);
        const live = new LiveWatershed(input);
        const lower = [34, 44, 21],
          shape = [8, 8, 1];
        live.setRegion(lower, shape);
        await settle();
        const next = [...lower];
        next[axis] += delta;
        live.setRegion(next, shape);
        expect(await live.readTile([0, 0, 0], [64, 64, 32], signal)).toEqual(
          new BigUint64Array(64 * 64 * 32),
        );
        await vi.advanceTimersByTimeAsync(149);
        expect(compute).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(compute).toHaveBeenCalledTimes(2);
        expect(compute.mock.calls[1].slice(1, 3)).toEqual([
          next.map((n) => n - 8),
          [24, 24, 17],
        ]);
        expect(
          (await live.readTile([0, 0, 0], [64, 64, 32], signal)).some(
            (x) => x === 7n,
          ),
        ).toBe(true);
        live.dispose();
      }
    },
  );

  it("reuses a clipped halo with negative native bounds until the first uncovered slice", async () => {
    const { input } = fixture([32, 32, 40]);
    const live = new LiveWatershed(input);
    live.setRegion([10, 20, -3], [8, 8, 1]);
    await settle();
    expect(compute.mock.calls[0].slice(1, 3)).toEqual([
      [10, 20, -3],
      [16, 16, 9],
    ]);
    live.setRegion([10, 20, 5], [8, 8, 1]);
    await settle();
    expect(compute).toHaveBeenCalledTimes(1);
    const labels = await live.readTile([0, 0, 0], [32, 32, 32], signal);
    expect(labels[8 * 32 * 32]).toBe(7n);
    live.setRegion([10, 20, 6], [8, 8, 1]);
    await settle();
    expect(compute).toHaveBeenCalledTimes(2);
    expect(compute.mock.calls[1].slice(1, 3)).toEqual([
      [10, 20, -2],
      [16, 16, 17],
    ]);
    live.dispose();
  });

  it("does not treat an unfinished halo as a reusable result", async () => {
    const { input } = fixture([64, 64, 64]);
    const gate = Promise.withResolvers<WatershedResult>();
    compute.mockImplementationOnce(async () => gate.promise);
    const live = new LiveWatershed(input);
    live.setRegion([34, 44, 21], [8, 8, 1]);
    await settle();
    live.setRegion([34, 44, 22], [8, 8, 1]);
    await settle();
    expect(compute).toHaveBeenCalledTimes(1);
    expect(compute.mock.calls[0][5].aborted).toBe(true);
    gate.resolve(result([24, 24, 17], 999));
    await vi.advanceTimersByTimeAsync(0);
    expect(compute).toHaveBeenCalledTimes(2);
    expect(compute.mock.calls[1].slice(1, 3)).toEqual([
      [26, 36, 14],
      [24, 24, 17],
    ]);
    const labels = await live.readTile([0, 0, 0], [64, 64, 32], signal);
    expect(labels.some((x) => x === 7n)).toBe(true);
    expect(labels.some((x) => x === 999n)).toBe(false);
    live.dispose();
  });

  it("reuses a completed region at the voxel cap without demanding another halo", async () => {
    const { input } = fixture([512, 512, 512]);
    const onError = vi.fn();
    const live = new LiveWatershed(
      input,
      [0, 1, 2],
      DEFAULT_WATERSHED_OPTIONS,
      onError,
    );
    live.setRegion([74, 84, 61], [112, 112, 112]);
    await settle();
    expect(compute.mock.calls[0].slice(1, 3)).toEqual([
      [66, 76, 53],
      [128, 128, 128],
    ]);
    live.setRegion([66, 76, 53], [128, 128, 128]);
    await settle();
    expect(compute).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    live.dispose();
  });

  it.each([
    { lower: [34.5, 44, 21], shape: [8, 8, 1] },
    { lower: [34, 44, 21], shape: [0, 8, 1] },
    { lower: [34, 44, 21], shape: [8, 8] },
    { lower: [34, 44, 21], shape: [8, 8, NaN] },
  ])(
    "does not reuse completed labels for invalid viewport bounds %j",
    async ({ lower, shape }) => {
      const { input } = fixture([64, 64, 64]);
      const onError = vi.fn();
      const live = new LiveWatershed(
        input,
        [0, 1, 2],
        DEFAULT_WATERSHED_OPTIONS,
        onError,
      );
      live.setRegion([34, 44, 21], [8, 8, 1]);
      await settle();
      live.setRegion(lower, shape);
      await settle();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Watershed viewport must be inside the native source bounds",
        }),
      );
      expect(compute).toHaveBeenCalledTimes(1);
      expect(await live.readTile([0, 0, 0], [64, 64, 32], signal)).toEqual(
        new BigUint64Array(64 * 64 * 32),
      );
      live.dispose();
    },
  );

  it("still retires a completed reused result when the input is invalidated", async () => {
    const { input, changed } = fixture([64, 64, 64]);
    const onError = vi.fn();
    const live = new LiveWatershed(
      input,
      [0, 1, 2],
      DEFAULT_WATERSHED_OPTIONS,
      onError,
    );
    live.setRegion([34, 44, 21], [8, 8, 1]);
    await settle();
    live.setRegion([34, 44, 29], [8, 8, 1]);
    changed.abort(new Error("Source replaced"));
    await settle();
    expect(compute).toHaveBeenCalledTimes(1);
    expect(live.signal.aborted).toBe(true);
    expect(input.dispose).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: "Watershed affinity source changed; add the layer again",
      }),
    );
    expect(() => live.setRegion([34, 44, 21], [8, 8, 1])).toThrow("stopped");
  });

  it("clears stale labels immediately and waits for physical completion before running only the latest region", async () => {
    const { input } = fixture([140, 1, 1]);
    const gate = Promise.withResolvers<WatershedResult>();
    compute.mockImplementationOnce(async () => gate.promise);
    const onError = vi.fn();
    const live = new LiveWatershed(
      input,
      [0, 1, 2],
      DEFAULT_WATERSHED_OPTIONS,
      onError,
    );
    live.setRegion([10, 20, -3], [8, 1, 1]);
    await settle();
    const firstSignal = compute.mock.calls[0][5];
    for (let i = 0; i < 100; ++i)
      live.setRegion([74 + (i % 2), 20, -3], [8, 1, 1]);
    live.setRegion([138, 20, -3], [8, 1, 1]);
    await settle();
    expect(firstSignal.aborted).toBe(true);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(await live.readTile([0, 0, 0], [64, 1, 1], signal)).toEqual(
      new BigUint64Array(64),
    );
    gate.resolve(result([16, 1, 1], 999));
    await vi.advanceTimersByTimeAsync(0);
    expect(compute).toHaveBeenCalledTimes(2);
    expect(compute.mock.calls[1].slice(1, 3)).toEqual([
      [130, 20, -3],
      [20, 1, 1],
    ]);
    expect(await live.readTile([128, 0, 0], [12, 1, 1], signal)).toEqual(
      new BigUint64Array(12).fill(7n),
    );
    expect(onError).not.toHaveBeenCalled();
    live.dispose();
  });

  it("clears completed results while hidden, cancels debounce, and resumes on the next visible region", async () => {
    const { input } = fixture([4, 1, 1]);
    const live = new LiveWatershed(input);
    live.setRegion([10, 20, -3], [4, 1, 1]);
    await settle();
    live.setRegion();
    expect(await live.readTile([0, 0, 0], [4, 1, 1], signal)).toEqual(
      new BigUint64Array(4),
    );
    live.setRegion([10, 20, -3], [4, 1, 1]);
    live.setRegion();
    await settle();
    expect(compute).toHaveBeenCalledTimes(1);
    expect(live.signal.aborted).toBe(false);
    live.setRegion([10, 20, -3], [4, 1, 1]);
    await settle();
    expect(compute).toHaveBeenCalledTimes(2);
    live.dispose();
  });

  it("reports an oversized whole region without splitting it, then recovers on zoom in", async () => {
    const { input } = fixture([512, 512, 64]);
    const onError = vi.fn();
    const live = new LiveWatershed(
      input,
      [0, 1, 2],
      DEFAULT_WATERSHED_OPTIONS,
      onError,
    );
    live.setRegion([10, 20, -3], [512, 512, 64]);
    await settle();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("2**21") }),
    );
    expect(compute).not.toHaveBeenCalled();
    expect(await live.readTile([0, 0, 0], [64, 64, 32], signal)).toEqual(
      new BigUint64Array(64 * 64 * 32),
    );
    live.setRegion([10, 20, -3], [8, 8, 8]);
    await settle();
    expect(compute).toHaveBeenCalledTimes(1);
    expect(live.signal.aborted).toBe(false);
    live.dispose();
  });

  it("reports current computation failures, clears the result and recovers on navigation", async () => {
    const { input } = fixture([140, 1, 1]);
    compute.mockRejectedValueOnce(new Error("Invalid affinity probabilities"));
    const onError = vi.fn();
    const live = new LiveWatershed(
      input,
      [0, 1, 2],
      DEFAULT_WATERSHED_OPTIONS,
      onError,
    );
    live.setRegion([10, 20, -3], [8, 1, 1]);
    await settle();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Invalid affinity probabilities" }),
    );
    expect(await live.readTile([0, 0, 0], [64, 1, 1], signal)).toEqual(
      new BigUint64Array(64),
    );
    live.setRegion([74, 20, -3], [8, 1, 1]);
    await settle();
    expect(compute).toHaveBeenCalledTimes(2);
    expect((await live.readTile([64, 0, 0], [64, 1, 1], signal))[0]).toBe(7n);
    live.dispose();
  });

  it("aborts on input invalidation and never publishes a late kernel", async () => {
    const { input, changed } = fixture([4, 1, 1]);
    const gate = Promise.withResolvers<WatershedResult>();
    compute.mockImplementationOnce(async () => gate.promise);
    const onError = vi.fn();
    const live = new LiveWatershed(
      input,
      [0, 1, 2],
      DEFAULT_WATERSHED_OPTIONS,
      onError,
    );
    live.setRegion([10, 20, -3], [4, 1, 1]);
    await settle();
    changed.abort(new Error("Source replaced"));
    expect(live.signal.aborted).toBe(true);
    expect(compute.mock.calls[0][5].aborted).toBe(true);
    gate.resolve(result([4, 1, 1]));
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(input.dispose).toHaveBeenCalledTimes(1);
    expect(() => live.readTile([0, 0, 0], [4, 1, 1], signal)).toThrow(
      "stopped",
    );
    live.dispose();
    expect(input.dispose).toHaveBeenCalledTimes(1);
  });

  it("allows a changed listener to dispose during setRegion without starting work", async () => {
    const { input } = fixture([4, 1, 1]);
    const live = new LiveWatershed(input);
    live.changed.add(() => live.dispose());
    live.setRegion([10, 20, -3], [4, 1, 1]);
    await settle();
    expect(compute).not.toHaveBeenCalled();
    expect(input.dispose).toHaveBeenCalledTimes(1);
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
    "rejects invalid display bounds $lower/$size without computing",
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

  it.each([
    [-1, 1, 2],
    [0, 1, 4],
    [0, 1],
    [0, 1, 1.5],
  ])(
    "rejects invalid channels %j before taking input ownership",
    (...channels) => {
      const { input } = fixture();
      expect(() => new LiveWatershed(input, channels)).toThrow(
        "three in-bounds",
      );
      expect(input.dispose).not.toHaveBeenCalled();
    },
  );
});
