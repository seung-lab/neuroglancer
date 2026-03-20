/**
 * @license
 * Copyright 2026 Google Inc.
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

/**
 * @file Support for rendering capsule annotations.
 */

import type { Capsule } from "#src/annotation/index.js";
import { AnnotationType } from "#src/annotation/index.js";
import type {
  AnnotationRenderContext,
  AnnotationShaderGetter,
} from "#src/annotation/type_handler.js";
import {
  AnnotationRenderHelper,
  registerAnnotationTypeRenderHandler,
} from "#src/annotation/type_handler.js";
import type { PerspectiveViewRenderContext } from "#src/perspective_view/render_layer.js";
import type { SliceViewPanelRenderContext } from "#src/sliceview/renderlayer.js";
import {
  mat3,
  mat4,
  normalMatrixFromMat4ToScaledSpace,
  projectPointToLineSegment,
} from "#src/util/geom.js";
import { CylinderRenderHelper } from "#src/webgl/cylinders.js";
import { drawQuads, glsl_getQuadVertexPosition } from "#src/webgl/quad.js";
import type { ShaderBuilder, ShaderProgram } from "#src/webgl/shader.js";
import { defineVectorArrayVertexShaderInput } from "#src/webgl/shader_lib.js";
import { SphereRenderHelper } from "#src/webgl/spheres.js";

const FULL_OBJECT_PICK_OFFSET = 0;
const ENDPOINTS_PICK_OFFSET = FULL_OBJECT_PICK_OFFSET + 1;
const PICK_IDS_PER_INSTANCE = ENDPOINTS_PICK_OFFSET + 2;
const tempMat4 = mat4.create();
const tempMat3 = mat3.create();

function defineNoOpCapsuleSetters(builder: ShaderBuilder) {
  builder.addVertexCode(`
void setCapsuleFillColor(vec4 color) {}
`);
}

abstract class BaseRenderHelper extends AnnotationRenderHelper {
  defineShader(builder: ShaderBuilder) {
    const { rank } = this;
    defineVectorArrayVertexShaderInput(
      builder,
      "float",
      WebGL2RenderingContext.FLOAT,
      /*normalized=*/ false,
      "VertexPosition",
      rank,
      2,
    );
    defineVectorArrayVertexShaderInput(
      builder,
      "float",
      WebGL2RenderingContext.FLOAT,
      /*normalized=*/ false,
      "Radius",
      1,
      2,
    );
    builder.addVertexCode(`
float getCapsuleRadiusA() {
  return getRadius0()[0];
}

float getCapsuleRadiusB() {
  return getRadius1()[0];
}

float getCapsuleRadius(float t) {
  return mix(getCapsuleRadiusA(), getCapsuleRadiusB(), t);
}

vec3 toSubspacePoint(vec3 subspacePoint) {
  return subspacePoint;
}

vec3 getSubspaceRadiusVector(float radius) {
  return vec3(radius);
}
`);
  }

  protected enableCapsule(
    shaderGetter: AnnotationShaderGetter,
    context: AnnotationRenderContext,
    positionDivisor: number,
    radiusDivisor: number,
    callback: (shader: ShaderProgram) => void,
  ) {
    super.enable(shaderGetter, context, (shader) => {
      const positionBinder = shader.vertexShaderInputBinders.VertexPosition;
      const radiusBinder = shader.vertexShaderInputBinders.Radius;
      positionBinder.enable(positionDivisor);
      radiusBinder.enable(radiusDivisor);
      this.gl.bindBuffer(
        WebGL2RenderingContext.ARRAY_BUFFER,
        context.buffer.buffer,
      );
      positionBinder.bind(this.geometryDataStride, context.bufferOffset);
      radiusBinder.bind(
        this.geometryDataStride,
        context.bufferOffset + 2 * this.rank * 4,
      );
      callback(shader);
      radiusBinder.disable();
      positionBinder.disable();
    });
  }
}

