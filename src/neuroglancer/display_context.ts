/**
 * @license
 * Copyright 2016 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {FrameNumberCounter} from 'neuroglancer/chunk_manager/frontend';
import {RefCounted} from 'neuroglancer/util/disposable';
import {vec3} from 'neuroglancer/util/geom';
import {NullarySignal} from 'neuroglancer/util/signal';
import {WatchableVisibilityPriority} from 'neuroglancer/visibility_priority/frontend';
import {GL, initializeWebGL} from 'neuroglancer/webgl/context';
import ResizeObserver from 'resize-observer-polyfill';

export abstract class RenderedPanel extends RefCounted {
  gl: GL;
  panelInfo: PanelInfo;
  constructor(
      public context: DisplayContext, public element: HTMLElement,
      public visibility: WatchableVisibilityPriority) {
    super();
    this.gl = context.gl;
    this.panelInfo = new PanelInfo();
    context.addPanel(this);
  }

  scheduleRedraw() {
    if (this.visible) {
      this.context.scheduleRedraw();
    }
  }

  abstract isReady(): boolean;

  setGLViewport() {
    let panelInfo = this.panelInfo;
    const clientRect = panelInfo.clientRect;
    let clientRectLeft = 0;
    let clientRectTop = 0;
    if (clientRect) {
      clientRectLeft = clientRect.left;
      clientRectTop = clientRect.top;
    }
    const canvasRect = this.context.canvasRect!;
    const scaleX = canvasRect.width / this.context.canvas.width;
    const scaleY = canvasRect.height / this.context.canvas.height;
    let left = (panelInfo.clientLeft + clientRectLeft - canvasRect.left) * scaleX;
    let width = panelInfo.clientWidth;
    let top = (clientRectTop - canvasRect.top + panelInfo.clientTop) * scaleY;
    let height = panelInfo.clientHeight;
    let bottom = top + height;
    let gl = this.gl;
    gl.enable(gl.SCISSOR_TEST);
    let glBottom = this.context.canvas.height - bottom;
    gl.viewport(left, glBottom, width, height);
    gl.scissor(left, glBottom, width, height);
  }

  abstract draw(): void;

  abstract translateDataPointByViewportPixels(
      out: vec3, orig: vec3, deltaX: number, deltaY: number): vec3;

  disposed() {
    this.context.removePanel(this);
    super.disposed();
  }

  get visible() {
    return this.visibility.visible;
  }
}

class PanelInfo {
  clientLeft: number;
  clientTop: number;
  clientWidth: number;
  clientHeight: number;
  offsetWidth: number;
  offsetHeight: number;
  clientRect: ClientRect|undefined;
}

export class DisplayContext extends RefCounted implements FrameNumberCounter {
  canvas = document.createElement('canvas');
  gl: GL;
  updateStarted = new NullarySignal();
  updateFinished = new NullarySignal();
  changed = this.updateFinished;
  panels = new Set<RenderedPanel>();
  private updatePending: number|null = null;
  canvasRect: ClientRect|undefined;

  /**
   * Unique number of the next frame.  Incremented once each time a frame is drawn.
   */
  frameNumber = 0;

  private resizeObserver = new ResizeObserver(() => this.scheduleRedraw());

  constructor(public container: HTMLElement) {
    super();
    const {canvas, resizeObserver} = this;
    container.style.position = 'relative';
    canvas.style.position = 'absolute';
    canvas.style.top = '0px';
    canvas.style.left = '0px';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.zIndex = '0';
    resizeObserver.observe(canvas);
    container.appendChild(canvas);
    this.gl = initializeWebGL(canvas);
  }

  isReady() {
    for (const panel of this.panels) {
      if (!panel.visible) {
        continue;
      }
      if (!panel.isReady()) {
        return false;
      }
    }
    return true;
  }

  /**
   * Returns a child element that overlays the canvas.
   */
  makeCanvasOverlayElement() {
    const element = document.createElement('div');
    element.style.position = 'absolute';
    element.style.top = '0px';
    element.style.left = '0px';
    element.style.width = '100%';
    element.style.height = '100%';
    element.style.zIndex = '2';
    this.container.appendChild(element);
    return element;
  }

  disposed() {
    this.resizeObserver.disconnect();
    if (this.updatePending != null) {
      cancelAnimationFrame(this.updatePending);
      this.updatePending = null;
    }
  }

  addPanel(panel: RenderedPanel) {
    this.panels.add(panel);
    this.resizeObserver.observe(panel.element);
    this.scheduleRedraw();
  }

  removePanel(panel: RenderedPanel) {
    this.resizeObserver.unobserve(panel.element);
    this.panels.delete(panel);
    panel.dispose();
    this.scheduleRedraw();
  }

  scheduleRedraw() {
    if (this.updatePending === null) {
      let canvas = this.canvas;
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      this.canvasRect = canvas.getBoundingClientRect();

      for (const panel of this.panels) {
        const panelInfo = panel.panelInfo;
        panelInfo.clientLeft = panel.element.clientLeft;
        panelInfo.clientTop = panel.element.clientTop;
        panelInfo.clientWidth = panel.element.clientWidth;
        panelInfo.clientHeight = panel.element.clientHeight;
        panelInfo.offsetWidth = panel.element.offsetWidth;
        panelInfo.offsetHeight = panel.element.offsetHeight;
        panelInfo.clientRect = panel.element.getBoundingClientRect();
      }

      this.updatePending = requestAnimationFrame(this.update.bind(this));
    }
  }

  draw() {
    ++this.frameNumber;
    this.updateStarted.dispatch();
    let gl = this.gl;
    this.gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    for (let panel of this.panels) {
      let panelInfo = panel.panelInfo;
      if (!panel.visible || panelInfo.clientWidth === 0 || panelInfo.clientHeight === 0 ||
          panelInfo.offsetWidth === 0 || panelInfo.offsetHeight === 0) {
        // Skip drawing if the panel has zero client area.
        continue;
      }
      panel.setGLViewport();
      panel.draw();
    }

    // Ensure the alpha buffer is set to 1.
    gl.disable(gl.SCISSOR_TEST);
    this.gl.clearColor(1.0, 1.0, 1.0, 1.0);
    this.gl.colorMask(false, false, false, true);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.gl.colorMask(true, true, true, true);
    this.updateFinished.dispatch();
  }

  private update() {
    this.updatePending = null;
    this.draw();
  }
}
