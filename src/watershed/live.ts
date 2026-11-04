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

import type { WatershedOptions, WatershedResult } from "#src/watershed/base.js";
import {
  DEFAULT_WATERSHED_OPTIONS,
  validateWatershedChannels,
  validateWatershedOptions,
} from "#src/watershed/base.js";
import type { PreparedAffinityInput } from "#src/watershed/input.js";
import { computeWatershed } from "#src/watershed/run.js";

export const LIVE_WATERSHED_TILE_SHAPE_XYZ = Object.freeze([64, 64, 32]);
export const LIVE_WATERSHED_HALO_XYZ = Object.freeze([8, 8, 8]);
const TILE_VOXELS = 64n * 64n * 32n;
const MAX_PENDING_TILES = 128;

export interface LiveWatershedInfo extends Omit<WatershedResult, "data"> {
  readonly chunkShapeXYZ: readonly number[];
}

interface TileJob {
  readonly lower: number[];
  readonly size: number[];
  readonly signal: AbortSignal;
  resolve(data: BigUint64Array<ArrayBuffer>): void;
  reject(error: unknown): void;
}

/** Demand-driven fixed native blocks, not independently numbered render chunks.
 * No output cache: the ordinary volume source owns budgeted CPU/GPU residency.
 * Blocks include a halo but are not stitched; IDs never merge unrelated blocks.
 * Takes ownership of input only after successful construction. */
export class LiveWatershed {
  readonly info: LiveWatershedInfo;
  private readonly lifetime = new AbortController();
  readonly signal = this.lifetime.signal;
  private readonly channels: readonly number[];
  private readonly options: WatershedOptions;
  private readonly lowerBound: readonly number[];
  private readonly gridShape: readonly number[];
  private readonly queue: TileJob[] = [];
  private active: TileJob | undefined;
  private draining = false;
  private readonly removeInvalidation: () => void;

  constructor(
    private readonly input: PreparedAffinityInput,
    channelsXYZ: readonly number[] = input.channelCount < 3
      ? [0, 0, 0]
      : [0, 1, 2],
    options: WatershedOptions = DEFAULT_WATERSHED_OPTIONS,
    private readonly onError: (error: unknown) => void = () => {},
  ) {
    input.assertValid();
    validateWatershedOptions(options);
    this.options = Object.freeze({ ...options });
    validateWatershedChannels(input.channelCount, channelsXYZ, options);
    this.channels = Object.freeze(Array.from(channelsXYZ));
    this.lowerBound = Object.freeze(Array.from(input.lowerBoundXYZ));
    const shapeXYZ = input.upperBoundXYZ.map((n, i) => n - this.lowerBound[i]);
    const offsetXYZ = this.lowerBound.map((n, i) => n + input.originXYZ[i]);
    if (
      this.lowerBound.length !== 3 ||
      !this.lowerBound.every(Number.isSafeInteger) ||
      shapeXYZ.length !== 3 ||
      shapeXYZ.some(
        (n) => !Number.isSafeInteger(n) || n <= 0 || Math.fround(n) !== n,
      ) ||
      offsetXYZ.length !== 3 ||
      !offsetXYZ.every(Number.isSafeInteger) ||
      input.spacingXYZ.length !== 3 ||
      input.spacingXYZ.some((n) => !Number.isFinite(n) || n <= 0) ||
      input.unitsXYZ.length !== 3
    ) {
      throw new Error("Invalid live watershed native volume geometry");
    }
    this.gridShape = Object.freeze(
      shapeXYZ.map((n, i) => Math.ceil(n / LIVE_WATERSHED_TILE_SHAPE_XYZ[i])),
    );
    const tiles = this.gridShape.reduce((n, x) => n * BigInt(x), 1n);
    if (
      this.gridShape.some((n) => n > 2 ** 24) ||
      tiles * TILE_VOXELS > 0xffffffffffffffffn
    ) {
      throw new Error(
        "Live watershed volume exceeds the exact UINT64 block namespace",
      );
    }
    this.info = Object.freeze({
      shapeXYZ: Object.freeze(shapeXYZ),
      offsetXYZ: Object.freeze(offsetXYZ),
      spacingXYZ: Object.freeze(Array.from(input.spacingXYZ)),
      unitsXYZ: Object.freeze(Array.from(input.unitsXYZ)),
      chunkShapeXYZ: LIVE_WATERSHED_TILE_SHAPE_XYZ,
    });
    const invalidate = () => {
      this.dispose();
      this.onError(
        new Error("Watershed affinity source changed; add the layer again"),
      );
    };
    input.signal.addEventListener("abort", invalidate, { once: true });
    this.removeInvalidation = () =>
      input.signal.removeEventListener("abort", invalidate);
    // A source can become invalid during native metadata validation.
    if (input.signal.aborted) invalidate();
  }

