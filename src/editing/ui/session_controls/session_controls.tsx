/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import "#src/editing/ui/session_controls/session_controls.css";

import type { EditSession, SessionError } from "@zetta-ai/edit-session";
import { Resolution } from "@zetta-ai/edit-session";
import { useCallback, useEffect, useReducer, useRef, useState } from "preact/hooks";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { useSignal } from "#src/editing/ui/interop/use_signal.js";
import { useWatchable } from "#src/editing/ui/interop/use_watchable.js";
import { ActiveToolSettings } from "#src/editing/ui/session_controls/active_tool_settings.js";
import { HistoryControls } from "#src/editing/ui/session_controls/history_controls.js";
import { SaveStatus } from "#src/editing/ui/session_controls/save_status.js";
import { SaveTracker } from "#src/editing/ui/session_controls/save_tracker.js";
import { SessionActions } from "#src/editing/ui/session_controls/session_actions.js";
import { ToolList } from "#src/editing/ui/session_controls/tool_list.js";

export function SessionControls({ host }: { host: EditSessionHost }) {
  const sessionOrUndefined = useWatchable(host.activeSession);
  const session = sessionOrUndefined ?? undefined;

  if (session === undefined) {
    return (
      <div class="neuroglancer-edit-session-section">
        <div class="neuroglancer-edit-session-section-title">Session</div>
        <div class="neuroglancer-edit-session-status-row">No active session.</div>
      </div>
    );
  }

  return <SessionContent host={host} session={session} />;
}

function SessionContent({
  host,
  session,
}: {
  host: EditSessionHost;
  session: EditSession;
}) {
  const [, forceRender] = useReducer((x: number) => x + 1, 0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const saveTrackerRef = useRef<SaveTracker | undefined>(undefined);
  if (saveTrackerRef.current === undefined) {
    saveTrackerRef.current = new SaveTracker(host, session);
  }
  const saveTracker = saveTrackerRef.current;

  useEffect(() => {
    return () => saveTracker.dispose();
  }, [saveTracker]);

  useEffect(() => {
    const unsubs = [
      session.on("active-tool-changed", () => forceRender(0)),
      session.on("history-changed", () => forceRender(0)),
      session.dirty.on("dirty-changed", () => forceRender(0)),
      session.on("error", (err: SessionError) => {
        if (err.kind === "fatal") {
          setErrorMessage(`Session error: ${err.message}`);
        } else {
          setErrorMessage(err.message);
        }
      }),
    ];
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [session]);

  useSignal(saveTracker.changed);

  const knownToolIds = new Set(session.tools.toolIds);
  const activeToolId = session.tools.getActiveToolId();
  const snapshot = session.getHistory();

  const handleToolClick = useCallback(
    (toolId: string) => {
      try {
        session.setActiveTool(toolId);
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : String(err));
      }
    },
    [session],
  );

  const handleError = useCallback((msg: string) => {
    setErrorMessage(msg);
  }, []);

  const region = session.config.region;
  const bbox = region.bbox;
  const w = Math.max(0, bbox[3] - bbox[0]);
  const h = Math.max(0, bbox[4] - bbox[1]);
  const d = Math.max(0, bbox[5] - bbox[2]);
  const voxelSizeNm = Resolution.toVoxelSize(region.resolution);

  const intent = host.state.value.value;
  const intentByLayer = new Map<
    string,
    { role: "writable" | "locked"; resolutions: readonly string[] }
  >();
  if (intent !== null) {
    for (const layer of intent.layers) {
      intentByLayer.set(layer.layerId, {
        role: layer.role,
        resolutions: layer.resolutions,
      });
    }
  }
  const layersParts = session.config.layers.map((sel) => {
    const meta = intentByLayer.get(sel.layerId);
    const role = meta?.role ?? "writable";
    const flag = role === "writable" ? "w" : "r";
    const resolutions =
      meta?.resolutions ?? sel.selectedResolutions;
    return `${sel.layerId} (${flag}) [${resolutions.join(", ")}]`;
  });

  return (
    <>
      <div class="neuroglancer-edit-session-section">
        <div class="neuroglancer-edit-session-section-title">Session</div>
        <div class="neuroglancer-edit-session-status-row">
          {"Region: " +
            `${w}x${h}x${d} @ ` +
            `${formatNm(voxelSizeNm[0])}x` +
            `${formatNm(voxelSizeNm[1])}x` +
            `${formatNm(voxelSizeNm[2])}nm`}
        </div>
        <div class="neuroglancer-edit-session-status-row">
          {`Layers: ${layersParts.join(", ")}`}
        </div>
      </div>

      <ToolList
        knownToolIds={knownToolIds}
        activeToolId={activeToolId}
        onToolClick={handleToolClick}
      />

      <ActiveToolSettings session={session} host={host} />

      <HistoryControls
        session={session}
        snapshot={snapshot}
        onError={handleError}
      />

      <SessionActions
        host={host}
        session={session}
        saveTracker={saveTracker}
        onError={handleError}
      />

      <SaveStatus saveTracker={saveTracker} />

      {errorMessage !== null && (
        <div class="neuroglancer-edit-session-error-banner">{errorMessage}</div>
      )}
    </>
  );
}

function formatNm(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Math.abs(value - Math.round(value)) < 1e-6) {
    return String(Math.round(value));
  }
  return value.toFixed(2);
}
