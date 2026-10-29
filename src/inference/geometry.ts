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

/** All spatial vectors are ZYX, with X contiguous in memory. */
export type Zyx = readonly [number, number, number];

/** Integer voxel indices; the box is half-open [origin, origin + shape). */
export interface VoxelBox {
  readonly origin: Zyx;
  readonly shape: Zyx;
}

/**
 * Fixed, batch-one NCDHW model geometry. Spacings and rawOutputOrigin use the
 * same physical units. Global input and output voxel index zero share physical
 * center zero: input i has center i * inputSpacing, output o has center
 * o * outputSpacing. Origins are CENTER coordinates, not voxel-corner offsets.
 *
 * rawOutputOrigin is the center of raw output voxel (0,0,0) relative to the
 * center of input voxel (0,0,0) within a model tile. Thus raw voxel r from an
 * input tile at i has physical center:
 *   i * inputSpacing + rawOutputOrigin + r * outputSpacing.
 * For centered fields of view, set each component of rawOutputOrigin to
 *   ((inputShape - 1) * inputSpacing - (rawOutputShape - 1) * outputSpacing) / 2.
 * This is NOT generally zero, nor the difference of voxel-corner extents.
 * Crops are counts of OUTPUT voxels and may be asymmetric.
 */
export interface InferenceGeometry {
  readonly inputShape: Zyx;
  readonly inputSpacing: Zyx;
  readonly rawOutputShape: Zyx;
  readonly outputSpacing: Zyx;
  readonly rawOutputOrigin: Zyx;
  readonly cropBefore: Zyx;
  readonly cropAfter: Zyx;
  readonly outputChannels: number;
}

export interface InferenceTile {
  /** Always the full fixed input shape, including on the last tile. */
  readonly input: VoxelBox;
  /** Absolute output indices; only this retained prefix is written. */
  readonly output: VoxelBox;
}

export interface TilePlanOptions {
  /** Available input indices. No implicit padding or clamping is performed. */
  readonly inputBounds: VoxelBox;
  readonly outputBounds?: VoxelBox;
  /** Positive safe integer; defaults to 100,000. Checked before yielding. */
  readonly maxTiles?: number;
}

