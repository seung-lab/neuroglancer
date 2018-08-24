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

import {ChunkState} from 'neuroglancer/chunk_manager/base';
import {Chunk, ChunkManager, ChunkSource} from 'neuroglancer/chunk_manager/frontend';
import {ChunkedGraphLayer} from 'neuroglancer/sliceview/chunked_graph/frontend';
import {FRAGMENT_SOURCE_RPC_ID, MESH_LAYER_RPC_ID} from 'neuroglancer/mesh/base';
import {PerspectiveViewRenderContext, PerspectiveViewRenderLayer} from 'neuroglancer/perspective_view/render_layer';
import {forEachVisibleSegment3D, getObjectKey} from 'neuroglancer/segmentation_display_state/base';
import {forEachSegment3DToDraw, getObjectColor, registerRedrawWhenSegmentationDisplayState3DChanged, SegmentationDisplayState3D, SegmentationLayerSharedObject} from 'neuroglancer/segmentation_display_state/frontend';
import {mat4, vec3, vec4} from 'neuroglancer/util/geom';
import {getObjectId} from 'neuroglancer/util/object_id';
import {Buffer} from 'neuroglancer/webgl/buffer';
import {GL} from 'neuroglancer/webgl/context';
import {ShaderBuilder, ShaderModule, ShaderProgram} from 'neuroglancer/webgl/shader';
import {setVec4FromUint32, glsl_random} from 'neuroglancer/webgl/shader_lib';
import {registerSharedObjectOwner, RPC} from 'neuroglancer/worker_rpc';

export class MeshShaderManager {
  private tempLightVec = new Float32Array(4);
  private tempPickID = new Float32Array(4);
  constructor() {}

  defineShader(builder: ShaderBuilder) {
    builder.addAttribute('highp vec3', 'aVertexPosition');
    builder.addAttribute('highp vec3', 'aVertexNormal');
    builder.addVarying('highp vec4', 'vColor');
    builder.addVarying('highp vec3', 'vNormal');
    builder.addVarying('highp vec3', 'vPositionWorld');
    builder.addVarying('highp vec3', 'vPositionEye');
    builder.addVarying('highp vec3', 'vLightDir');
    builder.addUniform('highp vec4', 'uLightDirection');
    builder.addUniform('highp vec4', 'uColor');
    builder.addUniform('highp mat4', 'uObjectMatrix');
    builder.addUniform('highp mat4', 'uModelViewMatrix');
    builder.addUniform('highp mat4', 'uProjectionMatrix');
    builder.addUniform('highp vec4', 'uPickID');
    builder.addFragmentCode(glsl_random);
    builder.setVertexMain(`
vPositionWorld = aVertexPosition.xyz;
vPositionEye = (uModelViewMatrix * uObjectMatrix * vec4(aVertexPosition, 1.0)).xyz;
gl_Position = uProjectionMatrix * (uModelViewMatrix * uObjectMatrix * vec4(aVertexPosition, 1.0));
vNormal = normalize((uModelViewMatrix * uObjectMatrix * vec4(aVertexNormal, 0.0)).xyz);
float lightingFactor = abs(dot(vNormal, uLightDirection.xyz)) + uLightDirection.w;
vLightDir = (uModelViewMatrix * uObjectMatrix * vec4(uLightDirection.xyz, 0.0)).xyz;
vColor = vec4(lightingFactor * uColor.rgb, uColor.a);
`);
    builder.setFragmentMain(`
const float LIGHT_INTENSITY = 0.25;
const vec3 RED = vec3(1.0, 0.7, 0.7) * LIGHT_INTENSITY;
const vec3 ORANGE = vec3(1.0, 0.67, 0.43) * LIGHT_INTENSITY;
const vec3 BLUE = vec3(0.54, 0.77, 1.0) * LIGHT_INTENSITY;
const vec3 WHITE = vec3(1.2, 1.07, 0.98) * LIGHT_INTENSITY;

vec3 normal = normalize(vNormal);
vec3 eye = -normalize(vPositionEye.xyz);
vec3 light = normalize(vec3(0.0, 1.0, 2.0));

// Compute curvature for fake ambient occlusion
vec3 dx = dFdx(normal);
vec3 dy = dFdy(normal);
vec3 xneg = normal - dx;
vec3 xpos = normal + dx;
vec3 yneg = normal - dy;
vec3 ypos = normal + dy;
float curv = cross(xneg, xpos).y - cross(yneg, ypos).x;

// Bump mapping based on procedural noise texture
vec3 noise = getNormal(vPositionWorld / 500.0);
normal += 0.3*noise;
normal = normalize(normal);

float NdotL = dot(normal, light);
float NdotE = dot(normal, eye);

float ambient = clamp(0.25 + 0.6*curv, 0.0, 0.25);
float diffuse = pow(abs(NdotL), 1.0 / 2.2);
float fresnel = pow(1.0 - max(NdotE, 0.0), 2.5) * 0.45;

float specular1 = pow(max(0.0, dot(light, reflect(-eye, normal))), 8.0) * 0.64;
normal = normalize(normal + light * 0.675);
float specular2 = pow(max(0.0, dot(light, reflect(-eye, normal))), 80.0) * 1.5;

vec3 col = mix(ambient * uColor.rgb, vec3(1.0), fresnel) + 0.6 * diffuse * uColor.rgb + specular1 * WHITE + specular2 * WHITE;

col = clamp(col, 0.0, 1.0);
emit(vec4(vec3(col), 1.0), uPickID);
`);
  }

