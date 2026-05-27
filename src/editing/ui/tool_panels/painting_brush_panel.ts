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
 * @file Panel widget for the `painting.brush` tool.
 *
 * Per `docs/edit-session-integration/architecture/04-ui-shell.md` §
 * "Per-tool panels", this panel renders the controls relevant to the brush
 * sub-tool: a size slider (1–129) with numeric input, preset cycle buttons,
 * and a target-value (BigInt) input.
 *
 * The user-facing value is the brush **size** in voxels — the diameter of
 * the footprint. The library's `PaintingSharedState.radius` field stores
 * the radius (`floor(size / 2)`), matching the reference codebase's
 * `radius = Math.floor(size / 2)` convention. So:
 *   - size 1 → radius 0 → paints the single center voxel
 *   - size 3 → radius 1 → paints the 5-voxel plus
 *   - size 5 → radius 2 → paints a 13-voxel diamond
 *
 * The panel reads/writes shared painting state via
 * `session.tools.getTool<PaintingTools>('painting').getState()` /
 * `patchState(...)`, and refreshes its widgets when the library emits
 * `painting.on('changed', ...)`.
 *
 * Mask config (image layer + threshold range) is left as a v2 enhancement.
 */

import type {
  PaintingSharedState,
  PaintingTools,
} from "@zetta-ai/edit-session";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { RefCounted } from "#src/util/disposable.js";

// Discrete preset sizes — the only values the user is allowed to select.
// Matches the reference codebase's `TOOL_SIZES` set.
const SIZE_PRESETS: readonly number[] = [1, 3, 5, 9, 17, 33, 65];
const MIN_PRESET_INDEX = 0;
const MAX_PRESET_INDEX = SIZE_PRESETS.length - 1;

function sizeToRadius(size: number): number {
  return Math.max(0, Math.floor(size / 2));
}

function radiusToSize(radius: number): number {
  // Inverse of `sizeToRadius` for odd sizes (the only ones we set).
  return radius * 2 + 1;
}

function radiusToPresetIndex(radius: number): number {
  return sizeToNearestPresetIndex(radiusToSize(radius));
}

