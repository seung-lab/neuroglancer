/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { ComponentType, RenderableProps } from "preact";

import { mountComponent } from "#src/editing/ui/interop/component_mount.js";
import type { SidePanelManager } from "#src/ui/side_panel.js";
import { SidePanel } from "#src/ui/side_panel.js";
import type { TrackableSidePanelLocation } from "#src/ui/side_panel_location.js";
import type { Disposer } from "#src/util/disposable.js";

export interface PanelMountOptions<T> {
  title: string;
  /**
   * Optional dynamic title source. When provided, the title bar is
   * re-evaluated each time the body re-renders (via `subscribe`). The static
   * `title` is still used for the initial paint so the title element exists
   * before any subscription fires.
   */
  getTitle?: () => string;
  classNames?: string[];
  component: ComponentType<T>;
  getProps: () => RenderableProps<T>;
  // Register listeners that should trigger a re-render of the body.
  // The returned disposer is invoked when the panel is disposed.
  subscribe?: (rerender: () => void) => Disposer;
  // Intercept the close action. Return false to keep the panel open.
  onClose?: () => boolean | void;
}

export class PanelMount<T> extends SidePanel {
  private readonly bodyElement: HTMLDivElement;
  private readonly titleElement: HTMLElement | undefined;

  constructor(
    sidePanelManager: SidePanelManager,
    location: TrackableSidePanelLocation | undefined,
    private readonly options: PanelMountOptions<T>,
  ) {
    super(sidePanelManager, location);
    const { titleElement } = this.addTitleBar({ title: options.title });
    this.titleElement = titleElement;
    this.bodyElement = document.createElement("div");
    if (options.classNames) {
      this.bodyElement.classList.add(...options.classNames);
    }
    this.addBody(this.bodyElement);
    this.registerDisposer(
      mountComponent(this.bodyElement, options.component, options.getProps()),
    );
    if (options.subscribe) {
      this.registerDisposer(options.subscribe(() => this.renderBody()));
    }
  }

  override close(): void {
    if (this.options.onClose?.() === false) return;
    super.close();
  }

  private renderBody(): void {
    mountComponent(
      this.bodyElement,
      this.options.component,
      this.options.getProps(),
    );
    if (
      this.options.getTitle !== undefined &&
      this.titleElement !== undefined
    ) {
      this.titleElement.textContent = this.options.getTitle();
    }
  }
}
