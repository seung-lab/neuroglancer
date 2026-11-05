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

import {
  INFERENCE_RECIPE_URL,
  parseInferenceRecipe,
} from "#src/inference/recipe.js";
import type { WatershedOptions } from "#src/watershed/base.js";
import {
  validateWatershedHalo,
  validateWatershedOptions,
} from "#src/watershed/base.js";

export const WATERSHED_RECIPE_URL = "watershed://recipe";

/** Version/profile freeze one visible-slice union and 150 ms debounce.
 * The isotropic native-voxel halo defaults to 8 and may be overridden.
 * Current viewport/ROI bounds and runtime/session objects are never saved.
 */
export interface WatershedRecipe {
  version: 1;
  profile: "visible-slice-union-v1";
  mode: "live";
  source: { name: string; source: unknown };
  inputScaleIndex: number;
  channelsXYZ: [number, number, number];
  /** Isotropic padding in native voxels; omission uses DEFAULT_WATERSHED_HALO. */
  halo?: number;
  options: WatershedOptions;
  spacingXYZ: [number, number, number];
}

function invalid(path: string, expected: string): never {
  throw new Error(`Invalid watershed recipe ${path}: expected ${expected}`);
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

function nonnegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    invalid(path, "a nonnegative safe integer");
  return value;
}

function triple(
  value: unknown,
  path: string,
  coordinate: (value: unknown, path: string) => number,
): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3)
    invalid(path, "an XYZ triple");
  return [0, 1, 2].map((i) => coordinate(value[i], `${path}[${i}]`)) as [
    number,
    number,
    number,
  ];
}

/** Never invoke getters, iterators, or toJSON. Reject lossy/runtime structures.
 * Retain undefined object fields until schema validation so an unsupported or
 * explicitly invalid recipe field cannot disappear. Only source JSON omits
 * undefined object fields, matching DataSource.toJSON/JSON.stringify.
 */
function snapshot(
  value: unknown,
  path: string,
  omitUndefined = false,
): unknown {
  const ancestors = new Set<object>();
  function copy(value: unknown, path: string, depth: number): unknown {
    if (depth > 64)
      invalid(path, "JSON data no more than 64 levels deep (no cycles)");
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return value;
    if (typeof value === "number") return finite(value, path);
    if (typeof value !== "object") invalid(path, "JSON data");
    if (ancestors.has(value)) invalid(path, "acyclic JSON data");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (
          Object.getPrototypeOf(value) !== Array.prototype ||
          Reflect.ownKeys(value).length !== value.length + 1
        )
          invalid(path, "a dense JSON array without extra properties");
        const result: unknown[] = [];
        for (let i = 0; i < value.length; ++i) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
          if (descriptor === undefined)
            invalid(`${path}[${i}]`, "a dense JSON array entry");
          if (!("value" in descriptor) || !descriptor.enumerable)
            invalid(
              `${path}[${i}]`,
              "JSON data, not an accessor or hidden entry",
            );
          result.push(copy(descriptor.value, `${path}[${i}]`, depth + 1));
        }
        return result;
      }
      const obj = object(value, path);
      const entries: [string, unknown][] = [];
      for (const key of Reflect.ownKeys(obj)) {
        if (typeof key !== "string")
          invalid(path, "JSON data without symbol keys");
        const descriptor = Object.getOwnPropertyDescriptor(obj, key)!;
        if (!("value" in descriptor) || !descriptor.enumerable)
          invalid(
            `${path}.${key}`,
            "JSON data, not an accessor or hidden field",
          );
        if (descriptor.value === undefined) {
          if (!omitUndefined) entries.push([key, undefined]);
        } else {
          entries.push([
            key,
            copy(descriptor.value, `${path}.${key}`, depth + 1),
          ]);
        }
      }
      return Object.fromEntries(entries);
    } finally {
      ancestors.delete(value);
    }
  }
  return copy(value, path, 0);
}

