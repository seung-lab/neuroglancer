/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

interface ToolRow {
  readonly toolId: string;
  readonly label: string;
  readonly hotkey: string;
  readonly markDisabled: boolean;
}

const TOOL_ROWS: readonly ToolRow[] = [
  { toolId: "painting.brush", label: "Brush", hotkey: "B", markDisabled: false },
  { toolId: "painting.erase", label: "Eraser", hotkey: "E", markDisabled: false },
  { toolId: "painting.fill", label: "Fill", hotkey: "F", markDisabled: false },
  {
    toolId: "correspondence",
    label: "Correspondence",
    hotkey: "C",
    markDisabled: true,
  },
  {
    toolId: "z-extrapolation",
    label: "Z-extrapolation",
    hotkey: "Z",
    markDisabled: true,
  },
];

export function ToolList({
  knownToolIds,
  activeToolId,
  onToolClick,
}: {
  knownToolIds: Set<string>;
  activeToolId: string | undefined;
  onToolClick: (id: string) => void;
}) {
  return (
    <div class="neuroglancer-edit-session-section">
      <div class="neuroglancer-edit-session-section-title">Tools</div>
      {TOOL_ROWS.filter((row) => knownToolIds.has(row.toolId)).map((row) => (
        <div
          key={row.toolId}
          class={
            "neuroglancer-edit-session-tool-row" +
            (row.toolId === activeToolId ? " active" : "") +
            (row.markDisabled ? " disabled" : "")
          }
          onClick={() => onToolClick(row.toolId)}
        >
          <span class="neuroglancer-edit-session-tool-radio" />
          <span class="neuroglancer-edit-session-tool-label">
            {row.label}
            {row.markDisabled && (
              <span class="neuroglancer-edit-session-tool-disabled-marker">
                (disabled)
              </span>
            )}
          </span>
          <span class="neuroglancer-edit-session-tool-hotkey">
            {`[${row.hotkey}]`}
          </span>
        </div>
      ))}
    </div>
  );
}
