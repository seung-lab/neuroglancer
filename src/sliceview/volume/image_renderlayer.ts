/**
 * @license
 * Copyright 2016 Google Inc.
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

import type { BboxAlphaShaderHook } from "#src/editing/shaders/bbox_alpha_chunk.js";
import { createBboxAlphaShaderHook } from "#src/editing/shaders/bbox_alpha_chunk.js";
import type { SliceView } from "#src/sliceview/frontend.js";
import type { MultiscaleVolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import type { RenderLayerBaseOptions } from "#src/sliceview/volume/renderlayer.js";
import { SliceViewVolumeRenderLayer } from "#src/sliceview/volume/renderlayer.js";
import type { TrackableAlphaValue } from "#src/trackable_alpha.js";
import type { TrackableBlendModeValue } from "#src/trackable_blend.js";
import { BLEND_FUNCTIONS, BLEND_MODES } from "#src/trackable_blend.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import {
  AggregateWatchableValue,
  constantWatchableValue,
  makeCachedDerivedWatchableValue,
  WatchableValue,
} from "#src/trackable_value.js";
import type { vec3 } from "#src/util/geom.js";
import { glsl_COLORMAPS } from "#src/webgl/colormaps.js";
import type { WatchableShaderError } from "#src/webgl/dynamic_shader.js";
import {
  makeTrackableFragmentMain,
  shaderCodeWithLineDirective,
} from "#src/webgl/dynamic_shader.js";
import type { ShaderBuilder, ShaderProgram } from "#src/webgl/shader.js";
import type {
  ShaderControlsBuilderState,
  ShaderControlState,
} from "#src/webgl/shader_ui_controls.js";
import {
  addControlsToBuilder,
  getFallbackBuilderState,
  parseShaderUiControls,
  setControlsInShader,
} from "#src/webgl/shader_ui_controls.js";

const DEFAULT_FRAGMENT_MAIN = `#uicontrol invlerp normalized
void main() {
  emitGrayscale(normalized());
}
`;

export function getTrackableFragmentMain(value = DEFAULT_FRAGMENT_MAIN) {
  return makeTrackableFragmentMain(value);
}

export interface ImageRenderLayerOptions extends RenderLayerBaseOptions {
  shaderError: WatchableShaderError;
  opacity: TrackableAlphaValue;
  blendMode: TrackableBlendModeValue;
  shaderControlState: ShaderControlState;
  /**
   * Voxel-edit hook: when defined and the inner value is non-`undefined`,
   * voxels outside the bbox render at a reduced alpha (see
   * `src/editing/shaders/bbox_alpha_chunk.ts`). When this field is omitted
   * (the common case for layers not participating in an edit session) the
   * render path is byte-identical to the pre-hook implementation.
   *
   * Mirrors `SliceViewSegmentationDisplayState.editBboxLoHi` from
   * `src/sliceview/volume/segmentation_renderlayer.ts` (step 15).
   *
   * Wired by the image user layer from
   * `viewer.editSessionHost.activeRegionByLayer.get(this.name)` in
   * Phase 4 step 24. Until that wiring lands, leave this field unset.
   */
  editBboxLoHi?: WatchableValueInterface<
    { loVoxel: vec3; hiVoxel: vec3 } | undefined
  >;
}

/**
 * Combined shader-parameters object for `ImageRenderLayer`. Bundles the
 * user-shader builder state (which historically WAS the entire shader
 * parameters object) with the voxel-edit bbox-dim gate. When
 * `editBboxActive === false`, the bbox-dim shader path is NOT compiled in
 * and the resulting GLSL is byte-identical to the pre-hook implementation.
 */
interface ImageShaderParameters {
  builderState: ShaderControlsBuilderState;
  /**
   * Voxel-edit bbox-dim shader path gate. Defaults to `false`; flips to
   * `true` only while an edit session is active for this layer. When
   * `false`, the bbox-dim uniforms/snippet are NOT added to the shader and
   * the compiled GLSL is byte-identical to the pre-hook implementation.
   */
  editBboxActive: boolean;
}

