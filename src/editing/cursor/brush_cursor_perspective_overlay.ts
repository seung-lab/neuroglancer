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
 * @file Brush cursor overlay for the 3D perspective panel.
 *
 * Draws a translucent wireframe centered on the brush cursor, shaped to the
 * current brush footprint. Used to give the user spatial feedback in the 3D
 * view while a brush-like tool is active.
 *
 * The painted brush is a circle in TARGET voxel-index space stamped on a
 * single Z plane, so its footprint is a flat ellipse on an anisotropic grid
 * (TM-300). We render a unit-sphere wireframe (three great-circle line loops at
 * 32 segments each — 96 line segments total) whose model matrix is built from
 * the two painted-plane semi-axis vectors plus a small out-of-plane thickness.
 * That flattens the sphere into a THIN ELLIPSOID DISK lying in the painted
 * plane — 1:1 with the painted z-slice, yet still legible edge-on in 3D.
 *
 * Pattern reference: line-drawing approach mirrors
 * `src/axes_lines.ts:AxesLineHelper.draw` (uses `trivialUniformColorShader`,
 * `gl.LINES`, with a `uProjectionMatrix` uniform composed of
 * `viewProjectionMat * modelMatrix`).
 */

import { computeBrushFootprintAxes } from "#src/editing/cursor/brush_cursor_footprint.js";
import type { BrushCursorState } from "#src/editing/cursor/brush_cursor_state.js";
import type { PerspectiveViewRenderContext } from "#src/perspective_view/render_layer.js";
import { PerspectiveViewRenderLayer } from "#src/perspective_view/render_layer.js";
import { mat4, vec3 } from "#src/util/geom.js";
import { GLBuffer } from "#src/webgl/buffer.js";
import type { GL } from "#src/webgl/context.js";
import type { ShaderProgram } from "#src/webgl/shader.js";
import { ShaderBuilder } from "#src/webgl/shader.js";

const SEGMENTS_PER_RING = 32;
const NUM_RINGS = 3;
// Each ring has SEGMENTS_PER_RING line segments = SEGMENTS_PER_RING * 2 vertices.
const VERTICES_PER_RING = SEGMENTS_PER_RING * 2;
const TOTAL_VERTICES = NUM_RINGS * VERTICES_PER_RING;

// Unit-sphere wireframe vertices, laid out as `gl.LINES` (pairs of endpoints).
// Three great circles in the XY, XZ, and YZ planes.
function buildSphereWireframeVertices(): Float32Array {
  const verts = new Float32Array(TOTAL_VERTICES * 3);
  let off = 0;
  for (let ring = 0; ring < NUM_RINGS; ++ring) {
    for (let i = 0; i < SEGMENTS_PER_RING; ++i) {
      const a0 = (i / SEGMENTS_PER_RING) * 2 * Math.PI;
      const a1 = ((i + 1) / SEGMENTS_PER_RING) * 2 * Math.PI;
      const c0 = Math.cos(a0);
      const s0 = Math.sin(a0);
      const c1 = Math.cos(a1);
      const s1 = Math.sin(a1);
      // ring 0 → XY plane, ring 1 → XZ plane, ring 2 → YZ plane.
      if (ring === 0) {
        verts[off++] = c0;
        verts[off++] = s0;
        verts[off++] = 0;
        verts[off++] = c1;
        verts[off++] = s1;
        verts[off++] = 0;
      } else if (ring === 1) {
        verts[off++] = c0;
        verts[off++] = 0;
        verts[off++] = s0;
        verts[off++] = c1;
        verts[off++] = 0;
        verts[off++] = s1;
      } else {
        verts[off++] = 0;
        verts[off++] = c0;
        verts[off++] = s0;
        verts[off++] = 0;
        verts[off++] = c1;
        verts[off++] = s1;
      }
    }
  }
  return verts;
}

// Brush and eraser share one neutral cursor color (matches the slice overlay).
const CURSOR_COLOR = new Float32Array([1.0, 1.0, 1.0, 0.6]);

// Out-of-plane thickness of the disk as a fraction of the smaller in-plane
// semi-axis. Small enough to read as a flat disk (the paint is one voxel thick)
// but non-zero so the disk stays visible edge-on in the 3D view.
const DISK_THICKNESS_FRACTION = 0.08;

const tempMat = mat4.create();
const tempNormal = vec3.create();

/**
 * Perspective-view render layer that draws a thin-ellipsoid-disk cursor
 * centered at the brush position, shaped to the painted footprint via the two
 * painted-plane semi-axis vectors (`computeBrushFootprintAxes`) so anisotropic
 * resolutions render as the correct ellipse rather than a single-scalar sphere.
 */
export class BrushCursorPerspectiveOverlay extends PerspectiveViewRenderLayer {
  private vertexBuffer: GLBuffer;
  private shader;

