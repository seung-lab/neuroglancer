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
import { HashMapUint64 } from "#src/gpu_hash/hash_table.js";
import {
  GPUHashTable,
  HashMapShaderManager,
  HashSetShaderManager,
} from "#src/gpu_hash/shader.js";
import {
  SegmentColorShaderManager,
  SegmentStatedColorShaderManager,
} from "#src/segment_color.js";
import { getVisibleSegments } from "#src/segmentation_display_state/base.js";
import type {
  SegmentationDisplayState,
  SegmentationGroupState,
} from "#src/segmentation_display_state/frontend.js";
import { registerRedrawWhenSegmentationDisplayStateChanged } from "#src/segmentation_display_state/frontend.js";
import type { SliceViewSourceOptions } from "#src/sliceview/base.js";
import type {
  SliceView,
  SliceViewSingleResolutionSource,
} from "#src/sliceview/frontend.js";
import type {
  MultiscaleVolumeChunkSource,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import type { RenderLayerBaseOptions } from "#src/sliceview/volume/renderlayer.js";
import { SliceViewVolumeRenderLayer } from "#src/sliceview/volume/renderlayer.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import {
  AggregateWatchableValue,
  constantWatchableValue,
  makeCachedDerivedWatchableValue,
} from "#src/trackable_value.js";
import type { Uint64Map } from "#src/uint64_map.js";
import type { DisjointUint64Sets } from "#src/util/disjoint_sets.js";
import type { vec3 } from "#src/util/geom.js";
import type { ShaderBuilder, ShaderProgram } from "#src/webgl/shader.js";

export class EquivalencesHashMap {
  generation = Number.NaN;
  hashMap = new HashMapUint64();
  constructor(public disjointSets: DisjointUint64Sets) {}
  update() {
    const { disjointSets } = this;
    const { generation } = disjointSets;
    if (this.generation !== generation) {
      this.generation = generation;
      const { hashMap } = this;
      hashMap.clear();
      for (const [objectId, minObjectId] of disjointSets.mappings()) {
        hashMap.set(objectId, minObjectId);
      }
    }
  }
}

export interface SliceViewSegmentationDisplayState
  extends SegmentationDisplayState,
    RenderLayerBaseOptions {
  selectedAlpha: WatchableValueInterface<number>;
  notSelectedAlpha: WatchableValueInterface<number>;
  hideSegmentZero: WatchableValueInterface<boolean>;
  ignoreNullVisibleSet: WatchableValueInterface<boolean>;
  /**
   * Voxel-edit hook: when defined and the inner value is non-`undefined`,
   * voxels outside the bbox render at a reduced alpha (see
   * `src/editing/shaders/bbox_alpha_chunk.ts`). When this field is omitted
   * (the common case for layers not participating in an edit session) the
   * render path is byte-identical to the pre-hook implementation.
   *
   * Wired by the segmentation user layer from
   * `viewer.editSessionHost.activeRegionByLayer.get(this.name)` in
   * Phase 4 step 24. Until that wiring lands, leave this field unset.
   */
  editBboxLoHi?: WatchableValueInterface<
    { loVoxel: vec3; hiVoxel: vec3 } | undefined
  >;
}

interface ShaderParameters {
  hasEquivalences: boolean;
  baseSegmentColoring: boolean;
  baseSegmentHighlighting: boolean;
  hasSegmentStatedColors: boolean;
  hideSegmentZero: boolean;
  hasSegmentDefaultColor: boolean;
  hasHighlightColor: boolean;
  /**
   * Voxel-edit bbox-dim shader path gate. Defaults to `false`; flips to
   * `true` only while an edit session is active for this layer. When
   * `false`, the bbox-dim uniforms/snippet are NOT added to the shader and
   * the compiled GLSL is byte-identical to the pre-hook implementation.
   */
  editBboxActive: boolean;
}

const HAS_SELECTED_SEGMENT_FLAG = 1;
const SHOW_ALL_SEGMENTS_FLAG = 2;

