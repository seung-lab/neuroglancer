/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { useEffect, useRef, useState } from "preact/hooks";

/**
 * The canonical editable value control for tool panels — the "draft pattern".
 *
 * While the field is focused the user owns the text: we never block a
 * keystroke, never reformat, and never revert. Empty and intermediate strings
 * (including a bare "0") are always allowed so the user can clear the field and
 * retype from scratch. The committed `value` is parsed/clamped and emitted via
 * `onCommit` only on blur or Enter; an invalid or empty field restores the last
 * committed value on blur rather than leaving a broken state.
 *
 * The crucial detail is the focus guard in the sync effect: external state is
 * adopted into the draft only when the field is *not* being edited. Without it,
 * the parent's frequent re-renders overwrite the draft mid-edit — the old
 * "can't clear the input / can't type 0" bug. All clamping and normalisation
 * lives in the caller's `parse`, so it runs on commit, never per-keystroke.
 *
 * Renders a bare `<input>` (no wrapper) so adjacency selectors such as
 * `input[type="range"] + input[type="number"]` keep working and callers can
 * compose it into their own row/label/error layout.
 */
export function ParamInput<T>({
  value,
  parse,
  onCommit,
  format = (v: T) => String(v),
  onInvalidChange,
  type = "text",
  inputMode,
  min,
  max,
  step,
  class: className,
  ariaLabel,
  disabled = false,
}: {
  /** The committed value the field reflects when not being edited. */
  value: T;
  /** Parse + normalise raw text; return null for empty/invalid input. */
  parse: (raw: string) => T | null;
  /** Called with the parsed value on commit (blur / Enter). */
  onCommit: (value: T) => void;
  /** Render the committed value as text (default `String`). */
  format?: (value: T) => string;
  /** Notified whenever the live validity of the draft changes. */
  onInvalidChange?: (invalid: boolean) => void;
  type?: "text" | "number";
  inputMode?: "numeric" | "decimal" | "text";
  min?: number;
  max?: number;
  step?: number;
  class?: string;
  ariaLabel?: string;
  /** When true the field is read-only and reflects the committed value. */
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(() => format(value));
  const [invalid, setInvalid] = useState(false);

  // Adopt the committed value into the draft ONLY when the field isn't being
  // edited. While focused the user owns the text — we never reformat, revert,
  // or clobber a keystroke. `format`/`onInvalidChange` identity is intentionally
  // excluded: we re-sync solely in response to a new committed `value`.
  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setDraft(format(value));
      setInvalid(false);
      onInvalidChange?.(false);
    }
  }, [value]);

  const flag = (bad: boolean) => {
    setInvalid(bad);
    onInvalidChange?.(bad);
  };

  const onInput = (e: Event) => {
    const raw = (e.currentTarget as HTMLInputElement).value;
    setDraft(raw);
    // Empty / partial input is allowed while typing and never flagged; only a
    // non-empty string that can't parse is surfaced as invalid.
    flag(raw.trim() !== "" && parse(raw) === null);
  };

  const commit = () => {
    const parsed = parse(draft);
    if (parsed === null) {
      // Invalid or empty on blur: restore the last committed value so the
      // field is never left broken.
      setDraft(format(value));
      flag(false);
      return;
    }
    // Reflect the normalised form immediately (e.g. "007" → "7", even → odd)
    // even when the committed value is unchanged and won't re-trigger the sync.
    setDraft(format(parsed));
    flag(false);
    onCommit(parsed);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const input = e.currentTarget as HTMLInputElement;
    if (e.key === "Enter") {
      input.blur();
    } else if (e.key === "Escape") {
      setDraft(format(value));
      flag(false);
      input.blur();
    }
  };

  return (
    <input
      ref={inputRef}
      type={type}
      inputMode={inputMode}
      min={min}
      max={max}
      step={step}
      class={className}
      aria-label={ariaLabel}
      aria-invalid={invalid ? "true" : undefined}
      disabled={disabled}
      value={draft}
      onInput={onInput}
      onBlur={commit}
      onKeyDown={onKeyDown}
    />
  );
}