class PerspectiveRenderHelper extends BaseRenderHelper {
  private sphereRenderHelper = this.registerDisposer(
    new SphereRenderHelper(this.gl, 10, 10),
  );
  private cylinderRenderHelper = this.registerDisposer(
    new CylinderRenderHelper(this.gl, 24),
  );
  private tempLightVec = new Float32Array(4);

  private cylinderShaderGetter = this.getDependentShader(
    "annotation/capsule/projection/cylinder",
    (builder: ShaderBuilder) => {
      const { rank } = this;
      this.defineShader(builder);
      this.cylinderRenderHelper.defineShader(builder);
      builder.addUniform("highp vec4", "uLightDirection");
      builder.addUniform("highp mat3", "uNormalMatrix");
      builder.addVarying("highp float", "vClipCoefficient");
      builder.addVertexCode(`
void setCapsuleFillColor(vec4 color) {
  vColor = color;
}

void emitSubspaceCapsuleCylinder(
    vec3 pointA,
    vec3 pointB,
  float radiusA,
  float radiusB,
    vec4 lightDirection) {
  vec3 axis = pointB - pointA;
  float axisLength = length(axis);
  if (axisLength < 1e-6) {
    gl_Position = vec4(2.0, 0.0, 0.0, 1.0);
    return;
  }
  vec3 yAxis = axis / axisLength;
  vec3 tangent = abs(yAxis.y) < 0.999 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 xAxis = normalize(cross(tangent, yAxis));
  vec3 zAxis = cross(yAxis, xAxis);
  float t = 0.5 * (aCylinderVertex.y + 1.0);
  float radius = mix(radiusA, radiusB, t);
  vec3 vertexPosition = pointA +
      axis * t +
      xAxis * (aCylinderVertex.x * radius) +
      zAxis * (aCylinderVertex.z * radius);
  gl_Position = uModelViewProjection * vec4(vertexPosition, 1.0);
  float radiusSlope = (radiusB - radiusA) / max(axisLength, 1e-6);
  vec3 objectNormal = normalize(
      xAxis * aCylinderVertex.x +
      zAxis * aCylinderVertex.z -
      yAxis * radiusSlope);
  vec3 displayNormal = normalize(uNormalMatrix * objectNormal);
  vLightingFactor = abs(dot(displayNormal, lightDirection.xyz)) + lightDirection.w;
}
`);
      builder.setVertexMain(`
float modelPositionA[${rank}] = getVertexPosition0();
float modelPositionB[${rank}] = getVertexPosition1();
float radiusA = getCapsuleRadiusA();
float radiusB = getCapsuleRadiusB();
vec3 subspacePointA = projectModelVectorToSubspace(modelPositionA);
vec3 subspacePointB = projectModelVectorToSubspace(modelPositionB);
vec3 objectPointA = toSubspacePoint(subspacePointA);
vec3 objectPointB = toSubspacePoint(subspacePointB);
vClipCoefficient = getMaxSubspaceClipCoefficient(modelPositionA, modelPositionB);
vColor = vec4(0.0, 0.0, 0.0, 0.0);
${this.invokeUserMain}
emitSubspaceCapsuleCylinder(
  objectPointA,
  objectPointB,
  radiusA,
  radiusB,
  uLightDirection);
${this.setPartIndex(builder)};
`);
      builder.setFragmentMain(`
emitAnnotation(vec4(vColor.rgb * vLightingFactor, vColor.a * vClipCoefficient));
`);
    },
  );

