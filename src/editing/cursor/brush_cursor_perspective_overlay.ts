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
 * Draws a translucent wireframe sphere centered on the brush cursor, sized
 * to the current brush radius. Used to give the user spatial feedback in
 * the 3D view while a brush-like tool is active.
 *
 * The sphere is rendered as three great-circle line loops (XY, XZ, YZ
 * planes) at 32 segments each — 96 line segments total. This is cheap and
 * reads visually as a sphere from any camera angle.
 *
 * Color depends on the active tool: green for brush, red for eraser.
 *
 * Pattern reference: line-drawing approach mirrors
 * `src/axes_lines.ts:AxesLineHelper.draw` (uses `trivialUniformColorShader`,
 * `gl.LINES`, with a `uProjectionMatrix` uniform composed of
 * `viewProjectionMat * modelMatrix`).
 */

import { Resolution } from "@zettaai/edit-session";

import type { BrushCursorState } from "#src/editing/cursor/brush_cursor_state.js";
import type { PerspectiveViewRenderContext } from "#src/perspective_view/render_layer.js";
import { PerspectiveViewRenderLayer } from "#src/perspective_view/render_layer.js";
import { mat4 } from "#src/util/geom.js";
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

const tempMat = mat4.create();

/**
 * Perspective-view render layer that draws a wireframe-sphere cursor
 * centered at the brush position with a radius matching the current
 * `radiusVoxels` setting (scaled by the largest axis of the target
 * resolution's voxel size to give a unified-looking sphere in nm/world
 * coordinates).
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

    // Visual radius = `size/2` voxels (matches the reference cursor's
    // `(size || 1) / 2 * displayScale` convention; size = 2*radius + 1, so
    // visual radius in voxels = radius + 0.5). Largest axis of voxel size
    // for a unified visualization — anisotropic voxels still get a round
    // sphere.
    const visualRadiusVoxels = radiusVoxels + 0.5;
    const resolution = state.targetResolution.value;
    let voxelScale = 1;
    if (resolution !== undefined) {
      const voxelSize = Resolution.toVoxelSize(resolution);
      voxelScale = Math.max(voxelSize[0], voxelSize[1], voxelSize[2]);
    }
    const radiusWorld = visualRadiusVoxels * voxelScale;
    if (!Number.isFinite(radiusWorld) || radiusWorld <= 0) return;

    // Model matrix: scale unit sphere → world radius, then translate to
    // the cursor's world position.
    const model = mat4.identity(tempMat);
    model[0] = radiusWorld;
    model[5] = radiusWorld;
    model[10] = radiusWorld;
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
