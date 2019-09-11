/**
 * @license
 * Copyright 2018 Google Inc.
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

import {TrackableRGB} from 'neuroglancer/util/color';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';
// import {vec3} from 'gl-matrix';

export class ColorWidget extends RefCounted {
  element = document.createElement('input');

  constructor(public model: TrackableRGB) {
    super();
    const {element} = this;
    element.classList.add('neuroglancer-color-widget');
    element.type = 'color';
    element.addEventListener('change', () => this.updateModel());
    this.registerDisposer(model.changed.add(() => this.updateView()));
    this.updateView();
  }
  private updateView() {
    this.element.value = this.model.toString();
  }
  private updateModel() {
    this.model.restoreState(this.element.value);
  }

  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }
}

/**
 * The lazy color widget does not hold a reference to
 * a TrackableRGB until you tell it to. Before that,
 * it is only a wrapper around a color input element.
 */
// export class LazyColorWidget extends RefCounted {
//   element = document.createElement('input');

//   constructor(public modelOrColor: string|TrackableRGB) {
//     super();
//     const {element} = this;
//     element.classList.add('neuroglancer-color-widget');
//     element.type = 'color';
//     if (typeof(modelOrColor) === 'string') {
//       this.element.value = modelOrColor;
//     } else {
//       this.registerDisposer(modelOrColor.changed.add(() => this.updateView()));
//       this.updateView();
//     }
//     element.addEventListener('change', () => this.updateModel());
//   }

//   public hasModel() {
//     return typeof(this.modelOrColor) === 'object';
//   }

//   public removeModel(color: string) {
//     if (this.hasModel()) {

//     }
//   }

//   private addModel(color: string) {
//     if (!this.hasModel()) {
//       this.modelOrColor = new TrackableRGB(vec3.fromValues(0.0, 0.0, 0.0));
//       this.modelOrColor.restoreState(color);
//       this.element.addEventListener('change', () => this.updateModel());
//       this.registerDisposer(this.modelOrColor.changed.add(() => this.updateView()));
//       this.updateView();
//     }
//   }

//   private updateView() {
//     this.element.value = this.modelOrColor.toString();
//   }

//   private updateModel() {
//     if (this.hasModel()) {
//       // Cast is needed for TypeScript
//       (<TrackableRGB>this.modelOrColor).restoreState(this.element.value);
//     } else {
//       this.addModel(this.element.value);
//     }
//   }

//   disposed() {
//     removeFromParent(this.element);
//     super.disposed();
//   }
// }
