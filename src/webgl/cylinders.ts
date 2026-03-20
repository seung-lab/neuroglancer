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
 * @file Facilities for drawing cylinders in WebGL.
 */

import { RefCounted } from "#src/util/disposable.js";
import type { GLBuffer } from "#src/webgl/buffer.js";
import { getMemoizedBuffer } from "#src/webgl/buffer.js";
import type { GL } from "#src/webgl/context.js";
import type { ShaderBuilder, ShaderProgram } from "#src/webgl/shader.js";

export function getCylinderVertexArray(radialSegments: number) {
  const result = new Float32Array((radialSegments + 1) * 2 * 3);
  let offset = 0;
  for (let i = 0; i <= radialSegments; ++i) {
    const theta = (i * 2 * Math.PI) / radialSegments;
    const x = Math.cos(theta);
    const z = Math.sin(theta);
    result[offset++] = x;
    result[offset++] = -1;
    result[offset++] = z;
    result[offset++] = x;
    result[offset++] = 1;
    result[offset++] = z;
  }
  return result;
}

export function getCylinderIndexArray(radialSegments: number) {
  const result = new Uint16Array(radialSegments * 6);
  let offset = 0;
  for (let i = 0; i < radialSegments; ++i) {
    const first = i * 2;
    const second = first + 1;
    const nextFirst = first + 2;
    const nextSecond = first + 3;
    result[offset++] = first;
    result[offset++] = second;
    result[offset++] = nextFirst;
    result[offset++] = second;
    result[offset++] = nextSecond;
    result[offset++] = nextFirst;
  }
  return result;
}

export class CylinderRenderHelper extends RefCounted {
  private vertexBuffer: GLBuffer;
  private indexBuffer: GLBuffer;
  private numIndices: number;

  constructor(gl: GL, radialSegments: number) {
    super();
    this.vertexBuffer = this.registerDisposer(
      getMemoizedBuffer(
        gl,
        WebGL2RenderingContext.ARRAY_BUFFER,
        getCylinderVertexArray,
        radialSegments,
      ),
    ).value;
    this.indexBuffer = this.registerDisposer(
      getMemoizedBuffer(
        gl,
        WebGL2RenderingContext.ELEMENT_ARRAY_BUFFER,
        getCylinderIndexArray,
        radialSegments,
      ),
    ).value;
    this.numIndices = radialSegments * 6;
  }

  defineShader(builder: ShaderBuilder) {
    builder.addAttribute("highp vec3", "aCylinderVertex");
    builder.addVarying("highp float", "vLightingFactor");
    builder.addVertexCode(`
void emitCylinder(
    mat4 projectionMatrix,
    mat4 normalTransformMatrix,
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
  vec3 localPosition = vec3(aCylinderVertex.x * radius,
                            aCylinderVertex.y * 0.5 * axisLength,
                            aCylinderVertex.z * radius);
  vec3 vertexPosition = center +
      xAxis * localPosition.x +
      yAxis * localPosition.y +
      zAxis * localPosition.z;
  gl_Position = projectionMatrix * vec4(vertexPosition, 1.0);
  vec3 normal = normalize((normalTransformMatrix * vec4(
      xAxis * aCylinderVertex.x + zAxis * aCylinderVertex.z,
      0.0)).xyz);
  vLightingFactor = abs(dot(normal, lightDirection.xyz)) + lightDirection.w;
}
`);
  }

  draw(shader: ShaderProgram, numInstances: number) {
    const aCylinderVertex = shader.attribute("aCylinderVertex");
    this.vertexBuffer.bindToVertexAttrib(
      aCylinderVertex,
      /*components=*/ 3,
      /*attributeType=*/ WebGL2RenderingContext.FLOAT,
      /*normalized=*/ false,
    );
    this.indexBuffer.bind();
    shader.gl.drawElementsInstanced(
      WebGL2RenderingContext.TRIANGLES,
      this.numIndices,
      WebGL2RenderingContext.UNSIGNED_SHORT,
      /*offset=*/ 0,
      numInstances,
    );
    shader.gl.disableVertexAttribArray(aCylinderVertex);
  }
}
