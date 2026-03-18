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
  mat3FromMat4,
  mat4,
  projectPointToLineSegment,
  scaleMat3Output,
  scaleMat3Input,
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
const tempMat3b = mat3.create();

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
    );
    builder.addVertexCode(`
float getCapsuleRadius() {
  return getRadius0()[0];
}

vec3 toCanonicalSubspace(vec3 subspacePoint) {
  return subspacePoint * uCanonicalVoxelFactors;
}

vec3 fromCanonicalSubspace(vec3 canonicalPoint) {
  return canonicalPoint / uCanonicalVoxelFactors;
}

vec3 getDisplayRadiusVector(float radius) {
  return vec3(radius) / uCanonicalVoxelFactors;
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
      shader.gl.uniform3fv(
        shader.uniform("uCanonicalVoxelFactors"),
        context.renderContext.projectionParameters.displayDimensionRenderInfo
          .canonicalVoxelFactors,
      );
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

  private initializeDisplayTransforms(
    shader: ShaderProgram,
    context: AnnotationRenderContext & {
      renderContext: PerspectiveViewRenderContext;
    },
  ) {
    const canonicalVoxelFactors =
      context.renderContext.projectionParameters.displayDimensionRenderInfo
        .canonicalVoxelFactors;
    mat3FromMat4(tempMat3, context.renderSubspaceModelMatrix);
    scaleMat3Input(tempMat3, tempMat3, [
      1 / canonicalVoxelFactors[0],
      1 / canonicalVoxelFactors[1],
      1 / canonicalVoxelFactors[2],
    ]);
    mat3FromMat4(tempMat3b, context.renderSubspaceInvModelMatrix);
    scaleMat3Output(tempMat3b, tempMat3b, canonicalVoxelFactors);
    shader.gl.uniformMatrix3fv(
      shader.uniform("uCanonicalToDisplayMatrix"),
      /*transpose=*/ false,
      tempMat3,
    );
    shader.gl.uniformMatrix3fv(
      shader.uniform("uDisplayToCanonicalMatrix"),
      /*transpose=*/ false,
      tempMat3b,
    );
  }

  private cylinderShaderGetter = this.getDependentShader(
    "annotation/capsule/projection/cylinder",
    (builder: ShaderBuilder) => {
      const { rank } = this;
      this.defineShader(builder);
      this.cylinderRenderHelper.defineShader(builder);
      builder.addUniform("highp vec4", "uLightDirection");
      builder.addUniform("highp mat3", "uCanonicalToDisplayMatrix");
      builder.addUniform("highp mat3", "uDisplayToCanonicalMatrix");
      builder.addUniform("highp vec3", "uCanonicalVoxelFactors");
      builder.addVarying("highp float", "vClipCoefficient");
      builder.addVertexCode(`
void setCapsuleFillColor(vec4 color) {
  vColor = color;
}

void emitCanonicalCapsuleCylinder(
    vec3 pointA,
    vec3 pointB,
    float radius,
    vec4 lightDirection) {
  vec3 axis = pointB - pointA;
  vec3 displayAxis = uCanonicalToDisplayMatrix * axis;
  float axisLength = length(displayAxis);
  if (axisLength < 1e-6) {
    gl_Position = vec4(2.0, 0.0, 0.0, 1.0);
    return;
  }
  vec3 yAxis = displayAxis / axisLength;
  vec3 tangent = abs(yAxis.y) < 0.999 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 xAxis = normalize(cross(tangent, yAxis));
  vec3 zAxis = cross(yAxis, xAxis);
  vec3 xAxisCanonical = uDisplayToCanonicalMatrix * xAxis;
  vec3 zAxisCanonical = uDisplayToCanonicalMatrix * zAxis;
  vec3 center = 0.5 * (pointA + pointB);
  vec3 canonicalVertexPosition = center +
      xAxisCanonical * (aCylinderVertex.x * radius) +
      axis * (aCylinderVertex.y * 0.5) +
      zAxisCanonical * (aCylinderVertex.z * radius);
  vec3 displayVertexPosition = fromCanonicalSubspace(canonicalVertexPosition);
  gl_Position = uModelViewProjection * vec4(displayVertexPosition, 1.0);
  vec3 displayNormal = normalize(xAxis * aCylinderVertex.x + zAxis * aCylinderVertex.z);
  vLightingFactor = abs(dot(displayNormal, lightDirection.xyz)) + lightDirection.w;
}
`);
      builder.setVertexMain(`
float modelPositionA[${rank}] = getVertexPosition0();
float modelPositionB[${rank}] = getVertexPosition1();
float radius = getCapsuleRadius();
vec3 subspacePointA = projectModelVectorToSubspace(modelPositionA);
vec3 subspacePointB = projectModelVectorToSubspace(modelPositionB);
vec3 canonicalPointA = toCanonicalSubspace(subspacePointA);
vec3 canonicalPointB = toCanonicalSubspace(subspacePointB);
vClipCoefficient = getMaxSubspaceClipCoefficient(modelPositionA, modelPositionB);
vColor = vec4(0.0, 0.0, 0.0, 0.0);
${this.invokeUserMain}
emitCanonicalCapsuleCylinder(
  canonicalPointA,
  canonicalPointB,
  radius,
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
      builder.addUniform("highp mat3", "uDisplayToCanonicalMatrix");
      builder.addUniform("highp vec3", "uCanonicalVoxelFactors");
      builder.addVarying("highp float", "vClipCoefficient");
      builder.addVertexCode(`
void setCapsuleFillColor(vec4 color) {
  vColor = color;
}

    void emitCanonicalCapsuleSphere(vec3 center, float radius, vec4 lightDirection) {
      vec3 canonicalVertexPosition = center + (uDisplayToCanonicalMatrix * aSphereVertex) * radius;
      vec3 displayVertexPosition = fromCanonicalSubspace(canonicalVertexPosition);
      gl_Position = uModelViewProjection * vec4(displayVertexPosition, 1.0);
      vec3 displayNormal = normalize(aSphereVertex);
      vLightingFactor = abs(dot(displayNormal, lightDirection.xyz)) + lightDirection.w;
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
float radius = getCapsuleRadius();
vec3 subspacePoint = projectModelVectorToSubspace(modelPosition);
vec3 canonicalPoint = toCanonicalSubspace(subspacePoint);
vClipCoefficient = getSubspaceClipCoefficient(modelPosition);
vColor = vec4(0.0, 0.0, 0.0, 0.0);
${this.invokeUserMain}
emitCanonicalCapsuleSphere(canonicalPoint, radius, uLightDirection);
${this.setPartIndex(builder, "endpointIndex + 1u")};
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
    this.initializeDisplayTransforms(shader, context);
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
      builder.addUniform("highp vec3", "uCanonicalVoxelFactors");
      builder.addVarying("highp vec2", "vViewportPosition");
      builder.addVarying("highp float", "vClipCoefficient");
      builder.addVarying("highp float", "vRadius", "flat");
      builder.addVarying("highp vec3", "vCanonicalPointA", "flat");
      builder.addVarying("highp vec3", "vCanonicalPointB", "flat");
      builder.addVertexCode(`
void setCapsuleFillColor(vec4 color) {
  vColor = color;
}

vec3 canonicalPointToViewport(vec3 canonicalPoint) {
  return (uObjectToViewport * vec4(fromCanonicalSubspace(canonicalPoint), 1.0)).xyz;
}

float getCapsuleRadiusInViewport(vec3 canonicalPoint, float radius) {
  vec3 viewportCenter = canonicalPointToViewport(canonicalPoint);
  vec3 viewportX = canonicalPointToViewport(canonicalPoint + vec3(radius, 0.0, 0.0));
  vec3 viewportY = canonicalPointToViewport(canonicalPoint + vec3(0.0, radius, 0.0));
  return max(length(viewportX.xy - viewportCenter.xy), length(viewportY.xy - viewportCenter.xy));
}
`);
      builder.addFragmentCode(`
vec3 viewportPointToCanonical(vec3 viewportPoint) {
  return (uViewportToObject * vec4(viewportPoint, 1.0)).xyz * uCanonicalVoxelFactors;
}
`);
      builder.setVertexMain(`
float modelPositionA[${rank}] = getVertexPosition0();
float modelPositionB[${rank}] = getVertexPosition1();
float radius = getCapsuleRadius();
vec3 subspacePointA = projectModelVectorToSubspace(modelPositionA);
vec3 subspacePointB = projectModelVectorToSubspace(modelPositionB);
vec3 canonicalPointA = toCanonicalSubspace(subspacePointA);
vec3 canonicalPointB = toCanonicalSubspace(subspacePointB);
vec3 viewportPointA = canonicalPointToViewport(canonicalPointA);
vec3 viewportPointB = canonicalPointToViewport(canonicalPointB);
float viewportRadius = max(
  getCapsuleRadiusInViewport(canonicalPointA, radius),
  max(
    getCapsuleRadiusInViewport(canonicalPointB, radius),
    getCapsuleRadiusInViewport(0.5 * (canonicalPointA + canonicalPointB), radius)));
vec2 viewportMin = min(viewportPointA.xy, viewportPointB.xy) - vec2(viewportRadius);
vec2 viewportMax = max(viewportPointA.xy, viewportPointB.xy) + vec2(viewportRadius);
vec2 viewportPosition = getQuadVertexPosition(viewportMin, viewportMax);
vClipCoefficient = getMaxSubspaceClipCoefficient(modelPositionA, modelPositionB);
vRadius = radius;
vCanonicalPointA = canonicalPointA;
vCanonicalPointB = canonicalPointB;
vViewportPosition = viewportPosition;
vColor = vec4(0.0, 0.0, 0.0, 0.0);
${this.invokeUserMain}
gl_Position = uViewportToDevice * vec4(viewportPosition, 0.0, 1.0);
${this.setPartIndex(builder)};
`);
      builder.setFragmentMain(`
vec3 p = viewportPointToCanonical(vec3(vViewportPosition, 0.0));
vec3 a = vCanonicalPointA;
vec3 b = vCanonicalPointB;
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
float distanceToBody = length(p - closestPoint);
if (distanceToBody > vRadius) {
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
      builder.addUniform("highp vec3", "uCanonicalVoxelFactors");
      builder.addVarying("highp vec2", "vViewportPosition");
      builder.addVarying("highp float", "vClipCoefficient");
      builder.addVarying("highp float", "vRadius", "flat");
      builder.addVarying("highp vec3", "vCanonicalPoint", "flat");
      builder.addVertexCode(`
void setCapsuleFillColor(vec4 color) {
  vColor = color;
}

vec3 canonicalPointToViewport(vec3 canonicalPoint) {
  return (uObjectToViewport * vec4(fromCanonicalSubspace(canonicalPoint), 1.0)).xyz;
}

float getCapsuleRadiusInViewport(vec3 canonicalPoint, float radius) {
  vec3 viewportCenter = canonicalPointToViewport(canonicalPoint);
  vec3 viewportX = canonicalPointToViewport(canonicalPoint + vec3(radius, 0.0, 0.0));
  vec3 viewportY = canonicalPointToViewport(canonicalPoint + vec3(0.0, radius, 0.0));
  return max(length(viewportX.xy - viewportCenter.xy), length(viewportY.xy - viewportCenter.xy));
}
`);
      builder.addFragmentCode(`
vec3 viewportPointToCanonical(vec3 viewportPoint) {
  return (uViewportToObject * vec4(viewportPoint, 1.0)).xyz * uCanonicalVoxelFactors;
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
float radius = getCapsuleRadius();
vec3 subspacePoint = projectModelVectorToSubspace(modelPosition);
vec3 canonicalPoint = toCanonicalSubspace(subspacePoint);
vec3 viewportPoint = canonicalPointToViewport(canonicalPoint);
float viewportRadius = getCapsuleRadiusInViewport(canonicalPoint, radius);
vec2 viewportPosition = getQuadVertexPosition(
  viewportPoint.xy - vec2(viewportRadius),
  viewportPoint.xy + vec2(viewportRadius));
vCanonicalPoint = canonicalPoint;
vViewportPosition = viewportPosition;
vClipCoefficient = getSubspaceClipCoefficient(modelPosition);
vRadius = radius;
vColor = vec4(0.0, 0.0, 0.0, 0.0);
${this.invokeUserMain}
gl_Position = uViewportToDevice * vec4(viewportPosition, 0.0, 1.0);
${this.setPartIndex(builder, "endpointIndex + 1u")};
`);
      builder.setFragmentMain(`
vec3 p = viewportPointToCanonical(vec3(vViewportPosition, 0.0));
if (distance(p, vCanonicalPoint) > vRadius) {
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
    out.set(
      partIndex === FULL_OBJECT_PICK_OFFSET ||
        partIndex === ENDPOINTS_PICK_OFFSET
        ? ann.pointA
        : ann.pointB,
    );
  },
  updateViaRepresentativePoint(oldAnnotation, position, partIndex) {
    const baseCapsule = { ...oldAnnotation };
    const rank = position.length;
    switch (partIndex) {
      case FULL_OBJECT_PICK_OFFSET: {
        const { pointA, pointB } = oldAnnotation;
        const newPointA = new Float32Array(rank);
        const newPointB = new Float32Array(rank);
        for (let i = 0; i < rank; ++i) {
          const pos = (newPointA[i] = position[i]);
          newPointB[i] = pointB[i] + (pos - pointA[i]);
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