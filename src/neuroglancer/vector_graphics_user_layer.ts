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

import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {CoordinateTransform} from 'neuroglancer/coordinate_transform';
import {GetVectorGraphicsOptions, getVectorGraphicsSource} from 'neuroglancer/datasource/factory';
import {UserLayer, UserLayerDropdown} from 'neuroglancer/layer';
import {LayerListSpecification, registerLayerType, registerVolumeLayerType} from 'neuroglancer/layer_specification';
import {getVolumeWithStatusMessage} from 'neuroglancer/layer_specification';
import {Overlay} from 'neuroglancer/overlay';
import {MultiscaleVectorGraphicsChunkSource, RenderLayer} from 'neuroglancer/sliceview/vector_graphics/frontend';
import {FRAGMENT_MAIN_START, getTrackableFragmentMain, VectorGraphicsLineRenderLayer} from 'neuroglancer/sliceview/vector_graphics/vector_graphics_line_renderlayer';
import {StatusMessage} from 'neuroglancer/status';
import {trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {trackableFiniteFloat} from 'neuroglancer/trackable_finite_float';
import {mat4} from 'neuroglancer/util/geom';
import {verifyFiniteFloat, verifyOptionalString} from 'neuroglancer/util/json';
import {makeWatchableShaderError} from 'neuroglancer/webgl/dynamic_shader';
import {RangeWidget} from 'neuroglancer/widget/range';
import {ShaderCodeWidget} from 'neuroglancer/widget/shader_code_widget';

require('./image_user_layer.css');
require('neuroglancer/help_button.css');
require('neuroglancer/maximize_button.css');

function getVectorGraphicsWithStatusMessage(
    chunkManager: ChunkManager, x: string,
    options: GetVectorGraphicsOptions = {}): Promise<MultiscaleVectorGraphicsChunkSource> {
  return StatusMessage.forPromise(
      new Promise(function(resolve) {
        resolve(getVectorGraphicsSource(chunkManager, x, options));
      }),
      {
        initialMessage: `Retrieving metadata for vector graphics source ${x}.`,
        delay: true,
        errorPrefix: `Error retrieving metadata for vector graphics source ${x}: `,
      });
}

export class VectorGraphicsUserLayer extends UserLayer {
  vectorGraphicsPath: string|undefined;
  opacity = trackableAlphaValue(0.5);
  primitiveSize = trackableFiniteFloat(10.0);
  fragmentMain = getTrackableFragmentMain();
  shaderError = makeWatchableShaderError();
  renderLayer: RenderLayer;
  constructor(manager: LayerListSpecification, x: any) {
    super();

    this.opacity.restoreState(x['opacity']);
    this.fragmentMain.restoreState(x['shader']);
    this.registerDisposer(this.fragmentMain.changed.add(() => {
      this.specificationChanged.dispatch();
    }));

    let vectorGraphicsPath = this.vectorGraphicsPath = verifyOptionalString(x['source']);
    if (vectorGraphicsPath !== undefined) {
      getVectorGraphicsWithStatusMessage(manager.chunkManager, vectorGraphicsPath)
          .then(vectorGraphics => {
            if (!this.wasDisposed) {
              let renderLayer = this.renderLayer =
                  new VectorGraphicsLineRenderLayer(vectorGraphics, {
                    opacity: this.opacity,
                    primitiveSize: this.primitiveSize,
                    fragmentMain: this.fragmentMain,
                    shaderError: this.shaderError,
                    sourceOptions: {}
                  });
              this.addRenderLayer(renderLayer);
            }
          });
    }
  }
  toJSON() {
    let x: any = {'type': 'vectorgraphics'};
    x['source'] = this.vectorGraphicsPath;
    x['opacity'] = this.opacity.toJSON();
    x['shader'] = this.fragmentMain.toJSON();
    return x;
  }
  makeDropdown(element: HTMLDivElement) {
    return new VectorGraphicsDropDown(element, this);
  }
}

function makeShaderCodeWidget(layer: VectorGraphicsUserLayer) {
  return new ShaderCodeWidget({
    shaderError: layer.shaderError,
    fragmentMain: layer.fragmentMain,
    fragmentMainStartLine: FRAGMENT_MAIN_START,
  });
}

class VectorGraphicsDropDown extends UserLayerDropdown {
  opacityWidget = this.registerDisposer(new RangeWidget(this.layer.opacity));
  primitiveSizeWidget =
      this.registerDisposer(new RangeWidget(this.layer.primitiveSize, {min: 0, max: 50, step: 1}));
  codeWidget = this.registerDisposer(makeShaderCodeWidget(this.layer));

  constructor(public element: HTMLDivElement, public layer: VectorGraphicsUserLayer) {
    super();
    element.classList.add('image-dropdown');
    let {opacityWidget, primitiveSizeWidget} = this;
    let topRow = document.createElement('div');
    topRow.className = 'image-dropdown-top-row';
    opacityWidget.promptElement.textContent = 'Opacity';
    primitiveSizeWidget.promptElement.textContent = 'Primitive Size';
    let spacer = document.createElement('div');
    let lineBreak = document.createElement('br');
    spacer.style.flex = '1';
    let helpLink = document.createElement('a');
    let helpButton = document.createElement('button');
    helpButton.type = 'button';
    helpButton.textContent = '?';
    helpButton.className = 'help-link';
    helpLink.appendChild(helpButton);
    helpLink.title = 'Documentation on vector graphics layer rendering';
    helpLink.target = '_blank';
    helpLink.href =
        'https://github.com/google/neuroglancer/blob/master/src/neuroglancer/sliceview/vectorgraphics_layer_rendering.md';

    let maximizeButton = document.createElement('button');
    maximizeButton.innerHTML = '&square;';
    maximizeButton.className = 'maximize-button';
    maximizeButton.title = 'Show larger editor view';
    this.registerEventListener(maximizeButton, 'click', () => {
      new ShaderCodeOverlay(this.layer);
    });

    topRow.appendChild(this.opacityWidget.element);
    topRow.appendChild(spacer);
    topRow.appendChild(maximizeButton);
    topRow.appendChild(helpLink);

    element.appendChild(topRow);
    element.appendChild(this.primitiveSizeWidget.element);
    element.appendChild(this.codeWidget.element);
    this.codeWidget.textEditor.refresh();
  }

  onShow() {
    this.codeWidget.textEditor.refresh();
  }
}

class ShaderCodeOverlay extends Overlay {
  codeWidget = this.registerDisposer(makeShaderCodeWidget(this.layer));
  constructor(public layer: VectorGraphicsUserLayer) {
    super();
    this.content.classList.add('image-layer-shader-overlay');
    this.content.appendChild(this.codeWidget.element);
    this.codeWidget.textEditor.refresh();
  }
}

registerLayerType('vectorgraphics', VectorGraphicsUserLayer);
// backwards compatibility
registerLayerType('point', VectorGraphicsUserLayer);
