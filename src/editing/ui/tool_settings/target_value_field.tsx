/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { useEffect, useState } from "preact/hooks";

import { ParamLabel } from "#src/editing/ui/tool_settings/param_label.js";

/**
 * The "Target value" parameter row, shared by the Brush and Fill panels: a
 * numeric segment-ID input that commits a `bigint` on change.
 *
 * Unlike the previous inline handler — which silently reverted bad input,
 * making the typed value vanish with no explanation — this surfaces a visible
 * invalid state (red field + an inline message) and *keeps* the user's text so
 * they can correct it. Validation is live on input; the value commits on
 * change (blur / Enter) only when it parses to a non-negative integer.
 */
export function TargetValueField({
  value,
  onCommit,
  label = "Target value",
  hint,
}: {
  value: number | bigint;
  onCommit: (value: bigint) => void;
  label?: string;
  hint: string;
}) {
  const [draft, setDraft] = useState(() => value.toString());
  const [invalid, setInvalid] = useState(false);

  // Sync the draft to the committed value whenever it changes from outside
  // (e.g. a fresh session, or our own successful commit normalising "007" →
  // "7"). Bad input never commits, so the prop is unchanged and the draft is
  // left intact for the user to fix.
  useEffect(() => {
    setDraft(value.toString());
    setInvalid(false);
  }, [value]);

  const onInput = (e: Event) => {
    const raw = (e.currentTarget as HTMLInputElement).value;
    setDraft(raw);
    setInvalid(parseSegmentId(raw) === null);
  };

  const onChange = (e: Event) => {
    const parsed = parseSegmentId((e.currentTarget as HTMLInputElement).value);
    if (parsed === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onCommit(parsed);
  };

  return (
    <div class="neuroglancer-tool-panel-field">
      <div class="neuroglancer-tool-panel-row">
        <ParamLabel text={label} hint={hint} />
        <input
          type="text"
          inputMode="numeric"
          aria-invalid={invalid ? "true" : undefined}
          value={draft}
          onInput={onInput}
          onChange={onChange}
        />
      </div>
      {invalid && (
        <div class="neuroglancer-tool-panel-error" role="alert">
          Enter a whole number of 0 or greater.
        </div>
      )}
    </div>
  );
}

/** Parse a non-negative integer segment ID, or null if the text is invalid. */
function parseSegmentId(raw: string): bigint | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  try {
    const parsed = BigInt(trimmed);
    return parsed < 0n ? null : parsed;
  } catch {
    return null;
  }
}
