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

/**
 * Optional preparation for exact, verified exports, NOT an ONNX parser.
 * Import only from lazy inference code, not from the application entry.
 *
 * The immutable splice recipes are protobuf-record diffs between fingerprinted
 * originals and padding-only prepared models (onnx 1.23.2). They replace Conv
 * pads with SAME_UPPER. All other nodes, including the original 3-D
 * ConvTranspose operations, all weights and graph metadata are copied verbatim.
 * Changed enclosing protobuf length prefixes are included, so the result is a
 * complete, self-contained ONNX model, not an in-place byte edit.
 *
 * Both fingerprints are essential: never apply these offsets to another model,
 * even a re-serialized or otherwise equivalent export. Updating a recipe
 * requires offline oracle checks and a new pair of fingerprints.
 * There is no Python, server, ORT deep import, or protobuf dependency at runtime.
 */

import type { InferenceCompatibilityAnalysis } from "#src/inference/model.js";
import * as model6280000Recipe from "#src/inference/model6280000_jsep_recipe.js";
import * as nooversegRecipe from "#src/inference/nooverseg_jsep_recipe.js";

export type CompatibilityAnalysis = InferenceCompatibilityAnalysis;

export interface PreparedNooversegModel {
  model: ArrayBuffer;
  /** Set only when this call applied an exact-model rewrite. */
  preparation?: "nooverseg-jsep" | "model6280000-jsep";
  status: "applied" | "not-needed";
  reason: "exact-original" | "already-prepared" | "unrecognized-model";
  sourceSha256: string;
  preparedSha256: string;
}

export interface PreparedWebGpuModel extends PreparedNooversegModel {
  compatibilityAnalysis: CompatibilityAnalysis;
}