export function defineImageLayerShader(
  builder: ShaderBuilder,
  shaderBuilderState: ShaderControlsBuilderState,
  bboxAlphaHook?: BboxAlphaShaderHook,
) {
  // The image layer exposes a small set of helper functions to user-supplied
  // shaders. Every one of these helpers funnels through the base `emit(...)`
  // declared in `src/sliceview/volume/renderlayer.ts`; therefore wrapping the
  // `emit(...)` calls in this prelude string is sufficient to dim ALL
  // emission paths reachable from user code (`emitRGB`, `emitRGBA`,
  // `emitGrayscale`, `emitTransparent`).
  let helpers = `
#define VOLUME_RENDERING false

void emitRGBA(vec4 rgba) {
  emit(vec4(rgba.rgb, rgba.a * uOpacity));
}
void emitRGB(vec3 rgb) {
  emit(vec4(rgb, uOpacity));
}
void emitGrayscale(float value) {
  emit(vec4(value, value, value, uOpacity));
}
void emitTransparent() {
  emit(vec4(0.0, 0.0, 0.0, 0.0));
}
void emitIntensity(float value) {
}
`;
  let userMain = shaderCodeWithLineDirective(
    shaderBuilderState.parseResult.code,
  );
  // Voxel-edit bbox-dim opt-in path: re-route every `emit(<expr>)` call in
  // the emit-helper prelude AND in the user-supplied fragmentMain through
  // `emitWithBboxDim(<expr>)`. Gated on `bboxAlphaHook !== undefined`, so
  // when no session is active this branch is NOT taken and the GLSL is
  // byte-identical to the pre-hook shader.
  if (bboxAlphaHook !== undefined) {
    helpers = bboxAlphaHook.wrapFragmentMain(helpers);
    userMain = bboxAlphaHook.wrapFragmentMain(userMain);
  }
  builder.addFragmentCode(helpers);
  builder.addFragmentCode(glsl_COLORMAPS);
  addControlsToBuilder(shaderBuilderState, builder);
  builder.setFragmentMainFunction(userMain);
}

export class ImageRenderLayer extends SliceViewVolumeRenderLayer<ImageShaderParameters> {
  opacity: TrackableAlphaValue;
  blendMode: TrackableBlendModeValue;
  shaderControlState: ShaderControlState;
  /**
   * Optional bbox watchable supplied by the image user layer during an edit
   * session. Stored so `initializeShader` can read the current bbox lo/hi.
   */
  private editBboxLoHi?: WatchableValueInterface<
    { loVoxel: vec3; hiVoxel: vec3 } | undefined
  >;
  /**
   * Voxel-edit bbox-dim shader hook. Stateless across compiles; gated by
   * the `editBboxActive` shader parameter so that when no session is
   * active for this layer the hook contributes NOTHING to the shader
   * source (no uniforms, no fragment code, no main-body wrapping).
   */
  private bboxAlphaHook: BboxAlphaShaderHook = createBboxAlphaShaderHook();
  constructor(
    multiscaleSource: MultiscaleVolumeChunkSource,
    options: ImageRenderLayerOptions,
  ) {
    const { opacity, blendMode, shaderControlState, editBboxLoHi } = options;
    const fallbackBuilderState = new WatchableValue(
      getFallbackBuilderState(
        parseShaderUiControls(DEFAULT_FRAGMENT_MAIN, {
          imageData: {
            dataType: multiscaleSource.dataType,
            channelRank: options.channelCoordinateSpace?.value?.rank ?? 0,
          },
        }),
      ),
    );
    super(multiscaleSource, {
      ...options,
      fallbackShaderParameters: new WatchableValue<ImageShaderParameters>({
        builderState: fallbackBuilderState.value,
        editBboxActive: false,
      }),
      // Cache key: the builderState carries its own key string; concatenate
      // the bbox-active bit so the two variants (with/without bbox-dim)
      // compile and cache independently.
      encodeShaderParameters: (p) =>
        `${p.builderState.key}/${p.editBboxActive ? 1 : 0}`,
      shaderParameters: new AggregateWatchableValue((refCounted) => ({
        builderState: shaderControlState.builderState,
        // Voxel-edit bbox-dim gate. Derived from the optional `editBboxLoHi`
        // watchable: `true` iff a session bbox is currently set for this
        // layer. When `editBboxLoHi` is undefined (the default), this
        // resolves to a constant `false` and the bbox-dim shader path is
        // never compiled in.
        editBboxActive:
          editBboxLoHi === undefined
            ? constantWatchableValue(false)
            : refCounted.registerDisposer(
                makeCachedDerivedWatchableValue(
                  (bbox) => bbox !== undefined,
                  [editBboxLoHi],
                ),
              ),
      })),
      dataHistogramSpecifications: shaderControlState.histogramSpecifications,
    });
    this.shaderControlState = shaderControlState;
    this.opacity = opacity;
    this.blendMode = blendMode;
    this.editBboxLoHi = editBboxLoHi;
    this.registerDisposer(
      this.shaderParameters as AggregateWatchableValue<ImageShaderParameters>,
    );
    this.registerDisposer(opacity.changed.add(this.redrawNeeded.dispatch));
    this.registerDisposer(blendMode.changed.add(this.redrawNeeded.dispatch));
    this.registerDisposer(
      shaderControlState.changed.add(this.redrawNeeded.dispatch),
    );
    // Redraw when the bbox lo/hi changes within an active session — value
    // changes don't flip the `editBboxActive` bit so they won't go through
    // `shaderParameters.changed`, but they DO need a fresh `bind()`.
    if (editBboxLoHi !== undefined) {
      this.registerDisposer(editBboxLoHi.changed.add(this.redrawNeeded.dispatch));
    }
  }

