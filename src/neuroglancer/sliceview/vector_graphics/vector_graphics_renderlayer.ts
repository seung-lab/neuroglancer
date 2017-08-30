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

import {VectorGraphicsSourceOptions} from 'neuroglancer/sliceview/vector_graphics/base';
import {MultiscaleVectorGraphicsChunkSource} from 'neuroglancer/sliceview/vector_graphics/frontend';
import {RenderLayer} from 'neuroglancer/sliceview/vector_graphics/frontend';
import {SliceView} from 'neuroglancer/sliceview/frontend';
import {TrackableAlphaValue, trackableAlphaValue} from 'neuroglancer/trackable_alpha';
import {vec3} from 'neuroglancer/util/geom';
import {makeTrackableFragmentMain, makeWatchableShaderError, TrackableFragmentMain} from 'neuroglancer/webgl/dynamic_shader';
import {ShaderBuilder} from 'neuroglancer/webgl/shader';

export const FRAGMENT_MAIN_START = '//NEUROGLANCER_VECTORGRAPHICS_RENDERLAYER_FRAGMENT_MAIN_START';

const DEFAULT_FRAGMENT_MAIN = `void main() {
  float distance = length(vNormal);
  float feather = 1.0; 
  vec3 color = vec3(0,1,0);
  if ( (distance > vLineWidth - feather) && (distance < vLineWidth + feather) ) {
    emitRGBA(vec4(color, distance));
  }
  emitRGB(color);
}
`;

export function getTrackableFragmentMain(value = DEFAULT_FRAGMENT_MAIN) {
  return makeTrackableFragmentMain(value);
}

export class VectorGraphicsRenderLayer extends RenderLayer {
  fragmentMain: TrackableFragmentMain;
  opacity: TrackableAlphaValue;
  constructor(multiscaleSource: MultiscaleVectorGraphicsChunkSource, {
    opacity = trackableAlphaValue(0.5),
    fragmentMain = getTrackableFragmentMain(),
    shaderError = makeWatchableShaderError(),
    sourceOptions = <VectorGraphicsSourceOptions>{},
  } = {}) {
    super(multiscaleSource, {shaderError, sourceOptions});
    this.opacity = opacity;
    this.registerDisposer(opacity.changed.add(() => {
      this.redrawNeeded.dispatch();
    }));
    this.fragmentMain = fragmentMain;
    this.registerDisposer(fragmentMain.changed.add(() => {
      this.shaderUpdated = true;
      this.redrawNeeded.dispatch();
    }));
  }

  getShaderKey() {
    return `vectorgraphics.VectorGraphicsRenderLayer:${JSON.stringify(this.fragmentMain.value)}`;
  }

  defineShader(builder: ShaderBuilder) {
    super.defineShader(builder);
    builder.addUniform('highp float', 'uOpacity');
    builder.addVarying('vec3', 'vNormal');
    builder.addVarying('float', 'vLineWidth');
    
    builder.addFragmentCode(`
void emitRGBA(vec4 rgba) {
  emit(vec4(rgba.rgb, rgba.a * uOpacity));
}
void emitRGB(vec3 rgb) {
  emit(vec4(rgb, uOpacity));
}
void emitGrayscale(float value) {
  emit(vec4(value, value, value, uOpacity));
}
void emitTransparent() {
  emit(vec4(0.0, 0.0, 0.0, 0.0));
}
`);
    builder.setFragmentMainFunction(FRAGMENT_MAIN_START + '\n' + this.fragmentMain.value);

    builder.setVertexMain(`
vNormal = aVertexNormal; 
vLineWidth = 3.0;
vec4 delta = vec4(aVertexNormal * vLineWidth, 0.0);
vec4 pos = vec4(aVertexPosition, 1.0);
gl_Position = uProjection * (pos + delta);
`);
    
  }

  beginSlice(sliceView: SliceView) {
    let shader = super.beginSlice(sliceView);
    let {gl} = this;
    gl.uniform1f(shader.uniform('uOpacity'), this.opacity.value);
    return shader;
  }
}
