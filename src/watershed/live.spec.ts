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
  type WatershedOptions,
  type WatershedResult,
} from "#src/watershed/base.js";
import type { PreparedAffinityInput } from "#src/watershed/input.js";
import {
  LIVE_WATERSHED_DEBOUNCE_MS,
  LIVE_WATERSHED_HALO_XYZ,
  LiveWatershed,
  type CompletedWatershedSnapshot,
} from "#src/watershed/live.js";
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
  await vi.advanceTimersByTimeAsync(LIVE_WATERSHED_DEBOUNCE_MS);
}

describe("live watershed parameter editing", () => {
  it.each([0, 3, 8, 17])(
    "uses constructor halo %s isotropically and retains the legacy default export",
    async (halo) => {
      const { input } = fixture();
      const live = new LiveWatershed(
        input,
        [0, 1, 2],
        DEFAULT_WATERSHED_OPTIONS,
        undefined,
        halo,
      );
      live.setRegion([80, 70, 30], [20, 10, 12]);
      await settle();
      expect(compute.mock.calls[0].slice(0, 5)).toEqual([
        input,
        [80, 70, 30].map((n) => n - halo),
        [20, 10, 12].map((n) => n + 2 * halo),
        [0, 1, 2],
        DEFAULT_WATERSHED_OPTIONS,
      ]);
      expect(LIVE_WATERSHED_HALO_XYZ).toEqual([8, 8, 8]);
      expect(Object.isFrozen(LIVE_WATERSHED_HALO_XYZ)).toBe(true);
      live.dispose();
    },
  );

  it.each([0, 3, 8, 17])(
    "clips edited halo %s at both source boundaries, including negative native coordinates",
    async (halo) => {
      const { input } = fixture();
      const live = new LiveWatershed(input);
      live.setRegion([10, 20, -3], [5, 2, 2]);
      live.setParameters([0, 1, 2], DEFAULT_WATERSHED_OPTIONS, halo);
      await settle();
      expect(compute).toHaveBeenCalledTimes(1);
      expect(compute.mock.calls[0].slice(1, 3)).toEqual([
        [10, 20, -3],
        [5, 2, 2].map((n) => n + halo),
      ]);
      live.setRegion([145, 118, 65], [5, 2, 2]);
      await settle();
      expect(compute.mock.calls[1].slice(1, 3)).toEqual([
        [145, 118, 65].map((n) => n - halo),
        [5, 2, 2].map((n) => n + halo),
      ]);
      live.dispose();
    },
  );

  it.each([
    ["highThreshold", 0.8],
    ["lowThreshold", 0.1],
    ["sizeThreshold", 0],
    ["dustThreshold", 0],
    ["maskThreshold", 0],
    ["aggThreshold", 0],
  ] as const)(
    "invalidates completed labels for a changed %s even after containment reuse",
    async (key, value) => {
      const { input } = fixture([80, 1, 1]);
      const live = new LiveWatershed(input);
      const changed = vi.fn();
      live.changed.add(changed);
      expect(live.epoch).toBe(0);
      live.setRegion([34, 20, -3], [8, 1, 1]);
      expect(live.epoch).toBe(1);
      expect(live.getCompletedSnapshot()).toBeUndefined();
      await settle();
      const completed = live.getCompletedSnapshot();
      expect(completed?.epoch).toBe(1);
      live.setRegion([42, 20, -3], [8, 1, 1]);
      expect(live.epoch).toBe(1);
      expect(live.getCompletedSnapshot()).toEqual(completed);
      expect(compute).toHaveBeenCalledTimes(1);
      expect(changed).toHaveBeenCalledTimes(2);
      const options = { ...DEFAULT_WATERSHED_OPTIONS, [key]: value };
      live.setParameters([0, 1, 2], options);
      expect(live.epoch).toBe(2);
      expect(live.getCompletedSnapshot()).toBeUndefined();
      expect(changed).toHaveBeenCalledTimes(3);
      expect(await live.readTile([0, 0, 0], [64, 1, 1], signal)).toEqual(
        new BigUint64Array(64),
      );
      // Re-reporting identical bounds must not cancel the parameter refresh.
      live.setRegion([42, 20, -3], [8, 1, 1]);
      await vi.advanceTimersByTimeAsync(149);
      expect(compute).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(compute).toHaveBeenCalledTimes(2);
      expect(compute.mock.calls[1].slice(0, 5)).toEqual([
        input,
        [34, 20, -3],
        [24, 1, 1],
        [0, 1, 2],
        options,
      ]);
      expect(changed).toHaveBeenCalledTimes(4);
      expect(live.epoch).toBe(2);
      expect(live.getCompletedSnapshot()?.epoch).toBe(2);
      expect((await live.readTile([0, 0, 0], [64, 1, 1], signal))[32]).toBe(7n);
      expect(input.dispose).not.toHaveBeenCalled();
      live.dispose();
    },
  );

  it.each([0, 3, 17])(
    "preserves navigation containment reuse for unchanged parameters with halo %s",
    async (halo) => {
      const { input } = fixture([140, 1, 1]);
      const live = new LiveWatershed(
        input,
        [0, 1, 2],
        DEFAULT_WATERSHED_OPTIONS,
        undefined,
        halo,
      );
      live.setRegion([50, 20, -3], [8, 1, 1]);
      await settle();
      live.setRegion([50 - halo, 20, -3], [8, 1, 1]);
      live.setRegion([50 + halo, 20, -3], [8, 1, 1]);
      await settle();
      expect(compute).toHaveBeenCalledTimes(1);
      expect(live.epoch).toBe(1);
      expect(live.getCompletedSnapshot()?.epoch).toBe(1);
      live.setRegion([49 - halo, 20, -3], [8, 1, 1]);
      expect(live.epoch).toBe(2);
      expect(live.getCompletedSnapshot()).toBeUndefined();
      await settle();
      expect(compute).toHaveBeenCalledTimes(2);
      expect(live.getCompletedSnapshot()?.epoch).toBe(2);
      expect(compute.mock.calls[1].slice(1, 3)).toEqual([
        [49 - 2 * halo, 20, -3],
        [8 + 2 * halo, 1, 1],
      ]);
      live.dispose();
    },
  );

  it("invalidates a halo-only change even when clipping leaves identical bounds", async () => {
    const { input } = fixture([4, 1, 1]);
    const live = new LiveWatershed(
      input,
      [0, 1, 2],
      DEFAULT_WATERSHED_OPTIONS,
      undefined,
      3,
    );
    const changed = vi.fn();
    live.changed.add(changed);
    live.setRegion([10, 20, -3], [4, 1, 1]);
    await settle();
    live.setParameters([0, 1, 2], { ...DEFAULT_WATERSHED_OPTIONS }, 3);
    await settle();
    expect(compute).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(live.epoch).toBe(1);
    expect(live.getCompletedSnapshot()?.epoch).toBe(1);
    // Omitting halo resets the custom constructor value to the default eight.
    live.setParameters([0, 1, 2], DEFAULT_WATERSHED_OPTIONS);
    expect(live.epoch).toBe(2);
    expect(live.getCompletedSnapshot()).toBeUndefined();
    expect(await live.readTile([0, 0, 0], [4, 1, 1], signal)).toEqual(
      new BigUint64Array(4),
    );
    await settle();
    expect(compute).toHaveBeenCalledTimes(2);
    expect(compute.mock.calls[1].slice(1, 3)).toEqual(
      compute.mock.calls[0].slice(1, 3),
    );
    expect(changed).toHaveBeenCalledTimes(4);
    expect(live.epoch).toBe(2);
    expect(live.getCompletedSnapshot()?.epoch).toBe(2);
    live.dispose();
  });

  it("snapshots edited channels/options and removes optional stages when omitted", async () => {
    const { input } = fixture([80, 1, 1]);
    const live = new LiveWatershed(input);
    live.setRegion([34, 20, -3], [8, 1, 1]);
    await settle();
    const channels = [2, 0, 1];
    const options = {
      ...DEFAULT_WATERSHED_OPTIONS,
      maskThreshold: 0.3,
      aggThreshold: 0,
    };
    live.setParameters(channels, options, 3);
    channels.fill(999);
    options.maskThreshold = 1;
    options.aggThreshold = 1;
    await settle();
    expect(compute.mock.calls[1].slice(0, 5)).toEqual([
      input,
      [31, 20, -3],
      [14, 1, 1],
      [2, 0, 1],
      { ...DEFAULT_WATERSHED_OPTIONS, maskThreshold: 0.3, aggThreshold: 0 },
    ]);
    expect(Object.isFrozen(compute.mock.calls[1][3])).toBe(true);
    expect(Object.isFrozen(compute.mock.calls[1][4])).toBe(true);
    live.setParameters([2, 0, 1], DEFAULT_WATERSHED_OPTIONS);
    await settle();
    expect(compute.mock.calls[2].slice(0, 5)).toEqual([
      input,
      [26, 20, -3],
      [24, 1, 1],
      [2, 0, 1],
      DEFAULT_WATERSHED_OPTIONS,
    ]);
    expect(input.readRegion).not.toHaveBeenCalled();
    expect(input.dispose).not.toHaveBeenCalled();
    live.dispose();
  });

  it("treats equal values and absent/undefined optional stages as a no-op while pending, running and completed", async () => {
    const { input } = fixture([4, 1, 1]);
    const gate = Promise.withResolvers<WatershedResult>();
    compute.mockImplementationOnce(async () => gate.promise);
    const live = new LiveWatershed(input);
    const changed = vi.fn();
    live.changed.add(changed);
    const noOp = () =>
      live.setParameters(
        [0, 1, 2],
        {
          ...DEFAULT_WATERSHED_OPTIONS,
          maskThreshold: undefined,
          aggThreshold: undefined,
        },
        8,
      );
    live.setRegion([10, 20, -3], [4, 1, 1]);
    await vi.advanceTimersByTimeAsync(100);
    noOp();
    await vi.advanceTimersByTimeAsync(50);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(live.epoch).toBe(1);
    expect(live.getCompletedSnapshot()).toBeUndefined();
    noOp();
    await settle();
    expect(live.epoch).toBe(1);
    expect(live.getCompletedSnapshot()).toBeUndefined();
    expect(compute.mock.calls[0][5].aborted).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
    gate.resolve(result([4, 1, 1]));
    await vi.advanceTimersByTimeAsync(0);
    noOp();
    await settle();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(live.epoch).toBe(1);
    expect(live.getCompletedSnapshot()?.epoch).toBe(1);
    expect(await live.readTile([0, 0, 0], [4, 1, 1], signal)).toEqual(
      new BigUint64Array(4).fill(7n),
    );
    live.dispose();
  });

  it("serializes physical kernels and keeps only the latest parameters and requested view", async () => {
    const { input } = fixture([140, 1, 1]);
    const onError = vi.fn();
    const live = new LiveWatershed(
      input,
      [0, 1, 2],
      DEFAULT_WATERSHED_OPTIONS,
      onError,
    );
    live.setRegion([34, 20, -3], [8, 1, 1]);
    await settle();
    const first = Promise.withResolvers<WatershedResult>();
    const second = Promise.withResolvers<WatershedResult>();
    compute.mockImplementationOnce(async () => first.promise);
    compute.mockImplementationOnce(async () => second.promise);
    const options = { ...DEFAULT_WATERSHED_OPTIONS, highThreshold: 0.8 };
    live.setParameters([2, 1, 0], options, 0);
    expect(await live.readTile([0, 0, 0], [64, 1, 1], signal)).toEqual(
      new BigUint64Array(64),
    );
    await settle();
    expect(compute).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 100; ++i)
      live.setParameters([0, 1, 2], {
        ...DEFAULT_WATERSHED_OPTIONS,
        sizeThreshold: i,
      });
    const latestOptions = {
      ...DEFAULT_WATERSHED_OPTIONS,
      highThreshold: 0.7,
      maskThreshold: 0.4,
      aggThreshold: 0,
    };
    live.setParameters([1, 2, 0], latestOptions, 3);
    live.setRegion([42, 20, -3], [8, 1, 1]);
    await settle();
    expect(compute.mock.calls[1][5].aborted).toBe(true);
    expect(compute).toHaveBeenCalledTimes(2);
    // The in-flight invocation retains its own original configuration.
    expect(compute.mock.calls[1].slice(0, 5)).toEqual([
      input,
      [34, 20, -3],
      [8, 1, 1],
      [2, 1, 0],
      options,
    ]);
    first.resolve(result([8, 1, 1], 999));
    await vi.advanceTimersByTimeAsync(0);
    expect(compute).toHaveBeenCalledTimes(3);
    expect(compute.mock.calls[2].slice(0, 5)).toEqual([
      input,
      [39, 20, -3],
      [14, 1, 1],
      [1, 2, 0],
      latestOptions,
    ]);
    expect(await live.readTile([0, 0, 0], [64, 1, 1], signal)).toEqual(
      new BigUint64Array(64),
    );
    const finalOptions = { ...DEFAULT_WATERSHED_OPTIONS, highThreshold: 0.6 };
    live.setRegion([100, 20, -3], [8, 1, 1]);
    live.setParameters([2, 0, 1], finalOptions, 1);
    await settle();
    expect(compute.mock.calls[2][5].aborted).toBe(true);
    expect(compute).toHaveBeenCalledTimes(3);
    second.reject(new Error("Obsolete kernel failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(compute).toHaveBeenCalledTimes(4);
    expect(compute.mock.calls[3].slice(0, 5)).toEqual([
      input,
      [99, 20, -3],
      [10, 1, 1],
      [2, 0, 1],
      finalOptions,
    ]);
    expect((await live.readTile([64, 0, 0], [64, 1, 1], signal))[30]).toBe(7n);
    expect(onError).not.toHaveBeenCalled();
    expect(input.dispose).not.toHaveBeenCalled();
    live.dispose();
  });

  it("waits for the full debounce even if an aborted kernel finishes sooner", async () => {
    const { input } = fixture([80, 1, 1]);
    const gate = Promise.withResolvers<WatershedResult>();
    compute.mockImplementationOnce(async () => gate.promise);
    const live = new LiveWatershed(input);
    live.setRegion([34, 20, -3], [8, 1, 1]);
    await settle();
    live.setParameters([2, 1, 0], DEFAULT_WATERSHED_OPTIONS, 0);
    gate.resolve(result([24, 1, 1], 999));
    await vi.advanceTimersByTimeAsync(149);
    expect(compute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(compute).toHaveBeenCalledTimes(2);
    expect(compute.mock.calls[1].slice(1, 5)).toEqual([
      [34, 20, -3],
      [8, 1, 1],
      [2, 1, 0],
      DEFAULT_WATERSHED_OPTIONS,
    ]);
    live.dispose();
  });

  const invalidEdits: {
    name: string;
    channels?: number[];
    options?: Partial<WatershedOptions>;
    halo?: number;
  }[] = [
    { name: "negative channel", channels: [-1, 1, 2] },
    { name: "out-of-bounds channel", channels: [0, 1, 4] },
    { name: "missing channel", channels: [0, 1] },
    { name: "fractional channel", channels: [0, 1, 1.5] },
    { name: "non-finite channel", channels: [0, 1, NaN] },
    {
      name: "mask channel used as affinity",
      channels: [0, 1, 3],
      options: { maskThreshold: 0 },
    },
    { name: "non-finite high threshold", options: { highThreshold: NaN } },
    { name: "high threshold above one", options: { highThreshold: 1.1 } },
    { name: "negative low threshold", options: { lowThreshold: -0.1 } },
    { name: "unordered thresholds", options: { lowThreshold: 0.9 } },
    {
      name: "float32-equal thresholds",
      options: { highThreshold: 0.5, lowThreshold: 0.5 - Number.EPSILON },
    },
    { name: "fractional size", options: { sizeThreshold: 0.5 } },
    { name: "negative dust", options: { dustThreshold: -1 } },
    { name: "overflowing size", options: { sizeThreshold: 2 ** 32 } },
    { name: "negative mask", options: { maskThreshold: -0.1 } },
    { name: "non-finite mask", options: { maskThreshold: NaN } },
    { name: "agglomeration above one", options: { aggThreshold: 1.1 } },
    { name: "non-finite agglomeration", options: { aggThreshold: Infinity } },
    { name: "negative halo", halo: -1 },
    { name: "fractional halo", halo: 0.5 },
    { name: "NaN halo", halo: NaN },
    { name: "infinite halo", halo: Infinity },
    { name: "unsafe halo", halo: 2 ** 53 },
  ];

  it.each(invalidEdits)(
    "rejects $name atomically, preserving labels and the old configuration",
    async ({ channels, options, halo }) => {
      const { input } = fixture([140, 1, 1]);
      const onError = vi.fn();
      const live = new LiveWatershed(
        input,
        [0, 1, 2],
        DEFAULT_WATERSHED_OPTIONS,
        onError,
      );
      const changed = vi.fn();
      live.changed.add(changed);
      live.setRegion([34, 20, -3], [8, 1, 1]);
      await settle();
      const labels = await live.readTile([0, 0, 0], [64, 1, 1], signal);
      const completed = live.getCompletedSnapshot();
      expect(() =>
        live.setParameters(
          channels ?? [2, 1, 0],
          { ...DEFAULT_WATERSHED_OPTIONS, highThreshold: 0.8, ...options },
          halo ?? 3,
        ),
      ).toThrow();
      expect(changed).toHaveBeenCalledTimes(2);
      expect(live.epoch).toBe(1);
      expect(live.getCompletedSnapshot()).toEqual(completed);
      expect(await live.readTile([0, 0, 0], [64, 1, 1], signal)).toEqual(
        labels,
      );
      await settle();
      expect(compute).toHaveBeenCalledTimes(1);
      live.setRegion([100, 20, -3], [8, 1, 1]);
      await settle();
      expect(compute.mock.calls[1].slice(0, 5)).toEqual([
        input,
        [92, 20, -3],
        [24, 1, 1],
        [0, 1, 2],
        DEFAULT_WATERSHED_OPTIONS,
      ]);
      expect(onError).not.toHaveBeenCalled();
      expect(input.dispose).not.toHaveBeenCalled();
      live.dispose();
    },
  );

  it.each([-1, 0.5, NaN, Infinity, 2 ** 53])(
    "rejects invalid constructor halo %s before taking input ownership",
    (halo) => {
      const { input } = fixture();
      expect(
        () =>
          new LiveWatershed(
            input,
            [0, 1, 2],
            DEFAULT_WATERSHED_OPTIONS,
            undefined,
            halo,
          ),
      ).toThrow();
      expect(input.dispose).not.toHaveBeenCalled();
    },
  );

  it("invalid edits neither reset a pending debounce nor cancel in-flight work", async () => {
    const { input } = fixture([4, 1, 1]);
    const gate = Promise.withResolvers<WatershedResult>();
    compute.mockImplementationOnce(async () => gate.promise);
    const live = new LiveWatershed(input);
    live.setRegion([10, 20, -3], [4, 1, 1]);
    await vi.advanceTimersByTimeAsync(100);
    const invalid = () =>
      live.setParameters([2, 1, 0], DEFAULT_WATERSHED_OPTIONS, -1);
    expect(invalid).toThrow();
    await vi.advanceTimersByTimeAsync(50);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(invalid).toThrow();
    await settle();
    expect(compute).toHaveBeenCalledTimes(1);
    expect(compute.mock.calls[0][5].aborted).toBe(false);
    gate.resolve(result([4, 1, 1]));
    await vi.advanceTimersByTimeAsync(0);
    expect(await live.readTile([0, 0, 0], [4, 1, 1], signal)).toEqual(
      new BigUint64Array(4).fill(7n),
    );
    live.dispose();
  });

  it("validates mask/channel compatibility before accepting an edit on a scalar source", async () => {
    const { input } = fixture([4, 1, 1]);
    const live = new LiveWatershed({ ...input, channelCount: 1 });
    live.setRegion([10, 20, -3], [4, 1, 1]);
    await settle();
    expect(() =>
      live.setParameters([0, 0, 0], {
        ...DEFAULT_WATERSHED_OPTIONS,
        maskThreshold: 0,
      }),
    ).toThrow("at least four");
    expect(await live.readTile([0, 0, 0], [4, 1, 1], signal)).toEqual(
      new BigUint64Array(4).fill(7n),
    );
    expect(compute).toHaveBeenCalledTimes(1);
    live.dispose();
  });

  it("updates parameters while hidden without starting jobs and uses the latest values when visible", async () => {
    const { input } = fixture([80, 1, 1]);
    const gate = Promise.withResolvers<WatershedResult>();
    compute.mockImplementationOnce(async () => gate.promise);
    const live = new LiveWatershed(input);
    live.setParameters([2, 0, 1], DEFAULT_WATERSHED_OPTIONS, 0);
    await settle();
    expect(compute).not.toHaveBeenCalled();
    live.setRegion([34, 20, -3], [8, 1, 1]);
    await settle();
    live.setRegion();
    const options = { ...DEFAULT_WATERSHED_OPTIONS, highThreshold: 0.8 };
    live.setParameters([1, 2, 0], options, 3);
    await settle();
    expect(compute.mock.calls[0][5].aborted).toBe(true);
    gate.resolve(result([8, 1, 1], 999));
    await settle();
    expect(compute).toHaveBeenCalledTimes(1);
    expect(await live.readTile([0, 0, 0], [64, 1, 1], signal)).toEqual(
      new BigUint64Array(64),
    );
    live.setRegion([34, 20, -3], [8, 1, 1]);
    await settle();
    expect(compute.mock.calls[1].slice(0, 5)).toEqual([
      input,
      [31, 20, -3],
      [14, 1, 1],
      [1, 2, 0],
      options,
    ]);
    live.dispose();
  });

  it("clears labels for an enlarged over-cap halo and recovers by reducing it on the same view", async () => {
    const { input } = fixture([512, 512, 512]);
    const onError = vi.fn();
    const live = new LiveWatershed(
      input,
      [0, 1, 2],
      DEFAULT_WATERSHED_OPTIONS,
      onError,
      0,
    );
    live.setRegion([74, 84, 61], [128, 128, 128]);
    await settle();
    expect(compute.mock.calls[0].slice(1, 3)).toEqual([
      [74, 84, 61],
      [128, 128, 128],
    ]);
    live.setParameters([0, 1, 2], DEFAULT_WATERSHED_OPTIONS, 1);
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: expect.stringContaining("2**21") }),
    );
    expect(await live.readTile([64, 64, 64], [64, 64, 32], signal)).toEqual(
      new BigUint64Array(64 * 64 * 32),
    );
    await settle();
    expect(compute).toHaveBeenCalledTimes(1);
    live.setRegion([74, 84, 61], [128, 128, 128]);
    live.setParameters([0, 1, 2], DEFAULT_WATERSHED_OPTIONS, 0);
    await settle();
    expect(compute).toHaveBeenCalledTimes(2);
    expect(compute.mock.calls[1].slice(1, 3)).toEqual([
      [74, 84, 61],
      [128, 128, 128],
    ]);
    expect((await live.readTile([64, 64, 64], [64, 64, 32], signal))[0]).toBe(
      7n,
    );
    expect(live.signal.aborted).toBe(false);
    live.dispose();
  });

  it("recovers a failed computation by changing parameters without navigation", async () => {
    const { input } = fixture([4, 1, 1]);
    const onError = vi.fn();
    compute.mockRejectedValueOnce(new Error("Current kernel failure"));
    const live = new LiveWatershed(
      input,
      [0, 1, 2],
      DEFAULT_WATERSHED_OPTIONS,
      onError,
    );
    live.setRegion([10, 20, -3], [4, 1, 1]);
    await settle();
    live.setParameters([2, 1, 0], DEFAULT_WATERSHED_OPTIONS);
    await settle();
    expect(compute).toHaveBeenCalledTimes(2);
    expect(compute.mock.calls[1][3]).toEqual([2, 1, 0]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(await live.readTile([0, 0, 0], [4, 1, 1], signal)).toEqual(
      new BigUint64Array(4).fill(7n),
    );
    live.dispose();
  });

  it("checks source validity even for otherwise equal parameters and cancels pending work", async () => {
    const { input } = fixture([4, 1, 1]);
    const live = new LiveWatershed(input);
    live.setRegion([10, 20, -3], [4, 1, 1]);
    vi.spyOn(input, "assertValid").mockImplementation(() => {
      throw new Error("Source geometry changed");
    });
    expect(() =>
      live.setParameters([0, 1, 2], DEFAULT_WATERSHED_OPTIONS),
    ).toThrow("Source geometry changed");
    await settle();
    expect(compute).not.toHaveBeenCalled();
    expect(live.signal.aborted).toBe(true);
    expect(input.dispose).toHaveBeenCalledTimes(1);
    expect(() =>
      live.setParameters([2, 1, 0], DEFAULT_WATERSHED_OPTIONS),
    ).toThrow("stopped");
  });

  it("source invalidation aborts a parameter refresh and prevents all later edits", async () => {
    const { input, changed } = fixture([4, 1, 1]);
    const gate = Promise.withResolvers<WatershedResult>();
    const onError = vi.fn();
    const live = new LiveWatershed(
      input,
      [0, 1, 2],
      DEFAULT_WATERSHED_OPTIONS,
      onError,
    );
    live.setRegion([10, 20, -3], [4, 1, 1]);
    await settle();
    compute.mockImplementationOnce(async () => gate.promise);
    live.setParameters([2, 1, 0], DEFAULT_WATERSHED_OPTIONS);
    await settle();
    live.setParameters([1, 0, 2], DEFAULT_WATERSHED_OPTIONS);
    changed.abort(new Error("Source replaced"));
    expect(compute.mock.calls[1][5].aborted).toBe(true);
    gate.resolve(result([4, 1, 1], 999));
    await settle();
    expect(compute).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: "Watershed affinity source changed; add the layer again",
      }),
    );
    expect(input.dispose).toHaveBeenCalledTimes(1);
    expect(() =>
      live.setParameters([1, 0, 2], DEFAULT_WATERSHED_OPTIONS),
    ).toThrow("stopped");
  });

  it("allows a changed listener to dispose during a parameter refresh without starting work", async () => {
    const { input } = fixture([4, 1, 1]);
    const live = new LiveWatershed(input);
    live.setRegion([10, 20, -3], [4, 1, 1]);
    await settle();
    live.changed.add(() => live.dispose());
    live.setParameters([2, 1, 0], DEFAULT_WATERSHED_OPTIONS);
    await settle();
    expect(compute).toHaveBeenCalledTimes(1);
    expect(input.dispose).toHaveBeenCalledTimes(1);
  });
});

