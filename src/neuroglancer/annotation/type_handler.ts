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

import {Annotation, AnnotationNumericPropertySpec, AnnotationPropertySpec, AnnotationType, annotationTypeHandlers, getPropertyOffsets, propertyTypeDataType} from 'neuroglancer/annotation';
import {AnnotationLayer} from 'neuroglancer/annotation/renderlayer';
import {PerspectiveViewRenderContext} from 'neuroglancer/perspective_view/render_layer';
import {ChunkDisplayTransformParameters} from 'neuroglancer/render_coordinate_transform';
import {SliceViewPanelRenderContext} from 'neuroglancer/sliceview/renderlayer';
import {WatchableValueInterface} from 'neuroglancer/trackable_value';
import {RefCounted} from 'neuroglancer/util/disposable';
import {mat4} from 'neuroglancer/util/geom';
import {Buffer} from 'neuroglancer/webgl/buffer';
import {glsl_COLORMAPS} from 'neuroglancer/webgl/colormaps';
import {GL} from 'neuroglancer/webgl/context';
import {ParameterizedContextDependentShaderGetter, parameterizedEmitterDependentShaderGetter, shaderCodeWithLineDirective, WatchableShaderError} from 'neuroglancer/webgl/dynamic_shader';
import {defineInvlerpShaderFunction, enableLerpShaderFunction} from 'neuroglancer/webgl/lerp';
import {ShaderBuilder, ShaderModule, ShaderProgram} from 'neuroglancer/webgl/shader';
import {addControlsToBuilder, setControlsInShader, ShaderControlsBuilderState, ShaderControlState} from 'neuroglancer/webgl/shader_ui_controls';
import {BasicHashColorShaderManager} from 'neuroglancer/segment_color';

const DEBUG_HISTOGRAMS = false;

export type AnnotationShaderGetter =
    ParameterizedContextDependentShaderGetter<ShaderModule, ShaderControlsBuilderState>;

export interface AnnotationRenderContext {
  buffer: Buffer;
  annotationLayer: AnnotationLayer;
  renderContext: SliceViewPanelRenderContext|PerspectiveViewRenderContext;
  bufferOffset: number;
  count: number;
  basePickId: number;
  selectedIndex: number;
  modelViewProjectionMatrix: mat4;
  subspaceMatrix: Float32Array;
  renderSubspaceModelMatrix: mat4;
  renderSubspaceInvModelMatrix: mat4;
  modelClipBounds: Float32Array;
  chunkDisplayTransform: ChunkDisplayTransformParameters;
}

interface AnnotationPropertyTypeRenderHandler {
  defineShader(builder: ShaderBuilder, identifier: string, rank: number): void;
}

function makeSimplePropertyRenderHandler(
    shaderType: string,
    bind: (gl: WebGL2RenderingContext, location: number, stride: number, offset: number) => void) {
  return {
    defineShader(builder: ShaderBuilder, identifier: string) {
      const propName = `prop_${identifier}`;
      const aName = `a_${propName}`;
      builder.addAttribute(`${shaderType}`, aName);
      builder.addVertexCode(`${shaderType} ${propName}() { return ${aName}; }`);
      builder.addInitializer(shader => {
        const location = shader.attribute(aName);
        const {gl} = shader;
        shader.vertexShaderInputBinders[propName] = location === -1 ?
            {
              enable() {},
              disable() {},
              bind() {},
            } :
            {
              enable(divisor: number) {
                gl.enableVertexAttribArray(location);
                gl.vertexAttribDivisor(location, divisor);
              },
              disable() {
                gl.vertexAttribDivisor(location, 0);
                gl.disableVertexAttribArray(location);
              },
              bind(stride: number, offset: number) {
                bind(gl, location, stride, offset);
              },
            };
      });
    },
  };
}

function makeFloatPropertyRenderHandler(
    shaderType: string, numComponents: number, attributeType: number, normalized: boolean) {
  return makeSimplePropertyRenderHandler(shaderType, (gl, location, stride, offset) => {
    gl.vertexAttribPointer(
        location, /*size=*/ numComponents, /*type=*/ attributeType,
        /*normalized=*/ normalized, stride, offset);
  });
}

