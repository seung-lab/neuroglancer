/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import "#src/editing/ui/session_controls/pending_changes.css";

import type { LayerId } from "@zettaai/edit-session";
import { useCallback, useState } from "preact/hooks";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { useSignal } from "#src/editing/ui/interop/use_signal.js";
import { useWatchable } from "#src/editing/ui/interop/use_watchable.js";
import { StatusMessage } from "#src/status.js";

const NO_SAVE_BACKEND_HINT =
  "Saving is unavailable — no save backend is registered.";

export function PendingChanges({ host }: { host: EditSessionHost }) {
  useSignal(host.commitTarget.changed);
  const [busy, setBusy] = useState(false);
  const saveAvailable = useWatchable(host.saveBackendAvailable);
  const layerIds = host.commitTarget.pendingLayerIds();

  const runReset = useCallback(
    (layerId: LayerId | undefined) => {
      const target =
        layerId === undefined ? "all layers" : `layer "${String(layerId)}"`;
      const ok = window.confirm(
        `Discard all in-memory patches for ${target}? This cannot be undone.`,
      );
      if (!ok) return;
      if (layerId === undefined) {
        host.resetAllCommitted();
      } else {
        host.resetLayer(layerId);
      }
    },
    [host],
  );

  const runSave = useCallback(
    async (ids: readonly LayerId[] | undefined) => {
      if (busy) return;
      setBusy(true);
      try {
        const result = await host.saveCommitted(ids);
        const failed = result.outcomes.filter((o) => o.status === "failed");
        if (failed.length === 0) {
          if (result.outcomes.length === 0) {
            StatusMessage.showTemporaryMessage("Nothing to save.", 3000);
          } else {
            StatusMessage.showTemporaryMessage(
              `Saved ${result.outcomes.length} layer(s) to backend.`,
              4000,
            );
          }
        } else {
          const summary = failed
            .map((o) =>
              o.status === "failed" ? `${o.layerId}: ${o.error.message}` : "",
            )
            .filter((s) => s.length > 0)
            .join("; ");
          StatusMessage.showTemporaryMessage(
            `Save partially failed: ${summary}`,
            8000,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        StatusMessage.showTemporaryMessage(`Save threw: ${message}`, 8000);
      } finally {
        setBusy(false);
      }
    },
    [host, busy],
  );

  return (
    <div class="neuroglancer-pending-changes-panel">
      {layerIds.length === 0 ? (
        <div class="neuroglancer-pending-changes-empty">
          No in-memory patches. Paint inside an edit session and Commit to
          queue changes here.
        </div>
      ) : (
        <>
          <div class="neuroglancer-pending-changes-list">
            {layerIds.map((layerId) => (
              <LayerRow
                key={String(layerId)}
                host={host}
                layerId={layerId}
                busy={busy}
                saveAvailable={saveAvailable}
                onSave={() => void runSave([layerId])}
                onReset={() => runReset(layerId)}
              />
            ))}
          </div>
          <div class="neuroglancer-pending-changes-global-actions">
            <button
              type="button"
              class="primary"
              disabled={busy || !saveAvailable}
              title={saveAvailable ? undefined : NO_SAVE_BACKEND_HINT}
              onClick={() => void runSave(undefined)}
            >
              Save all to backend
            </button>
            <button
              type="button"
              class="danger"
              disabled={busy}
              onClick={() => runReset(undefined)}
            >
              Reset all
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function LayerRow({
  host,
  layerId,
  busy,
  saveAvailable,
  onSave,
  onReset,
}: {
  host: EditSessionHost;
  layerId: LayerId;
  busy: boolean;
  saveAvailable: boolean;
  onSave: () => void;
  onReset: () => void;
}) {
  const chunkCount = host.commitTarget.countLayerChunks(layerId);
  return (
    <div class="neuroglancer-pending-changes-row">
      <div class="neuroglancer-pending-changes-row-label">
        <span class="neuroglancer-pending-changes-row-name">
          {String(layerId)}
        </span>
        <span class="neuroglancer-pending-changes-row-count">
          {`${chunkCount} chunk${chunkCount === 1 ? "" : "s"}`}
        </span>
      </div>
      <div class="neuroglancer-pending-changes-row-actions">
        <button
          type="button"
          disabled={busy || !saveAvailable}
          title={saveAvailable ? undefined : NO_SAVE_BACKEND_HINT}
          onClick={onSave}
        >
          Save
        </button>
        <button type="button" class="danger" disabled={busy} onClick={onReset}>
          Reset
        </button>
      </div>
    </div>
  );
}