  private sphereShaderGetter = this.getDependentShader(
    "annotation/capsule/projection/sphere",
    (builder: ShaderBuilder) => {
      const { rank } = this;
      this.defineShader(builder);
      this.sphereRenderHelper.defineShader(builder);
      builder.addUniform("highp vec4", "uLightDirection");
      builder.addUniform("highp mat3", "uNormalMatrix");
      builder.addVarying("highp float", "vClipCoefficient");
      builder.addVertexCode(`
void setCapsuleFillColor(vec4 color) {
  vColor = color;
}
`);
      builder.setVertexMain(`
float modelPositionA[${rank}] = getVertexPosition0();
float modelPositionB[${rank}] = getVertexPosition1();
highp uint endpointIndex = uint(gl_InstanceID % 2);
float modelPosition[${rank}] = getVertexPosition0();
for (int i = 0; i < ${rank}; ++i) {
  modelPosition[i] = mix(modelPositionA[i], modelPositionB[i], float(endpointIndex));
}
float radius = endpointIndex == 0u ? getCapsuleRadiusA() : getCapsuleRadiusB();
vec3 subspacePoint = projectModelVectorToSubspace(modelPosition);
vec3 canonicalPoint = toSubspacePoint(subspacePoint);
vClipCoefficient = getSubspaceClipCoefficient(modelPosition);
vColor = vec4(0.0, 0.0, 0.0, 0.0);
${this.invokeUserMain}
emitSphere(
  uModelViewProjection,
  uNormalMatrix,
  canonicalPoint,
  getSubspaceRadiusVector(radius),
  uLightDirection);
${this.setPartIndexForInstance(
  builder,
  "uint(gl_InstanceID) / 2u",
  "endpointIndex + 1u",
)};
`);
      builder.setFragmentMain(`
emitAnnotation(vec4(vColor.rgb * vLightingFactor, vColor.a * vClipCoefficient));
`);
    },
  );

  private initializeLighting(
    shader: ShaderProgram,
    context: AnnotationRenderContext & {
      renderContext: PerspectiveViewRenderContext;
    },
  ) {
    const lightVec = this.tempLightVec;
    const { lightDirection, ambientLighting, directionalLighting } =
      context.renderContext;
    lightVec[0] = lightDirection[0] * directionalLighting;
    lightVec[1] = lightDirection[1] * directionalLighting;
    lightVec[2] = lightDirection[2] * directionalLighting;
    lightVec[3] = ambientLighting;
    shader.gl.uniform4fv(shader.uniform("uLightDirection"), lightVec);
    normalMatrixFromMat4ToScaledSpace(
      tempMat3,
      context.renderSubspaceModelMatrix,
      context.renderContext.projectionParameters.displayDimensionRenderInfo
        .canonicalVoxelFactors,
    );
    shader.gl.uniformMatrix3fv(
      shader.uniform("uNormalMatrix"),
      false,
      tempMat3,
    );
  }

  draw(
    context: AnnotationRenderContext & {
      renderContext: PerspectiveViewRenderContext;
    },
  ) {
    this.enableCapsule(
      this.cylinderShaderGetter,
      context,
      /*positionDivisor=*/ 1,
      /*radiusDivisor=*/ 1,
      (shader) => {
        this.initializeLighting(shader, context);
        this.cylinderRenderHelper.draw(shader, context.count);
      },
    );
    this.enableCapsule(
      this.sphereShaderGetter,
      context,
      /*positionDivisor=*/ 2,
      /*radiusDivisor=*/ 2,
      (shader) => {
        this.initializeLighting(shader, context);
        this.sphereRenderHelper.draw(shader, context.count * 2);
      },
    );
  }
}