function integer(value: number, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function vector(value: Zyx, name: string, check: (x: number) => boolean) {
  if (value.length !== 3 || ![0, 1, 2].every((axis) => check(value[axis]))) {
    throw new Error(`Invalid ${name}: expected a ZYX triple`);
  }
}

function shape(value: Zyx, name: string) {
  vector(value, name, (x) => Number.isSafeInteger(x) && x > 0);
}

function volume(value: Zyx): number {
  return integer(value[0] * value[1] * value[2], "Voxel count", 1);
}

function validateBox(box: VoxelBox, name: string) {
  vector(box.origin, `${name} origin`, Number.isSafeInteger);
  shape(box.shape, `${name} shape`);
  for (let axis = 0; axis < 3; ++axis) {
    integer(
      box.origin[axis] + box.shape[axis],
      `${name} end`,
      -Number.MAX_SAFE_INTEGER,
    );
  }
  volume(box.shape);
}

function contains(outer: VoxelBox, inner: VoxelBox): boolean {
  return outer.origin.every(
    (start, axis) =>
      inner.origin[axis] >= start &&
      inner.origin[axis] + inner.shape[axis] <= start + outer.shape[axis],
  );
}

/** Validates geometry and returns rawOutputShape - cropBefore - cropAfter. */
export function getRetainedOutputShape(geometry: InferenceGeometry): Zyx {
  shape(geometry.inputShape, "inputShape");
  shape(geometry.rawOutputShape, "rawOutputShape");
  for (const [name, value] of [
    ["inputSpacing", geometry.inputSpacing],
    ["outputSpacing", geometry.outputSpacing],
  ] as const) {
    vector(value, name, (x) => Number.isFinite(x) && x > 0);
  }
  vector(geometry.rawOutputOrigin, "rawOutputOrigin", Number.isFinite);
  for (const [name, value] of [
    ["cropBefore", geometry.cropBefore],
    ["cropAfter", geometry.cropAfter],
  ] as const) {
    vector(value, name, (x) => Number.isSafeInteger(x) && x >= 0);
  }
  const retained = geometry.rawOutputShape.map(
    (size, axis) => size - geometry.cropBefore[axis] - geometry.cropAfter[axis],
  ) as [number, number, number];
  shape(retained, "retained output shape");
  integer(geometry.outputChannels, "outputChannels", 1);
  volume(geometry.inputShape);
  integer(
    volume(geometry.rawOutputShape) * geometry.outputChannels,
    "Output element count",
    1,
  );
  return retained;
}

function alignedInteger(value: number): number {
  const rounded = Math.round(value);
  // Absolute tolerance in input voxels, only to absorb floating point roundoff.
  if (!Number.isSafeInteger(rounded) || Math.abs(value - rounded) > 1e-7) {
    throw new Error(`Fractional input alignment: ${value}`);
  }
  return rounded === 0 ? 0 : rounded;
}

/**
 * Lazily tiles a nonempty requested OUTPUT ROI, X fastest. All validation is
 * eager, before returning the generator (including the last full input tile).
 * No tile list is allocated. Output boxes partition the ROI exactly once;
 * input tiles may overlap. Only final retained outputs are trimmed, never inputs.
 *
 * For a retained tile starting at output index o, the input origin is
 *   (o * outputSpacing - rawOutputOrigin - cropBefore * outputSpacing)
 *     / inputSpacing.
 * Both the first origin and every used retained-tile stride must be integral.
 */
export function planInferenceTiles(
  geometry: InferenceGeometry,
  outputRoi: VoxelBox,
  options: TilePlanOptions,
): Generator<InferenceTile, void, unknown> {
  const retained = getRetainedOutputShape(geometry);
  validateBox(outputRoi, "Output ROI");
  validateBox(options.inputBounds, "Input bounds");
  if (options.outputBounds !== undefined) {
    validateBox(options.outputBounds, "Output bounds");
    if (!contains(options.outputBounds, outputRoi)) {
      throw new Error("Output ROI exceeds output bounds");
    }
  }
  const maxTiles = integer(options.maxTiles ?? 100_000, "maxTiles", 1);
  const counts = outputRoi.shape.map((size, axis) =>
    Math.ceil(size / retained[axis]),
  );
  const count = counts[0] * counts[1] * counts[2];
  if (!Number.isSafeInteger(count) || count > maxTiles) {
    throw new Error(`Tile count ${count} exceeds maxTiles ${maxTiles}`);
  }
  // Snapshot the values used by the lazy iterator, independent of caller mutation.
  const roiOrigin = [...outputRoi.origin];
  const roiShape = [...outputRoi.shape];
  const inputShape: Zyx = [...geometry.inputShape];
  const first: number[] = [];
  const stride: number[] = [];
  for (let axis = 0; axis < 3; ++axis) {
    first[axis] = alignedInteger(
      ((roiOrigin[axis] - geometry.cropBefore[axis]) *
        geometry.outputSpacing[axis] -
        geometry.rawOutputOrigin[axis]) /
        geometry.inputSpacing[axis],
    );
    stride[axis] =
      counts[axis] === 1
        ? 0
        : alignedInteger(
            (retained[axis] * geometry.outputSpacing[axis]) /
              geometry.inputSpacing[axis],
          );
    const lastEnd =
      first[axis] + (counts[axis] - 1) * stride[axis] + inputShape[axis];
    integer(lastEnd, "Input tile end", -Number.MAX_SAFE_INTEGER);
    if (
      first[axis] < options.inputBounds.origin[axis] ||
      lastEnd >
        options.inputBounds.origin[axis] + options.inputBounds.shape[axis]
    ) {
      throw new Error(`Full input tile exceeds input bounds on axis ${axis}`);
    }
  }
  return (function* () {
    for (let z = 0; z < counts[0]; ++z) {
      for (let y = 0; y < counts[1]; ++y) {
        for (let x = 0; x < counts[2]; ++x) {
          const index = [z, y, x];
          yield {
            input: {
              origin: index.map(
                (i, axis) => first[axis] + i * stride[axis],
              ) as [number, number, number],
              shape: [...inputShape],
            },
            output: {
              origin: index.map(
                (i, axis) => roiOrigin[axis] + i * retained[axis],
              ) as [number, number, number],
              shape: index.map((i, axis) =>
                Math.min(retained[axis], roiShape[axis] - i * retained[axis]),
              ) as [number, number, number],
            },
          };
        }
      }
    }
  })();
}

/** Validated native strides; no resampling or fractional input shifts. */
export function getInferenceStrides(
  geometry: InferenceGeometry,
  overlap = true,
): { inputStride: Zyx; outputStride: Zyx } {
  const retained = getRetainedOutputShape(geometry);
  const inputStride = geometry.inputShape.map((size, axis) =>
    overlap
      ? integer(size / 2, "Half-input stride", 1)
      : integer(
          alignedInteger(
            (retained[axis] * geometry.outputSpacing[axis]) /
              geometry.inputSpacing[axis],
          ),
          "Retained-output input stride",
          1,
        ),
  ) as [number, number, number];
  const outputStride = inputStride.map((stride, axis) => {
    const value = overlap
      ? alignedInteger(
          (stride * geometry.inputSpacing[axis]) / geometry.outputSpacing[axis],
        )
      : retained[axis];
    if (value <= 0 || value > retained[axis])
      throw new Error(
        "Half-input stride leaves gaps in retained output coverage",
      );
    return value;
  }) as [number, number, number];
  return { inputStride, outputStride };
}

/** Source-anchored grid of valid, full context patches, with optional overlap. */
function blendedGrid(
  geometry: InferenceGeometry,
  inputBounds: VoxelBox,
  overlap: boolean,
) {
  const retained = getRetainedOutputShape(geometry);
  validateBox(inputBounds, "Input bounds");
  const { inputStride, outputStride } = getInferenceStrides(geometry, overlap);
  const counts = geometry.inputShape.map((size, axis) => {
    const count =
      Math.floor((inputBounds.shape[axis] - size) / inputStride[axis]) + 1;
    if (count <= 0)
      throw new Error("Source is smaller than one full model context patch");
    return count;
  });
  const outputBounds: VoxelBox = {
    origin: inputBounds.origin.map((start, axis) =>
      alignedInteger(
        (start * geometry.inputSpacing[axis] + geometry.rawOutputOrigin[axis]) /
          geometry.outputSpacing[axis] +
          geometry.cropBefore[axis],
      ),
    ) as [number, number, number],
    shape: counts.map(
      (count, axis) => (count - 1) * outputStride[axis] + retained[axis],
    ) as [number, number, number],
  };
  validateBox(outputBounds, "Blended output bounds");
  return { retained, inputStride, outputStride, counts, outputBounds };
}

/** Union of cropped outputs from all valid contexts on the chosen lattice; no padding. */
export function getBlendedOutputBounds(
  geometry: InferenceGeometry,
  inputBounds: VoxelBox,
  overlap = true,
): VoxelBox {
  return blendedGrid(geometry, inputBounds, overlap).outputBounds;
}

/**
 * Plans every full context whose cropped output intersects the requested ROI.
 * Unlike partition tiling, both low and high crop edges may extend outside the
 * ROI. The lattice is anchored to inputBounds.origin, never to the ROI or view.
 * With overlap=false the output stride is exactly the retained shape, so these
 * full tiles partition outputBounds. Intersecting them with any contained ROI
 * covers it exactly once, including both low and high partial tiles.
 */
export function planBlendedInferenceTiles(
  geometry: InferenceGeometry,
  outputRoi: VoxelBox,
  options: TilePlanOptions,
  overlap = true,
): { tiles: Generator<InferenceTile, void, unknown>; total: number } {
  const { retained, inputStride, outputStride, counts, outputBounds } =
    blendedGrid(geometry, options.inputBounds, overlap);
  validateBox(outputRoi, "Output ROI");
  if (!contains(outputBounds, outputRoi))
    throw new Error("Output ROI exceeds valid cropped input bounds");
  if (options.outputBounds !== undefined) {
    validateBox(options.outputBounds, "Output bounds");
    if (!contains(options.outputBounds, outputRoi))
      throw new Error("Output ROI exceeds output bounds");
  }
  const first = outputRoi.origin.map((start, axis) =>
    Math.max(
      0,
      Math.floor(
        (start - outputBounds.origin[axis] - retained[axis]) /
          outputStride[axis],
      ) + 1,
    ),
  );
  const last = outputRoi.origin.map((start, axis) =>
    Math.min(
      counts[axis] - 1,
      Math.ceil(
        (start + outputRoi.shape[axis] - outputBounds.origin[axis]) /
          outputStride[axis],
      ) - 1,
    ),
  );
  const total = first.reduce(
    (count, start, axis) => count * (last[axis] - start + 1),
    1,
  );
  const maxTiles = integer(options.maxTiles ?? 100_000, "maxTiles", 1);
  if (!Number.isSafeInteger(total) || total > maxTiles)
    throw new Error(`Tile count ${total} exceeds maxTiles ${maxTiles}`);
  const inputOrigin = [...options.inputBounds.origin];
  const inputShape: Zyx = [...geometry.inputShape];
  const tiles = (function* () {
    for (let z = first[0]; z <= last[0]; ++z) {
      for (let y = first[1]; y <= last[1]; ++y) {
        for (let x = first[2]; x <= last[2]; ++x) {
          const index = [z, y, x];
          yield {
            input: {
              origin: index.map(
                (i, axis) => inputOrigin[axis] + i * inputStride[axis],
              ) as [number, number, number],
              shape: [...inputShape] as Zyx,
            },
            output: {
              origin: index.map(
                (i, axis) => outputBounds.origin[axis] + i * outputStride[axis],
              ) as [number, number, number],
              shape: [...retained] as Zyx,
            },
          };
        }
      }
    }
  })();
  return { tiles, total };
}

/**
 * Chunkflow patch_mask.py: globally rescaled raw bump, normalized by the center
 * of a 3x3x3 translated bump sum, then (and only then) cast to float32. Allocate
 * once per result geometry, not per tile. X is contiguous.
 */
export function makeWuPatchMask(
  retainedShape: Zyx,
  outputStride: Zyx,
): Float32Array {
  shape(retainedShape, "retained output shape");
  shape(outputStride, "output stride");
  if (outputStride.some((stride, axis) => stride > retainedShape[axis]))
    throw new Error("Output stride leaves gaps in retained output coverage");
  const [nz, ny, nx] = retainedShape;
  const raw = new Float64Array(volume(retainedShape));
  const exponent = retainedShape.map((size) =>
    Array.from({ length: size }, (_, i) => {
      const u = ((i + 1) / (size + 1)) * 2 - 1;
      return -1 / (1 - u * u);
    }),
  );
  let minimum = Infinity;
  let maximum = -Infinity;
  let i = 0;
  for (let z = 0; z < nz; ++z)
    for (let y = 0; y < ny; ++y)
      for (let x = 0; x < nx; ++x) {
        const value = Math.exp(
          exponent[2][x] + exponent[1][y] + exponent[0][z],
        );
        raw[i++] = value;
        minimum = Math.min(minimum, value);
        maximum = Math.max(maximum, value);
      }
  // np.interp returns the upper endpoint for a degenerate range.
  const scale = maximum === minimum ? 0 : (1e6 - 1) / (maximum - minimum);
  for (let i = 0; i < raw.length; ++i)
    raw[i] = maximum === minimum ? 1e6 : 1 + (raw[i] - minimum) * scale;

  // Accumulate only the center crop of the reference's padded base_mask.
  const denominator = new Float64Array(raw.length);
  for (let dz = -1; dz <= 1; ++dz)
    for (let dy = -1; dy <= 1; ++dy)
      for (let dx = -1; dx <= 1; ++dx)
        for (
          let z = Math.max(0, dz * outputStride[0]);
          z < Math.min(nz, nz + dz * outputStride[0]);
          ++z
        )
          for (
            let y = Math.max(0, dy * outputStride[1]);
            y < Math.min(ny, ny + dy * outputStride[1]);
            ++y
          )
            for (
              let x = Math.max(0, dx * outputStride[2]);
              x < Math.min(nx, nx + dx * outputStride[2]);
              ++x
            ) {
              denominator[(z * ny + y) * nx + x] +=
                raw[
                  ((z - dz * outputStride[0]) * ny + y - dy * outputStride[1]) *
                    nx +
                    x -
                    dx * outputStride[2]
                ];
            }
  return Float32Array.from(raw, (value, i) => value / denominator[i]);
}

/**
 * Wu-weighted post-crop blend, clipped on both sides to the ROI. Spatial
 * weights are shared across channels. Normalize by actual contributions so
 * dataset edges do not darken. An online mean avoids float32 sum overflow;
 * destination and accumulated weights start at zero for each result.
 */
export function blendCroppedTile(
  croppedOutput: Float32Array,
  destination: Float32Array,
  weights: Float64Array,
  geometry: InferenceGeometry,
  outputRoi: VoxelBox,
  tileOutput: VoxelBox,
  patchMask: Float32Array,
): void {
  const retained = getRetainedOutputShape(geometry);
  validateBox(outputRoi, "Output ROI");
  validateBox(tileOutput, "Tile output");
  if (tileOutput.shape.some((size, axis) => size !== retained[axis]))
    throw new Error("Blended tile must contain the full retained output");
  const sourceVolume = volume(retained);
  const destinationVolume = volume(outputRoi.shape);
  if (
    croppedOutput.length !== sourceVolume * geometry.outputChannels ||
    destination.length !== destinationVolume * geometry.outputChannels ||
    weights.length !== destinationVolume ||
    patchMask.length !== sourceVolume
  )
    throw new Error("Blending buffer lengths do not match geometry");
  if (
    croppedOutput.buffer === destination.buffer ||
    croppedOutput.buffer === weights.buffer ||
    destination.buffer === weights.buffer ||
    patchMask.buffer === croppedOutput.buffer ||
    patchMask.buffer === destination.buffer ||
    patchMask.buffer === weights.buffer
  )
    throw new Error("Blending buffers must not alias");
  if (!patchMask.every((weight) => Number.isFinite(weight) && weight > 0))
    throw new Error("Blending mask weights must be finite and positive");
  if (!croppedOutput.every(Number.isFinite))
    throw new Error("Blending predictions must be finite");
  const lower = outputRoi.origin.map((start, axis) =>
    Math.max(start, tileOutput.origin[axis]),
  );
  const upper = outputRoi.origin.map((start, axis) =>
    Math.min(
      start + outputRoi.shape[axis],
      tileOutput.origin[axis] + retained[axis],
    ),
  );
  if (lower.some((start, axis) => start >= upper[axis]))
    throw new Error("Blended tile does not intersect output ROI");
  for (let z = lower[0]; z < upper[0]; ++z) {
    for (let y = lower[1]; y < upper[1]; ++y) {
      for (let x = lower[2]; x < upper[2]; ++x) {
        const source =
          ((z - tileOutput.origin[0]) * retained[1] +
            y -
            tileOutput.origin[1]) *
            retained[2] +
          x -
          tileOutput.origin[2];
        const target =
          ((z - outputRoi.origin[0]) * outputRoi.shape[1] +
            y -
            outputRoi.origin[1]) *
            outputRoi.shape[2] +
          x -
          outputRoi.origin[2];
        const previousWeight = weights[target];
        const weight = patchMask[source];
        const totalWeight = previousWeight + weight;
        if (
          !Number.isFinite(previousWeight) ||
          previousWeight < 0 ||
          !Number.isFinite(totalWeight)
        )
          throw new Error(
            "Accumulated blending weights must be finite and nonnegative",
          );
        const fraction = weight / totalWeight;
        weights[target] = totalWeight;
        for (let c = 0; c < geometry.outputChannels; ++c) {
          const i = c * destinationVolume + target;
          const value = croppedOutput[c * sourceVolume + source];
          if (!Number.isFinite(destination[i]))
            throw new Error("Blending destination must be finite");
          destination[i] += (value - destination[i]) * fraction;
        }
      }
    }
  }
}

/**
 * Worker-safe crop of contiguous float32 [1,C,Z,Y,X] raw output. Returns a new
 * [1,C,retainedZ,retainedY,retainedX] buffer, preserving every channel. Perform
 * this full crop even for final tiles; stitchCroppedTile trims the high edges.
 */
export function cropNcdhwOutput(
  rawOutput: Float32Array,
  geometry: InferenceGeometry,
): Float32Array {
  const retained = getRetainedOutputShape(geometry);
  const rawVolume = volume(geometry.rawOutputShape);
  if (rawOutput.length !== rawVolume * geometry.outputChannels) {
    throw new Error("Raw NCDHW output length does not match geometry");
  }
  const result = new Float32Array(volume(retained) * geometry.outputChannels);
  const [nz, ny, nx] = retained;
  const [, rawY, rawX] = geometry.rawOutputShape;
  const [cz, cy, cx] = geometry.cropBefore;
  let destination = 0;
  for (let c = 0; c < geometry.outputChannels; ++c) {
    for (let z = 0; z < nz; ++z) {
      for (let y = 0; y < ny; ++y) {
        const source = c * rawVolume + ((z + cz) * rawY + y + cy) * rawX + cx;
        result.set(rawOutput.subarray(source, source + nx), destination);
        destination += nx;
      }
    }
  }
  return result;
}

/**
 * Copies tileOutput.shape (a low-index prefix of the full cropped tile), clipped
 * on all faces to the ROI-local contiguous [1,C,Z,Y,X] destination. tileOutput
 * uses absolute output indices; its origin may lie outside the ROI. Buffers must
 * not alias. Call exactly once per nonoverlapping planned tile; no averaging.
 * Invalid boxes, nonfinite predictions or lengths are rejected before any writes.
 */
export function stitchCroppedTile(
  croppedOutput: Float32Array,
  destination: Float32Array,
  geometry: InferenceGeometry,
  outputRoi: VoxelBox,
  tileOutput: VoxelBox,
): void {
  const retained = getRetainedOutputShape(geometry);
  validateBox(outputRoi, "Output ROI");
  validateBox(tileOutput, "Tile output");
  if (tileOutput.shape.some((size, axis) => size > retained[axis])) {
    throw new Error("Tile output exceeds retained output bounds");
  }
  const lower = outputRoi.origin.map((start, axis) =>
    Math.max(start, tileOutput.origin[axis]),
  );
  const upper = outputRoi.origin.map((start, axis) =>
    Math.min(
      start + outputRoi.shape[axis],
      tileOutput.origin[axis] + tileOutput.shape[axis],
    ),
  );
  if (lower.some((start, axis) => start >= upper[axis]))
    throw new Error("Tile output does not intersect output ROI");
  const sourceVolume = volume(retained);
  const destinationVolume = volume(outputRoi.shape);
  const destinationLength = integer(
    destinationVolume * geometry.outputChannels,
    "Destination element count",
    1,
  );
  if (
    croppedOutput.length !== sourceVolume * geometry.outputChannels ||
    destination.length !== destinationLength
  ) {
    throw new Error(
      "Cropped NCDHW or destination length does not match geometry",
    );
  }
  if (
    croppedOutput.buffer === destination.buffer &&
    croppedOutput.byteOffset <
      destination.byteOffset + destination.byteLength &&
    destination.byteOffset < croppedOutput.byteOffset + croppedOutput.byteLength
  ) {
    throw new Error("Cropped output and destination must not alias");
  }
  if (!croppedOutput.every(Number.isFinite))
    throw new Error("Stitching predictions must be finite");
  const nx = upper[2] - lower[2];
  for (let c = 0; c < geometry.outputChannels; ++c) {
    for (let z = lower[0]; z < upper[0]; ++z) {
      for (let y = lower[1]; y < upper[1]; ++y) {
        const source =
          c * sourceVolume +
          ((z - tileOutput.origin[0]) * retained[1] +
            y -
            tileOutput.origin[1]) *
            retained[2] +
          lower[2] -
          tileOutput.origin[2];
        const target =
          c * destinationVolume +
          ((z - outputRoi.origin[0]) * outputRoi.shape[1] +
            y -
            outputRoi.origin[1]) *
            outputRoi.shape[2] +
          lower[2] -
          outputRoi.origin[2];
        destination.set(croppedOutput.subarray(source, source + nx), target);
      }
    }
  }
}