function makeIntegerPropertyRenderHandler(
    shaderType: string, numComponents: number, attributeType: number) {
  return makeSimplePropertyRenderHandler(shaderType, (gl, location, stride, offset) => {
    gl.vertexAttribIPointer(
        location, /*size=*/ numComponents, /*type=*/ attributeType, stride, offset);
  });
}

const annotationPropertyTypeRenderHandlers:
    {[K in AnnotationPropertySpec['type']]: AnnotationPropertyTypeRenderHandler} = {
      'rgb': makeFloatPropertyRenderHandler(
          'highp vec3', 3, WebGL2RenderingContext.UNSIGNED_BYTE, /*normalized=*/ true),
      'rgba': makeFloatPropertyRenderHandler(
          'highp vec4', 4, WebGL2RenderingContext.UNSIGNED_BYTE, /*normalized=*/ true),
      'float32': makeFloatPropertyRenderHandler(
          'highp float', 1, WebGL2RenderingContext.FLOAT, /*normalized=*/ false),
      'uint32':
          makeIntegerPropertyRenderHandler('highp uint', 1, WebGL2RenderingContext.UNSIGNED_INT),
      'int32': makeIntegerPropertyRenderHandler('highp int', 1, WebGL2RenderingContext.INT),
      'uint16':
          makeIntegerPropertyRenderHandler('highp uint', 1, WebGL2RenderingContext.UNSIGNED_SHORT),
      'int16': makeIntegerPropertyRenderHandler('highp int', 1, WebGL2RenderingContext.SHORT),
      'uint8':
          makeIntegerPropertyRenderHandler('highp uint', 1, WebGL2RenderingContext.UNSIGNED_BYTE),
      'int8': makeIntegerPropertyRenderHandler('highp int', 1, WebGL2RenderingContext.BYTE),
    };

class AnnotationRenderHelperBase extends RefCounted {
  readonly serializedBytesPerAnnotation: number;
  readonly serializedGeometryBytesPerAnnotation: number;
  readonly propertyOffsets: {group: number, offset: number}[];
  readonly propertyGroupBytes: number[];
  readonly propertyGroupCumulativeBytes: number[];
  readonly geometryDataStride: number;

  constructor(
      public gl: GL, public annotationType: AnnotationType, public rank: number,
      public properties: readonly Readonly<AnnotationPropertySpec>[]) {
    super();
    const serializedGeometryBytesPerAnnotation = this.serializedGeometryBytesPerAnnotation =
        annotationTypeHandlers[annotationType].serializedBytes(rank);
    const {offsets, serializedBytes: serializedBytesPerAnnotation, propertyGroupBytes} =
        getPropertyOffsets(rank, serializedGeometryBytesPerAnnotation, properties);
    this.serializedBytesPerAnnotation = serializedBytesPerAnnotation;
    this.propertyOffsets = offsets;
    this.propertyGroupBytes = propertyGroupBytes;
    this.geometryDataStride = propertyGroupBytes[0];
    const propertyGroupCumulativeBytes = this.propertyGroupCumulativeBytes =
        new Array<number>(propertyGroupBytes.length);
    propertyGroupCumulativeBytes[0] = 0;
    for (let i = 1; i < propertyGroupBytes.length; ++i) {
      propertyGroupCumulativeBytes[i] =
          propertyGroupCumulativeBytes[i - 1] + propertyGroupBytes[i - 1];
    }
  }

