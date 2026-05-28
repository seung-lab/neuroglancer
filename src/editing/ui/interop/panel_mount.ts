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
import { createElement, render } from "preact";

import type { SidePanelManager } from "#src/ui/side_panel.js";
import { SidePanel } from "#src/ui/side_panel.js";
import type { TrackableSidePanelLocation } from "#src/ui/side_panel_location.js";
import type { Disposer } from "#src/util/disposable.js";

export interface PanelMountOptions<T> {
  title: string;
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

  constructor(
    sidePanelManager: SidePanelManager,
    location: TrackableSidePanelLocation | undefined,
    private readonly options: PanelMountOptions<T>,
  ) {
    super(sidePanelManager, location);
    this.addTitleBar({ title: options.title });
    this.bodyElement = document.createElement("div");
    if (options.classNames) {
      this.bodyElement.classList.add(...options.classNames);
    }
    this.addBody(this.bodyElement);
    if (options.subscribe) {
      this.registerDisposer(options.subscribe(() => this.renderBody()));
    }
    this.renderBody();
  }

  override close(): void {
    if (this.options.onClose?.() === false) return;
    super.close();
  }

  override disposed(): void {
    render(null, this.bodyElement);
    super.disposed();
  }

  private renderBody(): void {
    render(
      createElement(this.options.component, this.options.getProps()),
      this.bodyElement,
    );
  }
}
