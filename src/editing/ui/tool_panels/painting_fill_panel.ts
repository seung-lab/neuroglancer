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
 * @file Panel widget for the `painting.fill` tool.
 *
 * Per `docs/edit-session-integration/architecture/04-ui-shell.md`, fill
 * surfaces only the shared `PaintingSharedState.activeValue` (target id) —
 * the flood-fill seed is taken from the click target at activation time and
 * has no radius. Mask config is left as a v2 enhancement.
 */

import type {
  PaintingSharedState,
  PaintingTools,
} from "@zetta-ai/edit-session";

import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { RefCounted } from "#src/util/disposable.js";

/**
 * Side-panel widget that surfaces the target value used by the fill tool.
 * Shares state with brush and eraser panels via `painting.patchState`.
 */
export class PaintingFillPanel extends RefCounted {
  readonly element: HTMLElement;

  private targetInput: HTMLInputElement | undefined;
  private unsubscribePainting: (() => void) | undefined;

  constructor(private readonly host: EditSessionHost) {
    super();
    this.element = document.createElement("div");
    this.element.classList.add(
      "neuroglancer-tool-panel",
      "neuroglancer-painting-fill-panel",
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
    msg.textContent = "Fill tool requires an active edit session.";
    this.element.appendChild(msg);
  }

  private makeTargetSection(
    painting: PaintingTools,
    state: PaintingSharedState,
  ): HTMLElement {
    const section = document.createElement("div");
    section.classList.add("neuroglancer-tool-panel-row");

    const label = document.createElement("label");
    label.textContent = "Target value";
    section.appendChild(label);

    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "numeric";
    input.value = state.activeValue.toString();
    this.registerEventListener(input, "change", () => {
      this.applyTargetValue(painting, input);
    });
    section.appendChild(input);
    this.targetInput = input;

    return section;
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
    this.targetInput = undefined;
    while (this.element.firstChild !== null) {
      this.element.removeChild(this.element.firstChild);
    }
  }
}