  protected defineProperties(builder: ShaderBuilder, referencedProperties: number[]) {
    const {properties, rank} = this;
    for (const i of referencedProperties) {
      const property = properties[i];
      const handler = annotationPropertyTypeRenderHandlers[property.type];
      handler.defineShader(builder, property.identifier, rank);
    }
    const {propertyOffsets} = this;
    const {propertyGroupBytes, propertyGroupCumulativeBytes} = this;
    builder.addInitializer(shader => {
      const binders = referencedProperties.map(
          i => shader.vertexShaderInputBinders[`prop_${properties[i].identifier}`]);
      const numProperties = binders.length;
      shader.vertexShaderInputBinders['properties'] = {
        enable(divisor: number) {
          for (let i = 0; i < numProperties; ++i) {
            binders[i].enable(divisor);
          }
        },
        bind(stride: number, offset: number) {
          for (let i = 0; i < numProperties; ++i) {
            const {group, offset: propertyOffset} = propertyOffsets[referencedProperties[i]];
            binders[i].bind(
                /*stride=*/ propertyGroupBytes[group],
                /*offset=*/ offset + propertyOffset + propertyGroupCumulativeBytes[group] * stride);
          }
        },
        disable() {
          for (let i = 0; i < numProperties; ++i) {
            binders[i].disable();
          }
        },
      };
    });
  }
}

export abstract class AnnotationRenderHelper extends AnnotationRenderHelperBase {
  pickIdsPerInstance: number;
  targetIsSliceView: boolean;

  protected hashColorShaderManager = new BasicHashColorShaderManager('hashColor');

  constructor(
      gl: GL, annotationType: AnnotationType, rank: number,
      properties: readonly Readonly<AnnotationPropertySpec>[],
      public shaderControlState: ShaderControlState,
      public fallbackShaderParameters: WatchableValueInterface<ShaderControlsBuilderState>,
      public shaderError: WatchableShaderError) {
    super(gl, annotationType, rank, properties);
  }