type Replacements = readonly (readonly [number, number, string])[];
interface Recipe {
  name: "nooverseg" | "model6280000";
  preparation: NonNullable<PreparedNooversegModel["preparation"]>;
  originalSha256: string;
  preparedSha256: string;
  originalBytes: number;
  preparedBytes: number;
  convCount: number;
  replacements: Replacements;
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Legacy old-only automatic behavior, including the original result shape.
 * In particular, model6280000 is never rewritten through this API.
 */
export async function prepareNooversegForWebGpu(
  model: ArrayBuffer,
): Promise<PreparedNooversegModel> {
  const { compatibilityAnalysis: _, ...result } = await prepare(
    model,
    true,
    RECIPES.slice(0, 1),
  );
  return result;
}

/**
 * SHA identity inspection only: no parsing, rewrite, device probe or global
 * buffer cache. "Available" means a verified recipe exists, not that arbitrary
 * WebGPU devices, layouts, geometry or segmentation quality are validated.
 */
export async function inspectWebGpuCompatibility(
  model: ArrayBuffer,
): Promise<CompatibilityAnalysis> {
  return analyze(await sha256(model), RECIPES);
}

/**
 * true: opt in to either verified recipe; false: never rewrite; undefined:
 * preserve old nooverseg automatic behavior, but require opt-in for model6280000.
 * Analysis is independent of the selected execution provider. A disabled known
 * original still reports "available". Unknown bytes pass through as unverified.
 * No call mutates or detaches the input. Hashing/rewrite verification is shared
 * within this operation, so a caller need not inspect and hash separately.
 */
export function prepareModelForWebGpu(
  model: ArrayBuffer,
  enabled: boolean | undefined,
): Promise<PreparedWebGpuModel> {
  return prepare(model, enabled, RECIPES);
}

function analyze(
  sourceSha256: string,
  recipes: readonly Recipe[],
): CompatibilityAnalysis {
  const recipe = recipes.find(
    (r) =>
      r.originalSha256 === sourceSha256 || r.preparedSha256 === sourceSha256,
  );
  if (recipe === undefined) {
    return {
      status: "unverified",
      fixes: [],
      message: `SHA-256 ${sourceSha256}: no verified WebGPU recipe. The model is unchanged; operator support and numerical equivalence are unverified.`,
    };
  }
  const prepared = sourceSha256 === recipe.preparedSha256;
  return {
    status: prepared ? "already-prepared" : "available",
    model: recipe.name,
    fixes: [
      `${recipe.convCount} Conv nodes: replace symmetric explicit pads with auto_pad=SAME_UPPER.`,
    ],
    message: `SHA-256 ${sourceSha256}: ${recipe.name} ${prepared ? "already matches the verified prepared graph" : "has an optional verified WebGPU recipe"}. Only Conv padding is changed; original ConvTranspose nodes and weights are preserved. Use NCHW. This is not a guarantee for every device or segmentation quality.`,
  };
}

async function prepare(
  model: ArrayBuffer,
  enabled: boolean | undefined,
  recipes: readonly Recipe[],
): Promise<PreparedWebGpuModel> {
  // Snapshot candidate originals BEFORE the first await. Never splice from a
  // buffer that a caller can mutate after its fingerprint has been computed.
  const source = recipes.some((r) => model.byteLength === r.originalBytes)
    ? model.slice(0)
    : model;
  const sourceSha256 = await sha256(source);
  const compatibilityAnalysis = analyze(sourceSha256, recipes);
  const recipe = recipes.find((r) => r.originalSha256 === sourceSha256);
  if (
    recipe === undefined ||
    enabled === false ||
    (enabled === undefined && recipe.name !== "nooverseg")
  ) {
    return {
      model,
      status: "not-needed",
      reason:
        compatibilityAnalysis.status === "already-prepared"
          ? "already-prepared"
          : recipe === undefined
            ? "unrecognized-model"
            : "exact-original",
      sourceSha256,
      preparedSha256: sourceSha256,
      compatibilityAnalysis,
    };
  }
  const prepared = rewriteExactOriginal(source, recipe);
  const preparedSha256 = await sha256(prepared);
  if (preparedSha256 !== recipe.preparedSha256) {
    // Fail closed: do not hand ORT an unverified partial/incorrect rewrite.
    throw new Error(
      `${recipe.name} preparation failed: prepared SHA-256 mismatch`,
    );
  }
  return {
    model: prepared,
    preparation: recipe.preparation,
    status: "applied",
    reason: "exact-original",
    sourceSha256,
    preparedSha256,
    // Analysis describes the selected source, independently of provider/policy.
    // The separate preparation tag records what was applied to returned bytes.
    // This also remains correct if a provider falls back to the original on CPU.
    compatibilityAnalysis,
  };
}

function rewriteExactOriginal(
  source: ArrayBuffer,
  recipe: Recipe,
): ArrayBuffer {
  if (source.byteLength !== recipe.originalBytes) {
    throw new Error(`${recipe.name} preparation failed: source size mismatch`);
  }
  const input = new Uint8Array(source);
  const output = new Uint8Array(recipe.preparedBytes);
  let sourceOffset = 0;
  let outputOffset = 0;
  for (const [start, end, base64] of recipe.replacements) {
    if (start < sourceOffset || end < start || end > input.length) {
      throw new Error(
        `${recipe.name} preparation failed: invalid splice bounds`,
      );
    }
    const unchanged = input.subarray(sourceOffset, start);
    const replacement = atob(base64);
    if (outputOffset + unchanged.length + replacement.length > output.length) {
      throw new Error(
        `${recipe.name} preparation failed: invalid output bounds`,
      );
    }
    output.set(unchanged, outputOffset);
    outputOffset += unchanged.length;
    for (let i = 0; i < replacement.length; ++i) {
      output[outputOffset++] = replacement.charCodeAt(i);
    }
    sourceOffset = end;
  }
  if (outputOffset + input.length - sourceOffset !== output.length) {
    throw new Error(`${recipe.name} preparation failed: output size mismatch`);
  }
  output.set(input.subarray(sourceOffset), outputOffset);
  return output.buffer;
}

const RECIPES: readonly Recipe[] = [
  {
    name: "nooverseg",
    preparation: "nooverseg-jsep",
    originalSha256: nooversegRecipe.ORIGINAL_SHA256,
    preparedSha256: nooversegRecipe.PREPARED_SHA256,
    originalBytes: nooversegRecipe.ORIGINAL_BYTES,
    preparedBytes: nooversegRecipe.PREPARED_BYTES,
    convCount: 34,
    replacements: nooversegRecipe.REPLACEMENTS,
  },
  {
    name: "model6280000",
    preparation: "model6280000-jsep",
    originalSha256: model6280000Recipe.ORIGINAL_SHA256,
    preparedSha256: model6280000Recipe.PREPARED_SHA256,
    originalBytes: model6280000Recipe.ORIGINAL_BYTES,
    preparedBytes: model6280000Recipe.PREPARED_BYTES,
    convCount: 37,
    replacements: model6280000Recipe.REPLACEMENTS,
  },
];
