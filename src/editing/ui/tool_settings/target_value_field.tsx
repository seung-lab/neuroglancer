/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { VoxelDataType } from "@zettaai/edit-session";
import { useMemo, useState } from "preact/hooks";

import {
  UINT64_MAX,
  voxelDataTypeRange,
} from "#src/editing/tool_runtimes/mask_coord.js";
import { ParamInput } from "#src/editing/ui/tool_settings/param_input.js";
import { ParamLabel } from "#src/editing/ui/tool_settings/param_label.js";

/**
 * The "Target value" parameter row, shared by the Brush and Fill panels: the
 * segment ID / value painted into the target layer.
 *
 * Validation is driven by the target layer's `voxelDataType`: the accepted
 * range matches the layer's representable values, so signed layers (int8 etc.)
 * permit negatives and every type rejects values it can't hold. Built on
 * {@link ParamInput} (the draft pattern), so the user can clear the field,
 * type `0`/`-5`, or edit freely; invalid input shows a red field + the valid
 * range and the value commits only when it's in range.
 *
 * Until the layer type resolves (`voxelDataType === undefined`) the field
 * accepts any non-negative whole number — the safe default for segment IDs.
 */
export function TargetValueField({
  value,
  onCommit,
  voxelDataType,
  label = "Target value",
  hint,
}: {
  value: number | bigint;
  onCommit: (value: number | bigint) => void;
  voxelDataType?: VoxelDataType;
  label?: string;
  hint: string;
}) {
  const [invalid, setInvalid] = useState(false);
  const rule = useMemo(() => valueRule(voxelDataType), [voxelDataType]);

  return (
    <div class="neuroglancer-tool-panel-field">
      <div class="neuroglancer-tool-panel-row">
        <ParamLabel text={label} hint={hint} />
        <ParamInput<number | bigint>
          type="text"
          inputMode={rule.inputMode}
          value={value}
          parse={rule.parse}
          onCommit={onCommit}
          onInvalidChange={setInvalid}
        />
      </div>
      {invalid && (
        <div class="neuroglancer-tool-panel-error" role="alert">
          {rule.message}
        </div>
      )}
    </div>
  );
}

interface ValueRule {
  /** Parse + range-check raw text; null means empty/invalid (don't commit). */
  parse: (raw: string) => number | bigint | null;
  /** Inline message shown when the field is invalid. */
  message: string;
  inputMode: "numeric" | "decimal" | "text";
}

/** Build the validation rule for a target layer's voxel data type. */
function valueRule(voxelDataType?: VoxelDataType): ValueRule {
  if (voxelDataType === undefined) {
    return {
      parse: parseUnsignedBigInt,
      message: "Enter a whole number of 0 or greater.",
      inputMode: "numeric",
    };
  }
  if (voxelDataType === "uint64") {
    return {
      parse: (raw) => {
        const v = parseUnsignedBigInt(raw);
        return v === null || v > UINT64_MAX ? null : v;
      },
      message: `Enter a whole number from 0 to ${UINT64_MAX}.`,
      inputMode: "numeric",
    };
  }
  if (voxelDataType === "float32") {
    return {
      parse: (raw) => {
        const trimmed = raw.trim();
        if (trimmed === "") return null;
        const n = Number(trimmed);
        return Number.isFinite(n) ? n : null;
      },
      message: "Enter a number.",
      inputMode: "decimal",
    };
  }
  // Signed/unsigned integer types (8/16/32-bit).
  const { min, max } = voxelDataTypeRange(voxelDataType)!;
  return {
    parse: (raw) => {
      const n = parseInteger(raw, min < 0);
      return n === null || n < min || n > max ? null : n;
    },
    message: `Enter a whole number from ${min} to ${max}.`,
    inputMode: min < 0 ? "text" : "numeric",
  };
}

/** Parse a non-negative integer as a bigint, or null if the text is invalid. */
function parseUnsignedBigInt(raw: string): bigint | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

/** Parse a decimal integer (optionally signed), or null if the text is invalid. */
function parseInteger(raw: string, allowNegative: boolean): number | null {
  const trimmed = raw.trim();
  const pattern = allowNegative ? /^-?\d+$/ : /^\d+$/;
  if (!pattern.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isInteger(n) ? n : null;
}