  getDependentShader(memoizeKey: any, defineShader: (builder: ShaderBuilder) => void):
      AnnotationShaderGetter {
    return parameterizedEmitterDependentShaderGetter(this, this.gl, {
      memoizeKey: {
        t: 'annotation',
        targetIsSliceView: this.targetIsSliceView,
        type: this.annotationType,
        subType: memoizeKey,
        properties: this.properties,
        rank: this.rank,
      },
      fallbackParameters: this.fallbackShaderParameters,
      parameters: this.shaderControlState.builderState,
      shaderError: this.shaderError,
      defineShader: (builder: ShaderBuilder, parameters: ShaderControlsBuilderState) => {
        const {rank, properties} = this;
        const referencedProperties: number[] = [];
        const controlsReferencedProperties = parameters.referencedProperties;
        const processedCode = parameters.parseResult.code;
        this.hashColorShaderManager.defineShader(builder);
        for (let i = 0, numProperties = properties.length; i < numProperties; ++i) {
          const property = properties[i];

          const enumLabels = (property as AnnotationNumericPropertySpec).enumLabels || [];
          const enumValues = (property as AnnotationNumericPropertySpec).enumValues || [];

          for (let i = 0; i < enumLabels.length && i < enumValues.length; i++) {
            builder.addVertexCode(`#define prop_${property.identifier}_${enumLabels[i]} uint(${enumValues[i]})\n`);
          }

          const functionName = `prop_${property.identifier}`;
          if (!controlsReferencedProperties.includes(property.identifier) &&
              !processedCode.match(new RegExp(`\\b${functionName}\\b`))) {
            continue;
          }
          referencedProperties.push(i);
        }
        // here
        this.defineProperties(builder, referencedProperties);
        builder.addUniform('highp vec3', 'uColor');
        builder.addUniform('highp uint', 'uSelectedIndex');
        builder.addVarying('highp vec4', 'vColor');
        // Transform from model coordinates to the rendered subspace.
        builder.addUniform('highp vec3', 'uSubspaceMatrix', rank);
        // Transform from the rendered subspace of the model coordinate space to clip coordinates.
        builder.addUniform('highp mat4', 'uModelViewProjection');

        // Specifies center vector and per-dimension scale in model coordinates used for
        // clipping.
        builder.addUniform('highp float', 'uModelClipBounds', rank * 2);
        builder.addUniform('highp uint', 'uPickID');
        builder.addVarying('highp uint', 'vPickID', 'flat');

        builder.addVertexCode(glsl_COLORMAPS);

        builder.addVertexCode(`
vec3 defaultColor() { return uColor; }
highp uint getPickBaseOffset() { return uint(gl_InstanceID) * ${this.pickIdsPerInstance}u; }
`);

        builder.addFragmentCode(`
void emitAnnotation(vec4 color) {
  emit(color, vPickID);
}
`);

        const glsl_getSubspaceClipCoefficient = `
float getSubspaceClipCoefficient(float modelPoint[${this.rank}]) {
  float coefficient = 1.0;
  for (int i = 0; i < ${rank}; ++i) {
    float d = abs(modelPoint[i] - uModelClipBounds[i]) * uModelClipBounds[${rank} + i];
    coefficient *= max(0.0, 1.0 - d);
  }
  return coefficient;
}
`;
        builder.addVertexCode(glsl_getSubspaceClipCoefficient);
        builder.addFragmentCode(glsl_getSubspaceClipCoefficient);
        builder.addVertexCode(`
vec3 projectModelVectorToSubspace(float modelPoint[${this.rank}]) {
  vec3 result = vec3(0.0, 0.0, 0.0);
  for (int i = 0; i < ${rank}; ++i) {
    result += uSubspaceMatrix[i] * modelPoint[i];
  }
  return result;
}

float getMaxEndpointSubspaceClipCoefficient(float modelPointA[${this.rank}],  float modelPointB[${
            this.rank}]) {
  float coefficient = 1.0;
  for (int i = 0; i < ${rank}; ++i) {
    float dA = abs(modelPointA[i] - uModelClipBounds[i]) * uModelClipBounds[${rank} + i];
    float dB = abs(modelPointB[i] - uModelClipBounds[i]) * uModelClipBounds[${rank} + i];
    coefficient *= max(0.0, 1.0 - min(dA, dB));
  }
  return coefficient;
}

float getMaxSubspaceClipCoefficient(float modelPointA[${this.rank}],  float modelPointB[${
            this.rank}]) {
  float coefficient = 1.0;
  for (int i = 0; i < ${rank}; ++i) {
    float a = modelPointA[i];
    float b = modelPointB[i];
    float c = uModelClipBounds[i];
    float x = clamp(c, min(a, b), max(a, b));
    float d = abs(x - c) * uModelClipBounds[${rank} + i];
    coefficient *= max(0.0, 1.0 - d);
  }
  return coefficient;
}

`);
        addControlsToBuilder(parameters, builder);
        builder.addVertexCode(`
const bool PROJECTION_VIEW = ${!this.targetIsSliceView};
bool ng_discardValue;
#define discard ng_discard()
void ng_discard() {
  ng_discardValue = true;
}
void setLineColor(vec4 startColor, vec4 endColor);
void setLineWidth(float width);

void setEndpointMarkerColor(vec4 startColor, vec4 endColor);
void setEndpointMarkerBorderColor(vec4 startColor, vec4 endColor);
void setEndpointMarkerSize(float startSize, float endSize);
void setEndpointMarkerBorderWidth(float startSize, float endSize);

void setPointMarkerColor(vec4 color);
void setPointMarkerBorderColor(vec4 color);
void setPointMarkerSize(float size);
void setPointMarkerBorderWidth(float size);
void setPointMarkerBorderColor(vec3 color) { setPointMarkerBorderColor(vec4(color, 1.0)); }

void setEllipsoidFillColor(vec4 color);

void setBoundingBoxBorderColor(vec4 color);
void setBoundingBoxBorderWidth(float size);
void setBoundingBoxFillColor(vec4 color);

void setEndpointMarkerColor(vec3 startColor, vec3 endColor) {
  setEndpointMarkerColor(vec4(startColor, 1.0), vec4(endColor, 1.0));
}
void setEndpointMarkerBorderColor(vec3 startColor, vec3 endColor) {
  setEndpointMarkerBorderColor(vec4(startColor, 1.0), vec4(endColor, 1.0));
}
void setEndpointMarkerColor(vec3 color) { setEndpointMarkerColor(color, color); }
void setEndpointMarkerColor(vec4 color) { setEndpointMarkerColor(color, color); }
void setEndpointMarkerBorderColor(vec3 color) { setEndpointMarkerBorderColor(color, color); }
void setEndpointMarkerBorderColor(vec4 color) { setEndpointMarkerBorderColor(color, color); }
void setEndpointMarkerSize(float size) { setEndpointMarkerSize(size, size); }
void setEndpointMarkerBorderWidth(float size) { setEndpointMarkerBorderWidth(size, size); }
void setLineColor(vec4 color) { setLineColor(color, color); }
void setLineColor(vec3 color) { setLineColor(vec4(color, 1.0)); }
void setLineColor(vec3 startColor, vec3 endColor) { setLineColor(vec4(startColor, 1.0), vec4(endColor, 1.0)); }
void setColor(vec4 color) {
  setPointMarkerColor(color);
  setLineColor(color);
  setEndpointMarkerColor(color);
  setBoundingBoxBorderColor(color);
  setEllipsoidFillColor(vec4(color.rgb, color.a * (PROJECTION_VIEW ? 1.0 : 0.5)));
}
void setEllipsoidFillColor(vec3 color) { setEllipsoidFillColor(vec4(color, 1.0)); }

void setBoundingBoxFillColor(vec3 color) { setBoundingBoxFillColor(vec4(color, 1.0)); }
void setBoundingBoxBorderColor(vec3 color) { setBoundingBoxBorderColor(vec4(color, 1.0)); }

void setColor(vec3 color) { setColor(vec4(color, 1.0)); }
void userMain();
`);
        for (const [annotationType, renderHandler] of annotationTypeRenderHandlers) {
          if (annotationType === this.annotationType) continue;
          renderHandler.defineShaderNoOpSetters(builder);
        }
        defineShader(builder);
        builder.addVertexCode(
            `\n#define main userMain\n` + shaderCodeWithLineDirective(parameters.parseResult.code) +
            `\n#undef main\n`);
      },
    });
  }

