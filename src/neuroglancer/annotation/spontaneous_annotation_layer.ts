/**
 * @license
 * Copyright 2019 The Neuroglancer Authors
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

import {vec3} from 'gl-matrix';
import {LocalAnnotationSource} from 'neuroglancer/annotation';
import {AnnotationLayerState} from 'neuroglancer/annotation/annotation_layer_state';
import {SliceViewAnnotationLayer} from 'neuroglancer/annotation/frontend';
import {AnnotationLayer, PerspectiveViewAnnotationLayer} from 'neuroglancer/annotation/renderlayer';
import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {CoordinateTransform} from 'neuroglancer/coordinate_transform';
import {RenderLayer} from 'neuroglancer/layer';
import {trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {TrackableRGB} from 'neuroglancer/util/color';
import {RefCounted} from 'neuroglancer/util/disposable';


/**
 * AnnotationLayer wrapper class that makes it easy to create AnnotationLayers on demand.
 */
export class SpontaneousAnnotationLayer extends RefCounted {
  source: LocalAnnotationSource;
  annotationLayer: AnnotationLayer;
  annotationLayerState: AnnotationLayerState;
  renderLayers: RenderLayer[];

  constructor(
      chunkManager: ChunkManager,
      public transform: CoordinateTransform,
      public color = new TrackableRGB(vec3.fromValues(1.0, 1.0, 0.0)),
      public fillOpacity = trackableAlphaValue(1.0),
  ) {
    super();
    const source = this.source = this.registerDisposer(new LocalAnnotationSource());
    this.annotationLayerState =
        this.registerDisposer(new AnnotationLayerState({transform, source, color, fillOpacity}));
    this.annotationLayer =
        this.registerDisposer(new AnnotationLayer(chunkManager, this.annotationLayerState));
    const sliceViewRenderLayer = new SliceViewAnnotationLayer(this.annotationLayer);
    const perspectiveViewAnnotationLayer =
        new PerspectiveViewAnnotationLayer(this.annotationLayer.addRef());
    this.renderLayers = [sliceViewRenderLayer, perspectiveViewAnnotationLayer];
  }
}
