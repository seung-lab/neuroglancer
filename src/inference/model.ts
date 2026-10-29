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

/** Bounded, concrete batch-one float32 NCDHW model contract. */
import type { InferenceResult as StoredInferenceResult } from "#src/datasource/inference/base.js";
import type { InferenceGeometry, Zyx } from "#src/inference/geometry.js";
import { getRetainedOutputShape } from "#src/inference/geometry.js";

export type InferenceProvider = "auto" | "webgpu" | "cpu";
export type InferencePrecision = "float32" | "float16";
export type ExecutionProvider = "webgpu" | "wasm";

export interface InferenceCompatibilityAnalysis {
  status: "available" | "already-prepared" | "unverified";
  model?: "nooverseg" | "model6280000";
  fixes: string[];
  message: string;
}

export interface ProviderMetadata {
  requestedProvider: InferenceProvider;
  actualProvider: ExecutionProvider;
  fallbackReason?: string;
  requestedPrecision?: InferencePrecision;
  actualPrecision?: InferencePrecision;
  precisionFallbackReason?: string;
  /** Compatibility rewrites applied in memory to the selected original file. */
  preparation?: "nooverseg-jsep" | "model6280000-jsep";
  /** Requested policy; absent preserves the legacy old-model-only policy. */
  compatibilityFixes?: boolean;
  compatibilityAnalysis?: InferenceCompatibilityAnalysis;
}

export interface ModelMetadata extends ProviderMetadata {
  inputNames: readonly string[];
  outputNames: readonly string[];
  inputShape: readonly number[];
  outputShape: readonly number[];
  initMs: number;
  threads: number;
}

export const INPUT_SHAPE = [1, 1, 20, 80, 80] as const;
export const OUTPUT_SHAPE = [1, 4, 20, 80, 80] as const;
export const MAX_MODEL_BYTES = 256 * 1024 * 1024;
export const MAX_RESULT_BYTES = 256 * 1024 * 1024;
export const MAX_TILES = 4096;

/** Native-grid equal-resolution profile; spacing must be explicitly confirmed. */
export function makeNooversegGeometry(spacing: Zyx): InferenceGeometry {
  return {
    inputShape: [20, 80, 80],
    inputSpacing: [...spacing],
    rawOutputShape: [20, 80, 80],
    outputSpacing: [...spacing],
    rawOutputOrigin: [0, 0, 0],
    cropBefore: [2, 10, 10],
    cropAfter: [2, 10, 10],
    outputChannels: 4,
  };
}

type ModelShapes = Pick<ModelMetadata, "inputShape" | "outputShape">;

/** Validate dimensions and bound float32 bytes before any tensor allocation. */
function validateTensorShape(
  shape: readonly number[],
  name: string,
  maxBytes: number,
  singleChannel: boolean,
): void {
  if (
    !Array.isArray(shape) ||
    shape.length !== 5 ||
    shape[0] !== 1 ||
    (singleChannel && shape[1] !== 1)
  ) {
    throw new Error(
      `Unsupported ${name} shape: expected batch-one rank-5 NCDHW${singleChannel ? " with one input channel" : ""}`,
    );
  }
  let elements = 1;
  for (const dimension of shape) {
    if (!Number.isSafeInteger(dimension) || dimension <= 0)
      throw new Error(
        `${name} shape must contain concrete positive safe integers`,
      );
    if (
      dimension >
      Math.floor(maxBytes / Float32Array.BYTES_PER_ELEMENT / elements)
    )
      throw new Error(`${name} tensor exceeds byte limit ${maxBytes}`);
    elements *= dimension;
  }
}

function validateModelShapes(metadata: ModelShapes): void {
  validateTensorShape(metadata.inputShape, "Input", MAX_MODEL_BYTES, true);
  validateTensorShape(metadata.outputShape, "Output", MAX_RESULT_BYTES, false);
}