class SliceViewRenderHelper extends BaseRenderHelper {
  private bodyShaderGetter = this.getDependentShader(
    "annotation/capsule/crossSection/body",
    (builder: ShaderBuilder) => {
      const { rank } = this;
      this.defineShader(builder);
      builder.addVertexCode(glsl_getQuadVertexPosition);
      builder.addUniform("highp mat4", "uViewportToObject");
      builder.addUniform("highp mat4", "uObjectToViewport");
      builder.addUniform("highp mat4", "uViewportToDevice");
      builder.addVarying("highp vec2", "vViewportPosition");
      builder.addVarying("highp float", "vClipCoefficient");
      builder.addVarying("highp float", "vRadiusA", "flat");
      builder.addVarying("highp float", "vRadiusB", "flat");
      builder.addVarying("highp vec3", "vObjectPointA", "flat");
      builder.addVarying("highp vec3", "vObjectPointB", "flat");
      builder.addVertexCode(`
void setCapsuleFillColor(vec4 color) {
  vColor = color;
}

vec3 objectPointToViewport(vec3 objectPoint) {
  return (uObjectToViewport * vec4(objectPoint, 1.0)).xyz;
}

float getCapsuleRadiusInViewport(vec3 objectPoint, float radius) {
  vec3 viewportCenter = objectPointToViewport(objectPoint);
  vec3 viewportX = objectPointToViewport(objectPoint + vec3(radius, 0.0, 0.0));
  vec3 viewportY = objectPointToViewport(objectPoint + vec3(0.0, radius, 0.0));
  vec3 viewportZ = objectPointToViewport(objectPoint + vec3(0.0, 0.0, radius));
  return max(length(viewportX.xy - viewportCenter.xy), max(length(viewportY.xy - viewportCenter.xy), length(viewportZ.xy - viewportCenter.xy)));
}
`);
      builder.addFragmentCode(`
vec3 viewportPointToObject(vec3 viewportPoint) {
  return (uViewportToObject * vec4(viewportPoint, 1.0)).xyz;
}
`);
      builder.setVertexMain(`
float modelPositionA[${rank}] = getVertexPosition0();
float modelPositionB[${rank}] = getVertexPosition1();
float radiusA = getCapsuleRadiusA();
float radiusB = getCapsuleRadiusB();
vec3 subspacePointA = projectModelVectorToSubspace(modelPositionA);
vec3 subspacePointB = projectModelVectorToSubspace(modelPositionB);
vec3 objectPointA = toSubspacePoint(subspacePointA);
vec3 objectPointB = toSubspacePoint(subspacePointB);
vec3 viewportPointA = objectPointToViewport(objectPointA);
vec3 viewportPointB = objectPointToViewport(objectPointB);
float viewportRadius = max(
  getCapsuleRadiusInViewport(objectPointA, radiusA),
  getCapsuleRadiusInViewport(objectPointB, radiusB));
vec2 viewportMin = min(viewportPointA.xy, viewportPointB.xy) - vec2(viewportRadius);
vec2 viewportMax = max(viewportPointA.xy, viewportPointB.xy) + vec2(viewportRadius);
vec2 viewportPosition = getQuadVertexPosition(viewportMin, viewportMax);
vClipCoefficient = getMaxSubspaceClipCoefficient(modelPositionA, modelPositionB);
vRadiusA = radiusA;
vRadiusB = radiusB;
vObjectPointA = objectPointA;
vObjectPointB = objectPointB;
vViewportPosition = viewportPosition;
vColor = vec4(0.0, 0.0, 0.0, 0.0);
${this.invokeUserMain}
gl_Position = uViewportToDevice * vec4(viewportPosition, 0.0, 1.0);
${this.setPartIndex(builder)};
`);
      builder.setFragmentMain(`
vec3 p = viewportPointToObject(vec3(vViewportPosition, 0.0));
vec3 a = vObjectPointA;
vec3 b = vObjectPointB;
vec3 ab = b - a;
float denom = dot(ab, ab);
if (denom <= 1e-6) {
  discard;
}
float t = dot(p - a, ab) / denom;
if (t <= 0.0 || t >= 1.0) {
  discard;
}
vec3 closestPoint = a + t * ab;
float radius = mix(vRadiusA, vRadiusB, t);
float distanceToBody = length(p - closestPoint);
if (distanceToBody > radius) {
  discard;
}
emitAnnotation(vec4(vColor.rgb, vColor.a * vClipCoefficient));
`);
    },
  );

