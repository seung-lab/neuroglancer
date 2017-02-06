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

import {SynapseAnnotationPointList} from 'neuroglancer/synapse/point_list';
import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {MouseSelectionState, RenderLayer} from 'neuroglancer/layer';
import {VoxelSize} from 'neuroglancer/navigation_state';
import {PerspectiveViewRenderContext, PerspectiveViewRenderLayer} from 'neuroglancer/perspective_view/render_layer';
import {SliceViewPanelRenderContext, SliceViewPanelRenderLayer} from 'neuroglancer/sliceview/panel';
import {WatchableValue} from 'neuroglancer/trackable_value';
import {RefCounted} from 'neuroglancer/util/disposable';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {Uint64} from 'neuroglancer/util/uint64';
import {Buffer} from 'neuroglancer/webgl/buffer';
import {GL} from 'neuroglancer/webgl/context';
import {countingBufferShaderModule, disableCountingBuffer, getCountingBuffer} from 'neuroglancer/webgl/index_emulation';
import {ShaderBuilder, ShaderModule, ShaderProgram} from 'neuroglancer/webgl/shader';
import {GL_FLOAT} from 'neuroglancer/webgl/constants';
import {glsl_addUint32, setVec4FromUint32, glsl_divmodUint32, glsl_floatToUint32} from 'neuroglancer/webgl/shader_lib';
import {getSquareCornersBuffer} from 'neuroglancer/webgl/square_corners_buffer';
import {Signal} from 'signals';

const tempMat = mat4.create();
const tempPickID = new Float32Array(4);

export class SynapseAnnotationPointListLayer extends RefCounted {
  buffer: Buffer;
  generation = -1;
  redrawNeeded = new Signal();
  color_pre = Float32Array.of(1.0, 0.0, 0.0, 1.0);
  color_post = Float32Array.of(0.0, 0.0, 1.0, 1.0);
  selectedColor = Float32Array.of(1.0, 1.0, 0.0, 1.0);

  constructor(
      public chunkManager: ChunkManager, public pointList: SynapseAnnotationPointList,
      public voxelSizeObject: VoxelSize, public selectedIndex: WatchableValue<number|null>) {
    super();
    this.buffer = new Buffer(chunkManager.gl);
    this.registerSignalBinding(pointList.changed.add(() => {
      // Clear selectedIndex, since the indices have changed.
      this.selectedIndex.value = null;
      this.redrawNeeded.dispatch();
    }));
    this.registerSignalBinding(selectedIndex.changed.add(() => { this.redrawNeeded.dispatch(); }));
  }

  get gl() { return this.chunkManager.gl; }

  updateBuffer() {
    let {pointList} = this;
    const newGeneration = pointList.generation;
    if (this.generation !== newGeneration) {
      this.generation = newGeneration;
      this.buffer.setData(pointList.points.view);
    }
  }

  updateMouseState(mouseState: MouseSelectionState, pickedOffset: number) {
    vec3.multiply(mouseState.position, this.pointList.get(pickedOffset), this.voxelSizeObject.size);
  }
}

export class RenderHelper extends RefCounted {
  private shaders = new Map<ShaderModule, ShaderProgram>();
  private squareCornersBuffer = getSquareCornersBuffer(this.gl);
  private countingBuffer = this.registerDisposer(getCountingBuffer(this.gl));
  private lineShader : ShaderProgram;

  constructor(public gl: GL) { super(); }