describe("completed live watershed snapshots", () => {
  it("owns exact-sized labels and bounds that can be mutated or transferred without affecting tiles", async () => {
    const { input } = fixture([4, 1, 1]);
    const backing = Uint32Array.of(123, 0, 900, 0xffffffff, 900, 456);
    const native = backing.subarray(1, 5);
    compute.mockResolvedValue({ ...result([4, 1, 1]), data: native });
    const live = new LiveWatershed(input);
    live.setRegion([10, 20, -3], [4, 1, 1]);
    await settle();
    const first = live.getCompletedSnapshot()!;
    expect(first).toEqual({
      epoch: 1,
      lowerXYZ: [10, 20, -3],
      sourceRelativeLowerXYZ: [0, 0, 0],
      shapeXYZ: [4, 1, 1],
      labels: Uint32Array.of(0, 900, 0xffffffff, 900),
    });
    expect(first.labels).toBeInstanceOf(Uint32Array);
    expect(first.labels.buffer).not.toBe(native.buffer);
    expect(first.labels.byteOffset).toBe(0);
    expect(first.labels.buffer.byteLength).toBe(16);
    expect(first.lowerXYZ).not.toBe(compute.mock.calls[0][1]);
    expect(first.shapeXYZ).not.toBe(compute.mock.calls[0][2]);
    const second = live.getCompletedSnapshot()!;
    expect(second).toEqual(first);
    expect(second.labels.buffer).not.toBe(first.labels.buffer);
    expect(second.lowerXYZ).not.toBe(first.lowerXYZ);
    expect(second.sourceRelativeLowerXYZ).not.toBe(
      first.sourceRelativeLowerXYZ,
    );
    expect(second.shapeXYZ).not.toBe(first.shapeXYZ);
    first.labels.fill(123);
    (first.lowerXYZ as number[]).fill(999);
    (first.sourceRelativeLowerXYZ as number[]).fill(999);
    (first.shapeXYZ as number[]).fill(999);
    const delivered = structuredClone(second, {
      transfer: [second.labels.buffer],
    });
    expect(second.labels.byteLength).toBe(0);
    // Node's structuredClone may return typed arrays from outside JSDOM's realm.
    expect(Array.from(delivered.labels)).toEqual([0, 900, 0xffffffff, 900]);
    expect(backing).toEqual(Uint32Array.of(123, 0, 900, 0xffffffff, 900, 456));
    expect(live.getCompletedSnapshot()).toEqual({
      epoch: delivered.epoch,
      lowerXYZ: Array.from(delivered.lowerXYZ),
      sourceRelativeLowerXYZ: Array.from(delivered.sourceRelativeLowerXYZ),
      shapeXYZ: Array.from(delivered.shapeXYZ),
      labels: Uint32Array.from(delivered.labels),
    });
    expect(await live.readTile([0, 0, 0], [4, 1, 1], signal)).toEqual(
      BigUint64Array.of(0n, 900n, 0xffffffffn, 900n),
    );
    expect(live.epoch).toBe(1);
    expect(compute).toHaveBeenCalledTimes(1);
    live.dispose();
    expect(Array.from(delivered.labels)).toEqual([0, 900, 0xffffffff, 900]);
  });

  it("aligns mesh volume-local offsets with native ROI offsets for negative/nonzero source bounds", async () => {
    const { input: source } = fixture();
    const input: PreparedAffinityInput = {
      ...source,
      lowerBoundXYZ: [-40, 20, -30],
      upperBoundXYZ: [100, 120, 40],
    };
    const live = new LiveWatershed(input);
    live.setRegion([-12, 50, -10], [8, 8, 4]);
    await settle();
    const snapshot = live.getCompletedSnapshot()!;
    expect(snapshot.lowerXYZ).toEqual([-20, 42, -18]);
    expect(snapshot.sourceRelativeLowerXYZ).toEqual([20, 22, 12]);
    expect(snapshot.shapeXYZ).toEqual([24, 24, 20]);
    expect(live.info.offsetXYZ).toEqual([60, -180, -28]);
    const meshOffset = snapshot.sourceRelativeLowerXYZ.map(
      (n, d) => n + live.info.offsetXYZ[d],
    );
    const nativeOffset = snapshot.lowerXYZ.map(
      (n, d) => n + input.originXYZ[d],
    );
    expect(meshOffset).toEqual([80, -158, -16]);
    expect(meshOffset).toEqual(nativeOffset);
    expect(snapshot.epoch).toBe(live.epoch);
    live.dispose();
  });

  it("checks readiness without requesting a snapshot or changing the content epoch", async () => {
    const { input } = fixture([80, 1, 1]);
    const live = new LiveWatershed(input);
    const snapshot = vi
      .spyOn(live, "getCompletedSnapshot")
      .mockImplementation(() => {
        throw new Error("Readiness must not copy labels");
      });
    const assertValid = vi.spyOn(input, "assertValid");
    expect(live.hasCompletedResult).toBe(false);
    expect(assertValid).toHaveBeenCalledTimes(1);
    const readiness: boolean[] = [];
    live.changed.add(() => readiness.push(live.hasCompletedResult));
    live.setRegion([34, 20, -3], [8, 1, 1]);
    expect(live.hasCompletedResult).toBe(false);
    await settle();
    assertValid.mockClear();
    expect(live.hasCompletedResult).toBe(true);
    expect(live.hasCompletedResult).toBe(true);
    expect(assertValid).toHaveBeenCalledTimes(2);
    live.setRegion([42, 20, -3], [8, 1, 1]);
    live.setParameters([0, 1, 2], { ...DEFAULT_WATERSHED_OPTIONS });
    expect(live.hasCompletedResult).toBe(true);
    expect(live.epoch).toBe(1);
    live.setParameters([2, 1, 0], DEFAULT_WATERSHED_OPTIONS);
    expect(live.hasCompletedResult).toBe(false);
    expect(live.epoch).toBe(2);
    await settle();
    expect(live.hasCompletedResult).toBe(true);
    expect(live.epoch).toBe(2);
    live.setRegion();
    expect(live.hasCompletedResult).toBe(false);
    expect(readiness).toEqual([false, true, false, true, false]);
    expect(snapshot).not.toHaveBeenCalled();
    expect(compute).toHaveBeenCalledTimes(2);
    live.dispose();
    expect(() => live.hasCompletedResult).toThrow("Live watershed stopped");
    expect(readiness).toEqual([false, true, false, true, false]);
  });

  it.each([
    {
      halo: 8,
      lower: [80, 70, 30],
      shape: [20, 10, 12],
      completedLower: [72, 62, 22],
      completedShape: [36, 26, 28],
    },
    {
      halo: 8,
      lower: [10, 20, -3],
      shape: [5, 2, 2],
      completedLower: [10, 20, -3],
      completedShape: [13, 10, 10],
    },
    {
      halo: 8,
      lower: [145, 118, 65],
      shape: [5, 2, 2],
      completedLower: [137, 110, 57],
      completedShape: [13, 10, 10],
    },
    {
      halo: 0,
      lower: [10, 20, -3],
      shape: [5, 2, 2],
      completedLower: [10, 20, -3],
      completedShape: [5, 2, 2],
    },
  ])(
    "copies the X-fastest completed halo tensor at native $lower with halo $halo, not full-domain geometry",
    async ({ halo, lower, shape, completedLower, completedShape }) => {
      const { input } = fixture();
      compute.mockImplementation(async (_input, _lower, shape) => ({
        ...result(shape),
        data: Uint32Array.from(
          { length: shape.reduce((a, b) => a * b, 1) },
          (_, i) => i + 1,
        ),
      }));
      const live = new LiveWatershed(
        input,
        [0, 1, 2],
        DEFAULT_WATERSHED_OPTIONS,
        undefined,
        halo,
      );
      live.setRegion(lower, shape);
      await settle();
      const snapshot = live.getCompletedSnapshot()!;
      expect(snapshot.lowerXYZ).toEqual(completedLower);
      expect(snapshot.sourceRelativeLowerXYZ).toEqual(
        completedLower.map((n, d) => n - input.lowerBoundXYZ[d]),
      );
      expect(snapshot.shapeXYZ).toEqual(completedShape);
      expect(snapshot.labels).toEqual(
        Uint32Array.from(
          { length: completedShape.reduce((a, b) => a * b, 1) },
          (_, i) => i + 1,
        ),
      );
      // Tiles are relative to the full domain, unlike native snapshot bounds.
      const native = [10, 20, -3];
      const tileLower = completedLower.map((n, d) => {
        const chunk = live.info.chunkShapeXYZ[d];
        return Math.floor((n - native[d]) / chunk) * chunk;
      });
      const tileShape = live.info.shapeXYZ.map((n, d) =>
        Math.min(live.info.chunkShapeXYZ[d], n - tileLower[d]),
      );
      const tile = await live.readTile(tileLower, tileShape, signal);
      const [sx, sy] = tileShape;
      const expected = BigUint64Array.from(tile, (_, i) => {
        const xyz = [
          i % sx,
          Math.floor(i / sx) % sy,
          Math.floor(i / (sx * sy)),
        ];
        const local = xyz.map(
          (n, d) => n + tileLower[d] + native[d] - completedLower[d],
        );
        if (local.some((n, d) => n < 0 || n >= completedShape[d])) return 0n;
        return BigInt(
          snapshot.labels[
            (local[2] * completedShape[1] + local[1]) * completedShape[0] +
              local[0]
          ],
        );
      });
      expect(expected.some((n) => n !== 0n)).toBe(true);
      expect(tile).toEqual(expected);
      expect(live.info.shapeXYZ).toEqual([140, 100, 70]);
      expect(live.info.offsetXYZ).toEqual([110, -180, -1]);
      expect(snapshot.epoch).toBe(live.epoch);
      expect(compute).toHaveBeenCalledTimes(1);
      live.dispose();
    },
  );

  it("exposes no snapshot while absent, pending, failed or hidden and never publishes obsolete work", async () => {
    const { input } = fixture([80, 1, 1]);
    const gate = Promise.withResolvers<WatershedResult>();
    compute.mockImplementationOnce(async () => gate.promise);
    const onError = vi.fn();
    const live = new LiveWatershed(
      input,
      [0, 1, 2],
      DEFAULT_WATERSHED_OPTIONS,
      onError,
    );
    const events: Array<[number, number | undefined]> = [];
    live.changed.add(() => {
      const snapshot = live.getCompletedSnapshot();
      expect(live.hasCompletedResult).toBe(snapshot !== undefined);
      events.push([live.epoch, snapshot?.epoch]);
    });
    expect(live.epoch).toBe(0);
    expect(live.getCompletedSnapshot()).toBeUndefined();
    live.setRegion();
    expect(live.epoch).toBe(0);
    live.setRegion([34, 20, -3], [8, 1, 1]);
    expect(live.getCompletedSnapshot()).toBeUndefined();
    await settle();
    expect(live.getCompletedSnapshot()).toBeUndefined();
    // An unfinished region cannot be reused even when the new view fits it.
    live.setRegion([35, 20, -3], [8, 1, 1]);
    expect(live.epoch).toBe(2);
    compute.mockRejectedValueOnce(new Error("Current kernel failure"));
    await settle();
    expect(compute).toHaveBeenCalledTimes(1);
    gate.resolve(result([24, 1, 1], 999));
    await vi.advanceTimersByTimeAsync(0);
    expect(compute).toHaveBeenCalledTimes(2);
    expect(live.epoch).toBe(2);
    expect(live.getCompletedSnapshot()).toBeUndefined();
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "Current kernel failure" }),
    );
    live.setParameters([2, 1, 0], DEFAULT_WATERSHED_OPTIONS);
    expect(live.epoch).toBe(3);
    expect(live.getCompletedSnapshot()).toBeUndefined();
    await settle();
    const completed = live.getCompletedSnapshot()!;
    expect(completed.epoch).toBe(3);
    expect(completed.labels.every((n) => n === 7)).toBe(true);
    live.setRegion();
    expect(live.epoch).toBe(4);
    expect(live.getCompletedSnapshot()).toBeUndefined();
    live.setParameters([1, 2, 0], DEFAULT_WATERSHED_OPTIONS);
    expect(live.epoch).toBe(5);
    await settle();
    expect(live.getCompletedSnapshot()).toBeUndefined();
    expect(compute).toHaveBeenCalledTimes(3);
    expect(events).toEqual([
      [1, undefined],
      [2, undefined],
      [2, undefined],
      [3, undefined],
      [3, 3],
      [4, undefined],
      [5, undefined],
    ]);
    live.setRegion([35, 20, -3], [8, 1, 1]);
    expect(live.epoch).toBe(6);
    await settle();
    expect(live.getCompletedSnapshot()?.epoch).toBe(6);
    expect(completed.epoch).toBe(3);
    expect(completed.labels.every((n) => n === 7)).toBe(true);
    live.dispose();
  });

  it.each([1, 2])(
    "does not return a result retired reentrantly during source assertion %s",
    async (assertion) => {
      const { input } = fixture([4, 1, 1]);
      const live = new LiveWatershed(input);
      live.setRegion([10, 20, -3], [4, 1, 1]);
      await settle();
      const assertValid = vi.spyOn(input, "assertValid");
      if (assertion === 2) assertValid.mockImplementationOnce(() => {});
      assertValid.mockImplementationOnce(() => {
        live.setParameters([2, 1, 0], DEFAULT_WATERSHED_OPTIONS);
      });
      expect(live.getCompletedSnapshot()).toBeUndefined();
      expect(live.hasCompletedResult).toBe(false);
      expect(live.epoch).toBe(2);
      await settle();
      expect(live.getCompletedSnapshot()?.epoch).toBe(2);
      expect(live.hasCompletedResult).toBe(true);
      live.dispose();
    },
  );

  it("preserves a snapshot when source validation reenters contained navigation", async () => {
    const { input } = fixture([80, 1, 1]);
    const live = new LiveWatershed(input);
    live.setRegion([34, 20, -3], [8, 1, 1]);
    await settle();
    const completed = live.getCompletedSnapshot();
    vi.spyOn(input, "assertValid")
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => live.setRegion([42, 20, -3], [8, 1, 1]));
    expect(live.getCompletedSnapshot()).toEqual(completed);
    expect(live.epoch).toBe(1);
    expect(compute).toHaveBeenCalledTimes(1);
    live.dispose();
  });

  it.each([false, true])(
    "checks readiness after reentrant source validation (contained: %s)",
    async (contained) => {
      const { input } = fixture([80, 1, 1]);
      const live = new LiveWatershed(input);
      live.setRegion([34, 20, -3], [8, 1, 1]);
      await settle();
      vi.spyOn(input, "assertValid").mockImplementationOnce(() => {
        if (contained) live.setRegion([42, 20, -3], [8, 1, 1]);
        else live.setParameters([2, 1, 0], DEFAULT_WATERSHED_OPTIONS);
      });
      expect(live.hasCompletedResult).toBe(contained);
      expect(live.epoch).toBe(contained ? 1 : 2);
      live.dispose();
    },
  );

  it("pairs snapshots with the current epoch when an earlier completion listener invalidates labels", async () => {
    const { input } = fixture([4, 1, 1]);
    const live = new LiveWatershed(input);
    live.changed.add(() => {
      if (live.epoch === 1 && live.getCompletedSnapshot() !== undefined)
        live.setParameters([2, 1, 0], DEFAULT_WATERSHED_OPTIONS);
    });
    const seen: Array<CompletedWatershedSnapshot | undefined> = [];
    live.changed.add(() => seen.push(live.getCompletedSnapshot()));
    live.setRegion([10, 20, -3], [4, 1, 1]);
    await settle();
    expect(live.epoch).toBe(2);
    expect(seen).toEqual([undefined, undefined, undefined]);
    await settle();
    expect(seen.at(-1)?.epoch).toBe(2);
    expect(compute).toHaveBeenCalledTimes(2);
    live.dispose();
  });

  it.each([
    { completed: false, query: "snapshot" },
    { completed: true, query: "snapshot" },
    { completed: false, query: "readiness" },
    { completed: true, query: "readiness" },
  ])(
    "asserts source validity for $query even when completed is $completed, and disposal only signals abort",
    async ({ completed, query }) => {
      const { input } = fixture([4, 1, 1]);
      const live = new LiveWatershed(input);
      if (completed) {
        live.setRegion([10, 20, -3], [4, 1, 1]);
        await settle();
      }
      const changed = vi.fn();
      const aborted = vi.fn();
      live.changed.add(changed);
      live.signal.addEventListener("abort", aborted);
      vi.spyOn(input, "assertValid").mockImplementation(() => {
        throw new Error("Source geometry changed");
      });
      const epoch = live.epoch;
      const getResult = () =>
        query === "snapshot"
          ? live.getCompletedSnapshot()
          : live.hasCompletedResult;
      expect(getResult).toThrow("Source geometry changed");
      expect(live.epoch).toBe(epoch);
      expect(live.signal.aborted).toBe(true);
      expect(aborted).toHaveBeenCalledTimes(1);
      expect(changed).not.toHaveBeenCalled();
      expect(input.dispose).toHaveBeenCalledTimes(1);
      expect(getResult).toThrow("Live watershed stopped");
      live.dispose();
      expect(input.dispose).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { action: "dispose", query: "snapshot" },
    { action: "source abort", query: "snapshot" },
    { action: "dispose", query: "readiness" },
    { action: "source abort", query: "readiness" },
  ])(
    "rejects $query after reentrant $action without emitting changed",
    async ({ action, query }) => {
      const { input, changed } = fixture([4, 1, 1]);
      const live = new LiveWatershed(input);
      live.setRegion([10, 20, -3], [4, 1, 1]);
      await settle();
      const notify = vi.fn();
      live.changed.add(notify);
      const assertValid = vi.spyOn(input, "assertValid");
      if (query === "snapshot") assertValid.mockImplementationOnce(() => {});
      assertValid.mockImplementationOnce(() => {
        if (action === "dispose") live.dispose();
        else changed.abort(new Error("Source replaced"));
      });
      const epoch = live.epoch;
      const getResult = () =>
        query === "snapshot"
          ? live.getCompletedSnapshot()
          : live.hasCompletedResult;
      expect(getResult).toThrow("Live watershed stopped");
      expect(live.epoch).toBe(epoch);
      expect(live.signal.aborted).toBe(true);
      expect(notify).not.toHaveBeenCalled();
      expect(input.dispose).toHaveBeenCalledTimes(1);
    },
  );
});

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
