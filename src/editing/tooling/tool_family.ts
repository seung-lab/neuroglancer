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
 * Shared tool-family config (TM-315 tooling redesign).
 *
 * A `ToolFamily` owns config SHARED by a set of related tools — e.g. the
 * painting family (brush / erase / fill) shares brush size, active value,
 * mask, and the target layer binding. The +/−, [/], and threshold shortcuts
 * mutate the family config regardless of which leaf is active, so the config
 * must live ABOVE the individual tools and outlive any single activation.
 *
 * Backed by a neuroglancer `WatchableValue<Config>` so the topbar, tool
 * settings panels, and brush cursor subscribe uniformly with `useWatchable`.
 * `patch` is the immutable-update entry point (mirrors the old
 * `PaintingState.patchState`).
 */

import { WatchableValue } from "#src/trackable_value.js";

export class ToolFamily<Config extends object> {
  readonly config: WatchableValue<Config>;

  constructor(
    readonly id: string,
    initial: Config,
  ) {
    this.config = new WatchableValue<Config>(initial);
  }

  /** Current config snapshot (mirrors the old `getState()`). */
  get value(): Config {
    return this.config.value;
  }

  /** Immutable shallow merge + notify (mirrors the old `patchState`). */
  patch(patch: Partial<Config>): void {
    this.config.value = { ...this.config.value, ...patch };
  }
}
