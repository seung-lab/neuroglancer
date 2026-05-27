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
 * @file Panel widget for the `painting.erase` tool.
 *
 * Per `docs/edit-session-integration/architecture/04-ui-shell.md`, the eraser
 * shares `PaintingSharedState.radius` with the brush panel (both panels patch
 * the same `radius` field), and surfaces the erase value as read-only —
 * typically `0n` for segmentation. Preset cycle buttons are reused so the
 * user can switch size from either panel.
 *
 * The user-facing value is **size** (footprint diameter in voxels). The
 * library's `radius` is `floor(size / 2)`; see the brush panel's docstring
 * for the size→radius mapping.
 */

import type {
  PaintingSharedState,
  PaintingTools,
} from "@zetta-ai/edit-session";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { RefCounted } from "#src/util/disposable.js";

// Discrete preset sizes — see brush panel for rationale.
const SIZE_PRESETS: readonly number[] = [1, 3, 5, 9, 17, 33, 65];
const MIN_PRESET_INDEX = 0;
const MAX_PRESET_INDEX = SIZE_PRESETS.length - 1;

function sizeToRadius(size: number): number {
  return Math.max(0, Math.floor(size / 2));
}

function radiusToSize(radius: number): number {
  return radius * 2 + 1;
}

function radiusToPresetIndex(radius: number): number {
  return sizeToNearestPresetIndex(radiusToSize(radius));
}

function sizeToNearestPresetIndex(size: number): number {
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
 * Side-panel widget that surfaces shared painting state for the eraser tool.
 * Shares `PaintingSharedState.radius` with the brush panel.
 */
export class PaintingEraserPanel extends RefCounted {
  readonly element: HTMLElement;

  private rangeInput: HTMLInputElement | undefined;
  private numericInput: HTMLInputElement | undefined;
  private eraseValueDisplay: HTMLSpanElement | undefined;
  private presetButtons: HTMLButtonElement[] = [];
  private unsubscribePainting: (() => void) | undefined;

  constructor(private readonly host: EditSessionHost) {
    super();
    this.element = document.createElement("div");
    this.element.classList.add(
      "neuroglancer-tool-panel",
      "neuroglancer-painting-eraser-panel",
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
    this.element.appendChild(this.makeEraseValueSection(state));

    this.unsubscribePainting = painting.on("changed", () => {
      this.refreshFromState(painting.getState());
    });
  }

  private renderPlaceholder(): void {
    const msg = document.createElement("p");
    msg.classList.add("neuroglancer-tool-panel-placeholder");
    msg.textContent = "Eraser tool requires an active edit session.";
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
      "Eraser diameter in voxels (preset values only: 1, 3, 5, 9, 17, 33, " +
      "65).";
    section.appendChild(label);

    const idxNow = radiusToPresetIndex(state.radius);
    const sizeNow = SIZE_PRESETS[idxNow];

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

  private makeEraseValueSection(state: PaintingSharedState): HTMLElement {
    const section = document.createElement("div");
    section.classList.add("neuroglancer-tool-panel-row");

    const label = document.createElement("label");
    label.textContent = "Erase value";
    section.appendChild(label);

    const display = document.createElement("span");
    display.classList.add("neuroglancer-tool-panel-readonly");
    display.textContent = state.eraseValue.toString();
    section.appendChild(display);
    this.eraseValueDisplay = display;

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
      sizeToNearestPresetIndex(this.numericInput.valueAsNumber) !== idx
    ) {
      this.numericInput.valueAsNumber = size;
    }
    for (const btn of this.presetButtons) {
      const preset = Number(btn.dataset.presetValue);
      btn.classList.toggle("active", preset === size);
    }
    if (this.eraseValueDisplay !== undefined) {
      const desired = state.eraseValue.toString();
      if (this.eraseValueDisplay.textContent !== desired) {
        this.eraseValueDisplay.textContent = desired;
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
    this.eraseValueDisplay = undefined;
    this.presetButtons = [];
    while (this.element.firstChild !== null) {
      this.element.removeChild(this.element.firstChild);
    }
  }
}

