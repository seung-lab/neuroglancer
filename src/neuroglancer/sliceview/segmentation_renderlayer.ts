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

import {HashMapUint64} from 'neuroglancer/gpu_hash/hash_table';
import {GPUHashTable, HashMapShaderManager, HashSetShaderManager} from 'neuroglancer/gpu_hash/shader';
import {SegmentColorShaderManager} from 'neuroglancer/segment_color';
import {registerRedrawWhenSegmentationDisplayStateChanged, SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {VolumeSourceOptions} from 'neuroglancer/sliceview/base';
import {MultiscaleVolumeChunkSource, SliceView} from 'neuroglancer/sliceview/frontend';
import {RenderLayer} from 'neuroglancer/sliceview/renderlayer';
import {TrackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {DisjointUint64Sets} from 'neuroglancer/util/disjoint_sets';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {glsl_unnormalizeUint8} from 'neuroglancer/webgl/shader_lib';
import {StatusMessage} from 'neuroglancer/status';
import {SharedDisjointUint64Sets} from 'neuroglancer/shared_disjoint_sets';
import {Uint64} from 'neuroglancer/util/uint64';

const selectedSegmentForShader = new Float32Array(8);

export class EquivalencesHashMap {
  generation = Number.NaN;
  hashMap = new HashMapUint64();
  constructor(public disjointSets: DisjointUint64Sets) {}

  update() {
    let {disjointSets} = this;
    const {generation} = disjointSets;
    if (this.generation !== generation) {
      this.generation = generation;
      let {hashMap} = this;
      hashMap.clear();

      for (let [objectId, minObjectId] of disjointSets.mappings()) {
        hashMap.set(objectId, minObjectId);
      }
    }
  }
};

export interface SliceViewSegmentationDisplayState extends SegmentationDisplayState {
  selectedAlpha: TrackableAlphaValue;
  notSelectedAlpha: TrackableAlphaValue;
  volumeSourceOptions: VolumeSourceOptions;
}

export class SegmentationRenderLayer extends RenderLayer {
  private segmentColorShaderManager = new SegmentColorShaderManager('segmentColorHash');
  private hashTableManager = new HashSetShaderManager('visibleSegments');
  private gpuHashTable = GPUHashTable.get(this.gl, this.displayState.visibleSegments.hashTable);

  private equivalencesShaderManager = new HashMapShaderManager('equivalences');
  private equivalencesHashMap =
      new EquivalencesHashMap(this.displayState.segmentEquivalences.disjointSets);
  private gpuEquivalencesHashTable = GPUHashTable.get(this.gl, this.equivalencesHashMap.hashMap);
  private hasEquivalences: boolean;

  private semanticShaderManager = new HashMapShaderManager('semantic');
  private gpusemanticHashTable = GPUHashTable.get(this.gl, this.displayState.semanticHashMap);

  constructor(
      multiscaleSource: MultiscaleVolumeChunkSource,
      public displayState: SliceViewSegmentationDisplayState) {
    super(multiscaleSource, {volumeSourceOptions: displayState.volumeSourceOptions});
    registerRedrawWhenSegmentationDisplayStateChanged(displayState, this);
    this.registerSignalBinding(
        displayState.selectedAlpha.changed.add(() => { this.redrawNeeded.dispatch(); }));
    this.hasEquivalences = this.displayState.segmentEquivalences.size !== 0;
    displayState.segmentEquivalences.changed.add(() => {
      let {segmentEquivalences} = this.displayState;
      let hasEquivalences = segmentEquivalences.size !== 0;
      if (hasEquivalences !== this.hasEquivalences) {
        this.hasEquivalences = hasEquivalences;
        this.shaderUpdated = true;
        // No need to trigger redraw, since that will happen anyway.
      }
    });
    this.registerSignalBinding(
        displayState.notSelectedAlpha.changed.add(() => { this.redrawNeeded.dispatch(); }));
  }

  getShaderKey() {
    // The shader to use depends on whether there are any equivalences.
    return `sliceview.SegmentationRenderLayer/${this.hasEquivalences}`;
  }

  defineShader(builder: ShaderBuilder) {
    super.defineShader(builder);
    this.segmentColorShaderManager.defineShader(builder);
    this.semanticShaderManager.defineShader(builder);
    this.hashTableManager.defineShader(builder);
    builder.addFragmentCode(`
uint64_t getUint64DataValue() {
  return toUint64(getDataValue());
}
`);
    if (this.hasEquivalences) {
      this.equivalencesShaderManager.defineShader(builder);
      builder.addFragmentCode(`
uint64_t getMappedObjectId() {
  uint64_t value = getUint64DataValue();
  uint64_t mappedValue;
  if (${this.equivalencesShaderManager.getFunctionName}(value, mappedValue)) {
    return mappedValue;
  }
  return value;
}
`);
    } else {
      builder.addFragmentCode(`
uint64_t getMappedObjectId() {
  return getUint64DataValue();
}
`);
    }

    builder.addFragmentCode(`
      uint64_t getObjectSemantic() {
        uint64_t value = getUint64DataValue();
        uint64_t mappedValue;
        if(${this.semanticShaderManager.getFunctionName}(value, mappedValue)){
          return mappedValue;
        }
        mappedValue.high = vec4(255,255,255,255);
        mappedValue.low = vec4(255,255,255,255);
        return mappedValue;
      }
      `);




    builder.addUniform('highp vec4', 'uSelectedSegment', 2);
    builder.addUniform('highp float', 'uShowAllSegments');
    builder.addUniform('highp float', 'uSelectedAlpha');
    builder.addUniform('highp float', 'uNotSelectedAlpha');
    builder.addUniform('lowp float', 'uShattered');
    builder.addUniform('lowp float', 'uSemanticMode');
    builder.addFragmentCode(glsl_unnormalizeUint8);
    builder.setFragmentMain(`
  uint64_t value = getMappedObjectId();
  
  float alpha = uSelectedAlpha;
  float saturation = 1.0;
  if (value.low == vec4(0,0,0,0) && value.high == vec4(0,0,0,0)) {
    emit(vec4(vec4(0, 0, 0, 0)));
    return;
  }
  bool has = uShowAllSegments > 0.0 ? true : ${this.hashTableManager.hasFunctionName}(value);
  if (uSelectedSegment[0] == unnormalizeUint8(value.low) &&
      uSelectedSegment[1] == unnormalizeUint8(value.high)) {
    saturation = has ? 0.5 : uNotSelectedAlpha;
  } else if (!has) {
    alpha = uNotSelectedAlpha;
  }

  if (uShattered == 1.0) {
    value = getUint64DataValue();
  }

  uint64_t semantic = getObjectSemantic();
  bool hasSemantic = true;
  if (semantic.low == vec4(255,255,255,255) && semantic.high == vec4(255,255,255,255)) {
    hasSemantic = false;
  }

  if (uSemanticMode == 1.0) {
   if(hasSemantic) {
      //ignore the high values, those are just flags
      semantic.high = vec4(0,0,0,0);
      vec3 rgb = segmentColorHash(semantic);
      emit(vec4(mix(vec3(1.0,1.0,1.0), rgb, saturation), alpha));
    } else {
      emit(vec4(mix(vec3(1.0,1.0,1.0), vec3(1.0,1.0,1.0), saturation), alpha));
    }
  } else {
    bool vissible = abs(semantic.high.x - 1.0/255.0) < 0.001;
    if (hasSemantic && !vissible) {
      emit(vec4(vec4(0, 0, 0, 0)));
    } else {
      vec3 rgb = segmentColorHash(value);
      emit(vec4(mix(vec3(1.0,1.0,1.0), rgb, saturation), alpha));
    }
  }
`);
  }

  beginSlice(sliceView: SliceView) {
    let shader = super.beginSlice(sliceView);
    let gl = this.gl;

    let {displayState} = this;
    let {segmentSelectionState, visibleSegments} = this.displayState;
    if (!segmentSelectionState.hasSelectedSegment) {
      selectedSegmentForShader.fill(0);
    } else {
      let seg = segmentSelectionState.selectedSegment;
      let low = seg.low, high = seg.high;
      for (let i = 0; i < 4; ++i) {
        selectedSegmentForShader[i] = ((low >> (8 * i)) & 0xFF);
        selectedSegmentForShader[4 + i] = ((high >> (8 * i)) & 0xFF);
      }
    }
    gl.uniform1f(shader.uniform('uSelectedAlpha'), this.displayState.selectedAlpha.value);
    gl.uniform1f(shader.uniform('uNotSelectedAlpha'), this.displayState.notSelectedAlpha.value);
    gl.uniform4fv(shader.uniform('uSelectedSegment'), selectedSegmentForShader);
    gl.uniform1f(shader.uniform('uShowAllSegments'), visibleSegments.hashTable.size ? 0.0 : 1.0);
    gl.uniform1f(shader.uniform('uShattered'), this.displayState.shattered ? 1.0 : 0.0);
    gl.uniform1f(shader.uniform('uSemanticMode'), this.displayState.semanticMode ? 1.0 : 0.0);

    this.hashTableManager.enable(gl, shader, this.gpuHashTable);

    if (this.hasEquivalences) {
      this.equivalencesHashMap.update();
      this.equivalencesShaderManager.enable(gl, shader, this.gpuEquivalencesHashTable);
    }
    this.semanticShaderManager.enable(gl, shader, this.gpusemanticHashTable);
    this.segmentColorShaderManager.enable(gl, shader, displayState.segmentColorHash);
    return shader;
  }
  endSlice(shader: ShaderProgram) {
    let {gl} = this;
    this.hashTableManager.disable(gl, shader);
    super.endSlice(shader);
  }

  handleAction(action: string) {
    super.handleAction(action);


    //FIXME probably redraw should be call everytime we dispatch
    //segmentation_user_layer.specificationChanged.dispatch();
    this.redrawNeeded.dispatch();

    let actions: { [key:string] : Function } = {};

    let fn : Function = actions[action]

    if (fn) {
      fn.call(this);
      this.redrawNeeded.dispatch();
    }
  }

};