  constructor(
    public gl: GL,
    public state: BrushCursorState,
  ) {
    super();
    this.shader = this.registerDisposer(buildSphereShader(gl));
    this.vertexBuffer = this.registerDisposer(
      GLBuffer.fromData(
        gl,
        buildSphereWireframeVertices(),
        gl.ARRAY_BUFFER,
        gl.STATIC_DRAW,
      ),
    );
    // Trigger a redraw whenever any relevant cursor state changes.
    this.registerDisposer(
      state.visible.changed.add(this.redrawNeeded.dispatch),
    );
    this.registerDisposer(
      state.radiusVoxels.changed.add(this.redrawNeeded.dispatch),
    );
    this.registerDisposer(
      state.worldCenter.changed.add(this.redrawNeeded.dispatch),
    );
    this.registerDisposer(
      state.toolKind.changed.add(this.redrawNeeded.dispatch),
    );
  }

  get isTransparent() {
    return true;
  }

  draw(renderContext: PerspectiveViewRenderContext): void {
    if (!renderContext.emitColor) return;
    const { state, gl, vertexBuffer, shader } = this;
    if (state.visible.value !== true) return;
    const worldCenter = state.worldCenter.value;
    if (worldCenter === undefined) return;
    const radiusVoxels = state.radiusVoxels.value;
    if (!Number.isFinite(radiusVoxels) || radiusVoxels <= 0) return;

    // Two painted-plane semi-axis vectors in display coords (the same frame as
    // `worldCenter` / `viewProjectionMat`). On an anisotropic grid these differ
    // in length → the disk is an ellipse.
    const { offsetX, offsetY } = computeBrushFootprintAxes(
      radiusVoxels,
      state.targetResolution.value,
      renderContext.projectionParameters.displayDimensionRenderInfo,
    );
    const lenX = vec3.length(offsetX);
    const lenY = vec3.length(offsetY);
    if (lenX <= 0 && lenY <= 0) return;

    // Out-of-plane basis: a small thickness along the normal of the painted
    // plane (cross of the two in-plane axes). Degenerate (one axis edge-on) →
    // zero thickness, leaving a flat ring, which is still correct.
    vec3.cross(tempNormal, offsetX, offsetY);
    const normalLen = vec3.length(tempNormal);
    if (normalLen > 0) {
      const thickness = DISK_THICKNESS_FRACTION * Math.min(lenX, lenY);
      vec3.scale(tempNormal, tempNormal, thickness / normalLen);
    }

    // Model matrix columns = the three world-space basis vectors of the disk,
    // translated to the cursor position. Maps the unit-sphere wireframe onto
    // the thin ellipsoid disk.
    const model = mat4.identity(tempMat);
    model[0] = offsetX[0];
    model[1] = offsetX[1];
    model[2] = offsetX[2];
    model[4] = offsetY[0];
    model[5] = offsetY[1];
    model[6] = offsetY[2];
    model[8] = tempNormal[0];
    model[9] = tempNormal[1];
    model[10] = tempNormal[2];
    model[12] = worldCenter[0];
    model[13] = worldCenter[1];
    model[14] = worldCenter[2];

    const { viewProjectionMat } = renderContext.projectionParameters;
    const mvp = mat4.multiply(mat4.create(), viewProjectionMat, model);

    const color = CURSOR_COLOR;

    shader.bind();
    gl.uniformMatrix4fv(shader.uniform("uProjectionMatrix"), false, mvp);
    gl.uniform4fv(shader.uniform("uColor"), color);

    const aVertexPosition = shader.attribute("aVertexPosition");
    vertexBuffer.bindToVertexAttrib(aVertexPosition, 3);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    // `lineWidth(2)` is honored only at width 1 on most WebGL2 drivers, but
    // it's harmless to request and matches the design spec.
    gl.lineWidth(2);
    // Draw without depth-write so the cursor is visible through geometry
    // without occluding picks. Keep depth-test so it's hidden behind near
    // surfaces (looks more grounded in 3D than a flat overlay).
    gl.depthMask(false);
    gl.drawArrays(gl.LINES, 0, TOTAL_VERTICES);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.lineWidth(1);

    gl.disableVertexAttribArray(aVertexPosition);
  }
}

/**
 * Inline sphere shader. Perspective panel binds three color attachments
 * (color / z / pickId) via `perspectivePanelEmit`; writing to only one
 * triggers `GL_INVALID_OPERATION`. The cursor is non-pickable and
 * non-depth-contributing — emit a far-plane depth and zero pickId.
 */
function buildSphereShader(gl: GL): ShaderProgram {
  const builder = new ShaderBuilder(gl);
  builder.addAttribute("vec3", "aVertexPosition");
  builder.addUniform("mat4", "uProjectionMatrix");
  builder.addUniform("vec4", "uColor");
  builder.addOutputBuffer("vec4", "out_color", 0);
  builder.addOutputBuffer("highp vec4", "out_z", 1);
  builder.addOutputBuffer("highp vec4", "out_pickId", 2);
  builder.setVertexMain(
    "gl_Position = uProjectionMatrix * vec4(aVertexPosition, 1.0);",
  );
  builder.setFragmentMain(`
out_color = uColor;
out_z = vec4(0.0, 0.0, 0.0, 1.0);
out_pickId = vec4(0.0, 0.0, 0.0, 1.0);
`);
  return builder.build();
}

// Expected host wiring (see step 13 / wave-3 integration pass):
//   const overlay = new BrushCursorPerspectiveOverlay(viewer.display.gl, brushCursorState);
//   viewer.layerManager.addRenderLayer(overlay); // or attach as a perspective overlay
