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
import { DEFAULT_WATERSHED_OPTIONS } from "#src/watershed/base.js";
import type { PreparedAffinityInput } from "#src/watershed/input.js";
import { watershedComputation } from "#src/watershed/request.js";
import { computeWatershed } from "#src/watershed/run.js";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("#src/async_computation/request.js", () => ({
  requestAsyncComputation: request,
}));

function makeInput() {
  const controller = new AbortController();
  const affinities = Float32Array.from({ length: 24 }, (_, i) => i / 24);
  const input: PreparedAffinityInput = {
    lowerBoundXYZ: [10, 20, 30],
    upperBoundXYZ: [20, 30, 40],
    channelCount: 4,
    originXYZ: [100, 200, 300],
    spacingXYZ: [4e-9, 4e-9, 40e-9],
    unitsXYZ: ["m", "m", "m"],
    signal: controller.signal,
    isValid: () => !controller.signal.aborted,
    assertValid: vi.fn(() => controller.signal.throwIfAborted()),
    readRegion: vi.fn(async () => affinities),
    dispose: () => controller.abort(),
  };
  return { input, controller, affinities };
}

beforeEach(() => {
  request.mockReset();
  request.mockResolvedValue(new Uint32Array(8).fill(1));
});

describe("watershed job coordination", () => {
  it("transfers only private input and places the snapshot at the native ROI", async () => {
    const { input, affinities } = makeInput();
    const lower = [11, 22, 33];
    const shape = [2, 2, 2];
    const channels = [3, 1, 0];
    const options = { ...DEFAULT_WATERSHED_OPTIONS };
    const pending = computeWatershed(
      input,
      lower,
      shape,
      channels,
      options,
      new AbortController().signal,
    );
    // A dialog or caller may reuse its request vectors while the read awaits.
    lower.fill(0);
    shape.fill(1);
    channels.fill(2);
    options.dustThreshold = 0;
    const result = await pending;
    expect(input.readRegion).toHaveBeenCalledWith(
      [11, 22, 33],
      [2, 2, 2],
      [3, 1, 0],
      expect.any(AbortSignal),
    );
    const [spec, signal, transfer, owned, workerShape, workerOptions] =
      request.mock.calls[0];
    expect(spec).toBe(watershedComputation);
    expect(signal.aborted).toBe(false);
    expect(owned).toEqual(affinities);
    expect(owned.buffer).not.toBe(affinities.buffer);
    expect(transfer).toEqual([owned.buffer]);
    expect(workerShape).toEqual([2, 2, 2]);
    expect(workerOptions).toEqual(DEFAULT_WATERSHED_OPTIONS);
    expect(result.data).toEqual(new Uint32Array(8).fill(1));
    expect(result.shapeXYZ).toEqual([2, 2, 2]);
    expect(result.offsetXYZ).toEqual([111, 222, 333]);
    expect(result.spacingXYZ).toEqual(input.spacingXYZ);
    expect(result.spacingXYZ).not.toBe(input.spacingXYZ);
    expect(result.unitsXYZ).not.toBe(input.unitsXYZ);
    expect(affinities.byteLength).toBe(96);
  });

  it.each([undefined, 0, 0.2])(
    "snapshots agglomeration %s before awaiting input without adding a mask plane",
    async (aggThreshold) => {
      const { input, affinities } = makeInput();
      const read = Promise.withResolvers<Float32Array>();
      vi.mocked(input.readRegion).mockReturnValue(read.promise);
      const options = {
        ...DEFAULT_WATERSHED_OPTIONS,
        ...(aggThreshold === undefined ? {} : { aggThreshold }),
      };
      const expected = { ...options };
      const pending = computeWatershed(
        input,
        [10, 20, 30],
        [2, 2, 2],
        [2, 0, 1],
        options,
        new AbortController().signal,
      );
      options.aggThreshold = 0.9;
      expect(request).not.toHaveBeenCalled();
      expect(input.readRegion).toHaveBeenCalledExactlyOnceWith(
        [10, 20, 30],
        [2, 2, 2],
        [2, 0, 1],
        expect.any(AbortSignal),
      );
      read.resolve(affinities);
      await pending;
      expect(request).toHaveBeenCalledOnce();
      expect(request.mock.calls[0][5]).toEqual(expected);
      if (aggThreshold === undefined)
        expect(request.mock.calls[0][5]).not.toHaveProperty("aggThreshold");
      else expect(request.mock.calls[0][5].aggThreshold).toBe(aggThreshold);
    },
  );

  it.each([
    { latePlane: "final affinity", maskThreshold: undefined },
    { latePlane: "last-channel mask", maskThreshold: 0.3 },
  ])(
    "waits for the $latePlane plane before requesting WASM",
    async ({ maskThreshold }) => {
      const { input } = makeInput();
      const channels = [2, 0, 1];
      const readChannels =
        maskThreshold === undefined ? channels : [...channels, 3];
      const planes = readChannels.map(() =>
        Promise.withResolvers<Float32Array>(),
      );
      vi.mocked(input.readRegion).mockImplementation(async () => {
        const ready = await Promise.all(planes.map((plane) => plane.promise));
        return Float32Array.from(ready.flatMap((plane) => [...plane]));
      });
      const pending = computeWatershed(
        input,
        [10, 20, 30],
        [2, 2, 2],
        channels,
        { ...DEFAULT_WATERSHED_OPTIONS, maskThreshold },
        new AbortController().signal,
      );
      expect(input.readRegion).toHaveBeenCalledExactlyOnceWith(
        [10, 20, 30],
        [2, 2, 2],
        readChannels,
        expect.any(AbortSignal),
      );
      expect(request).not.toHaveBeenCalled();
      const values = readChannels.map((_, i) =>
        new Float32Array(8).fill((i + 1) / 8),
      );
      // Even every earlier requested plane being ready is insufficient. With
      // masking enabled the late plane is the mask, not an affinity direction.
      for (let i = 0; i < planes.length - 1; ++i) planes[i].resolve(values[i]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(request).not.toHaveBeenCalled();
      planes.at(-1)!.resolve(values.at(-1)!);
      await pending;
      expect(request).toHaveBeenCalledOnce();
      expect(request.mock.calls[0][3]).toEqual(
        Float32Array.from(values.flatMap((plane) => [...plane])),
      );
      expect(request.mock.calls[0][4]).toEqual([2, 2, 2]);
    },
  );

  it.each([
    { lower: [9, 20, 30], shape: [2, 2, 2], channels: [0, 1, 2] },
    { lower: [19, 20, 30], shape: [2, 2, 2], channels: [0, 1, 2] },
    { lower: [10.5, 20, 30], shape: [2, 2, 2], channels: [0, 1, 2] },
    { lower: [10, 20], shape: [2, 2, 2], channels: [0, 1, 2] },
    { lower: [10, 20, 30], shape: [2, 2, 2], channels: [0, 1, 4] },
    { lower: [10, 20, 30], shape: [2, 2, 2], channels: [-1, 1, 2] },
    { lower: [10, 20, 30], shape: [2, 2, 2], channels: [0, 1.5, 2] },
    { lower: [10, 20, 30], shape: [0, 2, 2], channels: [0, 1, 2] },
    { lower: [10, 20, 30], shape: [129, 129, 129], channels: [0, 1, 2] },
  ])(
    "rejects invalid requests before reads: %j",
    async ({ lower, shape, channels }) => {
      const { input } = makeInput();
      await expect(
        computeWatershed(
          input,
          lower,
          shape,
          channels,
          DEFAULT_WATERSHED_OPTIONS,
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      expect(input.readRegion).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("requests repeated planes from a single-channel input", async () => {
    const { input } = makeInput();
    const scalar = { ...input, channelCount: 1 };
    await computeWatershed(
      scalar,
      [10, 20, 30],
      [2, 2, 2],
      [0, 0, 0],
      DEFAULT_WATERSHED_OPTIONS,
      new AbortController().signal,
    );
    expect(input.readRegion).toHaveBeenCalledWith(
      [10, 20, 30],
      [2, 2, 2],
      [0, 0, 0],
      expect.any(AbortSignal),
    );
    expect(request).toHaveBeenCalledOnce();
  });

  it("reads the last channel only when masking is enabled and snapshots its threshold", async () => {
    const { input } = makeInput();
    const planes = new Float32Array(4 * 8).fill(0.25);
    vi.mocked(input.readRegion).mockResolvedValue(planes);
    const options = { ...DEFAULT_WATERSHED_OPTIONS, maskThreshold: 0.3 };
    const pending = computeWatershed(
      input,
      [10, 20, 30],
      [2, 2, 2],
      [2, 0, 1],
      options,
      new AbortController().signal,
    );
    options.maskThreshold = 0.9;
    await pending;
    expect(input.readRegion).toHaveBeenCalledWith(
      [10, 20, 30],
      [2, 2, 2],
      [2, 0, 1, 3],
      expect.any(AbortSignal),
    );
    expect(request.mock.calls[0][3]).toEqual(planes);
    expect(request.mock.calls[0][3].buffer).not.toBe(planes.buffer);
    expect(request.mock.calls[0][5].maskThreshold).toBe(0.3);
  });

  it.each([
    { channelCount: 1, channels: [0, 0, 0], maskThreshold: 0.3 },
    { channelCount: 4, channels: [0, 1, 3], maskThreshold: 0.3 },
    { channelCount: 4, channels: [0, 1, 2], maskThreshold: NaN },
  ])(
    "rejects invalid mask requests before reading: %j",
    async ({ channelCount, channels, maskThreshold }) => {
      const { input } = makeInput();
      await expect(
        computeWatershed(
          { ...input, channelCount },
          [10, 20, 30],
          [2, 2, 2],
          channels,
          { ...DEFAULT_WATERSHED_OPTIONS, maskThreshold },
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      expect(input.readRegion).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("propagates a deferred source read failure without starting WASM", async () => {
    const { input } = makeInput();
    const read = Promise.withResolvers<Float32Array>();
    vi.mocked(input.readRegion).mockReturnValue(read.promise);
    const pending = computeWatershed(
      input,
      [10, 20, 30],
      [2, 2, 2],
      [0, 1, 2],
      DEFAULT_WATERSHED_OPTIONS,
      new AbortController().signal,
    );
    const error = new Error("affinity download failed");
    const rejected = expect(pending).rejects.toBe(error);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(input.readRegion).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    read.reject(error);
    await rejected;
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["user", "source"])(
    "never starts WASM after %s cancellation before affinity readiness",
    async (kind) => {
      const { input, controller, affinities } = makeInput();
      const user = new AbortController();
      const read = Promise.withResolvers<Float32Array>();
      vi.mocked(input.readRegion).mockReturnValue(read.promise);
      const pending = computeWatershed(
        input,
        [10, 20, 30],
        [2, 2, 2],
        [0, 1, 2],
        DEFAULT_WATERSHED_OPTIONS,
        user.signal,
      );
      expect(input.readRegion).toHaveBeenCalledOnce();
      expect(request).not.toHaveBeenCalled();
      const reason = new Error(`${kind} cancelled before affinities ready`);
      const rejected = expect(pending).rejects.toBe(reason);
      (kind === "user" ? user : controller).abort(reason);
      expect(vi.mocked(input.readRegion).mock.calls[0][3].aborted).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(request).not.toHaveBeenCalled();
      // A dependency may still finish after cancellation; that must not open
      // the WASM barrier, regardless of which lifetime was cancelled.
      read.resolve(affinities);
      await rejected;
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each(["user", "source"])(
    "holds the running worker slot until completion on %s cancellation",
    async (kind) => {
      const { input, controller } = makeInput();
      const user = new AbortController();
      const work = Promise.withResolvers<Uint32Array>();
      request.mockReturnValue(work.promise);
      const pending = computeWatershed(
        input,
        [10, 20, 30],
        [2, 2, 2],
        [0, 1, 2],
        DEFAULT_WATERSHED_OPTIONS,
        user.signal,
      );
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      const settled = vi.fn();
      void pending.then(settled, settled);
      const reason = new Error(`${kind} cancelled`);
      (kind === "user" ? user : controller).abort(reason);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(request.mock.calls[0][1].aborted).toBe(true);
      expect(settled).not.toHaveBeenCalled();
      // The live consumer cancels immediately, but its serial queue must retain
      // this physical worker slot until the uninterruptible kernel finishes.
      work.resolve(new Uint32Array(8).fill(42));
      await expect(pending).rejects.toBe(reason);
      expect(settled).toHaveBeenCalledOnce();
    },
  );

  it.each([new Uint32Array(7), new Float32Array(8)])(
    "rejects malformed worker output %j",
    async (output) => {
      const { input } = makeInput();
      request.mockResolvedValue(output);
      await expect(
        computeWatershed(
          input,
          [10, 20, 30],
          [2, 2, 2],
          [0, 1, 2],
          DEFAULT_WATERSHED_OPTIONS,
          new AbortController().signal,
        ),
      ).rejects.toThrow("Invalid watershed worker output");
    },
  );
});
