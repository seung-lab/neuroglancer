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

import { NullarySignal } from "#src/util/signal.js";

/**
 * Per-layer model backing the multi-resolution picker in the
 * session-entry modal. Holds the set of resolutions the user has checked
 * for inclusion in the session. The first available resolution is
 * pre-selected so that included layers are always immediately submittable.
 */
export class ResolutionSelectionModel {
  readonly selectionChanged = new NullarySignal();

  private resolutions_: readonly Resolution[] = [];
  private selection_ = new Set<Resolution>();

  constructor(metadata: LayerMetadata) {
    this.setMetadata(metadata);
  }

  get resolutions(): readonly Resolution[] {
    return this.resolutions_;
  }

  /**
   * Snapshot of the currently-checked resolutions, in `resolutions` order.
   * Empty when nothing is selected (the modal blocks submit in that case).
   */
  get selectedResolutions(): readonly Resolution[] {
    return this.resolutions_.filter((r) => this.selection_.has(r));
  }

  isSelected(value: Resolution): boolean {
    return this.selection_.has(value);
  }

  toggle(value: Resolution, checked: boolean): void {
    if (!this.resolutions_.includes(value)) return;
    if (checked === this.selection_.has(value)) return;
    if (checked) {
      this.selection_.add(value);
    } else {
      this.selection_.delete(value);
    }
    this.selectionChanged.dispatch();
  }

  setMetadata(metadata: LayerMetadata): void {
    this.resolutions_ = availableResolutions(metadata);
    this.selection_ = new Set();
    if (this.resolutions_.length > 0) {
      this.selection_.add(this.resolutions_[0]);
    }
  }
}
