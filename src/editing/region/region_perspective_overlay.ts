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
 * @file Perspective-view overlay for the active edit-session region (TM-302).
 *
 * Draws the region box as a 12-edge wireframe, driven directly by the
 * session's active-region watchable (display coords) — NOT by the source bbox
 * annotation, so the visual survives hiding/deleting the annotation layer
 * mid-session. Wireframe only; no fill (a fill would fight the data and the
 * shader hard-clip).
 *
 * The edges are rendered as thick anti-aliased line quads (the same
 * `emitLine` helper annotation lines use) rather than 1px GL hairlines, and
 * wider than the annotation default — the source bbox annotation occupies
 * the exact same coordinates, and the session region must stay clearly
 * visible even where the two overlap.
 *
 * The layer is transparent, so it draws inside the perspective panel's OIT
 * (order-independent transparency) pass. The fragment shader is built
 * against the pass's emitter (`renderContext.emitter`, via
 * `parameterizedEmitterDependentShaderGetter`) so it writes the OIT
 * accumulate/revealage outputs through `emit()` — and the draw call must NOT
 * touch any blend state: the pass configures blending once for all
 * transparent layers, and the final transparency composite relies on that
 * state still being intact afterwards. (Disabling blend here is what blacked
 * out the whole 3D view: the composite then *replaced* the opaque image —
 * sections, annotations — instead of blending over it.)
 */

import {
  BOX_EDGES,
  buildUnitBoxEdgeVertices,
} from "#src/editing/region/region_geometry.js";
import type { PerspectiveViewRenderContext } from "#src/perspective_view/render_layer.js";
import { PerspectiveViewRenderLayer } from "#src/perspective_view/render_layer.js";
import type { WatchableValue } from "#src/trackable_value.js";
import { constantWatchableValue } from "#src/trackable_value.js";
import type { vec3 } from "#src/util/geom.js";
import type { GL } from "#src/webgl/context.js";
import type { ParameterizedEmitterDependentShaderGetter } from "#src/webgl/dynamic_shader.js";
import { parameterizedEmitterDependentShaderGetter } from "#src/webgl/dynamic_shader.js";
import {
  defineLineShader,
  drawLines,
  initializeLineShader,
  VERTICES_PER_LINE,
} from "#src/webgl/lines.js";
import type { ShaderBuilder } from "#src/webgl/shader.js";

// Cyan wireframe matching the slice overlay's outline; fully opaque so it
// dominates the (coincident) source annotation.
const REGION_WIREFRAME = new Float32Array([0.0, 0.9, 1.0, 1.0]);

// Core line width in pixels (feather adds ~1px per side). Deliberately wider
// than the annotation lines drawn at the same coordinates.
const REGION_LINE_WIDTH = 3.0;
const FEATHER_WIDTH = 1.0;

// Unit-cube edge endpoints (24 × vec3, gl.LINES pair layout), uploaded as a
// uniform array and indexed by edge in the vertex shader.
const EDGE_ENDPOINTS = buildUnitBoxEdgeVertices();

function defineWireframeShader(builder: ShaderBuilder) {
  defineLineShader(builder);
  builder.addUniform("highp vec3", "uEdgeEndpoints", BOX_EDGES * 2);
  builder.addUniform("highp vec3", "uBoxLo");
  builder.addUniform("highp vec3", "uBoxHi");
  builder.addUniform("highp mat4", "uViewProjection");
  builder.addUniform("vec4", "uColor");
  builder.setVertexMain(`
int edgeIndex = gl_VertexID / ${VERTICES_PER_LINE};
vec3 cornerA = uEdgeEndpoints[edgeIndex * 2];
vec3 cornerB = uEdgeEndpoints[edgeIndex * 2 + 1];
emitLine(uViewProjection * vec4(mix(uBoxLo, uBoxHi, cornerA), 1.0),
         uViewProjection * vec4(mix(uBoxLo, uBoxHi, cornerB), 1.0),
         ${REGION_LINE_WIDTH.toFixed(1)});
`);
  // `emit` comes from the pass's emitter (e.g. OIT accumulate/revealage in
  // the transparent pass). The wireframe is non-pickable: pickId 0.
  builder.setFragmentMain(`
emit(vec4(uColor.rgb, uColor.a * getLineAlpha()), 0u);
`);
}

/**
 * Perspective-view render layer that draws the active edit-session region as
 * an axis-aligned wireframe box. Draws nothing when no session region is set.
 */
export class EditRegionPerspectiveOverlay extends PerspectiveViewRenderLayer {
  private shaderGetter: ParameterizedEmitterDependentShaderGetter<null>;

  constructor(
    public gl: GL,
    private region: WatchableValue<{ lo: vec3; hi: vec3 } | undefined>,
  ) {
    super();
    this.shaderGetter = parameterizedEmitterDependentShaderGetter(this, gl, {
      memoizeKey: "editing/region/EditRegionPerspectiveOverlay",
      parameters: constantWatchableValue(null),
      defineShader: (builder: ShaderBuilder) => defineWireframeShader(builder),
    });
    this.registerDisposer(region.changed.add(this.redrawNeeded.dispatch));
  }

  get isTransparent() {
    return true;
  }

  draw(renderContext: PerspectiveViewRenderContext): void {
    if (!renderContext.emitColor) return;
    const box = this.region.value;
    if (box === undefined) return;
    const { gl } = this;
    const { shader } = this.shaderGetter(renderContext.emitter);
    if (shader === null) return;

    shader.bind();
    initializeLineShader(
      shader,
      renderContext.projectionParameters,
      FEATHER_WIDTH,
    );
    gl.uniform3fv(shader.uniform("uEdgeEndpoints"), EDGE_ENDPOINTS);
    gl.uniform3fv(shader.uniform("uBoxLo"), box.lo);
    gl.uniform3fv(shader.uniform("uBoxHi"), box.hi);
    gl.uniformMatrix4fv(
      shader.uniform("uViewProjection"),
      false,
      renderContext.projectionParameters.viewProjectionMat,
    );
    gl.uniform4fv(shader.uniform("uColor"), REGION_WIREFRAME);

    // Leave ALL blend state untouched — the transparent pass configured OIT
    // blending for every layer in the pass and for the final composite.
    //
    // Draw WITHOUT depth test: the region box typically coincides exactly
    // with its source bbox annotation, whose opaque-pass lines already wrote
    // depth at the same positions — with depth test on, our fragments lose
    // that comparison and the wireframe is culled precisely along its own
    // edges. Skipping the test makes the region read as an always-visible
    // session indicator, above annotations and data alike.
    gl.disable(gl.DEPTH_TEST);
    drawLines(gl, BOX_EDGES, 1);
    gl.enable(gl.DEPTH_TEST);
  }
}
