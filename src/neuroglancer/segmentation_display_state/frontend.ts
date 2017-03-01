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
import {LayerSelectedValues, UserLayer} from 'neuroglancer/layer';
import {SegmentColorHash} from 'neuroglancer/segment_color';
import {forEachVisibleSegment, getObjectKey, VisibleSegmentsState} from 'neuroglancer/segmentation_display_state/base';
import {shareVisibility} from 'neuroglancer/shared_visibility_count/frontend';
import {TrackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {RefCounted} from 'neuroglancer/util/disposable';
import {vec4} from 'neuroglancer/util/geom';
import {Uint64} from 'neuroglancer/util/uint64';
import {UseCount} from 'neuroglancer/util/use_count';
import {SharedObject} from 'neuroglancer/worker_rpc';
import {Signal} from 'signals';

export class Uint64MapEntry {
  constructor(public key: Uint64, public value: Uint64) {}
  toString() { return `${this.key}→${this.value}`; }
};

export class SegmentSelectionState extends RefCounted {
  selectedSegment = new Uint64();
  rawSelectedSegment = new Uint64();
  hasSelectedSegment = false;
  changed = new Signal();

  set(value: Uint64|null|undefined) {
    if (value == null) {
      if (this.hasSelectedSegment) {
        this.hasSelectedSegment = false;
        this.changed.dispatch();
      }
    } 
    else {
      let existingValue = this.selectedSegment;
      let existingRawValue = this.rawSelectedSegment;
      if (!this.hasSelectedSegment || value.low !== existingValue.low || value.high !== existingValue.high) {

        existingValue.low = value.low;
        existingValue.high = value.high;
        this.hasSelectedSegment = true;
        this.changed.dispatch();
      }
    }
  }

  setRaw(value: Uint64|null|undefined) {
    if (value == null) {
      return;
    }
    
    let existingValue = this.selectedSegment;
    let existingRawValue = this.rawSelectedSegment;
    if (!this.hasSelectedSegment || value.low !== existingRawValue.low || value.high !== existingRawValue.high) {

      existingRawValue.low = value.low;
      existingRawValue.high = value.high;
    }
  }


  isSelected(value: Uint64) {
    return this.hasSelectedSegment && Uint64.equal(value, this.selectedSegment);
  }

  bindTo(layerSelectedValues: LayerSelectedValues, userLayer: UserLayer) {
    let temp = new Uint64();

    function toUint64 (value: Uint64|number|Uint64MapEntry) : Uint64 {
        if (typeof value === 'number') {
          temp.low = value;
          temp.high = 0;
          value = temp;
        } else if (value instanceof Uint64MapEntry) {
          value = value.value;
        }

        return value;
    }

    this.registerSignalBinding(layerSelectedValues.changed.add(() => {
      let value = layerSelectedValues.get(userLayer);
      this.set(toUint64(value));
    }));

    this.registerSignalBinding(layerSelectedValues.changed.add(() => {
      let value = layerSelectedValues.getRaw(userLayer);
      this.setRaw(toUint64(value));
    }));
  }
};

export interface SegmentationDisplayState extends VisibleSegmentsState {
  segmentSelectionState: SegmentSelectionState;
  segmentColorHash: SegmentColorHash;
}

export interface SegmentationDisplayStateWithAlpha extends SegmentationDisplayState {
  objectAlpha: TrackableAlphaValue;
}

export interface SegmentationDisplayState3D extends SegmentationDisplayStateWithAlpha {
  objectToDataTransform: CoordinateTransform;
}

export function registerRedrawWhenSegmentationDisplayStateChanged(
    displayState: SegmentationDisplayState, renderLayer: {redrawNeeded: Signal}&RefCounted) {
  let dispatchRedrawNeeded = () => { renderLayer.redrawNeeded.dispatch(); };
  renderLayer.registerSignalBinding(
      displayState.segmentColorHash.changed.add(dispatchRedrawNeeded));
  renderLayer.registerSignalBinding(displayState.visibleSegments.changed.add(dispatchRedrawNeeded));
  renderLayer.registerSignalBinding(
      displayState.segmentEquivalences.changed.add(dispatchRedrawNeeded));
  renderLayer.registerSignalBinding(
      displayState.segmentSelectionState.changed.add(dispatchRedrawNeeded));
}

export function registerRedrawWhenSegmentationDisplayStateWithAlphaChanged(
    displayState: SegmentationDisplayStateWithAlpha,
    renderLayer: {redrawNeeded: Signal}&RefCounted) {
  registerRedrawWhenSegmentationDisplayStateChanged(displayState, renderLayer);
  let dispatchRedrawNeeded = () => { renderLayer.redrawNeeded.dispatch(); };
  renderLayer.registerSignalBinding(displayState.objectAlpha.changed.add(dispatchRedrawNeeded));
}

export function registerRedrawWhenSegmentationDisplayState3DChanged(
    displayState: SegmentationDisplayState3D, renderLayer: {redrawNeeded: Signal}&RefCounted) {
  registerRedrawWhenSegmentationDisplayStateWithAlphaChanged(displayState, renderLayer);
  let dispatchRedrawNeeded = () => { renderLayer.redrawNeeded.dispatch(); };
  renderLayer.registerSignalBinding(
      displayState.objectToDataTransform.changed.add(dispatchRedrawNeeded));
}

/**
 * Temporary value used by getObjectColor.
 */
const tempColor = vec4.create();

/**
 * Returns the alpha-premultiplied color to use.
 */
export function getObjectColor(
    displayState: SegmentationDisplayState, objectId: Uint64, alpha: number = 1) {
  const color = tempColor;
  color[3] = alpha;
  displayState.segmentColorHash.compute(color, objectId);
  if (displayState.segmentSelectionState.isSelected(objectId)) {
    for (let i = 0; i < 3; ++i) {
      color[i] = color[i] * 0.5 + 0.5;
    }
  }
  color[0] *= alpha;
  color[1] *= alpha;
  color[2] *= alpha;
  return color;
}

export function forEachSegmentToDraw<SegmentData>(
    displayState: SegmentationDisplayState, 
    objects: Map<string, SegmentData>,
    callback: (rootObjectId: Uint64, objectId: Uint64, segmentData: SegmentData) => void) {

  forEachVisibleSegment(displayState, (objectId, rootObjectId) => {
    const key = getObjectKey(objectId);
    const segmentData = objects.get(key);
    if (segmentData !== undefined) {
      callback(rootObjectId, objectId, segmentData);
    }
  });
}

export class SegmentationLayerSharedObject extends SharedObject {
  visibilityCount = new UseCount();

  constructor(public chunkManager: ChunkManager, public displayState: SegmentationDisplayState) {
    super();
  }

  initializeCounterpartWithChunkManager(options: any) {
    let {displayState} = this;
    options['chunkManager'] = this.chunkManager.rpcId;
    options['visibleSegments'] = displayState.visibleSegments.rpcId;
    options['segmentEquivalences'] = displayState.segmentEquivalences.rpcId;
    super.initializeCounterpart(this.chunkManager.rpc!, options);
    shareVisibility(this);
  }
}
