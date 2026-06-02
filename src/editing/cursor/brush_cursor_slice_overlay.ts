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
 * + outline at the brush cursor position, sized to the painting tool's
 * voxel radius (converted to nm via the target layer's voxel size, then
 * to pixels via `SliceViewProjectionParameters.pixelSize`).
 *
 * Approach (per `05-tools-and-cursor.md` § Option A): a 24-sided unit
 * polygon (TRIANGLE_FAN for fill, LINE_LOOP for outline) is projected via
 * `worldCenter → clip space` plus a per-vertex NDC offset. Inline shader;
 * binding pattern mirrors `src/axes_lines.ts:AxesLineHelper.draw` (133).
 */

import { Resolution } from "@zettaai/edit-session";

import type { BrushCursorState } from "#src/editing/cursor/brush_cursor_state.js";
import type {
  SliceViewPanelRenderContext,
  SliceViewPanelReadyRenderContext,
} from "#src/sliceview/renderlayer.js";
import { SliceViewPanelRenderLayer } from "#src/sliceview/renderlayer.js";
import { SliceViewProjectionParameters } from "#src/sliceview/base.js";
import { vec3 } from "#src/util/geom.js";
import { GLBuffer } from "#src/webgl/buffer.js";
import type { GL } from "#src/webgl/context.js";
import { ShaderBuilder } from "#src/webgl/shader.js";
import type { ShaderProgram } from "#src/webgl/shader.js";

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

// Colors (per architecture spec): brush = green, eraser = red.
const BRUSH_OUTLINE = new Float32Array([0.0, 200 / 255, 0.0, 0.6]);
const BRUSH_FILL = new Float32Array([0.0, 200 / 255, 0.0, 0.15]);
const ERASER_OUTLINE = new Float32Array([1.0, 0.0, 0.0, 0.6]);
const ERASER_FILL = new Float32Array([1.0, 0.0, 0.0, 0.15]);

const tempVec3 = vec3.create();

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

    const radiusNm = voxelsToNm(radiusVoxels, state.targetResolution.value);
    if (!Number.isFinite(radiusNm) || radiusNm <= 0) return;

    const projectionParameters = renderContext.projectionParameters;
    // `pixelSize` is in canonical SI units (meters) — see
    // `src/sliceview/frontend.ts:265-272`. Convert our nm radius to meters
    // before dividing or the result is ~1e9× too large and the disk fills the
    // entire panel (mixing nm and m units).
    const pixelSizeMeters =
      projectionParameters instanceof SliceViewProjectionParameters
        ? projectionParameters.pixelSize
        : undefined;
    if (
      pixelSizeMeters === undefined ||
      !Number.isFinite(pixelSizeMeters) ||
      pixelSizeMeters <= 0
    ) {
      return;
    }
    const radiusMeters = radiusNm * 1e-9;
    const radiusPixels = radiusMeters / pixelSizeMeters;
    if (!Number.isFinite(radiusPixels) || radiusPixels < 0.5) return;

    const { width, height } = projectionParameters;
    if (width <= 0 || height <= 0) return;
    // NDC offset per pixel (clip space spans [-1, 1] in both axes).
    const ndcPerPixelX = 2 / width;
    const ndcPerPixelY = 2 / height;

    // Project worldCenter → clip coords.
    vec3.transformMat4(
      tempVec3,
      worldCenter,
      projectionParameters.viewProjectionMat,
    );
    const cx = tempVec3[0];
    const cy = tempVec3[1];

    const toolKind = state.toolKind.value;
    const outline = toolKind === "eraser" ? ERASER_OUTLINE : BRUSH_OUTLINE;
    const fill = toolKind === "eraser" ? ERASER_FILL : BRUSH_FILL;

    shader.bind();
    gl.uniform2f(shader.uniform("uCenterClip"), cx, cy);
    gl.uniform2f(
      shader.uniform("uRadiusNdc"),
      radiusPixels * ndcPerPixelX,
      radiusPixels * ndcPerPixelY,
    );

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
  builder.addUniform("vec2", "uRadiusNdc");
  builder.addUniform("vec4", "uColor");
  builder.addOutputBuffer("vec4", "out_fragColor", 0);
  builder.addOutputBuffer("highp vec4", "out_pickId", 1);
  builder.setVertexMain(
    "gl_Position = vec4(uCenterClip + aVertexOffset * uRadiusNdc, 0.0, 1.0);",
  );
  builder.setFragmentMain(
    "out_fragColor = uColor; out_pickId = vec4(0.0, 0.0, 0.0, 1.0);",
  );
  return builder.build();
}

/**
 * Convert library radius to nm, matching the reference cursor's `size/2`
 * convention (`radius + 0.5` voxels — exactly the radius that bounds the
 * painted footprint, since the footprint extends `radius` voxels each side
 * of the center voxel for a total diameter of `size = 2*radius + 1`).
 *
 * Uses the SMALLEST axis of the target resolution. For an XY slice over
 * anisotropic 16×16×40 voxels, max would over-bound the cursor by the Z/X
 * ratio (~2.5×); min matches the X-Y plane of a typical slice view. The
 * cursor is a 2D disk on the slice plane — picking the smallest axis gives
 * the tightest bound that still encloses the painted footprint in every
 * commonly-used slice orientation.
 */
function voxelsToNm(
  radiusVoxels: number,
  resolution: Resolution | undefined,
): number {
  const visualRadiusVoxels = radiusVoxels + 0.5;
  if (resolution === undefined) return visualRadiusVoxels;
  const voxelSize = Resolution.toVoxelSize(resolution);
  const minAxis = Math.min(voxelSize[0], voxelSize[1], voxelSize[2]);
  return visualRadiusVoxels * minAxis;
}
