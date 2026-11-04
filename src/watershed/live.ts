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

import { NullarySignal } from "#src/util/signal.js";
import type { WatershedOptions, WatershedResult } from "#src/watershed/base.js";
import {
  DEFAULT_WATERSHED_OPTIONS,
  validateWatershedChannels,
  validateWatershedOptions,
  validateWatershedShape,
} from "#src/watershed/base.js";
import type { PreparedAffinityInput } from "#src/watershed/input.js";
import { computeWatershed } from "#src/watershed/run.js";

// These are display/transport chunks, never independent watershed domains.
export const LIVE_WATERSHED_TILE_SHAPE_XYZ = Object.freeze([64, 64, 32]);
export const LIVE_WATERSHED_HALO_XYZ = Object.freeze([8, 8, 8]);
export const LIVE_WATERSHED_DEBOUNCE_MS = 150;

export interface LiveWatershedInfo extends Omit<WatershedResult, "data"> {
  readonly chunkShapeXYZ: readonly number[];
}

interface Region {
  readonly lower: readonly number[];
  readonly shape: readonly number[];
}

function sameRegion(a: Region | undefined, b: Region | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.lower.length === b.lower.length &&
    a.shape.length === b.shape.length &&
    a.lower.every((n, i) => n === b.lower[i]) &&
    a.shape.every((n, i) => n === b.shape[i])
  );
}

/** One bounded watershed result for all visible slice views, plus a halo.
 * Display chunk requests only copy that shared result. Region changes discard
 * obsolete labels immediately; an already-running kernel finishes before the
 * latest debounced region starts. Owns input after successful construction. */
