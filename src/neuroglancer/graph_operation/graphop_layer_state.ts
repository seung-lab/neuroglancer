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

import {AnnotationId, AnnotationReference, LocalAnnotationSource} from 'neuroglancer/annotation';
import {AnnotationHoverState} from 'neuroglancer/annotation/frontend';
import {CoordinateTransform} from 'neuroglancer/coordinate_transform';
import {RenderLayerRole} from 'neuroglancer/layer';
import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {TrackableAlphaValue, trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';
import {WatchableValue} from 'neuroglancer/trackable_value';
import {TrackableRGB} from 'neuroglancer/util/color';
import {Owned, RefCounted} from 'neuroglancer/util/disposable';
import {mat4} from 'neuroglancer/util/geom';


export class GraphOpHoverState extends AnnotationHoverState {}

export class GraphOpLayerState extends RefCounted {
  transform: CoordinateTransform;
  sourceA: Owned<LocalAnnotationSource>;
  sourceB: Owned<LocalAnnotationSource>;
  activeSource: Owned<LocalAnnotationSource>;

  hoverState: GraphOpHoverState;
  role: RenderLayerRole;
  colorA: TrackableRGB;
  colorB: TrackableRGB;
  fillOpacity: TrackableAlphaValue;

  /**
   * undefined means may have a segmentation state.
   */
  segmentationState: WatchableValue<SegmentationDisplayState|undefined>;
  filterBySegmentation: TrackableBoolean;

  private transformCacheGeneration = -1;
  private cachedObjectToGlobal = mat4.create();
  private cachedGlobalToObject = mat4.create();

  private updateTransforms() {
    const {transform, transformCacheGeneration} = this;
    const generation = transform.changed.count;
    if (generation === transformCacheGeneration) {
      return;
    }
    const {cachedObjectToGlobal} = this;
    mat4.multiply(cachedObjectToGlobal, this.transform.transform, this.sourceA.objectToLocal);
    mat4.invert(this.cachedGlobalToObject, cachedObjectToGlobal);
  }

  get objectToGlobal() {
    this.updateTransforms();
    return this.cachedObjectToGlobal;
  }

  get globalToObject() {
    this.updateTransforms();
    return this.cachedGlobalToObject;
  }

  constructor(options: {
    transform?: CoordinateTransform,
    sourceA: Owned<LocalAnnotationSource>,
    sourceB: Owned<LocalAnnotationSource>,
    hoverState?: GraphOpHoverState,
    colorA: TrackableRGB,
    colorB: TrackableRGB,
    segmentationState: WatchableValue<SegmentationDisplayState>,
    filterBySegmentation?: TrackableBoolean,
  }) {
    super();
    const {
      transform = new CoordinateTransform(),
      sourceA,
      sourceB,
      hoverState = new GraphOpHoverState(undefined),
      colorA,
      colorB,
      segmentationState,
      filterBySegmentation = new TrackableBoolean(true),
    } = options;
    this.transform = transform;
    this.sourceA = this.registerDisposer(sourceA);
    this.sourceB = this.registerDisposer(sourceB);
    this.activeSource = this.sourceA.addRef();
    this.hoverState = hoverState;
    this.role = RenderLayerRole.GRAPH_OPERATION;
    this.colorA = colorA;
    this.colorB = colorB;
    this.fillOpacity = trackableAlphaValue(1.0),
    this.segmentationState = segmentationState;
    this.filterBySegmentation = filterBySegmentation;
  }

  toggleSource() {
    if (this.activeSource === this.sourceA) {
      this.activeSource = this.sourceB.addRef();
    } else {
      this.activeSource = this.sourceA.addRef();
    }
  }

  getReference(id: AnnotationId): AnnotationReference {
    if (this.sourceA.get(id) !== undefined) {
      return this.sourceA.getReference(id);
    } else {
      return this.sourceB.getReference(id);
    }
  }

  delete(reference: AnnotationReference) {
    if (this.sourceA.get(reference.id) !== undefined) {
      this.sourceA.delete(reference);
    } else {
      this.sourceB.delete(reference);
    }
  }
}