/** Construct a centered field of view with a one-eighth raw-output border. */
export function makeModelGeometry(
  metadata: Pick<ModelMetadata, "inputShape" | "outputShape">,
  inputSpacing: Zyx,
  outputSpacing?: Zyx,
): InferenceGeometry {
  validateModelShapes(metadata);
  const inputShape: Zyx = [
    metadata.inputShape[2],
    metadata.inputShape[3],
    metadata.inputShape[4],
  ];
  const rawOutputShape: Zyx = [
    metadata.outputShape[2],
    metadata.outputShape[3],
    metadata.outputShape[4],
  ];
  const spacing: Zyx =
    outputSpacing === undefined
      ? (inputShape.map(
          (size, axis) => (inputSpacing[axis] * size) / rawOutputShape[axis],
        ) as [number, number, number])
      : [...outputSpacing];
  const crop = rawOutputShape.map((size) => Math.floor(size / 8)) as [
    number,
    number,
    number,
  ];
  const geometry: InferenceGeometry = {
    inputShape,
    inputSpacing: [...inputSpacing],
    rawOutputShape,
    outputSpacing: spacing,
    rawOutputOrigin: inputShape.map(
      (size, axis) =>
        ((size - 1) * inputSpacing[axis] -
          (rawOutputShape[axis] - 1) * spacing[axis]) /
        2,
    ) as [number, number, number],
    cropBefore: [...crop],
    cropAfter: [...crop],
    outputChannels: metadata.outputShape[1],
  };
  validateModelGeometry(metadata, geometry);
  return geometry;
}

/** Validate custom/restored geometry without substituting a default profile. */
export function validateModelGeometry(
  metadata: Pick<ModelMetadata, "inputShape" | "outputShape">,
  geometry: InferenceGeometry,
): void {
  validateModelShapes(metadata);
  getRetainedOutputShape(geometry);
  if (
    geometry.inputShape.some(
      (size, axis) => size !== metadata.inputShape[axis + 2],
    ) ||
    geometry.rawOutputShape.some(
      (size, axis) => size !== metadata.outputShape[axis + 2],
    ) ||
    geometry.outputChannels !== metadata.outputShape[1]
  ) {
    throw new Error("Geometry shapes/channels do not match model metadata");
  }
}

export function validateModelMetadata(
  metadata: Pick<
    ModelMetadata,
    "inputNames" | "outputNames" | "inputShape" | "outputShape"
  >,
): void {
  for (const names of [metadata.inputNames, metadata.outputNames]) {
    if (
      !Array.isArray(names) ||
      names.length !== 1 ||
      typeof names[0] !== "string" ||
      names[0].length === 0
    )
      throw new Error(
        "Model must have exactly one named input and one named output",
      );
  }
  validateModelShapes(metadata);
}

/** Exact version-one recipe contract, not the general inference contract. */
export function validateLegacyModelMetadata(
  metadata: Pick<
    ModelMetadata,
    "inputNames" | "outputNames" | "inputShape" | "outputShape"
  >,
): void {
  const equal = (a: readonly unknown[], b: readonly unknown[]) =>
    Array.isArray(a) && a.length === b.length && b.every((x, i) => x === a[i]);
  if (
    !equal(metadata.inputNames, ["input"]) ||
    !equal(metadata.outputNames, ["output"]) ||
    !equal(metadata.inputShape, INPUT_SHAPE) ||
    !equal(metadata.outputShape, OUTPUT_SHAPE)
  ) {
    throw new Error(
      "Unsupported model profile: expected input float32 [1,1,20,80,80] named input and output float32 [1,4,20,80,80] named output",
    );
  }
}

export interface InferenceResult extends StoredInferenceResult {
  readonly channels: number;
}

export type InferenceWorkerRequest =
  | {
      id: number;
      kind: "load";
      model: ArrayBuffer;
      provider: InferenceProvider;
      compatibilityFixes?: boolean;
      precision?: InferencePrecision;
    }
  | {
      id: number;
      kind: "run";
      input: Float32Array;
      geometry: InferenceGeometry;
    };

export type InferenceWorkerResponse =
  | { id: number; kind: "loaded"; metadata: ModelMetadata }
  | {
      id: number;
      kind: "output";
      output: Float32Array;
      runMs: number;
      metadata: ModelMetadata;
    }
  | { id: number; kind: "error"; message: string; metadata?: ModelMetadata };
