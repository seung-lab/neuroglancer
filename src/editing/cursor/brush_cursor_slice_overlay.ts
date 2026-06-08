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
 * @file Slice-view brush cursor overlay. Renders a translucent filled disk
 * + outline at the brush cursor position, shaped to the painting tool's
 * footprint.
 *
 * The painted brush is a circle in TARGET voxel-index space, so on an
 * anisotropic grid its on-screen footprint is an ELLIPSE (TM-300). Rather than
 * collapse voxel size to one scalar, we derive the two painted-plane basis
 * steps as display-space vectors (`computeBrushFootprintAxes`) and project them
 * through `viewProjectionMat`. The two clip-space differences become the
 * ellipse's semi-axis vectors — exact for any per-layer resolution and for
 * rotated / oblique views.
 *
 * Approach: a 24-sided unit polygon (TRIANGLE_FAN for fill, LINE_LOOP for
 * outline) whose unit-circle `(cos, sin)` offsets are mapped to clip space via
 * `center + cos·axisX + sin·axisY`. Inline shader; binding pattern mirrors
 * `src/axes_lines.ts:AxesLineHelper.draw` (133).
 */

import { computeBrushFootprintAxes } from "#src/editing/cursor/brush_cursor_footprint.js";
import type { BrushCursorState } from "#src/editing/cursor/brush_cursor_state.js";
import type {
  SliceViewPanelRenderContext,
  SliceViewPanelReadyRenderContext,
} from "#src/sliceview/renderlayer.js";
import { SliceViewPanelRenderLayer } from "#src/sliceview/renderlayer.js";
import type { mat4 } from "#src/util/geom.js";
import { vec3 } from "#src/util/geom.js";
import { GLBuffer } from "#src/webgl/buffer.js";
import type { GL } from "#src/webgl/context.js";
import type { ShaderProgram } from "#src/webgl/shader.js";
import { ShaderBuilder } from "#src/webgl/shader.js";

const DISK_SEGMENTS = 24;
// One center vertex + (DISK_SEGMENTS + 1) rim vertices for a triangle-fan.
const FAN_VERTEX_COUNT = DISK_SEGMENTS + 2;
// One loop of DISK_SEGMENTS vertices for the outline.
const LOOP_VERTEX_COUNT = DISK_SEGMENTS;

// Unit-circle (x,y) offsets in [-1, 1]; center is (0, 0).
function buildFanVertices(): Float32Array {
  const out = new Float32Array(FAN_VERTEX_COUNT * 2);
  // Center vertex.
  out[0] = 0;
  out[1] = 0;
  for (let i = 0; i <= DISK_SEGMENTS; ++i) {
    const a = (i / DISK_SEGMENTS) * 2 * Math.PI;
    out[(i + 1) * 2 + 0] = Math.cos(a);
    out[(i + 1) * 2 + 1] = Math.sin(a);
  }
  return out;
}

function buildLoopVertices(): Float32Array {
  const out = new Float32Array(LOOP_VERTEX_COUNT * 2);
  for (let i = 0; i < LOOP_VERTEX_COUNT; ++i) {
    const a = (i / LOOP_VERTEX_COUNT) * 2 * Math.PI;
    out[i * 2 + 0] = Math.cos(a);
    out[i * 2 + 1] = Math.sin(a);
  }
  return out;
}

// Brush and eraser share one neutral cursor: a soft white disk that gently
// brightens the slice (no color cast), with a subtle rim. Identical for both
// tools so the cursor reads the same regardless of brush vs eraser.
const CURSOR_OUTLINE = new Float32Array([1.0, 1.0, 1.0, 0.5]);
const CURSOR_FILL = new Float32Array([1.0, 1.0, 1.0, 0.12]);

const tempCenterClip = vec3.create();
const tempAxisPoint = vec3.create();
const tempWorldOffset = vec3.create();

/**
 * Project `worldCenter + offset` to NDC and return the difference from the
 * already-projected center `(cx, cy)` — i.e. one ellipse semi-axis in clip
 * space. Returns a fresh 2-element array so the two axis calls don't clobber
 * each other's result.
 */
function projectOffsetToNdc(
  worldCenter: vec3,
  offset: vec3,
  cx: number,
  cy: number,
  viewProjectionMat: mat4,
): [number, number] {
  vec3.add(tempWorldOffset, worldCenter, offset);
  vec3.transformMat4(tempAxisPoint, tempWorldOffset, viewProjectionMat);
  return [tempAxisPoint[0] - cx, tempAxisPoint[1] - cy];
}

/**
 * Slice-view render layer that draws a 2D disk cursor for brush and eraser
 * tools. Visibility and radius are derived from `BrushCursorState`.
 */
export class BrushCursorSliceOverlay extends SliceViewPanelRenderLayer {
  private fanBuffer: GLBuffer;
  private loopBuffer: GLBuffer;
  private shader: ShaderProgram;

