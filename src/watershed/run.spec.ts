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

  it.each([
    { lower: [9, 20, 30], shape: [2, 2, 2], channels: [0, 1, 2] },
    { lower: [19, 20, 30], shape: [2, 2, 2], channels: [0, 1, 2] },
    { lower: [10.5, 20, 30], shape: [2, 2, 2], channels: [0, 1, 2] },
    { lower: [10, 20], shape: [2, 2, 2], channels: [0, 1, 2] },
    { lower: [10, 20, 30], shape: [2, 2, 2], channels: [0, 0, 2] },
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

  it("propagates source read failures without starting WASM", async () => {
    const { input } = makeInput();
    const error = new Error("affinity download failed");
    vi.mocked(input.readRegion).mockRejectedValue(error);
    await expect(
      computeWatershed(
        input,
        [10, 20, 30],
        [2, 2, 2],
        [0, 1, 2],
        DEFAULT_WATERSHED_OPTIONS,
        new AbortController().signal,
      ),
    ).rejects.toBe(error);
    expect(request).not.toHaveBeenCalled();
  });

  it("does not submit a read invalidated before completion", async () => {
    const { input, controller, affinities } = makeInput();
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
    const reason = new Error("source replaced");
    controller.abort(reason);
    read.resolve(affinities);
    await expect(pending).rejects.toBe(reason);
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["user", "source"])(
    "immediately discards a running worker on %s cancellation",
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
      const reason = new Error(`${kind} cancelled`);
      (kind === "user" ? user : controller).abort(reason);
      await expect(pending).rejects.toBe(reason);
      expect(request.mock.calls[0][1].aborted).toBe(true);
      // Already running synchronous work can still finish, but cannot publish.
      work.resolve(new Uint32Array(8).fill(42));
      await Promise.resolve();
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
