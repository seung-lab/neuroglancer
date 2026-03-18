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
import { mat4 } from "#src/util/geom.js";
import { projectPointToLineSegment } from "#src/util/geom.js";
import {
  defineCircleShader,
  drawCircles,
  initializeCircleShader,
  VERTICES_PER_CIRCLE,
} from "#src/webgl/circles.js";
import { CylinderRenderHelper } from "#src/webgl/cylinders.js";
import {
  defineLineShader,
  drawLines,
  initializeLineShader,
} from "#src/webgl/lines.js";
import type { ShaderBuilder, ShaderProgram } from "#src/webgl/shader.js";
import { defineVectorArrayVertexShaderInput } from "#src/webgl/shader_lib.js";
import { SphereRenderHelper } from "#src/webgl/spheres.js";

const FULL_OBJECT_PICK_OFFSET = 0;
const ENDPOINTS_PICK_OFFSET = FULL_OBJECT_PICK_OFFSET + 1;
const PICK_IDS_PER_INSTANCE = ENDPOINTS_PICK_OFFSET + 2;

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

vec3 canonicalNormalToDisplay(vec3 canonicalNormal) {
  return canonicalNormal * uCanonicalVoxelFactors;
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

  private cylinderShaderGetter = this.getDependentShader(
    "annotation/capsule/projection/cylinder",
    (builder: ShaderBuilder) => {
      const { rank } = this;
      this.defineShader(builder);
      this.cylinderRenderHelper.defineShader(builder);
      builder.addUniform("highp vec4", "uLightDirection");
      builder.addUniform("highp mat4", "uNormalTransform");
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
  float axisLength = length(axis);
  if (axisLength < 1e-6) {
    gl_Position = vec4(2.0, 0.0, 0.0, 1.0);
    return;
  }
  vec3 yAxis = axis / axisLength;
  vec3 tangent = abs(yAxis.y) < 0.999 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 xAxis = normalize(cross(tangent, yAxis));
  vec3 zAxis = cross(yAxis, xAxis);
  vec3 center = 0.5 * (pointA + pointB);
  vec3 canonicalVertexPosition = center +
      xAxis * (aCylinderVertex.x * radius) +
      yAxis * (aCylinderVertex.y * 0.5 * axisLength) +
      zAxis * (aCylinderVertex.z * radius);
  vec3 displayVertexPosition = fromCanonicalSubspace(canonicalVertexPosition);
  gl_Position = uModelViewProjection * vec4(displayVertexPosition, 1.0);
  vec3 canonicalNormal = normalize(xAxis * aCylinderVertex.x + zAxis * aCylinderVertex.z);
  vec3 displayNormal = normalize((uNormalTransform * vec4(
      canonicalNormalToDisplay(canonicalNormal), 0.0)).xyz);
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
      builder.addUniform("highp mat4", "uNormalTransform");
      builder.addUniform("highp vec3", "uCanonicalVoxelFactors");
      builder.addVarying("highp float", "vClipCoefficient");
      builder.addVertexCode(`
void setCapsuleFillColor(vec4 color) {
  vColor = color;
}

    void emitCanonicalCapsuleSphere(vec3 center, float radius, vec4 lightDirection) {
      vec3 canonicalVertexPosition = center + aSphereVertex * radius;
      vec3 displayVertexPosition = fromCanonicalSubspace(canonicalVertexPosition);
      gl_Position = uModelViewProjection * vec4(displayVertexPosition, 1.0);
      vec3 displayNormal = normalize((uNormalTransform * vec4(
      canonicalNormalToDisplay(aSphereVertex), 0.0)).xyz);
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
    shader.gl.uniformMatrix4fv(
      shader.uniform("uNormalTransform"),
      /*transpose=*/ false,
      mat4.transpose(mat4.create(), context.renderSubspaceInvModelMatrix),
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
      defineLineShader(builder);
      builder.addUniform("highp vec3", "uCanonicalVoxelFactors");
      builder.addVarying("highp float", "vClipCoefficient");
      builder.addVertexCode(`
void setCapsuleFillColor(vec4 color) {
  vColor = color;
}

float getCapsuleRadiusInPixels(vec3 subspacePoint, float radius) {
  vec3 displayRadius = getDisplayRadiusVector(radius);
  vec4 centerClip = uModelViewProjection * vec4(subspacePoint, 1.0);
  vec2 centerDevice = centerClip.xy / centerClip.w;
  vec4 xOffsetClip = uModelViewProjection * vec4(subspacePoint + vec3(displayRadius.x, 0.0, 0.0), 1.0);
  vec4 yOffsetClip = uModelViewProjection * vec4(subspacePoint + vec3(0.0, displayRadius.y, 0.0), 1.0);
  vec2 xDevice = xOffsetClip.xy / xOffsetClip.w;
  vec2 yDevice = yOffsetClip.xy / yOffsetClip.w;
  float xRadius = length((xDevice - centerDevice) / uLineParams.xy * 0.5);
  float yRadius = length((yDevice - centerDevice) / uLineParams.xy * 0.5);
  return max(xRadius, yRadius);
}
`);
      builder.setVertexMain(`
float modelPositionA[${rank}] = getVertexPosition0();
float modelPositionB[${rank}] = getVertexPosition1();
float radius = getCapsuleRadius();
vec3 subspacePointA = projectModelVectorToSubspace(modelPositionA);
vec3 subspacePointB = projectModelVectorToSubspace(modelPositionB);
vClipCoefficient = getMaxSubspaceClipCoefficient(modelPositionA, modelPositionB);
vColor = vec4(0.0, 0.0, 0.0, 0.0);
${this.invokeUserMain}
emitLine(
  uModelViewProjection * vec4(subspacePointA, 1.0),
  uModelViewProjection * vec4(subspacePointB, 1.0),
  2.0 * getCapsuleRadiusInPixels(0.5 * (subspacePointA + subspacePointB), radius));
${this.setPartIndex(builder)};
`);
      builder.setFragmentMain(`
emitAnnotation(vec4(vColor.rgb, vColor.a * getLineAlpha() * vClipCoefficient));
`);
    },
  );

  private endpointShaderGetter = this.getDependentShader(
    "annotation/capsule/crossSection/endpoint",
    (builder: ShaderBuilder) => {
      const { rank } = this;
      this.defineShader(builder);
      defineCircleShader(builder, this.targetIsSliceView);
      builder.addUniform("highp vec3", "uCanonicalVoxelFactors");
      builder.addVarying("highp float", "vClipCoefficient");
      builder.addVertexCode(`
int getEndpointIndex() {
  return gl_VertexID / ${VERTICES_PER_CIRCLE};
}

void setCapsuleFillColor(vec4 color) {
  vColor = color;
}

float getCapsuleRadiusInPixels(vec3 subspacePoint, float radius) {
  vec3 displayRadius = getDisplayRadiusVector(radius);
  vec4 centerClip = uModelViewProjection * vec4(subspacePoint, 1.0);
  vec2 centerDevice = centerClip.xy / centerClip.w;
  vec4 xOffsetClip = uModelViewProjection * vec4(subspacePoint + vec3(displayRadius.x, 0.0, 0.0), 1.0);
  vec4 yOffsetClip = uModelViewProjection * vec4(subspacePoint + vec3(0.0, displayRadius.y, 0.0), 1.0);
  vec2 xDevice = xOffsetClip.xy / xOffsetClip.w;
  vec2 yDevice = yOffsetClip.xy / yOffsetClip.w;
  float xRadius = length((xDevice - centerDevice) / uCircleParams.xy * 0.5);
  float yRadius = length((yDevice - centerDevice) / uCircleParams.xy * 0.5);
  return max(xRadius, yRadius);
}
`);
      builder.setVertexMain(`
float modelPosition[${rank}] = getVertexPosition0();
float modelPositionB[${rank}] = getVertexPosition1();
for (int i = 0; i < ${rank}; ++i) {
  modelPosition[i] = mix(modelPosition[i], modelPositionB[i], float(getEndpointIndex()));
}
float radius = getCapsuleRadius();
vec3 subspacePoint = projectModelVectorToSubspace(modelPosition);
vClipCoefficient = getSubspaceClipCoefficient(modelPosition);
vColor = vec4(0.0, 0.0, 0.0, 0.0);
${this.invokeUserMain}
emitCircle(
  uModelViewProjection * vec4(subspacePoint, 1.0),
  2.0 * getCapsuleRadiusInPixels(subspacePoint, radius),
  0.0);
${this.setPartIndex(builder, "uint(getEndpointIndex()) + 1u")};
`);
      builder.setFragmentMain(`
vec4 color = getCircleColor(vColor, vColor);
color.a *= vClipCoefficient;
emitAnnotation(color);
`);
    },
  );

  draw(
    context: AnnotationRenderContext & {
      renderContext: SliceViewPanelRenderContext;
    },
  ) {
    this.enableCapsule(
      this.bodyShaderGetter,
      context,
      /*positionDivisor=*/ 1,
      /*radiusDivisor=*/ 1,
      (shader) => {
        initializeLineShader(
          shader,
          context.renderContext.sliceView.projectionParameters.value,
          /*featherWidthInPixels=*/ 1.0,
        );
        drawLines(shader.gl, 1, context.count);
      },
    );
    this.enableCapsule(
      this.endpointShaderGetter,
      context,
      /*positionDivisor=*/ 1,
      /*radiusDivisor=*/ 1,
      (shader) => {
        initializeCircleShader(
          shader,
          context.renderContext.sliceView.projectionParameters.value,
          { featherWidthInPixels: 0.5 },
        );
        drawCircles(shader.gl, 2, context.count);
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