/** Check only URL/source fields, never arbitrary shader/metadata strings. */
function inferenceUrl(url: string, path: string): boolean {
  if (/\bwatershed:\/\//i.test(url))
    invalid(
      path,
      "a non-watershed data source (recursive watershed is unsupported)",
    );
  if (/\b(?:blob|file):/i.test(url))
    invalid(
      path,
      "a restorable data source URL, not an ephemeral blob/file source; host the data and use its URL",
    );
  if (!/\binference:\/\//i.test(url)) return false;
  if (url !== INFERENCE_RECIPE_URL)
    invalid(
      path,
      '"inference://recipe" with saved state, not a session inference://id or wrapped inference URL; save the upstream inference recipe',
    );
  return true;
}

function sourceUrl(value: unknown, path: string): void {
  if (typeof value !== "string") invalid(path, "a nonempty data source URL");
  inferenceUrl(value, path);
  if (!/^[a-z][a-z\d+.-]*:\/\/\S+$/i.test(value))
    invalid(path, "a nonempty data source URL");
  try {
    new URL(value);
  } catch {
    invalid(path, "a valid data source URL");
  }
}

function checkNestedSources(
  value: unknown,
  path: string,
  sourceField = false,
): void {
  if (typeof value === "string") {
    if (sourceField && inferenceUrl(value, path))
      invalid(
        path,
        'an "inference://recipe" source object with saved recipe state',
      );
  } else if (Array.isArray(value)) {
    value.forEach((entry, i) =>
      checkNestedSources(entry, `${path}[${i}]`, sourceField),
    );
  } else if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const inference =
      typeof obj.url === "string" && inferenceUrl(obj.url, `${path}.url`);
    if (inference) {
      try {
        obj.state = parseInferenceRecipe(obj.state);
      } catch (error) {
        throw new Error(
          `Invalid watershed recipe ${path}.state: ${String(error)}`,
        );
      }
    }
    for (const [key, entry] of Object.entries(obj)) {
      if (key === "url" && inference) continue;
      checkNestedSources(
        entry,
        `${path}.${key}`,
        key === "url" || key === "source" || key === "sources",
      );
    }
  }
}

function sourceSnapshot(value: unknown): unknown {
  // value is already detached and safe to inspect; validate inference state
  // before omitting undefined fields (e.g. precision: undefined is invalid).
  const specs = Array.isArray(value) ? value : [value];
  if (specs.length === 0) invalid("source.source", "at least one data source");
  for (const [i, spec] of specs.entries()) {
    const path = `source.source[${i}]`;
    sourceUrl(typeof spec === "string" ? spec : object(spec, path).url, path);
  }
  checkNestedSources(value, "source.source", true);
  return snapshot(value, "source.source", true);
}

function parseOptions(value: unknown): WatershedOptions {
  const obj = fields(value, "options", [
    "highThreshold",
    "lowThreshold",
    "sizeThreshold",
    "dustThreshold",
    "maskThreshold",
    "aggThreshold",
  ]);
  const result: WatershedOptions = {
    highThreshold: finite(obj.highThreshold, "options.highThreshold"),
    lowThreshold: finite(obj.lowThreshold, "options.lowThreshold"),
    sizeThreshold: finite(obj.sizeThreshold, "options.sizeThreshold"),
    dustThreshold: finite(obj.dustThreshold, "options.dustThreshold"),
    ...("maskThreshold" in obj
      ? { maskThreshold: finite(obj.maskThreshold, "options.maskThreshold") }
      : {}),
    ...("aggThreshold" in obj
      ? { aggThreshold: finite(obj.aggThreshold, "options.aggThreshold") }
      : {}),
  };
  validateWatershedOptions(result);
  return result;
}

/** Validate and detach saved JSON; never resolve viewer/session objects.
 * An upstream local-model inference descriptor is preserved, not made portable:
 * restoration must visibly require a hosted model URL in that case.
 */
export function parseWatershedRecipe(value: unknown): WatershedRecipe {
  const obj = fields(snapshot(value, ""), "", [
    "version",
    "profile",
    "mode",
    "source",
    "inputScaleIndex",
    "channelsXYZ",
    "halo",
    "options",
    "spacingXYZ",
  ]);
  if (obj.version !== 1) invalid("version", "1");
  if (obj.profile !== "visible-slice-union-v1")
    invalid("profile", '"visible-slice-union-v1"');
  if (obj.mode !== "live") invalid("mode", '"live"');
  const source = fields(obj.source, "source", ["name", "source"]);
  const halo = "halo" in obj ? finite(obj.halo, "halo") : undefined;
  if (halo !== undefined) validateWatershedHalo(halo);
  return {
    version: 1,
    profile: "visible-slice-union-v1",
    mode: "live",
    source: {
      name: name(source.name, "source.name"),
      source: sourceSnapshot(source.source),
    },
    inputScaleIndex: nonnegativeInteger(obj.inputScaleIndex, "inputScaleIndex"),
    // Native channel count/mask-channel bounds are checked when preparing input.
    channelsXYZ: triple(obj.channelsXYZ, "channelsXYZ", nonnegativeInteger),
    ...(halo === undefined ? {} : { halo }),
    options: parseOptions(obj.options),
    spacingXYZ: triple(obj.spacingXYZ, "spacingXYZ", (value, path) => {
      const n = finite(value, path);
      if (n <= 0) invalid(path, "a positive finite coordinate");
      return n;
    }),
  };
}
