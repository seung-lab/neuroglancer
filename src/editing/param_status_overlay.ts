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
 * @file Transient center-screen readout for the Ctrl+Arrow parameter scheme
 * (TM-337).
 *
 * Reuses neuroglancer's existing {@link StatusMessage} in modal mode (which is
 * centered on screen) to surface "what you are changing and its value" while the
 * user nudges a parameter from the canvas. A single message instance is reused
 * across rapid updates (e.g. the hold-to-accelerate ramp) and auto-dismissed a
 * short time after the last update.
 */

import { StatusMessage } from "#src/status.js";
import { RefCounted } from "#src/util/disposable.js";

const DEFAULT_DISMISS_MS = 1200;

export class ParamStatusOverlay extends RefCounted {
  private message: StatusMessage | undefined;
  private timer: number | undefined;

  constructor(private readonly dismissAfterMs: number = DEFAULT_DISMISS_MS) {
    super();
    this.registerDisposer(() => this.clear());
  }

  /**
   * Show `text` centered on screen, replacing any current readout, and (re)arm
   * the auto-dismiss timer. Called on every selection move and value step.
   */
  show(text: string): void {
    if (this.message === undefined) {
      // `delay = false` shows immediately; `modal = true` centers it.
      this.message = new StatusMessage(false, true);
    }
    this.message.setText(text, true);
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.clear(), this.dismissAfterMs);
  }

  private clear(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.message !== undefined) {
      this.message.dispose();
      this.message = undefined;
    }
  }
}