  assertValid(): void {
    this.signal.throwIfAborted();
    try {
      this.input.assertValid();
    } catch (error) {
      this.dispose();
      throw error;
    }
    this.signal.throwIfAborted();
  }

  readTile(
    lowerXYZ: readonly number[],
    sizeXYZ: readonly number[],
    signal: AbortSignal,
  ): Promise<BigUint64Array<ArrayBuffer>> {
    signal.throwIfAborted();
    this.assertValid();
    const lower = Array.from(lowerXYZ);
    const size = Array.from(sizeXYZ);
    if (
      lower.length !== 3 ||
      size.length !== 3 ||
      lower.some(
        (n, i) =>
          !Number.isSafeInteger(n) ||
          n < 0 ||
          n >= this.info.shapeXYZ[i] ||
          n % LIVE_WATERSHED_TILE_SHAPE_XYZ[i] !== 0 ||
          size[i] !==
            Math.min(
              LIVE_WATERSHED_TILE_SHAPE_XYZ[i],
              this.info.shapeXYZ[i] - n,
            ),
      )
    ) {
      throw new Error(
        "Live watershed tile must be an aligned, clipped native block",
      );
    }
    if (
      this.queue.length + Number(this.active !== undefined) >=
      MAX_PENDING_TILES
    ) {
      throw new Error(
        "Too many pending watershed tiles; reduce visible area or download concurrency",
      );
    }
    const combined = AbortSignal.any([signal, this.signal]);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return false;
        settled = true;
        combined.removeEventListener("abort", abort);
        return true;
      };
      const job: TileJob = {
        lower,
        size,
        signal: combined,
        resolve: (data) => {
          if (finish()) resolve(data);
        },
        reject: (error) => {
          if (finish()) reject(error);
        },
      };
      const abort = () => {
        const i = this.queue.indexOf(job);
        if (i !== -1) this.queue.splice(i, 1);
        job.reject(combined.reason);
      };
      combined.addEventListener("abort", abort, { once: true });
      this.queue.push(job);
      void this.drain();
    });
  }

  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.signal.aborted && this.queue.length !== 0) {
        const job = (this.active = this.queue.shift()!);
        try {
          const data = await this.computeTile(job);
          job.signal.throwIfAborted();
          this.assertValid();
          job.resolve(data);
        } catch (error) {
          job.reject(error);
          if (!job.signal.aborted && !this.signal.aborted) this.onError(error);
        } finally {
          this.active = undefined;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async computeTile(
    job: TileJob,
  ): Promise<BigUint64Array<ArrayBuffer>> {
    const lower = job.lower.map((n, i) => this.lowerBound[i] + n);
    const haloLower = lower.map((n, i) =>
      Math.max(this.lowerBound[i], n - LIVE_WATERSHED_HALO_XYZ[i]),
    );
    const haloShape = lower.map(
      (n, i) =>
        Math.min(
          this.lowerBound[i] + this.info.shapeXYZ[i],
          n + job.size[i] + LIVE_WATERSHED_HALO_XYZ[i],
        ) - haloLower[i],
    );
    const result = await computeWatershed(
      this.input,
      haloLower,
      haloShape,
      this.channels,
      this.options,
      job.signal,
    );
    job.signal.throwIfAborted();
    this.assertValid();
    const grid = job.lower.map((n, i) => n / LIVE_WATERSHED_TILE_SHAPE_XYZ[i]);
    const ordinal =
      BigInt(grid[0]) +
      BigInt(this.gridShape[0]) *
        (BigInt(grid[1]) + BigInt(this.gridShape[1]) * BigInt(grid[2]));
    const base = ordinal * TILE_VOXELS;
    const data = new BigUint64Array(job.size.reduce((n, x) => n * x, 1));
    const labels = new Map<number, bigint>();
    const offset = lower.map((n, i) => n - haloLower[i]);
    let target = 0;
    for (let z = 0; z < job.size[2]; ++z) {
      for (let y = 0; y < job.size[1]; ++y) {
        let source =
          ((z + offset[2]) * haloShape[1] + y + offset[1]) * haloShape[0] +
          offset[0];
        for (let x = 0; x < job.size[0]; ++x, ++target, ++source) {
          const local = result.data[source];
          if (local === 0) continue;
          let global = labels.get(local);
          if (global === undefined) {
            global = base + BigInt(target) + 1n;
            labels.set(local, global);
          }
          data[target] = global;
        }
      }
    }
    return data;
  }

  dispose(): void {
    if (this.signal.aborted) return;
    this.removeInvalidation();
    this.lifetime.abort(
      new DOMException("Live watershed stopped", "AbortError"),
    );
    this.input.dispose();
  }
}