  private endpointShaderGetter = this.getDependentShader(
    "annotation/capsule/crossSection/endpoint",
    (builder: ShaderBuilder) => {
      const { rank } = this;
      this.defineShader(builder);
      builder.addVertexCode(glsl_getQuadVertexPosition);
      builder.addUniform("highp mat4", "uViewportToObject");
      builder.addUniform("highp mat4", "uObjectToViewport");
      builder.addUniform("highp mat4", "uViewportToDevice");
      builder.addVarying("highp vec2", "vViewportPosition");
      builder.addVarying("highp float", "vClipCoefficient");
      builder.addVarying("highp float", "vRadius", "flat");
      builder.addVarying("highp vec3", "vObjectPoint", "flat");
      builder.addVertexCode(`
void setCapsuleFillColor(vec4 color) {
  vColor = color;
}

vec3 objectPointToViewport(vec3 objectPoint) {
  return (uObjectToViewport * vec4(objectPoint, 1.0)).xyz;
}

float getCapsuleRadiusInViewport(vec3 objectPoint, float radius) {
  vec3 viewportCenter = objectPointToViewport(objectPoint);
  vec3 viewportX = objectPointToViewport(objectPoint + vec3(radius, 0.0, 0.0));
  vec3 viewportY = objectPointToViewport(objectPoint + vec3(0.0, radius, 0.0));
  vec3 viewportZ = objectPointToViewport(objectPoint + vec3(0.0, 0.0, radius));
  return max(length(viewportX.xy - viewportCenter.xy), max(length(viewportY.xy - viewportCenter.xy), length(viewportZ.xy - viewportCenter.xy)));
}
`);
      builder.addFragmentCode(`
vec3 viewportPointToObject(vec3 viewportPoint) {
  return (uViewportToObject * vec4(viewportPoint, 1.0)).xyz;
}
`);
      builder.setVertexMain(`
highp uint endpointIndex = uint(gl_InstanceID % 2);
float modelPositionA[${rank}] = getVertexPosition0();
float modelPositionB[${rank}] = getVertexPosition1();
float modelPosition[${rank}] = getVertexPosition0();
for (int i = 0; i < ${rank}; ++i) {
  modelPosition[i] = mix(modelPositionA[i], modelPositionB[i], float(endpointIndex));
}
float radius = endpointIndex == 0u ? getCapsuleRadiusA() : getCapsuleRadiusB();
vec3 subspacePoint = projectModelVectorToSubspace(modelPosition);
vec3 objectPoint = toSubspacePoint(subspacePoint);
vec3 viewportPoint = objectPointToViewport(objectPoint);
float viewportRadius = getCapsuleRadiusInViewport(objectPoint, radius);
vec2 viewportPosition = getQuadVertexPosition(
  viewportPoint.xy - vec2(viewportRadius),
  viewportPoint.xy + vec2(viewportRadius));
vObjectPoint = objectPoint;
vViewportPosition = viewportPosition;
vClipCoefficient = getSubspaceClipCoefficient(modelPosition);
vRadius = radius;
vColor = vec4(0.0, 0.0, 0.0, 0.0);
${this.invokeUserMain}
gl_Position = uViewportToDevice * vec4(viewportPosition, 0.0, 1.0);
${this.setPartIndexForInstance(
  builder,
  "uint(gl_InstanceID) / 2u",
  "endpointIndex + 1u",
)};
`);
      builder.setFragmentMain(`
vec3 p = viewportPointToObject(vec3(vViewportPosition, 0.0));
if (distance(p, vObjectPoint) > vRadius) {
  discard;
}
emitAnnotation(vec4(vColor.rgb, vColor.a * vClipCoefficient));
`);
    },
  );

  draw(
    context: AnnotationRenderContext & {
      renderContext: SliceViewPanelRenderContext;
    },
  ) {
    const projectionParameters =
      context.renderContext.sliceView.projectionParameters.value;
    const viewportToObject = mat4.multiply(
      tempMat4,
      context.renderSubspaceInvModelMatrix,
      projectionParameters.invViewMatrix,
    );
    const objectToViewport = mat4.create();
    mat4.invert(objectToViewport, viewportToObject);
    this.enableCapsule(
      this.bodyShaderGetter,
      context,
      /*positionDivisor=*/ 1,
      /*radiusDivisor=*/ 1,
      (shader) => {
        const { gl } = shader;
        gl.uniformMatrix4fv(
          shader.uniform("uViewportToObject"),
          false,
          viewportToObject,
        );
        gl.uniformMatrix4fv(
          shader.uniform("uObjectToViewport"),
          false,
          objectToViewport,
        );
        gl.uniformMatrix4fv(
          shader.uniform("uViewportToDevice"),
          false,
          projectionParameters.projectionMat,
        );
        drawQuads(gl, 1, context.count);
      },
    );
    this.enableCapsule(
      this.endpointShaderGetter,
      context,
      /*positionDivisor=*/ 2,
      /*radiusDivisor=*/ 2,
      (shader) => {
        const { gl } = shader;
        gl.uniformMatrix4fv(
          shader.uniform("uViewportToObject"),
          false,
          viewportToObject,
        );
        gl.uniformMatrix4fv(
          shader.uniform("uObjectToViewport"),
          false,
          objectToViewport,
        );
        gl.uniformMatrix4fv(
          shader.uniform("uViewportToDevice"),
          false,
          projectionParameters.projectionMat,
        );
        drawQuads(gl, 1, context.count * 2);
      },
    );
  }
}

