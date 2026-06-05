/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * @file Bridge between the edit-session host and the segmentation layer's
 * viewport selection paths.
 *
 * While an edit session is active and a non-cursor tool (brush, eraser,
 * fill, z-extrapolation, correspondence) is selected, picking in the
 * viewport must not toggle segment visibility/selection — those clicks
 * belong to the active tool. The host exposes the active tool through
 * `activeSession.value?.getActiveToolId()`; `undefined` means cursor mode
 * (selection allowed).
 */

import type { TopLevelLayerListSpecification } from "#src/layer/index.js";

interface SegmentSelectionLockHost {
  activeSession?: {
    value?: {
      getActiveToolId(): string | undefined;
    };
  };
}

/**
 * Returns `true` when an edit session is active with a non-cursor tool
 * selected, meaning viewport segment selection should be suppressed.
 *
 * Returns `false` when no `editSessionHost` is wired on the layer manager
 * (test viewers, alternative embeddings) or when the session is in cursor
 * mode, leaving the stock selection behavior unchanged.
 */
export function isSegmentSelectionLockedByActiveTool(
  root: TopLevelLayerListSpecification,
): boolean {
  const host = (root as { editSessionHost?: SegmentSelectionLockHost })
    .editSessionHost;
  const session = host?.activeSession?.value;
  return session !== undefined && session.getActiveToolId() !== undefined;
}