function sizeToNearestPresetIndex(size: number): number {
  // The preset whose value most closely matches `size`. Linear search is
  // fine — the table has ~7 entries.
  if (!Number.isFinite(size)) return 0;
  let bestIdx = 0;
  let bestDelta = Math.abs(SIZE_PRESETS[0] - size);
  for (let i = 1; i < SIZE_PRESETS.length; ++i) {
    const delta = Math.abs(SIZE_PRESETS[i] - size);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Side-panel widget that surfaces shared painting state for the brush tool.
 * Constructed by the tool-panel registry only while a session is active.
 */
export class PaintingBrushPanel extends RefCounted {
  readonly element: HTMLElement;

  private rangeInput: HTMLInputElement | undefined;
  private numericInput: HTMLInputElement | undefined;
  private targetInput: HTMLInputElement | undefined;
  private presetButtons: HTMLButtonElement[] = [];
  private unsubscribePainting: (() => void) | undefined;

  constructor(private readonly host: EditSessionHost) {
    super();
    this.element = document.createElement("div");
    this.element.classList.add(
      "neuroglancer-tool-panel",
      "neuroglancer-painting-brush-panel",
    );

    this.render();

    this.registerDisposer(
      host.activeSession.changed.add(() => this.render()),
    );
  }

  override disposed(): void {
    this.detachPainting();
    while (this.element.firstChild !== null) {
      this.element.removeChild(this.element.firstChild);
    }
    super.disposed();
  }

  private render(): void {
    this.detachPainting();
    this.clear();

    const session = this.host.activeSession.value;
    if (session === undefined) {
      this.renderPlaceholder();
      return;
    }

    const painting = session.tools.getTool<PaintingTools>("painting");
    const state = painting.getState();

    this.element.appendChild(this.makeRadiusSection(painting, state));
    this.element.appendChild(this.makePresetSection(painting, state));
    this.element.appendChild(this.makeTargetSection(painting, state));
    // Mask config (image layer + threshold range) deferred to v2; the
    // library accepts `PaintingSharedState.mask` but no UI surface yet.

    this.unsubscribePainting = painting.on("changed", () => {
      this.refreshFromState(painting.getState());
    });
  }

  private renderPlaceholder(): void {
    const msg = document.createElement("p");
    msg.classList.add("neuroglancer-tool-panel-placeholder");
    msg.textContent = "Brush tool requires an active edit session.";
    this.element.appendChild(msg);
  }

  private makeRadiusSection(
    painting: PaintingTools,
    state: PaintingSharedState,
  ): HTMLElement {
    const section = document.createElement("div");
    section.classList.add("neuroglancer-tool-panel-row");

    const label = document.createElement("label");
    label.textContent = "Size";
    label.title =
      "Brush diameter in voxels (preset values only: 1, 3, 5, 9, 17, 33, " +
      "65). Size 1 paints a single voxel; size 3 paints a 5-voxel plus; " +
      "size 5 paints a 13-voxel diamond.";
    section.appendChild(label);

    const idxNow = radiusToPresetIndex(state.radius);
    const sizeNow = SIZE_PRESETS[idxNow];

    // Discrete slider over preset indices. ArrowUp/ArrowDown step between
    // presets naturally, and the slider cannot land on intermediate values.
    const range = document.createElement("input");
    range.type = "range";
    range.min = String(MIN_PRESET_INDEX);
    range.max = String(MAX_PRESET_INDEX);
    range.step = "1";
    range.valueAsNumber = idxNow;
    this.registerEventListener(range, "input", () => {
      this.applyPresetByIndex(painting, range.valueAsNumber);
    });
    section.appendChild(range);
    this.rangeInput = range;

    // Free-form numeric input. The user can type any value; on commit
    // (change / Enter / blur) we snap to the nearest preset. ArrowUp /
    // ArrowDown step between presets (overriding the default ±1 step) so
    // keyboard adjustment never gets stuck on a value that snaps back to
    // the same preset.
    const numeric = document.createElement("input");
    numeric.type = "number";
    numeric.min = String(SIZE_PRESETS[MIN_PRESET_INDEX]);
    numeric.max = String(SIZE_PRESETS[MAX_PRESET_INDEX]);
    numeric.step = "1";
    numeric.style.width = "5ch";
    numeric.valueAsNumber = sizeNow;
    this.registerEventListener(numeric, "change", () => {
      this.applyPresetByIndex(
        painting,
        sizeToNearestPresetIndex(numeric.valueAsNumber),
      );
    });
    this.registerEventListener(numeric, "keydown", (ev: Event) => {
      const key = (ev as KeyboardEvent).key;
      if (key === "ArrowUp" || key === "ArrowDown") {
        ev.preventDefault();
        const currentIdx = radiusToPresetIndex(painting.getState().radius);
        const delta = key === "ArrowUp" ? 1 : -1;
        this.applyPresetByIndex(painting, currentIdx + delta);
      }
    });
    section.appendChild(numeric);
    this.numericInput = numeric;

    return section;
  }

  private makePresetSection(
    painting: PaintingTools,
    state: PaintingSharedState,
  ): HTMLElement {
    const section = document.createElement("div");
    section.classList.add("neuroglancer-tool-panel-row");

    const label = document.createElement("label");
    label.textContent = "Presets";
    section.appendChild(label);

    const sizeNow = radiusToSize(state.radius);
    const wrap = document.createElement("div");
    wrap.classList.add("neuroglancer-tool-panel-presets");
    this.presetButtons = [];
    for (const preset of SIZE_PRESETS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = String(preset);
      btn.dataset.presetValue = String(preset);
      if (preset === sizeNow) btn.classList.add("active");
      this.registerEventListener(btn, "click", () => {
        this.applySize(painting, preset);
      });
      wrap.appendChild(btn);
      this.presetButtons.push(btn);
    }
    section.appendChild(wrap);
    return section;
  }

  private makeTargetSection(
    painting: PaintingTools,
    state: PaintingSharedState,
  ): HTMLElement {
    const section = document.createElement("div");
    section.classList.add("neuroglancer-tool-panel-row");

    const label = document.createElement("label");
    label.textContent = "Target value";
    label.title =
      "Segment id to paint. 0 = erase (no visible segment). Accepts decimal " +
      "or hex (0x…) integers up to 64 bits.";
    section.appendChild(label);

    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "numeric";
    input.value = state.activeValue.toString();
    input.title = label.title;
    this.registerEventListener(input, "change", () => {
      this.applyTargetValue(painting, input);
    });
    section.appendChild(input);
    this.targetInput = input;

    return section;
  }

  private applySize(painting: PaintingTools, presetSize: number): void {
    const nextRadius = sizeToRadius(presetSize);
    const currentRadius = painting.getState().radius;
    if (nextRadius === currentRadius) {
      this.refreshFromState(painting.getState());
      return;
    }
    painting.patchState({ radius: nextRadius });
  }

  private applyPresetByIndex(painting: PaintingTools, rawIndex: number): void {
    const clamped = Math.max(
      MIN_PRESET_INDEX,
      Math.min(MAX_PRESET_INDEX, Math.round(rawIndex)),
    );
    this.applySize(painting, SIZE_PRESETS[clamped]);
  }

  private applyTargetValue(
    painting: PaintingTools,
    input: HTMLInputElement,
  ): void {
    const raw = input.value.trim();
    let parsed: bigint;
    try {
      parsed = BigInt(raw);
    } catch {
      input.value = painting.getState().activeValue.toString();
      return;
    }
    painting.patchState({ activeValue: parsed });
  }

  private refreshFromState(state: PaintingSharedState): void {
    const idx = radiusToPresetIndex(state.radius);
    const size = SIZE_PRESETS[idx];
    if (
      this.rangeInput !== undefined &&
      this.rangeInput.valueAsNumber !== idx
    ) {
      this.rangeInput.valueAsNumber = idx;
    }
    if (
      this.numericInput !== undefined &&
      // Avoid clobbering the input mid-edit; only sync when the parsed value
      // differs from the snapped size.
      sizeToNearestPresetIndex(this.numericInput.valueAsNumber) !== idx
    ) {
      this.numericInput.valueAsNumber = size;
    }
    for (const btn of this.presetButtons) {
      const preset = Number(btn.dataset.presetValue);
      btn.classList.toggle("active", preset === size);
    }
    if (this.targetInput !== undefined) {
      const desired = state.activeValue.toString();
      if (this.targetInput.value !== desired) {
        this.targetInput.value = desired;
      }
    }
  }

  private detachPainting(): void {
    if (this.unsubscribePainting !== undefined) {
      try {
        this.unsubscribePainting();
      } catch {
        // ignore
      }
      this.unsubscribePainting = undefined;
    }
  }

  private clear(): void {
    this.rangeInput = undefined;
    this.numericInput = undefined;
    this.targetInput = undefined;
    this.presetButtons = [];
    while (this.element.firstChild !== null) {
      this.element.removeChild(this.element.firstChild);
    }
  }
}

