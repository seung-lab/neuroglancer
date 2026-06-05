/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import "#src/editing/ui/toggle_switch.css";

/**
 * A pill-shaped on/off switch. Replaces bare checkboxes where the control
 * gates a chunk of UI (e.g. the brush Advanced section) or represents a
 * binary feature flag. Renders as a `role="switch"` button so it stays
 * keyboard- and screen-reader-accessible.
 */
export function ToggleSwitch({
  checked,
  disabled = false,
  title,
  ariaLabel,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  title?: string;
  ariaLabel: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      data-checked={checked ? "true" : "false"}
      class="neuroglancer-toggle-switch"
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
    >
      <span class="neuroglancer-toggle-switch-thumb" aria-hidden="true" />
    </button>
  );
}