export class SegmentationRenderLayer extends SliceViewVolumeRenderLayer<ShaderParameters> {
  public readonly segmentationGroupState: SegmentationGroupState;
  protected segmentColorShaderManager = new SegmentColorShaderManager(
    "segmentColorHash",
  );
  protected segmentStatedColorShaderManager =
    new SegmentStatedColorShaderManager("segmentStatedColor");
  private gpuSegmentStatedColorHashTable:
    | GPUHashTable<HashMapUint64>
    | undefined;
  private hashTableManager = new HashSetShaderManager("visibleSegments");
  private gpuHashTable;
  private gpuTemporaryHashTable;
  private equivalencesShaderManager = new HashMapShaderManager("equivalences");
  private equivalencesHashMap;
  private temporaryEquivalencesHashMap;
  private gpuEquivalencesHashTable;
  private gpuTemporaryEquivalencesHashTable;

  /**
   * Voxel-edit bbox-dim shader hook. Stateless across compiles; gated by
   * the `editBboxActive` shader parameter so that when no session is
   * active for this layer the hook contributes NOTHING to the shader
   * source (no uniforms, no fragment code, no main-body wrapping).
   */
  private bboxAlphaHook: BboxAlphaShaderHook = createBboxAlphaShaderHook();

  constructor(
    multiscaleSource: MultiscaleVolumeChunkSource,
    public displayState: SliceViewSegmentationDisplayState,
  ) {
    super(multiscaleSource, {
      shaderParameters: new AggregateWatchableValue((refCounted) => ({
        hasEquivalences: refCounted.registerDisposer(
          makeCachedDerivedWatchableValue(
            (x) => x.size !== 0,
            [displayState.segmentationGroupState.value.segmentEquivalences],
          ),
        ),
        hasSegmentStatedColors: refCounted.registerDisposer(
          makeCachedDerivedWatchableValue(
            (
              segmentStatedColors: Uint64Map,
              tempSegmentStatedColors2d: Uint64Map,
              useTempSegmentStatedColors2d: boolean,
            ) => {
              const releventMap = useTempSegmentStatedColors2d
                ? tempSegmentStatedColors2d
                : segmentStatedColors;
              return releventMap.size !== 0;
            },
            [
              displayState.segmentStatedColors,
              displayState.tempSegmentStatedColors2d,
              displayState.useTempSegmentStatedColors2d,
            ],
          ),
        ),
        hasSegmentDefaultColor: refCounted.registerDisposer(
          makeCachedDerivedWatchableValue(
            (segmentDefaultColor, tempSegmentDefaultColor2d) => {
              return (
                segmentDefaultColor !== undefined ||
                tempSegmentDefaultColor2d !== undefined
              );
            },
            [
              displayState.segmentDefaultColor,
              displayState.tempSegmentDefaultColor2d,
            ],
          ),
        ),
        hasHighlightColor: refCounted.registerDisposer(
          makeCachedDerivedWatchableValue(
            (x) => x !== undefined,
            [displayState.highlightColor],
          ),
        ),
        hideSegmentZero: displayState.hideSegmentZero,
        baseSegmentColoring: displayState.baseSegmentColoring,
        baseSegmentHighlighting: displayState.baseSegmentHighlighting,
        // Voxel-edit bbox-dim gate. Derived from the optional
        // `editBboxLoHi` watchable: `true` iff a session bbox is currently
        // set for this layer. When `editBboxLoHi` is undefined (the
        // default), this resolves to a constant `false` and the bbox-dim
        // shader path is never compiled in.
        editBboxActive:
          displayState.editBboxLoHi === undefined
            ? constantWatchableValue(false)
            : refCounted.registerDisposer(
                makeCachedDerivedWatchableValue(
                  (bbox) => bbox !== undefined,
                  [displayState.editBboxLoHi],
                ),
              ),
      })),
      transform: displayState.transform,
      renderScaleHistogram: displayState.renderScaleHistogram,
      renderScaleTarget: displayState.renderScaleTarget,
      localPosition: displayState.localPosition,
    });
    this.segmentationGroupState = displayState.segmentationGroupState.value;
    this.gpuHashTable = this.registerDisposer(
      GPUHashTable.get(
        this.gl,
        this.segmentationGroupState.visibleSegments.hashTable,
      ),
    );
    this.gpuTemporaryHashTable = GPUHashTable.get(
      this.gl,
      this.segmentationGroupState.temporaryVisibleSegments.hashTable,
    );
    this.equivalencesHashMap = new EquivalencesHashMap(
      this.segmentationGroupState.segmentEquivalences.disjointSets,
    );
    this.temporaryEquivalencesHashMap = new EquivalencesHashMap(
      this.segmentationGroupState.temporarySegmentEquivalences.disjointSets,
    );
    this.gpuEquivalencesHashTable = this.registerDisposer(
      GPUHashTable.get(this.gl, this.equivalencesHashMap.hashMap),
    );
    this.gpuTemporaryEquivalencesHashTable = this.registerDisposer(
      GPUHashTable.get(this.gl, this.temporaryEquivalencesHashMap.hashMap),
    );

    this.registerDisposer(
      this.shaderParameters as AggregateWatchableValue<ShaderParameters>,
    );
    registerRedrawWhenSegmentationDisplayStateChanged(displayState, this);
    this.registerDisposer(
      displayState.selectedAlpha.changed.add(this.redrawNeeded.dispatch),
    );
    this.registerDisposer(
      displayState.notSelectedAlpha.changed.add(this.redrawNeeded.dispatch),
    );
    this.registerDisposer(
      displayState.ignoreNullVisibleSet.changed.add(this.redrawNeeded.dispatch),
    );
    // Redraw when the bbox lo/hi changes within an active session — value
    // changes don't flip the `editBboxActive` bit so they won't go through
    // `shaderParameters.changed`, but they DO need a fresh `bind()`.
    if (displayState.editBboxLoHi !== undefined) {
      this.registerDisposer(
        displayState.editBboxLoHi.changed.add(this.redrawNeeded.dispatch),
      );
    }
  }

