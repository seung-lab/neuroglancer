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

import {AnnotationId, AnnotationReference, LocalAnnotationSource} from 'neuroglancer/annotation';
import {CoordinateTransform} from 'neuroglancer/coordinate_transform';
import {RenderLayerRole} from 'neuroglancer/layer';
import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {WatchableValue} from 'neuroglancer/trackable_value';
import {Owned, RefCounted} from 'neuroglancer/util/disposable';
import {mat4} from 'neuroglancer/util/geom';
import {verifyArray} from 'neuroglancer/util/json';
import {NullarySignal} from 'neuroglancer/util/signal';

const ANNOTATIONS_JSON_KEY = 'annotations';

export class GraphOperationHoverState extends WatchableValue<{id: string}|undefined> {}

export class GraphOperationLayerState extends RefCounted {
  changed = new NullarySignal();
  transform: CoordinateTransform;
  sourceA: Owned<LocalAnnotationSource>;
  sourceB: Owned<LocalAnnotationSource>;
  activeSource: Owned<LocalAnnotationSource>;

  hoverState: GraphOperationHoverState;
  role: RenderLayerRole;

  /**
   * undefined means may have a segmentation state.
   */
  segmentationState: WatchableValue<SegmentationDisplayState|undefined>;

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
    hoverState?: GraphOperationHoverState,
              segmentationState: WatchableValue<SegmentationDisplayState>,
  }) {
    super();
    const {
      transform = new CoordinateTransform(),
      sourceA,
      sourceB,
      hoverState = new GraphOperationHoverState(undefined),
      segmentationState,
    } = options;
    this.transform = transform;
    this.sourceA = this.registerDisposer(sourceA);
    this.sourceB = this.registerDisposer(sourceB);
    this.activeSource = this.sourceA.addRef();
    this.hoverState = hoverState;
    this.role = RenderLayerRole.GRAPH_MODIFICATION_MARKER;
    this.segmentationState = segmentationState;

    this.sourceA.changed.add(() => this.changed.dispatch());
    this.sourceB.changed.add(() => this.changed.dispatch());
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

  restoreState(spec: any) {
    const groups = verifyArray(spec);
    if (groups.length > 0) {
      this.sourceA.restoreState(spec[0][ANNOTATIONS_JSON_KEY], []);
    }
    if (groups.length > 1) {
      this.sourceB.restoreState(spec[1][ANNOTATIONS_JSON_KEY], []);
    }
  }

  toJSON() {
    return [
      this.sourceA.toJSON(),
      this.sourceB.toJSON(),
    ];
  }
}
