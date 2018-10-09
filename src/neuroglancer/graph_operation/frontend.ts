/**
 * @license
 * Copyright 2018 The Neuroglancer Authors
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

import {LocalAnnotationSource} from 'neuroglancer/annotation';
import {AnnotationLayer, AnnotationLayerState, SliceViewAnnotationLayer} from 'neuroglancer/annotation/frontend';
import {PerspectiveViewAnnotationLayer} from 'neuroglancer/annotation/renderlayer';
import {setAnnotationHoverStateFromMouseState} from 'neuroglancer/annotation/selection';
import {GraphOpLayerState} from 'neuroglancer/graph_operation/graphop_layer_state';
import {RenderLayerRole} from 'neuroglancer/layer';
import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {SegmentationUserLayer} from 'neuroglancer/segmentation_user_layer';
import {trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {WatchableRefCounted, WatchableValue} from 'neuroglancer/trackable_value';
import {GraphOperationLayerView, GraphOperationTab, SelectedGraphOperationState} from 'neuroglancer/ui/graph';
import {TrackableRGB} from 'neuroglancer/util/color';
import {Borrowed, RefCounted} from 'neuroglancer/util/disposable';
import {vec3} from 'neuroglancer/util/geom';

export class GraphOperationLayer extends RefCounted {
  private annotationLayerStateA = this.registerDisposer(new WatchableRefCounted<AnnotationLayerState>());
  private annotationLayerStateB = this.registerDisposer(new WatchableRefCounted<AnnotationLayerState>());

  graphOperationLayerState = this.registerDisposer(new WatchableRefCounted<GraphOpLayerState>());
  selectedGraphOperationElement =
    this.registerDisposer(new SelectedGraphOperationState(
        this.graphOperationLayerState.addRef())
    );

    constructor(
        public layer: Borrowed<SegmentationUserLayer>) {
      super();
      this.selectedGraphOperationElement.changed.add(layer.specificationChanged.dispatch);

      this.layer.tabs.add('graph', {
        label: 'Graph',
        order: 75,
        getter: () => new GraphOperationTab(
          this, this.selectedGraphOperationElement.addRef(),
          this.layer.manager.voxelSize.addRef(),
          point => this.layer.manager.setSpatialCoordinates(point))
      });

      this.annotationLayerStateA.changed.add(() => {
        const state = this.annotationLayerStateA.value;
        if (state !== undefined) {
          const annotationLayer = new AnnotationLayer(this.layer.manager.chunkManager, state.addRef());
          setAnnotationHoverStateFromMouseState(state,
              this.layer.manager.layerSelectedValues.mouseState);
          this.layer.addRenderLayer(new SliceViewAnnotationLayer(annotationLayer));
          this.layer.addRenderLayer(new PerspectiveViewAnnotationLayer(annotationLayer.addRef()));
        }
      });

      this.annotationLayerStateB.changed.add(() => {
        const state = this.annotationLayerStateB.value;
        if (state !== undefined) {
          const annotationLayer = new AnnotationLayer(this.layer.manager.chunkManager, state.addRef());
          setAnnotationHoverStateFromMouseState(state,
              this.layer.manager.layerSelectedValues.mouseState);
          this.layer.addRenderLayer(new SliceViewAnnotationLayer(annotationLayer));
          this.layer.addRenderLayer(new PerspectiveViewAnnotationLayer(annotationLayer.addRef()));
        }
      });

      const segmentationState =
        new WatchableValue<SegmentationDisplayState>(this.layer.displayState);

      this.graphOperationLayerState.value = new GraphOpLayerState({
        transform: this.layer.transform,
        sourceA: this.registerDisposer(new LocalAnnotationSource()),
        sourceB: this.registerDisposer(new LocalAnnotationSource()),
        colorA: new TrackableRGB(vec3.fromValues(1.0, 0.0, 0.0)),
        colorB: new TrackableRGB(vec3.fromValues(0.0, 0.0, 1.0)),
        segmentationState: segmentationState
      });

      this.annotationLayerStateA.value = new AnnotationLayerState({
        transform: this.graphOperationLayerState.value.transform,
        source: this.graphOperationLayerState.value.sourceA.addRef(),
        role: RenderLayerRole.GRAPH_OPERATION,
        fillOpacity: trackableAlphaValue(1.0),
        color: this.graphOperationLayerState.value.colorA,
        segmentationState: segmentationState
      });

      this.annotationLayerStateB.value = new AnnotationLayerState({
        transform: this.graphOperationLayerState.value.transform,
        source: this.graphOperationLayerState.value.sourceB.addRef(),
        role: RenderLayerRole.GRAPH_OPERATION,
        fillOpacity: trackableAlphaValue(1.0),
        color: this.graphOperationLayerState.value.colorB,
        segmentationState: segmentationState
      });
    }

    initializeGraphOperationLayerViewTab(tab: GraphOperationLayerView) {
      tab;
    }
}
