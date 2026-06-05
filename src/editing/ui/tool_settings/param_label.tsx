/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { Info } from "lucide-preact";

/**
 * A tool-panel parameter label with an inline help marker. The marker carries
 * a `data-tooltip` hint surfaced by the shared fast-tooltip mechanism (see
 * fast_tooltip.ts), so hovering the ⓘ explains what the parameter does.
 *
 * Drop-in replacement for a bare `<label>` inside `.neuroglancer-tool-panel-row`.
 */
export function ParamLabel({ text, hint }: { text: string; hint: string }) {
  return (
    <label>
      {text}
      <span class="neuroglancer-param-hint" data-tooltip={hint} aria-hidden="true">
        <Info size={13} />
      </span>
    </label>
  );
}