function snapPositionToLine(position: Float32Array, endpoints: Float32Array) {
  const rank = position.length;
  projectPointToLineSegment(
    position,
    endpoints.subarray(0, rank),
    endpoints.subarray(rank, 2 * rank),
    position,
  );
}

function snapPositionToEndpoint(
  position: Float32Array,
  endpoints: Float32Array,
  endpointIndex: number,
) {
  const rank = position.length;
  const startOffset = rank * endpointIndex;
  for (let i = 0; i < rank; ++i) {
    position[i] = endpoints[startOffset + i];
  }
}

function getCapsuleRepresentativePoint(
  out: Float32Array,
  ann: Capsule,
  partIndex: number,
) {
  const { pointA, pointB } = ann;
  if (partIndex === FULL_OBJECT_PICK_OFFSET) {
    for (let i = 0; i < out.length; ++i) {
      out[i] = 0.5 * (pointA[i] + pointB[i]);
    }
    return;
  }
  out.set(partIndex === ENDPOINTS_PICK_OFFSET ? pointA : pointB);
}

registerAnnotationTypeRenderHandler<Capsule>(AnnotationType.CAPSULE, {
  sliceViewRenderHelper: SliceViewRenderHelper,
  perspectiveViewRenderHelper: PerspectiveRenderHelper,
  defineShaderNoOpSetters(builder) {
    defineNoOpCapsuleSetters(builder);
  },
  pickIdsPerInstance: PICK_IDS_PER_INSTANCE,
  snapPosition(position, data, offset, partIndex) {
    const rank = position.length;
    const endpoints = new Float32Array(data, offset, rank * 2);
    if (partIndex === FULL_OBJECT_PICK_OFFSET) {
      snapPositionToLine(position, endpoints);
    } else {
      snapPositionToEndpoint(
        position,
        endpoints,
        partIndex - ENDPOINTS_PICK_OFFSET,
      );
    }
  },
  getRepresentativePoint(out, ann, partIndex) {
    getCapsuleRepresentativePoint(out, ann, partIndex);
  },
  updateViaRepresentativePoint(oldAnnotation, position, partIndex) {
    const baseCapsule = { ...oldAnnotation };
    const rank = position.length;
    switch (partIndex) {
      case FULL_OBJECT_PICK_OFFSET: {
        const { pointA, pointB } = oldAnnotation;
        const representativePoint = new Float32Array(rank);
        getCapsuleRepresentativePoint(
          representativePoint,
          oldAnnotation,
          FULL_OBJECT_PICK_OFFSET,
        );
        const newPointA = new Float32Array(rank);
        const newPointB = new Float32Array(rank);
        for (let i = 0; i < rank; ++i) {
          const delta = position[i] - representativePoint[i];
          newPointA[i] = pointA[i] + delta;
          newPointB[i] = pointB[i] + delta;
        }
        return { ...oldAnnotation, pointA: newPointA, pointB: newPointB };
      }
      case FULL_OBJECT_PICK_OFFSET + 1:
        return { ...oldAnnotation, pointA: new Float32Array(position) };
      case FULL_OBJECT_PICK_OFFSET + 2:
        return { ...oldAnnotation, pointB: new Float32Array(position) };
    }
    return baseCapsule;
  },
});
