/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * @file Slice-view overlay for the active edit-session region (TM-302).
 *
 * Draws the outline of the region box's cross-section with the slice plane.
 * Driven directly by the session's active-region watchable (display coords),
 * NOT by the source bbox annotation — so the drawn box and the shader-clipped
 * region can never diverge, and hiding/deleting the annotation layer
 * mid-session leaves the visual intact.
 *
 * Slice views can be oblique, so the cross-section is a 3–6 vertex polygon,
 * not always a rectangle. We reuse the core box–plane intersection vertex
 * shader (`defineBoundingBoxCrossSectionShader`) that annotation bounding
 * boxes render with: 6 candidate vertices in perimeter order, connected as
 * 6 lines (i → i+1 mod 6). Unused vertices come back duplicated, and the
 * line shader rasterizes nothing for zero-length segments — including the
 * all-duplicate case when the plane misses the box entirely.
 *
 * The outline is rendered as thick anti-aliased line quads (the same
 * `emitLine` helper annotation lines use) rather than 1px GL hairlines, and
 * wider than the annotation default — the source bbox annotation occupies
 * the exact same coordinates, and the session region must stay clearly
 * visible even where the two overlap.
 */

import { planeIntersectsBox } from "#src/editing/region/region_geometry.js";
import {
  defineBoundingBoxCrossSectionShader,
  setBoundingBoxCrossSectionShaderPlane,
} from "#src/sliceview/bounding_box_shader_helper.js";
import type {
  SliceViewPanelRenderContext,
  SliceViewPanelReadyRenderContext,
} from "#src/sliceview/renderlayer.js";
import { SliceViewPanelRenderLayer } from "#src/sliceview/renderlayer.js";
import type { WatchableValue } from "#src/trackable_value.js";
import { vec3 } from "#src/util/geom.js";
import type { GL } from "#src/webgl/context.js";
import {
  defineLineShader,
  drawLines,
  initializeLineShader,
  VERTICES_PER_LINE,
} from "#src/webgl/lines.js";
import type { ShaderProgram } from "#src/webgl/shader.js";
import { ShaderBuilder } from "#src/webgl/shader.js";

// The cross-section shader emits up to 6 polygon vertices, in perimeter
// order; the outline connects vertex i to i+1 (mod 6).
const CROSS_SECTION_LINES = 6;

// Cyan outline: distinct from the default yellow of annotation bboxes and the
// white brush cursor, so the active edit region isn't confused with a stray
// bbox annotation. Outline only — a fill would fight the data and the shader
// hard-clip. Fully opaque so it dominates the (coincident) source annotation.
const REGION_OUTLINE = new Float32Array([0.0, 0.9, 1.0, 1.0]);

// Core line width in pixels (feather adds ~1px per side). Deliberately wider
// than the 1px-core annotation lines drawn at the same coordinates.
const REGION_LINE_WIDTH = 3.0;
const FEATHER_WIDTH = 1.0;

const tempNormal = vec3.create();
const tempLo = vec3.create();
const tempHi = vec3.create();

/**
 * Slice-view render layer that outlines the active edit-session region's
 * cross-section. Draws nothing when no session region is set or the slice
 * plane lies outside the box.
 */
export class EditRegionSliceOverlay extends SliceViewPanelRenderLayer {
  // Above ordinary layers (annotations included), below the brush cursor.
  override drawOrderPriority = 10;
  private shader: ShaderProgram;

  constructor(
    public gl: GL,
    private region: WatchableValue<{ lo: vec3; hi: vec3 } | undefined>,
  ) {
    super();
    this.shader = this.registerDisposer(buildCrossSectionShader(gl));
    this.registerDisposer(region.changed.add(this.redrawNeeded.dispatch));
  }

  override isReady(_renderContext: SliceViewPanelReadyRenderContext): boolean {
    return true;
  }

  override draw(renderContext: SliceViewPanelRenderContext): void {
    if (!renderContext.emitColor) return;
    const box = this.region.value;
    if (box === undefined) return;
    const { gl, shader } = this;

    // Normalize per component so a malformed region (lo > hi on some axis)
    // still yields a valid box for the intersection shader.
    vec3.min(tempLo, box.lo, box.hi);
    vec3.max(tempHi, box.lo, box.hi);

    // Slice plane in display coords — the same frame the region watchable is
    // expressed in, so no model matrix is needed (this is what
    // `setBoundingBoxCrossSectionShaderViewportPlane` reduces to with
    // identity model matrices; see `src/annotation/bounding_box.ts`).
    const sliceParams = renderContext.sliceView.projectionParameters.value;
    vec3.normalize(tempNormal, sliceParams.viewportNormalInGlobalCoordinates);
    const planeDistance = vec3.dot(sliceParams.centerDataPosition, tempNormal);

    // CPU early-out when the slice is outside the box (the shader would
    // independently degenerate to zero-length segments).
    if (!planeIntersectsBox(tempLo, tempHi, tempNormal, planeDistance)) return;

    shader.bind();
    setBoundingBoxCrossSectionShaderPlane(shader, tempNormal, planeDistance);
    initializeLineShader(
      shader,
      renderContext.projectionParameters,
      FEATHER_WIDTH,
    );
    gl.uniform3fv(shader.uniform("uBoxLo"), tempLo);
    gl.uniform3fv(shader.uniform("uBoxHi"), tempHi);
    gl.uniformMatrix4fv(
      shader.uniform("uViewProjection"),
      false,
      renderContext.projectionParameters.viewProjectionMat,
    );
    gl.uniform4fv(shader.uniform("uColor"), REGION_OUTLINE);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    drawLines(gl, CROSS_SECTION_LINES, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
  }
}

/**
 * Inline cross-section outline shader. Writes BOTH slice-panel attachments
 * (color + pickId) because the panel's main draw loop binds both; writing to
 * only one triggers `GL_INVALID_OPERATION`. The region outline is
 * non-pickable, so we emit a constant zero pickId.
 */
function buildCrossSectionShader(gl: GL): ShaderProgram {
  const builder = new ShaderBuilder(gl);
  defineBoundingBoxCrossSectionShader(builder);
  defineLineShader(builder);
  builder.addUniform("highp vec3", "uBoxLo");
  builder.addUniform("highp vec3", "uBoxHi");
  builder.addUniform("highp mat4", "uViewProjection");
  builder.addUniform("vec4", "uColor");
  builder.addOutputBuffer("vec4", "out_fragColor", 0);
  builder.addOutputBuffer("highp vec4", "out_pickId", 1);
  builder.setVertexMain(`
int lineIndex = gl_VertexID / ${VERTICES_PER_LINE};
int vertexIndex2 = lineIndex == ${CROSS_SECTION_LINES - 1} ? 0 : lineIndex + 1;
vec3 p1 = getBoundingBoxPlaneIntersectionVertexPosition(
    uBoxHi - uBoxLo, uBoxLo, uBoxLo, uBoxHi, lineIndex);
vec3 p2 = getBoundingBoxPlaneIntersectionVertexPosition(
    uBoxHi - uBoxLo, uBoxLo, uBoxLo, uBoxHi, vertexIndex2);
emitLine(uViewProjection * vec4(p1, 1.0),
         uViewProjection * vec4(p2, 1.0),
         ${REGION_LINE_WIDTH.toFixed(1)});
`);
  builder.setFragmentMain(`
out_fragColor = vec4(uColor.rgb, uColor.a * getLineAlpha());
out_pickId = vec4(0.0, 0.0, 0.0, 1.0);
`);
  return builder.build();
}