  defineShader(builder: ShaderBuilder) {
    // Position of point in camera coordinates.
    builder.addAttribute('highp vec3', 'aVertexPosition');

    // XY corners of square ranging from [-1, -1] to [1, 1].
    builder.addAttribute('highp vec2', 'aCornerOffset');

    // The x and y radii of the point in normalized device coordinates.
    builder.addUniform('highp vec2', 'uPointRadii');

    builder.addUniform('highp vec4', 'uColorPre');
    builder.addUniform('highp vec4', 'uColorPost');
    builder.addUniform('highp vec4', 'uColorSelected');
    builder.addUniform('highp vec4', 'uSelectedIndex');
    builder.addVarying('highp vec4', 'vColor');

    // Transform from camera to clip coordinates.
    builder.addUniform('highp mat4', 'uProjection');
    builder.addUniform('highp vec4', 'uPickID');
    builder.addVarying('highp vec4', 'vPickID');
    builder.addVarying('highp vec2', 'vPointCoord');
    builder.addVertexCode(glsl_floatToUint32);
    builder.require(countingBufferShaderModule);
    builder.addVertexCode(glsl_addUint32);
    builder.addVertexCode(glsl_divmodUint32);
    builder.setVertexMain(`
gl_Position = uProjection * vec4(aVertexPosition, 1.0);
gl_Position.xy += aCornerOffset * uPointRadii * gl_Position.w;
vPointCoord = aCornerOffset;

uint32_t primitiveIndex = getPrimitiveIndex();

uint32_t pickID; pickID.value = uPickID;

uint32_t quotient;
divmod(primitiveIndex, 2.0, quotient);
vPickID = add(pickID, quotient).value;

uint32_t _;
if(divmod(primitiveIndex, 2.0, _)==0.0) {
  vColor = uColorPre;
}
else {
  vColor = uColorPost;
}

const float EPSILON = 0.000001;
if (all(lessThan(abs(uSelectedIndex-quotient.value), vec4(EPSILON)))) {
  vColor = uColorSelected;
} 

`);
    builder.setFragmentMain(`
if (dot(vPointCoord, vPointCoord) > 1.0) {
  discard;
}
else {
  emit(getColor(), vPickID);
}
`);
  }

  defineLineShader(builder: ShaderBuilder) {
    builder.addAttribute('highp vec3', 'aVertexPosition');
    builder.addUniform('highp mat4', 'uProjection');
    builder.addUniform('highp vec4', 'uPickID');
    builder.setVertexMain(`gl_Position = uProjection * vec4(aVertexPosition, 1.0);`);
    builder.setFragmentMain(`v4f_fragColor = vec4(0.0,0.0,0.0,1.0);`);
  }

  getShader(emitter: ShaderModule) {
    let {shaders} = this;
    let shader = shaders.get(emitter);
    if (shader === undefined) {
      const builder = new ShaderBuilder(this.gl);
      builder.require(emitter);
      this.defineShader(builder);
      shader = this.registerDisposer(builder.build());
      shaders.set(emitter, shader);
    }
    return shader;
  }

  getLineShader() {
    if (this.lineShader === undefined) {
      const builder = new ShaderBuilder(this.gl);
      this.defineLineShader(builder);
      this.lineShader = this.registerDisposer(builder.build());
    }
     
    return this.lineShader;
  }

  draw(
      renderLayer: RenderLayer, base: SynapseAnnotationPointListLayer,
      renderContext: SliceViewPanelRenderContext|PerspectiveViewRenderContext) {
    let shader = this.getShader(renderContext.emitter);
    let {gl} = this;
    shader.bind();
    base.updateBuffer();
    const numPoints = base.pointList.length;
    const aVertexPosition = shader.attribute('aVertexPosition');
    const aCornerOffset = shader.attribute('aCornerOffset');
    base.buffer.bindToVertexAttrib(aVertexPosition, /*components=*/3);
    gl.vertexAttribDivisor(aVertexPosition, 1);
    this.squareCornersBuffer.bindToVertexAttrib(aCornerOffset, /*components=*/2);
    this.countingBuffer.ensure(numPoints).bind(shader, 1);

    let objectToDataMatrix = tempMat;
    mat4.identity(objectToDataMatrix);
    mat4.scale(objectToDataMatrix, objectToDataMatrix, base.voxelSizeObject.size);
    mat4.multiply(tempMat, renderContext.dataToDevice, objectToDataMatrix);
    gl.uniformMatrix4fv(shader.uniform('uProjection'), false, tempMat);
    const pointRadius = 8;
    gl.uniform2f(
        shader.uniform('uPointRadii'),
        pointRadius / renderContext.viewportWidth,
        pointRadius / renderContext.viewportHeight);
    if (renderContext.emitPickID) {
      const pickID = renderContext.pickIDs.register(renderLayer, numPoints);
      gl.uniform4fv(shader.uniform('uPickID'), setVec4FromUint32(tempPickID, pickID));
    }
    if (renderContext.emitColor) {
      gl.uniform4fv(shader.uniform('uColorPre'), base.color_pre);
      gl.uniform4fv(shader.uniform('uColorPost'), base.color_post);
      gl.uniform4fv(shader.uniform('uColorSelected'), base.selectedColor);
      let selectedIndex = base.selectedIndex.value;
      if (selectedIndex === null) {
        selectedIndex = 0xFFFFFFFF;
      }
      gl.uniform4fv(shader.uniform('uSelectedIndex'), setVec4FromUint32(tempPickID, selectedIndex));
    }

    gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, 4, numPoints);
    
