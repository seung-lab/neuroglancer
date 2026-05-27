/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { LayerMetadata, Resolution } from "@zetta-ai/edit-session";
import { availableResolutions } from "@zetta-ai/edit-session";

import { RefCounted } from "#src/util/disposable.js";
import { NullarySignal } from "#src/util/signal.js";

/**
 * Dropdown picker over the resolutions a single `LayerMetadata` exposes,
 * sorted finest-to-coarsest (the order returned by `availableResolutions`).
 * Programmatic writes through the `selection` setter do NOT dispatch
 * `selectionChanged` — only user-driven change events do.
 */
export class ResolutionPicker extends RefCounted {
  readonly element: HTMLElement;
  readonly selectionChanged = new NullarySignal();

  private readonly select: HTMLSelectElement;
  private metadata: LayerMetadata;
  private resolutions: readonly Resolution[] = [];
  private selection_: Resolution | undefined;

  constructor(metadata: LayerMetadata) {
    super();
    this.element = document.createElement("div");
    this.element.classList.add("neuroglancer-resolution-picker");
    this.select = document.createElement("select");
    this.select.classList.add("neuroglancer-resolution-picker-select");
    this.select.addEventListener("change", this.onSelectChange);
    this.element.appendChild(this.select);

    this.metadata = metadata;
    this.rebuild();

    this.registerDisposer(() => {
      this.select.removeEventListener("change", this.onSelectChange);
    });
  }

  get selection(): Resolution | undefined {
    return this.selection_;
  }

  set selection(value: Resolution | undefined) {
    if (value === this.selection_) return;
    if (value !== undefined && !this.resolutions.includes(value)) return;
    this.selection_ = value;
    this.select.value = value ?? "";
  }

  setMetadata(metadata: LayerMetadata): void {
    this.metadata = metadata;
    this.rebuild();
  }

  private readonly onSelectChange = () => {
    const raw = this.select.value;
    const next = this.resolutions.find((r) => r === raw);
    if (next === this.selection_) return;
    this.selection_ = next;
    this.selectionChanged.dispatch();
  };

  private rebuild() {
    const next = availableResolutions(this.metadata);
    this.resolutions = next;
    while (this.select.firstChild !== null) {
      this.select.removeChild(this.select.firstChild);
    }
    if (next.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "(no resolutions available)";
      opt.disabled = true;
      this.select.appendChild(opt);
      this.selection_ = undefined;
      this.select.value = "";
      return;
    }
    for (const resolution of next) {
      const opt = document.createElement("option");
      opt.value = resolution;
      opt.textContent = resolution;
      this.select.appendChild(opt);
    }
    // Default selection: finest = first.
    this.selection_ = next[0];
    this.select.value = next[0];
  }
}