  disposed() {
    this.gpuSegmentStatedColorHashTable?.dispose();
  }

  getSources(
    options: SliceViewSourceOptions,
  ): SliceViewSingleResolutionSource<VolumeChunkSource>[][] {
    return this.multiscaleSource.getSources({
      ...options,
      discreteValues: true,
    });
  }

  /**
   * Voxel-edit extension point: subclasses override this to inject patch
   * sampling into the segmentation read path. The default body returns
   * `toUint64(getDataValue())` — stock base-segmentation behavior.
   */
  protected defineGetUint64DataValue(builder: ShaderBuilder) {
    builder.addFragmentCode(`
uint64_t getUint64DataValue() {
  uint64_t x = toUint64(getDataValue());
  return x;
}
`);
  }

  defineShader(builder: ShaderBuilder, parameters: ShaderParameters) {
    this.hashTableManager.defineShader(builder);
    this.defineGetUint64DataValue(builder);
    if (parameters.hasEquivalences) {
      this.equivalencesShaderManager.defineShader(builder);
      builder.addFragmentCode(`
uint64_t getMappedObjectId(uint64_t value) {
  uint64_t mappedValue;
  if (${this.equivalencesShaderManager.getFunctionName}(value, mappedValue)) {
    return mappedValue;
  }
  return value;
}
`);
    } else {
      builder.addFragmentCode(`
uint64_t getMappedObjectId(uint64_t value) {
  return value;
}
`);
    }
    builder.addUniform("highp uvec2", "uSelectedSegment");
    builder.addUniform("highp uint", "uFlags");
    builder.addUniform("highp float", "uSelectedAlpha");
    builder.addUniform("highp float", "uNotSelectedAlpha");
    builder.addUniform("highp float", "uSaturation");
    let fragmentMain = `
  uint64_t baseValue = getUint64DataValue();
  uint64_t value = getMappedObjectId(baseValue);
  uint64_t valueForColor = ${
    parameters.baseSegmentColoring ? "baseValue" : "value"
  };
  uint64_t valueForHighlight = ${
    parameters.baseSegmentHighlighting ? "baseValue" : "value"
  };

  float alpha = uSelectedAlpha;
  float saturation = uSaturation;
`;

    let getMappedIdColor = `vec4 getMappedIdColor(uint64_t value) {
  `;
    // If the value has a mapped color, use it; otherwise, compute the color.

    // specific color, highlight ok
    if (parameters.hasSegmentStatedColors) {
      this.segmentStatedColorShaderManager.defineShader(builder);
      getMappedIdColor += `
    vec4 rgba;
    if (${this.segmentStatedColorShaderManager.getFunctionName}(value, rgba)) {
      return rgba;
    }
  `;
    }
    if (parameters.hasSegmentDefaultColor) {
      builder.addUniform("highp vec4", "uSegmentDefaultColor");
      getMappedIdColor += `  return uSegmentDefaultColor;
  `;
    } else {
      this.segmentColorShaderManager.defineShader(builder);
      getMappedIdColor += `  return vec4(segmentColorHash(value), 0.0);
  `;
    }
    getMappedIdColor += `
  }
  `;
    builder.addFragmentCode(getMappedIdColor);

    if (parameters.hideSegmentZero) {
      fragmentMain += `
  if (value.value[0] == 0u && value.value[1] == 0u) {`;
      if (parameters.hasSegmentStatedColors) {
        fragmentMain += `
    vec4 rgba;
    if (${this.segmentStatedColorShaderManager.getFunctionName}(valueForColor, rgba)) {
      emit(vec4(mix(vec3(1.0,1.0,1.0), vec3(rgba), saturation), alpha));
      return;
    }
  `;
      }
      fragmentMain += `
    emit(vec4(vec4(0, 0, 0, 0)));
    return;
  }
`;
    }
    fragmentMain += `
  bool has = (uFlags & ${SHOW_ALL_SEGMENTS_FLAG}u) != 0u ? true : ${this.hashTableManager.hasFunctionName}(value);
  if ((uFlags & ${HAS_SELECTED_SEGMENT_FLAG}u) != 0u && uSelectedSegment == valueForHighlight.value) {
    float adjustment = has ? 0.5 : 0.75;
    if (saturation > adjustment) {
      saturation -= adjustment;
    } else {
      saturation += adjustment;
    }
`;
    if (parameters.hasHighlightColor) {
      builder.addUniform("highp vec4", "uHighlightColor");
      fragmentMain += `
    emit(uHighlightColor);
    return;
`;
    }
    fragmentMain += `
  } else if (!has) {
    alpha = uNotSelectedAlpha;
  }
`;
    fragmentMain += `
  vec4 rgba = getMappedIdColor(valueForColor);
  if (rgba.a > 0.0) {
    alpha = rgba.a;
  }
  emit(vec4(mix(vec3(1.0,1.0,1.0), vec3(rgba), saturation), alpha));
`;
    // Voxel-edit bbox-dim opt-in path: when an edit session is active for
    // this layer, route every `emit(...)` call in the main body through
    // `emitWithBboxDim(...)` so outside-bbox fragments render at 0.25x
    // alpha. Gated on the `editBboxActive` shader parameter, so when no
    // session is active this branch is NOT taken and the resulting GLSL is
    // byte-identical to the pre-hook shader.
    if (parameters.editBboxActive) {
      this.bboxAlphaHook.defineUniforms(builder);
      builder.addFragmentCode(this.bboxAlphaHook.fragmentSnippet());
      fragmentMain = this.bboxAlphaHook.wrapFragmentMain(fragmentMain);
    }
    builder.setFragmentMain(fragmentMain);
  }

