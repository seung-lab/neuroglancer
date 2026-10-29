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

import type { InferenceGeometry } from "#src/inference/geometry.js";
import type {
  InferencePrecision,
  InferenceProvider,
  ModelMetadata,
} from "#src/inference/model.js";
import {
  makeModelGeometry,
  makeNooversegGeometry,
  MAX_MODEL_BYTES,
  validateLegacyModelMetadata,
} from "#src/inference/model.js";

export const INFERENCE_RECIPE_URL = "inference://recipe";

interface InferenceRecipeCommon {
  source: { name: string; source: unknown };
  model:
    | {
        kind: "url";
        name: string;
        urls: string[];
        size: number;
        sha256: string;
      }
    | { kind: "local"; name: string; size: number };
  provider: InferenceProvider;
  /** Experimental internal FP16; absent retains FP32. I/O remains float32. */
  precision?: InferencePrecision;
  /** Absent retains the legacy old-model-only automatic GPU fixes policy. */
  compatibilityFixes?: boolean;
  /** Absent retains overlapping-context blending, as in legacy recipes. */
  overlap?: boolean;
  /** Native input scale index; absent retains the finest scale (0). */
  inputScaleIndex?: number;
  mode: "live";
  spacingZYX: [number, number, number];
}

type InferenceRecipeGeometryPolicy =
  | { version: 1; profile: "nooverseg-ncdhw-native-grid-v1" }
  | {
      version: 2;
      profile: "ncdhw-centered-v2";
      outputSpacingZYX: [number, number, number];
    };

/** Version/profile freeze geometry policy; the hash freezes the model bytes. */
export type InferenceRecipe = InferenceRecipeCommon &
  InferenceRecipeGeometryPolicy;

/** Derive geometry only from the saved policy and the loaded model metadata. */
export function getInferenceRecipeGeometry(
  recipe: InferenceRecipe,
  metadata: ModelMetadata,
): InferenceGeometry {
  if (recipe.version === 1) {
    validateLegacyModelMetadata(metadata);
    return makeNooversegGeometry(recipe.spacingZYX);
  }
  return makeModelGeometry(
    metadata,
    recipe.spacingZYX,
    recipe.outputSpacingZYX,
  );
}

function invalid(path: string, expected: string): never {
  throw new Error(`Invalid inference recipe ${path}: expected ${expected}`);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    invalid(path, "a JSON object");
  }
  return value as Record<string, unknown>;
}

function fields(
  value: unknown,
  path: string,
  allowed: readonly string[],
): Record<string, unknown> {
  const result = object(value, path);
  for (const key of Object.keys(result)) {
    if (!allowed.includes(key)) invalid(`${path}.${key}`, "a supported field");
  }
  return result;
}

function name(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "")
    invalid(path, "a nonempty string");
  return value;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    invalid(path, "a finite number");
  return value;
}

function positiveTriple(
  value: unknown,
  path: string,
): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3)
    invalid(path, "a ZYX triple");
  return [0, 1, 2].map((i) => {
    const n = finite(value[i], `${path}[${i}]`);
    if (n <= 0) invalid(path, "positive finite coordinates");
    return n;
  }) as [number, number, number];
}

/** Copy JSON data without invoking toJSON methods or keeping runtime objects.
 * Undefined object properties from DataSource.toJSON are omitted, like JSON.stringify.
 */
function snapshot(value: unknown, path: string, depth = 0): unknown {
  if (depth > 64)
    invalid(path, "JSON data no more than 64 levels deep (no cycles)");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") return finite(value, path);
  if (Array.isArray(value)) {
    return Array.from(value, (entry, i) =>
      snapshot(entry, `${path}[${i}]`, depth + 1),
    );
  }
  const obj = object(value, path);
  const entries: [string, unknown][] = [];
  for (const key of Object.keys(obj)) {
    const descriptor = Object.getOwnPropertyDescriptor(obj, key)!;
    if (!("value" in descriptor))
      invalid(`${path}.${key}`, "JSON data, not an accessor");
    if (descriptor.value === undefined) continue;
    entries.push([
      key,
      snapshot(descriptor.value, `${path}.${key}`, depth + 1),
    ]);
  }
  return Object.fromEntries(entries);
}