  setPartIndex(builder: ShaderBuilder, ...partIndexExpressions: string[]) {
    let s = `
void setPartIndex(${partIndexExpressions.map((_, i) => `highp uint partIndex${i}`).join()}) {
  highp uint pickID = uPickID;
  highp uint pickBaseOffset = getPickBaseOffset();
${
        partIndexExpressions
            .map((_, i) => `highp uint pickOffset${i} = pickBaseOffset + partIndex${i};`)
            .join('\n')}
`;
    if (partIndexExpressions.length === 0) {
      s += `
  highp uint pickOffset0 = pickBaseOffset;
`;
    }
    s += `
  vPickID = pickID + pickOffset0;
  highp uint selectedIndex = uSelectedIndex;
if (selectedIndex == pickBaseOffset${
        partIndexExpressions.map((_, i) => ` || selectedIndex == pickOffset${i}`).join('')}) {
    vColor = vec4(mix(vColor.rgb, vec3(1.0, 1.0, 1.0), 0.75), vColor.a);
  }
}
`;
    builder.addVertexCode(s);
    return `setPartIndex(${partIndexExpressions.join()})`;
  }

  get invokeUserMain() {
    return `
ng_discardValue = false;
userMain();
if (ng_discardValue) {
  gl_Position = vec4(2.0, 0.0, 0.0, 1.0);
  return;
}
`;
  }

  getCrossSectionFadeFactor() {
    if (this.targetIsSliceView) {
      return `(clamp(1.0 - 2.0 * abs(0.5 - gl_FragCoord.z), 0.0, 1.0))`;
    } else {
      return `(1.0)`;
    }
  }