  beginLayer(gl: GL, shader: ShaderProgram, renderContext: PerspectiveViewRenderContext) {
    let {dataToViewport, viewportToDevice, lightDirection, ambientLighting, directionalLighting} = renderContext;
    gl.uniformMatrix4fv(shader.uniform('uModelViewMatrix'), false, dataToViewport);
    gl.uniformMatrix4fv(shader.uniform('uProjectionMatrix'), false, viewportToDevice);
    let lightVec = <vec3>this.tempLightVec;
    vec3.scale(lightVec, lightDirection, directionalLighting);
    lightVec[3] = ambientLighting;
    gl.uniform4fv(shader.uniform('uLightDirection'), lightVec);
  }

  setColor(gl: GL, shader: ShaderProgram, color: vec4) {
    gl.uniform4fv(shader.uniform('uColor'), color);
  }

  setPickID(gl: GL, shader: ShaderProgram, pickID: number) {
    gl.uniform4fv(shader.uniform('uPickID'), setVec4FromUint32(this.tempPickID, pickID));
  }

  beginObject(gl: GL, shader: ShaderProgram, objectToDataMatrix: mat4) {
    gl.uniformMatrix4fv(shader.uniform('uObjectMatrix'), false, objectToDataMatrix);
  }

  getShader(gl: GL, emitter: ShaderModule) {
    return gl.memoize.get(`mesh/MeshShaderManager:${getObjectId(emitter)}`, () => {
      let builder = new ShaderBuilder(gl);
      builder.require(emitter);
      this.defineShader(builder);
      return builder.build();
    });
  }

  drawFragment(gl: GL, shader: ShaderProgram, fragmentChunk: FragmentChunk) {
    fragmentChunk.vertexBuffer.bindToVertexAttrib(
        shader.attribute('aVertexPosition'),
        /*components=*/3);

    fragmentChunk.normalBuffer.bindToVertexAttrib(
        shader.attribute('aVertexNormal'),
        /*components=*/3);
    fragmentChunk.indexBuffer.bind();
    gl.drawElements(gl.TRIANGLES, fragmentChunk.numIndices, gl.UNSIGNED_INT, 0);
  }
  endLayer(gl: GL, shader: ShaderProgram) {
    gl.disableVertexAttribArray(shader.attribute('aVertexPosition'));
    gl.disableVertexAttribArray(shader.attribute('aVertexNormal'));
  }
}

export class MeshLayer extends PerspectiveViewRenderLayer {
  protected meshShaderManager = new MeshShaderManager();
  private shaders = new Map<ShaderModule, ShaderProgram>();
  private sharedObject: SegmentationLayerSharedObject;

  constructor(
      public chunkManager: ChunkManager,
      public chunkedGraph: ChunkedGraphLayer|null,
      public source: MeshSource,
      public displayState: SegmentationDisplayState3D) {
    super();

    registerRedrawWhenSegmentationDisplayState3DChanged(displayState, this);

    let sharedObject = this.sharedObject =
        this.registerDisposer(new SegmentationLayerSharedObject(chunkManager, displayState));
    sharedObject.RPC_TYPE_ID = MESH_LAYER_RPC_ID;
    sharedObject.initializeCounterpartWithChunkManager({
      'source': source.addCounterpartRef(),
      'chunkedGraph': chunkedGraph ? chunkedGraph.rpcId : null,
    });
    this.setReady(true);
    sharedObject.visibility.add(this.visibility);
  }

  protected getShader(emitter: ShaderModule) {
    let {shaders} = this;
    let shader = shaders.get(emitter);
    if (shader === undefined) {
      shader = this.registerDisposer(this.meshShaderManager.getShader(this.gl, emitter));
      shaders.set(emitter, shader);
    }
    return shader;
  }

  get isTransparent() {
    return this.displayState.objectAlpha.value < 1.0;
  }

  get gl() {
    return this.chunkManager.chunkQueueManager.gl;
  }