export class LiveWatershed {
  readonly info: LiveWatershedInfo;
  readonly changed = new NullarySignal();
  private readonly lifetime = new AbortController();
  readonly signal = this.lifetime.signal;
  private readonly channels: readonly number[];
  private readonly options: WatershedOptions;
  private readonly lowerBound: readonly number[];
  private readonly upperBound: readonly number[];
  private requested: Region | undefined;
  private region: Region | undefined;
  private result:
    | { readonly region: Region; readonly data: Uint32Array }
    | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private revision = 0;
  private ready = false;
  private active: AbortController | undefined;
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
    this.upperBound = Object.freeze(Array.from(input.upperBoundXYZ));
    const shapeXYZ = this.upperBound.map((n, i) => n - this.lowerBound[i]);
    const offsetXYZ = this.lowerBound.map((n, i) => n + input.originXYZ[i]);
    if (
      this.lowerBound.length !== 3 ||
      !this.lowerBound.every(Number.isSafeInteger) ||
      shapeXYZ.length !== 3 ||
      shapeXYZ.some(
        (n, i) =>
          !Number.isSafeInteger(n) ||
          n <= 0 ||
          Math.fround(n) !== n ||
          !Number.isSafeInteger(this.upperBound[i]) ||
          Math.ceil(n / LIVE_WATERSHED_TILE_SHAPE_XYZ[i]) > 2 ** 24,
      ) ||
      offsetXYZ.length !== 3 ||
      !offsetXYZ.every(Number.isSafeInteger) ||
      input.spacingXYZ.length !== 3 ||
      Array.from(input.spacingXYZ).some((n) => !Number.isFinite(n) || n <= 0) ||
      input.unitsXYZ.length !== 3
    ) {
      throw new Error("Invalid live watershed native volume geometry");
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

  /** Native input-grid bounds. No region means hidden/no visible slice views. */
  setRegion(lowerXYZ?: readonly number[], shapeXYZ?: readonly number[]): void {
    this.assertValid();
    const requested =
      lowerXYZ === undefined && shapeXYZ === undefined
        ? undefined
        : {
            lower: Array.from(lowerXYZ ?? []),
            shape: Array.from(shapeXYZ ?? []),
          };
    if (sameRegion(requested, this.requested)) return;
    this.requested = requested;
    const revision = ++this.revision;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.ready = false;
    this.region = undefined;
    this.result = undefined;
    this.active?.abort(
      new DOMException("Watershed viewport changed", "AbortError"),
    );
    let error: unknown;
    if (requested !== undefined) {
      try {
        if (
          requested.lower.length !== 3 ||
          requested.shape.length !== 3 ||
          requested.lower.some(
            (n, i) =>
              !Number.isSafeInteger(n) ||
              !Number.isSafeInteger(requested.shape[i]) ||
              requested.shape[i] <= 0 ||
              n < this.lowerBound[i] ||
              !Number.isSafeInteger(n + requested.shape[i]) ||
              n + requested.shape[i] > this.upperBound[i],
          )
        )
          throw new Error(
            "Watershed viewport must be inside the native source bounds",
          );
        const lower = requested.lower.map((n, i) =>
          Math.max(this.lowerBound[i], n - LIVE_WATERSHED_HALO_XYZ[i]),
        );
        const shape = requested.lower.map(
          (n, i) =>
            Math.min(
              this.upperBound[i],
              n + requested.shape[i] + LIVE_WATERSHED_HALO_XYZ[i],
            ) - lower[i],
        );
        try {
          validateWatershedShape(shape);
        } catch {
          throw new Error(
            "Visible watershed region including its halo exceeds the 2**21 voxel limit; zoom in or select a coarser native source scale. The region will not be split into separate watersheds.",
          );
        }
        this.region = { lower, shape };
      } catch (caught) {
        error = caught;
      }
    }
    this.changed.dispatch();
    if (this.signal.aborted || revision !== this.revision) return;
    if (error !== undefined) {
      this.onError(error);
      return;
    }
    if (this.region === undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.signal.aborted || revision !== this.revision) return;
      this.ready = true;
      void this.drain();
    }, LIVE_WATERSHED_DEBOUNCE_MS);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.signal.aborted && this.ready && this.region !== undefined) {
        const region = this.region;
        this.ready = false;
        const active = (this.active = new AbortController());
        const signal = AbortSignal.any([active.signal, this.signal]);
        try {
          const result = await computeWatershed(
            this.input,
            region.lower,
            region.shape,
            this.channels,
            this.options,
            signal,
          );
          signal.throwIfAborted();
          this.assertValid();
          if (this.region !== region) continue;
          if (
            !(result.data instanceof Uint32Array) ||
            result.data.length !== region.shape.reduce((n, x) => n * x, 1)
          )
            throw new Error("Invalid whole-region watershed result");
          this.result = { region, data: result.data };
          this.changed.dispatch();
        } catch (error) {
          if (
            !signal.aborted &&
            !this.signal.aborted &&
            this.region === region
          ) {
            this.result = undefined;
            this.changed.dispatch();
            if (!this.signal.aborted && this.region === region)
              this.onError(error);
          }
        } finally {
          if (this.active === active) this.active = undefined;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  readTile(
    lowerXYZ: readonly number[],
    sizeXYZ: readonly number[],
    signal: AbortSignal,
  ): Promise<BigUint64Array<ArrayBuffer>> {
    signal.throwIfAborted();
    this.assertValid();
    const lower = Array.from(lowerXYZ),
      size = Array.from(sizeXYZ);
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
    )
      throw new Error(
        "Live watershed tile must be an aligned, clipped native block",
      );
    const data = new BigUint64Array(size.reduce((n, x) => n * x, 1));
    const result = this.result;
    if (result !== undefined) {
      const nativeLower = lower.map((n, i) => n + this.lowerBound[i]);
      const start = nativeLower.map((n, i) =>
        Math.max(n, result.region.lower[i]),
      );
      const end = nativeLower.map((n, i) =>
        Math.min(n + size[i], result.region.lower[i] + result.region.shape[i]),
      );
      if (start.every((n, i) => n < end[i])) {
        for (let z = start[2]; z < end[2]; ++z) {
          for (let y = start[1]; y < end[1]; ++y) {
            let target =
              ((z - nativeLower[2]) * size[1] + y - nativeLower[1]) * size[0] +
              start[0] -
              nativeLower[0];
            let source =
              ((z - result.region.lower[2]) * result.region.shape[1] +
                y -
                result.region.lower[1]) *
                result.region.shape[0] +
              start[0] -
              result.region.lower[0];
            for (let x = start[0]; x < end[0]; ++x)
              data[target++] = BigInt(result.data[source++]);
          }
        }
      }
    }
    return Promise.resolve(data);
  }

  dispose(): void {
    if (this.signal.aborted) return;
    this.removeInvalidation();
    clearTimeout(this.timer);
    this.timer = undefined;
    this.requested = this.region = this.result = undefined;
    this.ready = false;
    this.lifetime.abort(
      new DOMException("Live watershed stopped", "AbortError"),
    );
    this.input.dispose();
  }
}