function sourceUrl(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z\d+.-]*:\/\/\S+$/i.test(value))
    invalid(path, "a nonempty data source URL");
  try {
    new URL(value);
  } catch {
    invalid(path, "a valid data source URL");
  }
  // Also catches an inference source inside a chained/wrapped data source URL.
  if (/\binference:\/\//i.test(value))
    invalid(
      path,
      "a non-inference data source (recursive inference is unsupported)",
    );
  return value;
}

/** Inspect URL/source fields, not arbitrary shader text or other metadata strings. */
function checkNestedSources(
  value: unknown,
  path: string,
  sourceField = false,
): void {
  if (typeof value === "string") {
    if (sourceField && /\binference:\/\//i.test(value))
      invalid(
        path,
        "a non-inference data source (recursive inference is unsupported)",
      );
  } else if (Array.isArray(value)) {
    value.forEach((entry, i) =>
      checkNestedSources(entry, `${path}[${i}]`, sourceField),
    );
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      checkNestedSources(
        entry,
        `${path}.${key}`,
        key === "url" || key === "source" || key === "sources",
      );
    }
  }
}

function sourceSnapshot(value: unknown): unknown {
  const result = snapshot(value, "source.source");
  const specs = Array.isArray(result) ? result : [result];
  if (specs.length === 0) invalid("source.source", "at least one data source");
  for (const spec of specs) {
    sourceUrl(
      typeof spec === "string" ? spec : object(spec, "source.source").url,
      "source.source.url",
    );
  }
  checkNestedSources(result, "source.source", true);
  return result;
}

/** Shared model URL policy for recipe restoration and interactive selection. */
export function validateInferenceModelUrl(value: unknown): string {
  const url = name(value, "model.urls");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    invalid("model.urls", "an absolute HTTP(S) URL");
  }
  if (
    !/^https?:\/\/\S+$/i.test(url) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    (parsed.protocol !== "https:" &&
      !(
        parsed.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
      ))
  ) {
    invalid("model.urls", "HTTPS, or HTTP on localhost/127.0.0.1/[::1]");
  }
  return url;
}

function parseModel(value: unknown): InferenceRecipe["model"] {
  const obj = object(value, "model");
  if (obj.kind !== "local" && obj.kind !== "url")
    invalid("model.kind", '"url" or "local"');
  fields(
    obj,
    "model",
    obj.kind === "url"
      ? ["kind", "name", "urls", "size", "sha256"]
      : ["kind", "name", "size"],
  );
  const modelName = name(obj.name, "model.name");
  const size = finite(obj.size, "model.size");
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_MODEL_BYTES)
    invalid("model.size", `an integer from 1 to ${MAX_MODEL_BYTES}`);
  if (obj.kind === "local") return { kind: "local", name: modelName, size };
  if (!Array.isArray(obj.urls) || obj.urls.length === 0)
    invalid("model.urls", "at least one model URL");
  const urls = Array.from(obj.urls, validateInferenceModelUrl);
  if (typeof obj.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(obj.sha256))
    invalid("model.sha256", "a lowercase 64-hex SHA-256");
  return { kind: "url", name: modelName, urls, size, sha256: obj.sha256 };
}