  constructor(
    public gl: GL,
    public state: BrushCursorState,
  ) {
    super();
    this.fanBuffer = this.registerDisposer(
      GLBuffer.fromData(
        gl,
        buildFanVertices(),
        gl.ARRAY_BUFFER,
        gl.STATIC_DRAW,
      ),
    );
    this.loopBuffer = this.registerDisposer(
      GLBuffer.fromData(
        gl,
        buildLoopVertices(),
        gl.ARRAY_BUFFER,
        gl.STATIC_DRAW,
      ),
    );
    this.shader = this.registerDisposer(buildDiskShader(gl));

    // Trigger panel redraw on any cursor-state change.
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

  override isReady(_renderContext: SliceViewPanelReadyRenderContext): boolean {
    return true;
  }

  override draw(renderContext: SliceViewPanelRenderContext): void {
    if (!renderContext.emitColor) return;
    const { state, gl, shader, fanBuffer, loopBuffer } = this;
    if (state.visible.value !== true) return;
    const worldCenter = state.worldCenter.value;
    if (worldCenter === undefined) return;
    const radiusVoxels = state.radiusVoxels.value;
    if (!Number.isFinite(radiusVoxels) || radiusVoxels <= 0) return;

    const projectionParameters = renderContext.projectionParameters;
    const { width, height } = projectionParameters;
    if (width <= 0 || height <= 0) return;

    // Two painted-plane basis steps, in display coords (the frame
    // `viewProjectionMat` consumes), scaled to the visual brush radius.
    const { offsetX, offsetY } = computeBrushFootprintAxes(
      radiusVoxels,
      state.targetResolution.value,
      projectionParameters.displayDimensionRenderInfo,
    );

    // Project worldCenter → NDC. `vec3.transformMat4` includes the perspective
    // divide, so these are normalized device coords ([-1, 1]).
    vec3.transformMat4(
      tempCenterClip,
      worldCenter,
      projectionParameters.viewProjectionMat,
    );
    const cx = tempCenterClip[0];
    const cy = tempCenterClip[1];

    // Project worldCenter ± each display-space offset and take the NDC
    // difference → the ellipse's semi-axis vectors in clip space.
    const axisX = projectOffsetToNdc(
      worldCenter,
      offsetX,
      cx,
      cy,
      projectionParameters.viewProjectionMat,
    );
    const axisY = projectOffsetToNdc(
      worldCenter,
      offsetY,
      cx,
      cy,
      projectionParameters.viewProjectionMat,
    );

    // Sub-pixel guard: skip drawing when both semi-axes are under half a pixel.
    // NDC spans [-1, 1] across each dimension, so one pixel is `2 / dimension`
    // NDC units; pixel length = ndcLength × dimension / 2.
    const axisXPx = Math.hypot(axisX[0] * width, axisX[1] * height) / 2;
    const axisYPx = Math.hypot(axisY[0] * width, axisY[1] * height) / 2;
    if (axisXPx < 0.5 && axisYPx < 0.5) return;

    const outline = CURSOR_OUTLINE;
    const fill = CURSOR_FILL;

    shader.bind();
    gl.uniform2f(shader.uniform("uCenterClip"), cx, cy);
    gl.uniform2f(shader.uniform("uAxisX"), axisX[0], axisX[1]);
    gl.uniform2f(shader.uniform("uAxisY"), axisY[0], axisY[1]);

    const aVertexOffset = shader.attribute("aVertexOffset");
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);

    // Draw filled disk.
    fanBuffer.bindToVertexAttrib(aVertexOffset, 2);
    gl.uniform4fv(shader.uniform("uColor"), fill);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, FAN_VERTEX_COUNT);

    // Draw outline (line loop) — 2px requested though most drivers cap at 1.
    loopBuffer.bindToVertexAttrib(aVertexOffset, 2);
    gl.uniform4fv(shader.uniform("uColor"), outline);
    gl.lineWidth(2);
    gl.drawArrays(gl.LINE_LOOP, 0, LOOP_VERTEX_COUNT);
    gl.lineWidth(1);

    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disableVertexAttribArray(aVertexOffset);
  }
}

/**
 * Inline disk shader. Writes to BOTH slice-panel attachments (color + pickId)
 * because the panel's main draw loop binds both via
 * `sliceViewPanelEmitColorAndPickID`. Writing to only one attachment while
 * both are active triggers `GL_INVALID_OPERATION: Active draw buffers with
 * missing fragment shader outputs`. The cursor is non-pickable, so we emit
 * a constant zero pickId.
 */
function buildDiskShader(gl: GL): ShaderProgram {
  const builder = new ShaderBuilder(gl);
  builder.addAttribute("vec2", "aVertexOffset");
  builder.addUniform("vec2", "uCenterClip");
  builder.addUniform("vec2", "uAxisX");
  builder.addUniform("vec2", "uAxisY");
  builder.addUniform("vec4", "uColor");
  builder.addOutputBuffer("vec4", "out_fragColor", 0);
  builder.addOutputBuffer("highp vec4", "out_pickId", 1);
  // `aVertexOffset` carries unit-circle (cos, sin); map it onto the ellipse's
  // clip-space semi-axis vectors so anisotropic footprints render correctly.
  builder.setVertexMain(
    "gl_Position = vec4(uCenterClip + aVertexOffset.x * uAxisX + aVertexOffset.y * uAxisY, 0.0, 1.0);",
  );
  builder.setFragmentMain(
    "out_fragColor = uColor; out_pickId = vec4(0.0, 0.0, 0.0, 1.0);",
  );
  return builder.build();
}
