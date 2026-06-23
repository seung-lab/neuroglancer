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
 * @file Cursor-attached fill progress indicator (TM-269). A flood fill is one
 * click but can take a while on a large region; the engine flushes
 * progressively, and this small spinner — pinned to the pointer — tells the
 * user the fill is still working (and, implicitly, that Escape / right-click
 * will cancel it).
 *
 * Deliberately a plain DOM overlay rather than a GL render layer (like the
 * brush cursor) or a React subtree (like the topbar): it is transient, needs no
 * per-frame projection, and must follow the raw pointer with zero pick-pass
 * lag. It mounts on `document.body` and tracks `pointermove` directly.
 */

import "#src/editing/cursor/fill_cursor_progress.css";

import type { WatchableValueInterface } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";

export type FillProgressState =
  | { readonly kind: "idle" }
  | { readonly kind: "running"; readonly voxelsWritten: number };

export class FillCursorProgress extends RefCounted {
  private readonly el: HTMLDivElement;
  private lastClientX = 0;
  private lastClientY = 0;
  private running = false;

  constructor(
    private readonly progress: WatchableValueInterface<FillProgressState>,
  ) {
    super();
    const el = document.createElement("div");
    el.className = "neuroglancer-editing-fill-cursor-progress";
    el.setAttribute("aria-hidden", "true");
    el.style.display = "none";
    document.body.appendChild(el);
    this.el = el;
    this.registerDisposer(() => el.remove());

    // Track the pointer in capture phase so we still update while the bridge
    // consumes (stopPropagation) paint events.
    const onPointerMove = (ev: PointerEvent) => {
      this.lastClientX = ev.clientX;
      this.lastClientY = ev.clientY;
      if (this.running) this.reposition();
    };
    document.addEventListener("pointermove", onPointerMove, { capture: true });
    this.registerDisposer(() =>
      document.removeEventListener("pointermove", onPointerMove, {
        capture: true,
      }),
    );

    this.registerDisposer(progress.changed.add(() => this.sync()));
    this.sync();
  }

  private sync(): void {
    const running = this.progress.value.kind === "running";
    if (running === this.running) return;
    this.running = running;
    this.el.style.display = running ? "block" : "none";
    if (running) this.reposition();
  }

  private reposition(): void {
    this.el.style.left = `${this.lastClientX}px`;
    this.el.style.top = `${this.lastClientY}px`;
  }
}
