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

/** Demand-driven, globally anchored native-grid inference. No output cache here:
 * the normal VolumeChunkSource owns the budgeted CPU/GPU cache. */
import {
  getInferenceMetadataInfo,
  LIVE_INFERENCE_TILE_SHAPE_ZYX,
} from "#src/datasource/inference/base.js";
import type { OnnxInferenceController } from "#src/inference/controller.js";
import {
  getBlendedOutputBounds,
  getInferenceStrides,
  getRetainedOutputShape,
  type InferenceGeometry,
} from "#src/inference/geometry.js";
import type { PreparedInferenceInput } from "#src/inference/input.js";
import { makeNooversegGeometry } from "#src/inference/model.js";

export function makeLiveInferenceInfo(
  input: PreparedInferenceInput,
  geometry: InferenceGeometry = makeNooversegGeometry([
    input.spacingZYX[0],
    input.spacingZYX[1],
    input.spacingZYX[2],
  ]),
  overlap = true,
) {
  input.assertValid();
  if (!geometry.inputSpacing.every((x, i) => x === input.spacingZYX[i]))
    throw new Error(
      "Inference geometry input spacing must match the prepared input",
    );
  const bounds = getBlendedOutputBounds(
    geometry,
    {
      origin: [input.originZYX[0], input.originZYX[1], input.originZYX[2]],
      shape: [input.shapeZYX[0], input.shapeZYX[1], input.shapeZYX[2]],
    },
    overlap,
  );
  const { inputStride } = getInferenceStrides(geometry, overlap);
  // Publish only full display chunks, but retain every source-valid context
  // contributing to them, including crops extending beyond these bounds.
  const shapeZYX = bounds.shape.map(
    (size, axis) =>
      Math.floor(size / LIVE_INFERENCE_TILE_SHAPE_ZYX[axis]) *
      LIVE_INFERENCE_TILE_SHAPE_ZYX[axis],
  );
  const originZYX = bounds.origin;
  return getInferenceMetadataInfo({
    channels: geometry.outputChannels,
    shapeZYX,
    originZYX,
    spacingZYX: geometry.outputSpacing,
    axisNamesZYX: input.axisNamesZYX,
    unitsZYX: input.unitsZYX,
    provenance: {
      mode: "live",
      profile: "nooverseg-ncdhw-native-grid-v1",
      boundary: overlap
        ? "Cropped overlapping contexts fully inside the source; live publishes full output chunks only; no padding"
        : "Cropped nonoverlapping outputs from contexts fully inside the source; live publishes full output chunks only; no padding",
      blending: {
        method: overlap ? "wu" : "none",
        inputStrideZYX: [...inputStride],
        retainedOutputShapeZYX: getRetainedOutputShape(geometry),
      },
      geometry: { ...geometry },
    },
  });
}

interface Consumer {
  resolve(data: Float32Array): void;
  reject(error: unknown): void;
}
interface Job {
  key: string;
  grid: number[];
  consumers: Set<Consumer>;
  canceled: boolean;
}

/** One inference run at a time, deduplicated in flight; cancellation removes queued
 * jobs immediately and terminates an unneeded active run (including its read).
 * Queue metadata is bounded independently of volume extent. */
export class LiveInference {
  readonly info;
  private jobs = new Map<string, Job>();
  private queue: Job[] = [];
  private active: Job | undefined;
  private draining = false;
  private disposed = false;
  private readonly removeInvalidation: () => void;

  constructor(
    private readonly controller: Pick<
      OnnxInferenceController,
      "run" | "cancel"
    >,
    private readonly input: PreparedInferenceInput,
    private readonly onError: (error: unknown) => void = () => {},
    private readonly geometry: InferenceGeometry = makeNooversegGeometry([
      input.spacingZYX[0],
      input.spacingZYX[1],
      input.spacingZYX[2],
    ]),
    private readonly overlap = true,
  ) {
    this.geometry = structuredClone(geometry);
    this.info = makeLiveInferenceInfo(input, this.geometry, this.overlap);
    const invalidate = () => {
      this.dispose();
      onError(
        new Error("Inference source changed; confirm the current source again"),
      );
    };
    input.signal?.addEventListener("abort", invalidate, { once: true });
    this.removeInvalidation = () =>
      input.signal?.removeEventListener("abort", invalidate);
  }

  readTile(
    gridZYX: readonly number[],
    signal: AbortSignal,
  ): Promise<Float32Array> {
    signal.throwIfAborted();
    if (this.disposed)
      return Promise.reject(new Error("Live inference has stopped"));
    this.input.assertValid();
    if (
      gridZYX.length !== 3 ||
      gridZYX.some(
        (x, i) =>
          !Number.isSafeInteger(x) ||
          x < 0 ||
          (x + 1) * LIVE_INFERENCE_TILE_SHAPE_ZYX[i] > this.info.shapeZYX[i],
      )
    )
      return Promise.reject(
        new Error("Live inference tile is outside the valid domain"),
      );
    const key = gridZYX.join(",");
    let job = this.jobs.get(key);
    if (job === undefined) {
      if (this.jobs.size >= 128) {
        const error = new Error(
          "Too many pending live inference tiles; reduce the visible area or download concurrency",
        );
        this.onError(error);
        return Promise.reject(error);
      }
      job = { key, grid: [...gridZYX], consumers: new Set(), canceled: false };
      this.jobs.set(key, job);
      this.queue.push(job);
    }
    const captured = job;
    return new Promise<Float32Array>((resolve, reject) => {
      const finish = () => {
        signal.removeEventListener("abort", abort);
        captured.consumers.delete(consumer);
      };
      const consumer: Consumer = {
        resolve: (data) => {
          finish();
          resolve(data);
        },
        reject: (error) => {
          finish();
          reject(error);
        },
      };
      const abort = () => {
        consumer.reject(signal.reason);
        if (captured.consumers.size !== 0) return;
        captured.canceled = true;
        if (this.jobs.get(key) === captured) this.jobs.delete(key);
        this.queue = this.queue.filter((x) => x !== captured);
        if (this.active === captured) this.controller.cancel();
      };
      captured.consumers.add(consumer);
      signal.addEventListener("abort", abort, { once: true });
      void this.drain();
    });
  }

  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.disposed && this.queue.length !== 0) {
        const job = (this.active = this.queue.shift()!);
        try {
          const result = await this.controller.run(this.input, {
            originZYX: job.grid.map(
              (x, i) =>
                this.info.originZYX[i] + x * LIVE_INFERENCE_TILE_SHAPE_ZYX[i],
            ),
            shapeZYX: [...LIVE_INFERENCE_TILE_SHAPE_ZYX],
            geometry: this.geometry,
            overlap: this.overlap,
          });
          this.input.assertValid();
          if (!job.canceled && !this.disposed)
            for (const consumer of job.consumers) consumer.resolve(result.data);
        } catch (error) {
          for (const consumer of job.consumers) consumer.reject(error);
          if (!job.canceled && !this.disposed) this.onError(error);
        } finally {
          if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
          this.active = undefined;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.removeInvalidation();
    for (const job of this.jobs.values()) {
      job.canceled = true;
      for (const consumer of job.consumers)
        consumer.reject(
          new DOMException("Live inference stopped", "AbortError"),
        );
    }
    this.jobs.clear();
    this.queue = [];
    if (this.active !== undefined) this.controller.cancel();
  }
}
