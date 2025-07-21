/**
 * @license
 * Copyright 2017 Google Inc.
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
 * @file Facilities for drawing anti-aliased lines in WebGL as quads.
 */

import {
  drawQuads,
  glsl_getQuadVertexPosition,
  VERTICES_PER_QUAD,
} from "#src/webgl/quad.js";
import type { ShaderBuilder, ShaderProgram } from "#src/webgl/shader.js";
import { glsl_clipLineToDepthRange } from "#src/webgl/shader_lib.js";

export const VERTICES_PER_LINE = VERTICES_PER_QUAD;

export function defineLineShader(builder: ShaderBuilder, rounded = false) {
  rounded;
  builder.addVertexCode(glsl_getQuadVertexPosition);
  // x: 1 / viewportWidth
  // y: 1 / viewportHeight
  // z: featherWidth: Line feather width in pixels
  builder.addUniform("highp vec3", "uLineParams");
  builder.addVarying("highp float", "vLineCoord");
  // max(1e-6, featherWidth) / (lineWidth + featherWidth)
  builder.addVarying("highp float", "vLineFeatherFraction");
  builder.addVertexCode(glsl_clipLineToDepthRange);
  builder.addVertexCode(`
vec2 getLineOffset() { return getQuadVertexPosition(vec2(0.0, -1.0), vec2(1.0, 1.0)); }
float getLineEndpointCoefficient() { return getLineOffset().x; }
uint getLineEndpointIndex() { return uint(getLineEndpointCoefficient()); }

void emitLineWithVariableWidthFoo(mat4 projection, mat4 viewModel, vec4 vertexAView, vec4 vertexBView, float lineWidthInPixels) {
  vec4 vertexAClip = projection * vertexAView;
  vec4 vertexBClip = projection * vertexBView;

  if (!clipLineToDepthRange(vertexAClip, vertexBClip)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  vec2 lineDirectionUnnormalized = vertexBView.xy - vertexAView.xy;
  vec2 lineDirection;
  float linePixelLength = length(lineDirectionUnnormalized / uLineParams.xy * 0.5);

  if (linePixelLength < 1e-3) {
    // If the line is too short, we can't draw it.
    // return; any reason not to just return?
    lineDirection = vec2(1.0, 0.0);
    vertexAView.z = vertexBView.z = 0.0;
  } else {
    // Normalize the line direction to a unit vector.
    lineDirection = normalize(lineDirectionUnnormalized);
  }
  vec2 lineNormal = normalize(vec2(lineDirection.y, -lineDirection.x));

  vec2 lineOffset = getLineOffset();
  gl_Position = mix(vertexAView, vertexBView, lineOffset.x);

  float totalLineWidth = lineWidthInPixels;

  float scale = length(viewModel[0].xyz);
  gl_Position.xy += (lineOffset.y * lineNormal * scale * totalLineWidth);
  gl_Position = projection * gl_Position;

  // TODO, add minimum line width in pixels.


  // vLineFeatherFraction = max(1e-6, uLineParams.z) / totalLineWidth;
  // vLineCoord = lineOffset.y;
}

void emitLineWithVariableWidth(mat4 projection, mat4 viewModel, vec3 vertexA, vec3 vertexB, float startingLineWidthInPixels) {
  emitLineWithVariableWidthFoo(projection, viewModel, viewModel * vec4(vertexA, 1.0), viewModel * vec4(vertexB, 1.0),
           startingLineWidthInPixels);
}
`);

  builder.addFragmentCode(`
float getLineAlpha() {
  return clamp((1.0 - abs(vLineCoord)) / vLineFeatherFraction, 0.0, 1.0);
}
`);
}

export function drawLines(
  gl: WebGL2RenderingContext,
  linesPerInstance: number,
  numInstances: number,
) {
  drawQuads(gl, linesPerInstance, numInstances);
}

export function initializeLineShader(
  shader: ShaderProgram,
  projectionParameters: { width: number; height: number },
  featherWidthInPixels: number,
) {
  const { gl } = shader;
  console.log('ulineParams', projectionParameters.width, projectionParameters.height);
  gl.uniform3f(
    shader.uniform("uLineParams"),
    1 / projectionParameters.width,
    1 / projectionParameters.height,
    featherWidthInPixels,
  );
}