  enable(
      shaderGetter: AnnotationShaderGetter, context: AnnotationRenderContext,
      callback: (shader: ShaderProgram) => void) {
    const {shader, parameters} = shaderGetter(context.renderContext.emitter);
    if (shader === null) return;
    shader.bind();
    const {gl} = this;
    const {renderContext} = context;
    const {annotationLayer} = context;
    setControlsInShader(gl, shader, this.shaderControlState, parameters.parseResult.controls);
    gl.uniform3fv(shader.uniform('uSubspaceMatrix'), context.subspaceMatrix);
    gl.uniform1fv(shader.uniform('uModelClipBounds'), context.modelClipBounds);
    gl.uniformMatrix4fv(
        shader.uniform('uModelViewProjection'), false, context.modelViewProjectionMatrix);
    if (renderContext.emitPickID) {
      gl.uniform1ui(shader.uniform('uPickID'), context.basePickId);
    }
    if (renderContext.emitColor) {
      const color = annotationLayer.state.displayState.color.value;
      gl.uniform3f(shader.uniform('uColor'), color[0], color[1], color[2]);
      gl.uniform1ui(shader.uniform('uSelectedIndex'), context.selectedIndex);
    }

    const binder = shader.vertexShaderInputBinders['properties'];
    binder.enable(1);
    gl.bindBuffer(WebGL2RenderingContext.ARRAY_BUFFER, context.buffer.buffer);
    binder.bind(/*stride=*/ context.count, context.bufferOffset);
    callback(shader);
    binder.disable();
  }

  abstract draw(context: AnnotationRenderContext): void;

  private histogramShaders = new Map<AnnotationPropertySpec['type'], ShaderProgram>();

  private getHistogramShader(propertyType: AnnotationPropertySpec['type']): ShaderProgram {
    const {histogramShaders} = this;
    let shader = histogramShaders.get(propertyType);
    if (shader === undefined) {
      const {gl} = this;
      shader = gl.memoize.get(
          JSON.stringify({t: 'propertyHistogramGenerator', propertyType}), () => {
            const builder = new ShaderBuilder(gl);
            this.defineHistogramShader(builder, propertyType);
            return builder.build();
          });
      histogramShaders.set(propertyType, shader);
    }
    return shader;
  }

  private defineHistogramShader(builder: ShaderBuilder, propertyType: AnnotationPropertySpec['type']) {
    const handler = annotationPropertyTypeRenderHandlers[propertyType];
    // TODO(jbms): If rank-dependent properties are added, this will need to change to support
    // histograms.
    handler.defineShader(builder, 'histogram', /*rank=*/ 0);
    builder.addOutputBuffer('vec4', 'out_histogram', 0);
    const invlerpName = `invlerpForHistogram`;
    const dataType = propertyTypeDataType[propertyType]!;
    builder.addVertexCode(
        defineInvlerpShaderFunction(builder, invlerpName, dataType, /*clamp=*/ false));
    builder.setVertexMain(`
float x = invlerpForHistogram(prop_histogram());
if (x < 0.0) x = 0.0;
else if (x > 1.0) x = 1.0;
else x = (1.0 + x * 253.0) / 255.0;
gl_Position = vec4(2.0 * (x * 255.0 + 0.5) / 256.0 - 1.0, 0.0, 0.0, 1.0);
gl_PointSize = 1.0;
`);
    builder.setFragmentMain(`out_histogram = vec4(1.0, 1.0, 1.0, 1.0);`);
  }

