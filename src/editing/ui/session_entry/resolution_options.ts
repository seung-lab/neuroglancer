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

export class ResolutionSelectionModel {
  readonly selectionChanged = new NullarySignal();

  private resolutions_: readonly Resolution[] = [];
  private selection_: Resolution | undefined;

  constructor(metadata: LayerMetadata) {
    this.setMetadata(metadata);
  }

  get resolutions(): readonly Resolution[] {
    return this.resolutions_;
  }

  get selection(): Resolution | undefined {
    return this.selection_;
  }

  select(value: Resolution | undefined): void {
    if (value === this.selection_) return;
    if (value !== undefined && !this.resolutions_.includes(value)) return;
    this.selection_ = value;
    this.selectionChanged.dispatch();
  }

  setMetadata(metadata: LayerMetadata): void {
    const next = availableResolutions(metadata);
    this.resolutions_ = next;
    this.selection_ = next.length > 0 ? next[0] : undefined;
  }
}
