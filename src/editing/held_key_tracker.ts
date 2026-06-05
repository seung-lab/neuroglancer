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
 * @file Held-key tracker (TM-292).
 *
 * Tracks which physical keys are currently held down, by `event.code`
 * lowercased (matching `getEventKeyName` in `keyboard_bindings.ts`). Needed
 * for the `L+[` / `H+[` threshold chords: `L` and `H` are not real keyboard
 * modifiers, so neuroglancer's `EventActionMap` can't express them — the
 * bracket action handlers instead consult this tracker.
 *
 * Listeners are attached in the capture phase so a held state is recorded even
 * if some other handler stops propagation of the key event. `window` blur
 * clears all state so a key whose `keyup` was missed (e.g. the user
 * alt-tabbed) doesn't stay stuck.
 */

import { RefCounted } from "#src/util/disposable.js";

export class HeldKeyTracker extends RefCounted {
  private readonly held = new Set<string>();

  constructor(target: EventTarget) {
    super();

    const onKeyDown = (event: Event) => {
      this.held.add((event as KeyboardEvent).code.toLowerCase());
    };
    const onKeyUp = (event: Event) => {
      this.held.delete((event as KeyboardEvent).code.toLowerCase());
    };
    const onBlur = () => this.held.clear();

    target.addEventListener("keydown", onKeyDown, true);
    target.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    this.registerDisposer(() => {
      target.removeEventListener("keydown", onKeyDown, true);
      target.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    });
  }

  /** True while the key with the given lowercased `event.code` is held. */
  isHeld(code: string): boolean {
    return this.held.has(code);
  }
}