  draw(renderContext: PerspectiveViewRenderContext) {
    if (!renderContext.emitColor && renderContext.alreadyEmittedPickID) {
      // No need for a separate pick ID pass.
      return;
    }
    let {gl, displayState, meshShaderManager} = this;
    let alpha = Math.min(1.0, displayState.objectAlpha.value);
    if (alpha <= 0.0) {
      // Skip drawing.
      return;
    }
    let shader = this.getShader(renderContext.emitter);
    shader.bind();
    meshShaderManager.beginLayer(gl, shader, renderContext);

    let objectChunks = this.source.fragmentSource.objectChunks;

    let {pickIDs} = renderContext;

    const objectToDataMatrix = this.displayState.objectToDataTransform.transform;

    forEachSegment3DToDraw(displayState, objectChunks, (rootObjectId, objectId, fragments) => {
      if (renderContext.emitColor) {
        meshShaderManager.setColor(gl, shader, getObjectColor(displayState, rootObjectId, alpha));
      }
      if (renderContext.emitPickID) {
        meshShaderManager.setPickID(gl, shader, pickIDs.registerUint64(this, objectId));
      }
      meshShaderManager.beginObject(gl, shader, objectToDataMatrix);
      for (let fragment of fragments) {
        if (fragment.state === ChunkState.GPU_MEMORY) {
          meshShaderManager.drawFragment(gl, shader, fragment);
        }
      }
    });

    meshShaderManager.endLayer(gl, shader);
  }

  isReady() {
    const {displayState, source} = this;
    let ready = true;
    const fragmentChunks = source.fragmentSource.chunks;
    forEachVisibleSegment3D(displayState, objectId => {
      const key = getObjectKey(objectId, displayState.clipBounds.value);
      const manifestChunk = source.chunks.get(key);
      if (manifestChunk === undefined) {
        ready = false;
        return;
      }
      for (const fragmentId of manifestChunk.fragmentIds) {
        const fragmentChunk = fragmentChunks.get(`${key}/${fragmentId}`);
        if (fragmentChunk === undefined || fragmentChunk.state !== ChunkState.GPU_MEMORY) {
          ready = false;
          return;
        }
      }
    });
    return ready;
  }
}

export class ManifestChunk extends Chunk {
  fragmentIds: string[];

  constructor(source: MeshSource, x: any) {
    super(source);
    this.fragmentIds = x.fragmentIds;
  }
}

export class FragmentChunk extends Chunk {
  vertexPositions: Float32Array;
  indices: Uint32Array;
  vertexNormals: Float32Array;
  objectKey: string;
  source: FragmentSource;
  vertexBuffer: Buffer;
  indexBuffer: Buffer;
  normalBuffer: Buffer;
  numIndices: number;

  constructor(source: FragmentSource, x: any) {
    super(source);
    this.objectKey = x['objectKey'];
    this.vertexPositions = x['vertexPositions'];
    let indices = this.indices = x['indices'];
    this.numIndices = indices.length;
    this.vertexNormals = x['vertexNormals'];
  }

  copyToGPU(gl: GL) {
    super.copyToGPU(gl);
    this.vertexBuffer = Buffer.fromData(gl, this.vertexPositions, gl.ARRAY_BUFFER, gl.STATIC_DRAW);
    this.indexBuffer = Buffer.fromData(gl, this.indices, gl.ELEMENT_ARRAY_BUFFER, gl.STATIC_DRAW);
    this.normalBuffer = Buffer.fromData(gl, this.vertexNormals, gl.ARRAY_BUFFER, gl.STATIC_DRAW);
  }

  freeGPUMemory(gl: GL) {
    super.freeGPUMemory(gl);
    this.vertexBuffer.dispose();
    this.indexBuffer.dispose();
    this.normalBuffer.dispose();
  }
}

export class MeshSource extends ChunkSource {
  fragmentSource = this.registerDisposer(new FragmentSource(this.chunkManager, this));
  chunks: Map<string, ManifestChunk>;
  initializeCounterpart(rpc: RPC, options: any) {
    this.fragmentSource.initializeCounterpart(this.chunkManager.rpc!, {});
    options['fragmentSource'] = this.fragmentSource.addCounterpartRef();
    super.initializeCounterpart(rpc, options);
  }
  getChunk(x: any) {
    return new ManifestChunk(this, x);
  }
}

@registerSharedObjectOwner(FRAGMENT_SOURCE_RPC_ID)
export class FragmentSource extends ChunkSource {
  objectChunks = new Map<string, Set<FragmentChunk>>();
  constructor(chunkManager: ChunkManager, public meshSource: MeshSource) {
    super(chunkManager);
  }
  addChunk(key: string, chunk: FragmentChunk) {
    super.addChunk(key, chunk);
    let {objectChunks} = this;
    let {objectKey} = chunk;
    let fragments = objectChunks.get(objectKey);
    if (fragments === undefined) {
      fragments = new Set();
      objectChunks.set(objectKey, fragments);
    }
    fragments.add(chunk);
  }
  deleteChunk(key: string) {
    let chunk = <FragmentChunk>this.chunks.get(key);
    super.deleteChunk(key);
    let {objectChunks} = this;
    let {objectKey} = chunk;
    let fragments = objectChunks.get(objectKey)!;
    fragments.delete(chunk);
    if (fragments.size === 0) {
      objectChunks.delete(objectKey);
    }
  }
  getChunk(x: any) {
    return new FragmentChunk(this, x);
  }
}