  initializeShader(
    _sliceView: SliceView,
    shader: ShaderProgram,
    parameters: ShaderParameters,
  ) {
    const { gl } = this;
    const { displayState, segmentationGroupState } = this;
    const { segmentSelectionState } = this.displayState;
    const {
      segmentDefaultColor: { value: segmentDefaultColor },
      segmentColorHash: { value: segmentColorHash },
      highlightColor: { value: highlightColor },
      tempSegmentDefaultColor2d: { value: tempSegmentDefaultColor2d },
    } = this.displayState;
    const visibleSegments = getVisibleSegments(segmentationGroupState);
    const ignoreNullSegmentSet = this.displayState.ignoreNullVisibleSet.value;
    let selectedSegmentLow = 0;
    let selectedSegmentHigh = 0;
    let flags = 0;
    if (
      segmentSelectionState.hasSelectedSegment &&
      displayState.hoverHighlight.value
    ) {
      const seg = displayState.baseSegmentHighlighting.value
        ? segmentSelectionState.baseSelectedSegment
        : segmentSelectionState.selectedSegment;
      selectedSegmentLow = Number(seg & 0xffffffffn);
      selectedSegmentHigh = Number(seg >> 32n);
      flags |= HAS_SELECTED_SEGMENT_FLAG;
    }
    gl.uniform1f(
      shader.uniform("uSelectedAlpha"),
      displayState.selectedAlpha.value,
    );
    gl.uniform1f(shader.uniform("uSaturation"), displayState.saturation.value);
    gl.uniform1f(
      shader.uniform("uNotSelectedAlpha"),
      displayState.notSelectedAlpha.value,
    );
    gl.uniform2ui(
      shader.uniform("uSelectedSegment"),
      selectedSegmentLow,
      selectedSegmentHigh,
    );
    if (visibleSegments.hashTable.size === 0 && ignoreNullSegmentSet) {
      flags |= SHOW_ALL_SEGMENTS_FLAG;
    }
    gl.uniform1ui(shader.uniform("uFlags"), flags);
    this.hashTableManager.enable(
      gl,
      shader,
      segmentationGroupState.useTemporaryVisibleSegments.value
        ? this.gpuTemporaryHashTable
        : this.gpuHashTable,
    );
    if (parameters.hasEquivalences) {
      const useTemp =
        segmentationGroupState.useTemporarySegmentEquivalences.value;
      (useTemp
        ? this.temporaryEquivalencesHashMap
        : this.equivalencesHashMap
      ).update();
      this.equivalencesShaderManager.enable(
        gl,
        shader,
        useTemp
          ? this.gpuTemporaryEquivalencesHashTable
          : this.gpuEquivalencesHashTable,
      );
    }
    const activeSegmentDefaultColor =
      tempSegmentDefaultColor2d || segmentDefaultColor;
    if (activeSegmentDefaultColor) {
      const [r, g, b, a] = activeSegmentDefaultColor;
      gl.uniform4f(
        shader.uniform("uSegmentDefaultColor"),
        r,
        g,
        b,
        a === undefined ? 0 : a,
      );
    } else {
      this.segmentColorShaderManager.enable(gl, shader, segmentColorHash);
    }
    if (parameters.hasSegmentStatedColors) {
      const segmentStatedColors = displayState.useTempSegmentStatedColors2d
        .value
        ? displayState.tempSegmentStatedColors2d.value
        : displayState.segmentStatedColors.value;
      let { gpuSegmentStatedColorHashTable } = this;
      if (
        gpuSegmentStatedColorHashTable === undefined ||
        gpuSegmentStatedColorHashTable.hashTable !==
          segmentStatedColors.hashTable
      ) {
        gpuSegmentStatedColorHashTable?.dispose();
        this.gpuSegmentStatedColorHashTable = gpuSegmentStatedColorHashTable =
          GPUHashTable.get(gl, segmentStatedColors.hashTable);
      }
      this.segmentStatedColorShaderManager.enable(
        gl,
        shader,
        gpuSegmentStatedColorHashTable,
      );
    }
    if (highlightColor !== undefined) {
      gl.uniform4fv(shader.uniform("uHighlightColor"), highlightColor);
    }
    // Bbox-dim uniforms are bound only when the bbox-dim shader path was
    // compiled (`editBboxActive === true`). Otherwise the uniforms don't
    // exist on the shader at all.
    //
    // Picking-pass safety: `SliceViewVolumeRenderLayer.draw` is invoked
    // only from `SliceView.updateRendering` (color into the sliceView
    // offscreen buffer); the panel-level picking pass goes through
    // `SliceViewPanelRenderLayer` subclasses (annotation/cursor overlays),
    // which do NOT invoke this volume layer. There is therefore no
    // separate picking-pass shader for this layer to dim.
    if (parameters.editBboxActive) {
      const bbox = displayState.editBboxLoHi?.value;
      this.bboxAlphaHook.bind(gl, shader, {
        bbox,
        outsideAlphaMultiplier: 0.25,
      });
    }
  }
  endSlice(
    sliceView: SliceView,
    shader: ShaderProgram,
    parameters: ShaderParameters,
  ) {
    const { gl } = this;
    this.hashTableManager.disable(gl, shader);
    if (parameters.hasEquivalences) {
      this.equivalencesShaderManager.disable(gl, shader);
    }
    if (parameters.hasSegmentStatedColors) {
      this.segmentStatedColorShaderManager.disable(gl, shader);
    }
    super.endSlice(sliceView, shader, parameters);
  }
}