  computeHistograms(context: AnnotationRenderContext, frameNumber: number) {
    const {histogramSpecifications} = this.shaderControlState;
    const histogramProperties = histogramSpecifications.properties.value;
    const numHistograms = histogramProperties.length;
    const {properties} = this;
    const numProperties = properties.length;
    const {propertyOffsets} = this;
    const {propertyGroupBytes, propertyGroupCumulativeBytes} = this;
    const {gl} = this;
    gl.enable(WebGL2RenderingContext.BLEND);
    gl.disable(WebGL2RenderingContext.SCISSOR_TEST);
    gl.disable(WebGL2RenderingContext.DEPTH_TEST);
    gl.blendFunc(WebGL2RenderingContext.ONE, WebGL2RenderingContext.ONE);
    const outputFramebuffers = histogramSpecifications.getFramebuffers(gl);
    const oldFrameNumber = histogramSpecifications.frameNumber;
    histogramSpecifications.frameNumber = frameNumber;
    gl.bindBuffer(WebGL2RenderingContext.ARRAY_BUFFER, context.buffer.buffer);
    for (let histogramIndex = 0; histogramIndex < numHistograms; ++histogramIndex) {
      const propertyIdentifier = histogramProperties[histogramIndex];
      for (let propertyIndex = 0; propertyIndex < numProperties; ++propertyIndex) {
        const property = properties[propertyIndex];
        if (property.identifier !== propertyIdentifier) continue;
        const propertyType = property.type;
        const dataType = propertyTypeDataType[propertyType]!;
        const shader = this.getHistogramShader(propertyType);
        shader.bind();
        const binder = shader.vertexShaderInputBinders['prop_histogram'];
        binder.enable(0);
        const {group, offset: propertyOffset} = propertyOffsets[propertyIndex];
        enableLerpShaderFunction(
          shader, `invlerpForHistogram`, dataType, histogramSpecifications.bounds.value[histogramIndex]);
        binder.bind(
            /*stride=*/ propertyGroupBytes[group],
            /*offset=*/ context.bufferOffset + propertyOffset +
                propertyGroupCumulativeBytes[group] * context.count);
        outputFramebuffers[histogramIndex].bind(256, 1);
        if (frameNumber !== oldFrameNumber) {
          gl.clearColor(0, 0, 0, 0);
          gl.clear(WebGL2RenderingContext.COLOR_BUFFER_BIT);
        }
        gl.drawArrays(WebGL2RenderingContext.POINTS, 0, context.count);
        if (DEBUG_HISTOGRAMS) {
          const tempBuffer = new Float32Array(256 * 4);
          gl.readPixels(
              0, 0, 256, 1, WebGL2RenderingContext.RGBA, WebGL2RenderingContext.FLOAT, tempBuffer);
          const tempBuffer2 = new Float32Array(256);
          for (let j = 0; j < 256; ++j) {
            tempBuffer2[j] = tempBuffer[j * 4];
          }
          console.log('histogram', tempBuffer2.join(' '));
        }
        binder.disable();
        break;
      }
    }
    gl.disable(WebGL2RenderingContext.BLEND);
  }
}

interface AnnotationRenderHelperConstructor {
  new(gl: GL, annotationType: AnnotationType, rank: number,
      properties: readonly Readonly<AnnotationPropertySpec>[],
      shaderControlState: ShaderControlState,
      fallbackShaderParameters: WatchableValueInterface<ShaderControlsBuilderState>,
      shaderError: WatchableShaderError): AnnotationRenderHelper;
}

interface AnnotationTypeRenderHandler<T extends Annotation> {
  defineShaderNoOpSetters: (builder: ShaderBuilder) => void;
  perspectiveViewRenderHelper: AnnotationRenderHelperConstructor;
  sliceViewRenderHelper: AnnotationRenderHelperConstructor;
  pickIdsPerInstance: number;
  getRepresentativePoint(out: Float32Array, annotation: T, partIndex: number): void;
  updateViaRepresentativePoint(oldAnnotation: T, position: Float32Array, partIndex: number): T;
  snapPosition(position: Float32Array, data: ArrayBuffer, offset: number, partIndex: number): void;
}

const annotationTypeRenderHandlers =
    new Map<AnnotationType, AnnotationTypeRenderHandler<Annotation>>();

export function registerAnnotationTypeRenderHandler<T extends Annotation>(
    type: AnnotationType, handler: AnnotationTypeRenderHandler<T>) {
  annotationTypeRenderHandlers.set(type, handler);
}

export function getAnnotationTypeRenderHandler(type: AnnotationType):
    AnnotationTypeRenderHandler<Annotation> {
  return annotationTypeRenderHandlers.get(type)!;
}