  defineShader(builder: ShaderBuilder, parameters: ImageShaderParameters) {
    const { builderState, editBboxActive } = parameters;
    if (builderState.parseResult.errors.length !== 0) {
      throw new Error("Invalid UI control specification");
    }
    builder.addUniform("highp float", "uOpacity");
    // Voxel-edit bbox-dim opt-in path: when an edit session is active for
    // this layer, install the bbox uniforms + helper snippet and route every
    // `emit(...)` call (in both the emit-helper prelude and the user's
    // fragmentMain) through `emitWithBboxDim(...)` so outside-bbox fragments
    // render at 0.25x alpha. Gated on the `editBboxActive` shader parameter,
    // so when no session is active this branch is NOT taken and the
    // resulting GLSL is byte-identical to the pre-hook shader.
    if (editBboxActive) {
      this.bboxAlphaHook.defineUniforms(builder);
      builder.addFragmentCode(this.bboxAlphaHook.fragmentSnippet());
      defineImageLayerShader(builder, builderState, this.bboxAlphaHook);
    } else {
      defineImageLayerShader(builder, builderState);
    }
  }

  initializeShader(
    _sliceView: SliceView,
    shader: ShaderProgram,
    parameters: ImageShaderParameters,
  ) {
    const { gl } = this;
    gl.uniform1f(shader.uniform("uOpacity"), this.opacity.value);
    setControlsInShader(
      gl,
      shader,
      this.shaderControlState,
      parameters.builderState.parseResult.controls,
    );
    // Bbox-dim uniforms are bound only when the bbox-dim shader path was
    // compiled (`editBboxActive === true`). Otherwise the uniforms don't
    // exist on the shader at all.
    //
    // Picking-pass safety: `SliceViewVolumeRenderLayer.draw` is invoked
    // only from `SliceView.updateRendering` (color into the sliceView
    // offscreen buffer); the panel-level picking pass goes through
    // `SliceViewPanelRenderLayer` subclasses, which do NOT invoke this
    // volume layer. There is therefore no separate picking-pass shader
    // for this layer to dim.
    if (parameters.editBboxActive) {
      const bbox = this.editBboxLoHi?.value;
      this.bboxAlphaHook.bind(gl, shader, {
        bbox,
        outsideAlphaMultiplier: 0.25,
      });
    }
  }

  setGLBlendMode(gl: WebGL2RenderingContext, renderLayerNum: number) {
    const blendModeValue = this.blendMode.value;
    if (blendModeValue === BLEND_MODES.ADDITIVE || renderLayerNum > 0) {
      gl.enable(gl.BLEND);
      BLEND_FUNCTIONS.get(blendModeValue)!(gl);
    } else {
      gl.disable(WebGL2RenderingContext.BLEND);
    }
  }
}
