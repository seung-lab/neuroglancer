/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

export function ZExtrapolation() {
  return (
    <div class="neuroglancer-tool-panel neuroglancer-z-extrapolation-panel">
      <p class="neuroglancer-tool-panel-placeholder">
        Z-extrapolation tool is not available in v1.
      </p>
      <div class="neuroglancer-tool-panel-row">
        <button type="button" disabled>
          Propagate slice
        </button>
      </div>
    </div>
  );
}
