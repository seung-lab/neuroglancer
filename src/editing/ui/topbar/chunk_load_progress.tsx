/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import "#src/editing/ui/topbar/editing_topbar.css";

import { Check, Loader2, TriangleAlert } from "lucide-preact";
import { useEffect, useState } from "preact/hooks";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { useWatchable } from "#src/editing/ui/interop/use_watchable.js";

/** How long the "loaded" confirmation stays up before clearing. */
const CONFIRM_VISIBLE_MS = 3000;

/**
 * Topbar indicator for the background bbox-chunk preload (TM-316).
 *
 * - while `loading`: `chunks N/M` + a progress bar (painting is already usable);
 * - on `done` with no failures: a brief "loaded ✓" confirmation, then nothing;
 * - on `done` with failures: a warning with per-(layer, resolution) detail —
 *   painting still works (unavailable chunks zero-fill lazily on first read).
 */
export function ChunkLoadProgress({ host }: { host: EditSessionHost }) {
  const progress = useWatchable(host.chunkLoadProgress);

  const doneSuccess = progress.kind === "done" && progress.failed === 0;
  const [confirmVisible, setConfirmVisible] = useState(false);
  useEffect(() => {
    if (!doneSuccess) {
      setConfirmVisible(false);
      return;
    }
    setConfirmVisible(true);
    const timer = setTimeout(
      () => setConfirmVisible(false),
      CONFIRM_VISIBLE_MS,
    );
    return () => clearTimeout(timer);
  }, [doneSuccess]);

  if (progress.kind === "idle") return null;

  if (progress.kind === "loading") {
    const { loaded, total } = progress;
    const pct =
      total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
    return (
      <div
        class="neuroglancer-editing-topbar-group neuroglancer-editing-topbar-chunkload"
        role="status"
        aria-label={`Loading edit region: ${loaded} of ${total} chunks`}
        data-tooltip="Preloading the edit region — painting is available now"
      >
        <Loader2
          size={13}
          class="neuroglancer-editing-topbar-spinner"
          aria-hidden="true"
        />
        <span class="neuroglancer-editing-topbar-chunkload-label">
          chunks {loaded}/{total}
        </span>
        <span
          class="neuroglancer-editing-topbar-chunkload-bar"
          aria-hidden="true"
        >
          <span
            class="neuroglancer-editing-topbar-chunkload-fill"
            style={{ width: `${pct}%` }}
          />
        </span>
      </div>
    );
  }

  // progress.kind === "done"
  if (progress.failed > 0) {
    const detail = progress.failures
      .map((f) => `${f.layerId} @ ${f.resolution}: ${f.count}`)
      .join("\n");
    const noun = progress.failed === 1 ? "chunk" : "chunks";
    return (
      <div
        class="neuroglancer-editing-topbar-group neuroglancer-editing-topbar-chunkload warning"
        role="status"
        aria-label={`${progress.failed} ${noun} unavailable`}
        data-tooltip={`${progress.failed} ${noun} unavailable — they will load on demand while painting${
          detail ? `\n${detail}` : ""
        }`}
      >
        <TriangleAlert size={13} aria-hidden="true" />
        <span class="neuroglancer-editing-topbar-chunkload-label">
          {progress.failed} {noun} unavailable
        </span>
      </div>
    );
  }

  if (confirmVisible) {
    return (
      <div
        class="neuroglancer-editing-topbar-group neuroglancer-editing-topbar-chunkload success"
        role="status"
        aria-label="Edit region loaded"
        data-tooltip="Edit region fully loaded"
      >
        <Check size={13} aria-hidden="true" />
        <span class="neuroglancer-editing-topbar-chunkload-label">loaded</span>
      </div>
    );
  }

  return null;
}