    base.buffer.bindToVertexAttrib(aVertexPosition, /*components=*/3);
    gl.vertexAttribDivisor(aVertexPosition, 0); //reset to default
    disableCountingBuffer(gl, shader, /*instanced=*/true);
    gl.disableVertexAttribArray(aVertexPosition);

    //Make a second shader for displaying lines
    if (numPoints) {
      this.getLineShader();
      this.lineShader.bind()
      base.buffer.bindToVertexAttrib(aVertexPosition, /*components=*/3);
      base.updateBuffer();
      gl.uniformMatrix4fv(this.lineShader.uniform('uProjection'), false, tempMat);
      if (renderContext.emitPickID) {
        const pickID = renderContext.pickIDs.register(renderLayer, numPoints);
        gl.uniform4fv(this.lineShader.uniform('uPickID'), setVec4FromUint32(tempPickID, pickID));
      }
      gl.lineWidth(2);
      gl.drawArrays(gl.LINES, 0, numPoints);
      gl.disableVertexAttribArray(aVertexPosition);
    }


  }
}

class PerspectiveViewRenderHelper extends RenderHelper {
  defineShader(builder: ShaderBuilder) {
    super.defineShader(builder);
    builder.addFragmentCode(`
vec4 getColor () { return vColor; }
`);
  }
}

export class PerspectiveViewAnnotationPointListLayer extends PerspectiveViewRenderLayer {
  private renderHelper = this.registerDisposer(new PerspectiveViewRenderHelper(this.gl));

  constructor(public base: SynapseAnnotationPointListLayer) {
    super();
    this.registerDisposer(base);
    this.registerSignalBinding(base.redrawNeeded.add(() => { this.redrawNeeded.dispatch(); }));
    this.setReady(true);
  }

  get gl() { return this.base.chunkManager.gl; }

  draw(renderContext: PerspectiveViewRenderContext) {
    this.renderHelper.draw(this, this.base, renderContext);
  }

  updateMouseState(mouseState: MouseSelectionState, _pickedValue: Uint64, pickedOffset: number) {
    this.base.updateMouseState(mouseState, pickedOffset);
  }

  transformPickedValue(_pickedValue: Uint64, pickedOffset: number) { return pickedOffset; }
}

class SliceViewRenderHelper extends RenderHelper {
  defineShader(builder: ShaderBuilder) {
    super.defineShader(builder);
    builder.addFragmentCode(`
vec4 getColor() {
  float scalar = 1.0 - 2.0 * abs(0.5 - gl_FragCoord.z);
  return vec4(vColor.xyz, scalar * vColor.a);
}
`);
  }
}

export class SliceViewAnnotationPointListLayer extends SliceViewPanelRenderLayer {
  private renderHelper = this.registerDisposer(new SliceViewRenderHelper(this.gl));

  constructor(public base: SynapseAnnotationPointListLayer) {
    super();
    this.registerDisposer(base);
    this.registerSignalBinding(base.redrawNeeded.add(() => { this.redrawNeeded.dispatch(); }));
    this.setReady(true);
  }

  get gl() { return this.base.chunkManager.gl; }

  draw(renderContext: SliceViewPanelRenderContext) {
    this.renderHelper.draw(this, this.base, renderContext);
  }

  updateMouseState(mouseState: MouseSelectionState, _pickedValue: Uint64, pickedOffset: number) {
    this.base.updateMouseState(mouseState, pickedOffset);
  }

  transformPickedValue(_pickedValue: Uint64, pickedOffset: number) { return pickedOffset; }
}