/** Validate and detach a URL-serializable recipe; never resolves viewer/session objects. */
export function parseInferenceRecipe(value: unknown): InferenceRecipe {
  const obj = fields(value, "", [
    "version",
    "profile",
    "source",
    "model",
    "provider",
    "precision",
    "compatibilityFixes",
    "overlap",
    "inputScaleIndex",
    "mode",
    "spacingZYX",
    "outputSpacingZYX",
  ]);
  if (obj.version !== 1 && obj.version !== 2) invalid("version", "1 or 2");
  let policy: InferenceRecipeGeometryPolicy;
  if (obj.version === 1) {
    if (obj.profile !== "nooverseg-ncdhw-native-grid-v1")
      invalid("profile", '"nooverseg-ncdhw-native-grid-v1"');
    if ("outputSpacingZYX" in obj)
      invalid("outputSpacingZYX", "no output spacing in version 1");
    policy = { version: 1, profile: "nooverseg-ncdhw-native-grid-v1" };
  } else {
    if (obj.profile !== "ncdhw-centered-v2")
      invalid("profile", '"ncdhw-centered-v2"');
    policy = {
      version: 2,
      profile: "ncdhw-centered-v2",
      outputSpacingZYX: positiveTriple(
        obj.outputSpacingZYX,
        "outputSpacingZYX",
      ),
    };
  }
  if (
    obj.provider !== "auto" &&
    obj.provider !== "webgpu" &&
    obj.provider !== "cpu"
  )
    invalid("provider", '"auto", "webgpu", or "cpu"');
  if (obj.mode !== "live") invalid("mode", '"live"');
  const source = fields(obj.source, "source", ["name", "source"]);
  const result: InferenceRecipe = {
    ...policy,
    source: {
      name: name(source.name, "source.name"),
      source: sourceSnapshot(source.source),
    },
    model: parseModel(obj.model),
    provider: obj.provider,
    mode: obj.mode,
    spacingZYX: positiveTriple(obj.spacingZYX, "spacingZYX"),
  };
  if ("precision" in obj) {
    if (obj.precision !== "float32" && obj.precision !== "float16")
      invalid("precision", '"float32" or "float16"');
    result.precision = obj.precision;
  }
  if ("compatibilityFixes" in obj) {
    if (typeof obj.compatibilityFixes !== "boolean")
      invalid("compatibilityFixes", "a boolean");
    result.compatibilityFixes = obj.compatibilityFixes;
  }
  if ("overlap" in obj) {
    if (typeof obj.overlap !== "boolean") invalid("overlap", "a boolean");
    result.overlap = obj.overlap;
  }
  if ("inputScaleIndex" in obj) {
    if (
      typeof obj.inputScaleIndex !== "number" ||
      !Number.isSafeInteger(obj.inputScaleIndex) ||
      obj.inputScaleIndex < 0
    )
      invalid("inputScaleIndex", "a nonnegative safe integer");
    result.inputScaleIndex = obj.inputScaleIndex;
  }
  return result;
}

/** Fetch concatenated original model bytes, with a hard bound before retaining each chunk. */
export async function fetchInferenceModel(
  model: Extract<InferenceRecipe["model"], { kind: "url" }>,
  signal: AbortSignal,
  fetchModel: typeof fetch = fetch,
): Promise<File> {
  signal.throwIfAborted();
  // Validate even when called directly, and snapshot URLs across awaits.
  const spec = parseModel(model);
  if (spec.kind !== "url") invalid("model.kind", '"url"');
  const bytes = new Uint8Array(spec.size);
  let received = 0;
  for (const url of spec.urls) {
    signal.throwIfAborted();
    const response = await fetchModel(url, {
      signal,
      mode: "cors",
      credentials: "omit",
    });
    const reader = response.body?.getReader();
    const cancel = () => {
      void reader?.cancel(signal.reason).catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      if (!response.ok)
        throw new Error(
          `HTTP ${response.status} ${response.statusText}`.trim(),
        );
      const length = response.headers.get("Content-Length");
      // Fetch exposes decompressed bytes; encoded Content-Length is not that size.
      const encoding = response.headers.get("Content-Encoding");
      if (
        (encoding === null || encoding === "identity") &&
        length !== null &&
        Number(length) > spec.size - received
      )
        throw new Error(
          `Expected ${spec.size} model bytes, response exceeds remaining size`,
        );
      if (reader !== undefined) {
        while (true) {
          const chunk = await reader.read();
          signal.throwIfAborted();
          if (chunk.done) break;
          if (chunk.value.byteLength > spec.size - received)
            throw new Error(
              `Expected ${spec.size} model bytes, received too many`,
            );
          bytes.set(chunk.value, received);
          received += chunk.value.byteLength;
        }
      }
    } catch (error) {
      // Do not drain oversized/error replies, including later multipart replies.
      await reader?.cancel(error).catch(() => {});
      throw error;
    } finally {
      signal.removeEventListener("abort", cancel);
      reader?.releaseLock();
    }
  }
  if (received !== spec.size)
    throw new Error(`Expected ${spec.size} model bytes, received ${received}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  signal.throwIfAborted();
  const hash = Array.from(new Uint8Array(digest), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
  if (hash !== spec.sha256) throw new Error("Model SHA-256 mismatch");
  return new File([bytes], spec.name);
}
