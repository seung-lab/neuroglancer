/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import "#src/editing/ui/segmented_control.css";

/**
 * A small segmented control: a row of mutually-exclusive options where the
 * active one is highlighted (e.g. the fill panel's `[2D | 3D]` mode picker).
 * Use over {@link ToggleSwitch} when both states deserve an explicit, equally
 * weighted label rather than an on/off reading.
 *
 * Renders as a `role="radiogroup"` of `role="radio"` buttons so it stays
 * keyboard- and screen-reader-accessible.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  ariaLabel,
  disabled = false,
  onChange,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  ariaLabel: string;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div
      class="neuroglancer-segmented-control"
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            data-active={active ? "true" : "false"}
            class="neuroglancer-segmented-control-option"
            onClick={() => {
              if (!disabled && !active) onChange(option.value);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
