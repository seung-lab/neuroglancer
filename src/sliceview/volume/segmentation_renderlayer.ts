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
import type { PatchedMaskProvider } from "#src/editing/shaders/patched_mask_provider.js";
import { HashMapUint64 } from "#src/gpu_hash/hash_table.js";
import {
  GPUHashTable,
  HashMapShaderManager,
  HashSetShaderManager,
} from "#src/gpu_hash/shader.js";
import { getChunkPositionFromCombinedGlobalLocalPositions } from "#src/render_coordinate_transform.js";
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
  SliceViewChunkSource,
  SliceViewSingleResolutionSource,
} from "#src/sliceview/frontend.js";
import type {
  MultiscaleVolumeChunkSource,
  VolumeChunk,
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
import type { GL } from "#src/webgl/context.js";
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
   * fragments outside the bbox are HARD-CLIPPED via `discard` (see
   * `src/editing/shaders/bbox_alpha_chunk.ts`). When this field is omitted
   * (the common case for layers not participating in an edit session) the
   * render path is byte-identical to the pre-hook implementation.
   *
   * The bbox is expressed in the layer's GLOBAL frame (nm) so the
   * comparison is resolution-independent — the shader converts the
   * fragment's chunk-grid voxel position to global coords via
   * `uChunkToGlobal`. Without this, the session's chosen resolution would
   * have to match the actually-rendered scale, which it often doesn't (e.g.
   * the session picks 16 nm but the viewer renders the 32 nm chunks).
   *
   * Wired by the segmentation user layer from
   * `viewer.editSessionHost.getActiveRegionWatchableForLayer(this.name)`.
   */
  editBboxLoHi?: WatchableValueInterface<{ lo: vec3; hi: vec3 } | undefined>;

  /**
   * Voxel-edit resolution-display lock. When set, the slice-view's
   * `getSources()` returns only scales matching the user-selected
   * resolutions for the active session; `undefined` means no filtering.
   * Same wiring pattern as `editBboxLoHi`.
   */
  allowedSourcePredicate?: WatchableValueInterface<
    | ((
        source: SliceViewSingleResolutionSource<SliceViewChunkSource>,
      ) => boolean)
    | undefined
  >;

  /**
   * Voxel-edit patch-overlay hook. When defined and the inner value is
   * non-`undefined`, the base segmentation render layer samples the
   * provider's per-chunk patched-mask 3D texture (R8UI) and `discard`s
   * fragments at voxels the user has edited — leaving the active session's
   * `PatchedSegmentationRenderLayer` as the sole source of truth for those
   * voxels' appearance. This is what makes erase actually erase: the
   * baseline segment is hidden, the patch layer emits transparent, and the
   * image layer behind shows through at its natural opacity.
   *
   * When this field is omitted (the default — every non-session viewer
   * mount) the render path is byte-identical to the pre-hook implementation:
   * no extra sampler, no discard branch in the shader.
   *
   * Wired by the segmentation user layer from
   * `viewer.editSessionHost.getPatchOverlayWatchableForLayer(this.name)`.
   * Same wiring pattern as `editBboxLoHi`.
   */
  editPatchOverlay?: WatchableValueInterface<PatchedMaskProvider | undefined>;
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
  /**
   * Voxel-edit patch-overlay shader path gate. Defaults to `false`; flips
   * to `true` only when an active session's `PatchedSegmentationRenderLayer`
   * has registered a `PatchedMaskProvider` on `displayState.editPatchOverlay`.
   * When `false`, no patched-mask sampler is added and the shader is
   * byte-identical to the pre-hook implementation.
   */
  editPatchOverlayActive: boolean;
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

  // Patch-overlay shader hook state. The sampler unit symbols are reused
  // across shader recompiles. The two textures are bound only when
  // `editPatchOverlayActive`; for chunks without patches, the provider's
  // fallback path binds a 1×1×1 zero mask + 1×1×1 zero value, so the
  // shader reads patched=0 and falls through to the baseline chunk value
  // — byte-identical to the pre-hook implementation.
  //
  // The allocated texture-unit indices are NOT stored on the instance — they
  // are read from the active shader program at draw time (`onBeginChunk`),
  // because the compiled shader is shared across render-layer instances
  // (TM-303).
  private static readonly patchedMaskSamplerSymbol = Symbol(
    "SegmentationRenderLayer.patchedMaskSampler",
  );
  private static readonly patchValueSamplerSymbol = Symbol(
    "SegmentationRenderLayer.patchValueSampler",
  );

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
        // Same compile-out pattern as `editBboxActive`: flips true only
        // when an active session has registered a `PatchedMaskProvider`.
        editPatchOverlayActive:
          displayState.editPatchOverlay === undefined
            ? constantWatchableValue(false)
            : refCounted.registerDisposer(
                makeCachedDerivedWatchableValue(
                  (provider) => provider !== undefined,
                  [displayState.editPatchOverlay],
                ),
              ),
      })),
      transform: displayState.transform,
      renderScaleHistogram: displayState.renderScaleHistogram,
      renderScaleTarget: displayState.renderScaleTarget,
      localPosition: displayState.localPosition,
      allowedSourcePredicate: displayState.allowedSourcePredicate,
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
    // Patch-overlay redraw plumbing.
    //
    // When the user paints / erases, the provider's underlying
    // `LocalPatchStore` mutates and dispatches its own `changed` signal,
    // which the provider re-dispatches via its `changed` member. Without
    // an explicit subscription here, the base render layer would never
    // know to redraw and the stroke would only appear at the next
    // incidental redraw (camera move, etc.). The old
    // `PatchedSegmentationRenderLayer` carried this subscription
    // implicitly; collapsing it into this layer requires we wire the
    // signal ourselves.
    //
    // The provider reference can swap (session open / close / commit), so
    // we re-subscribe whenever `displayState.editPatchOverlay.value`
    // changes. The detacher closure is captured at subscribe time and
    // called before the new subscription is wired.
    if (displayState.editPatchOverlay !== undefined) {
      const editPatchOverlay = displayState.editPatchOverlay;
      let unsubscribeProvider: (() => void) | undefined;
      const updateProviderSubscription = () => {
        if (unsubscribeProvider !== undefined) {
          unsubscribeProvider();
          unsubscribeProvider = undefined;
        }
        const provider = editPatchOverlay.value;
        if (provider !== undefined) {
          unsubscribeProvider = provider.changed.add(
            this.redrawNeeded.dispatch,
          );
        }
      };
      updateProviderSubscription();
      this.registerDisposer(
        editPatchOverlay.changed.add(updateProviderSubscription),
      );
      this.registerDisposer(() => {
        if (unsubscribeProvider !== undefined) {
          unsubscribeProvider();
          unsubscribeProvider = undefined;
        }
      });
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
   * Patch-aware CPU value lookup for hover / pick / status-bar consumers.
   *
   * In slice view, the segmentation layer doesn't write into the GPU
   * picking framebuffer — so `mouseState.value` is resolved CPU-side by
   * walking visible sources and calling `source.getValueAt(...)`, which
   * reads BASELINE chunks only. With patches active, that produced a
   * mismatch: GPU rendered the patch value (segment N), CPU pick saw
   * the baseline value (segment M), and the highlight uniform
   * `uSelectedSegment` pointed at M — so hovering an edited voxel
   * highlighted a different segment than the one displayed there. We
   * intercept here and consult the patch provider first; on a hit, the
   * patched bigint wins. The cast to `any` matches the parent
   * `getValueAt` return contract.
   */
  override getValueAt(globalPosition: Float32Array): any {
    const provider = this.displayState.editPatchOverlay?.value;
    if (provider === undefined) {
      return super.getValueAt(globalPosition);
    }
    const scratch = this.patchedValueAtScratch;
    for (const { source, chunkTransform } of this.visibleSourcesList) {
      if (scratch.length !== chunkTransform.layerRank) {
        this.patchedValueAtScratch = new Float32Array(chunkTransform.layerRank);
      }
      const chunkPosition = this.patchedValueAtScratch;
      if (
        !getChunkPositionFromCombinedGlobalLocalPositions(
          chunkPosition,
          globalPosition,
          this.localPosition.value,
          chunkTransform.layerRank,
          chunkTransform.combinedGlobalLocalToChunkTransform,
        )
      ) {
        continue;
      }
      const chunkDataSize = source.spec.chunkDataSize;
      if (chunkDataSize.length < 3) continue;
      const sx = chunkDataSize[0];
      const sy = chunkDataSize[1];
      const sz = chunkDataSize[2];
      const vx = chunkPosition[0];
      const vy = chunkPosition[1];
      const vz = chunkPosition[2];
      const gx = Math.floor(vx / sx);
      const gy = Math.floor(vy / sy);
      const gz = Math.floor(vz / sz);
      const lx = Math.floor(vx - sx * gx);
      const ly = Math.floor(vy - sy * gy);
      const lz = Math.floor(vz - sz * gz);
      // Out-of-chunk-range guards (parity with VolumeChunkSource.getValueAt).
      if (lx < 0 || ly < 0 || lz < 0 || lx >= sx || ly >= sy || lz >= sz) {
        continue;
      }
      const patched = provider.getPatchedValueAt([gx, gy, gz], [lx, ly, lz]);
      if (patched !== undefined) {
        return patched;
      }
      const baseline = source.getValueAt(chunkPosition, chunkTransform);
      if (baseline != null) {
        return baseline;
      }
    }
    return null;
  }

  // Scratch buffer for `getValueAt`'s chunk-position computation. Resized
  // lazily to the current source's `layerRank`; the parent class uses a
  // similar private field but it isn't accessible from a subclass.
  private patchedValueAtScratch = new Float32Array(0);

  /**
   * Emit GLSL for the per-fragment uint64 segment-id lookup. When the
   * patch-overlay shader path is active, the lookup samples the
   * patched-mask first and SUBSTITUTES the per-voxel patch value at edited
   * voxels — so every downstream branch (hover highlight, selected-segment
   * highlight, equivalences, stated colors, `hideSegmentZero`) runs
   * uniformly over baseline and patched voxels. That uniformity is what
   * fixes the prior "hovered segment shows two shades" bug: the patched
   * region used to take a separate render layer with no hover logic; now
   * it goes through the same shader as everything else.
   *
   * The erase semantic also falls out for free: a patched voxel with
   * value 0 hits the existing `hideSegmentZero` path and emits transparent
   * — image layer underneath shows through at full opacity.
   */
  protected defineGetUint64DataValue(
    builder: ShaderBuilder,
    withPatchOverlay: boolean,
  ) {
    if (withPatchOverlay) {
      builder.addFragmentCode(`
uint64_t getUint64DataValue() {
  highp ivec3 patchedP = ivec3(max(vec3(0.0, 0.0, 0.0), min(floor(vChunkPosition), uChunkDataSize - 1.0)));
  uint patched = texelFetch(uPatchedMaskSampler, patchedP, 0).r;
  if (patched != 0u) {
    highp uvec4 raw = texelFetch(uPatchValueSampler, patchedP, 0);
    uint64_t v;
    v.value = uvec2(raw.r, raw.g);
    return v;
  }
  return toUint64(getDataValue());
}
`);
    } else {
      builder.addFragmentCode(`
uint64_t getUint64DataValue() {
  uint64_t x = toUint64(getDataValue());
  return x;
}
`);
    }
  }

  defineShader(builder: ShaderBuilder, parameters: ShaderParameters) {
    this.hashTableManager.defineShader(builder);
    // Patch-overlay samplers MUST be added before `defineGetUint64DataValue`
    // emits the function that calls `texelFetch(uPatch*Sampler, ...)` — the
    // shader builder records uniform declarations in addition order. The
    // allocated unit indices are recovered at draw time via
    // `shader.textureUnit(symbol)` (see `onBeginChunk`); we deliberately do NOT
    // cache them in instance fields, because this compiled shader is shared
    // across `SegmentationRenderLayer` instances and `defineShader` runs only
    // for the one that triggers the build (TM-303).
    if (parameters.editPatchOverlayActive) {
      builder.addTextureSampler(
        "usampler3D",
        "uPatchedMaskSampler",
        SegmentationRenderLayer.patchedMaskSamplerSymbol,
      );
      builder.addTextureSampler(
        "usampler3D",
        "uPatchValueSampler",
        SegmentationRenderLayer.patchValueSamplerSymbol,
      );
    }
    this.defineGetUint64DataValue(builder, parameters.editPatchOverlayActive);
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
    // The patch overlay is no longer surfaced via a separate discard
    // branch here: `defineGetUint64DataValue` returns the patch value
    // directly when this voxel is patched, so the rest of the shader
    // (hover, selected, equivalences, stated colors, `hideSegmentZero`)
    // applies uniformly across baseline and patched voxels.
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
    // Bbox-clip uniforms are bound only when the bbox-clip shader path was
    // compiled (`editBboxActive === true`). Otherwise the uniforms don't
    // exist on the shader at all.
    //
    // Picking-pass safety: `SliceViewVolumeRenderLayer.draw` is invoked
    // only from `SliceView.updateRendering` (color into the sliceView
    // offscreen buffer); the panel-level picking pass goes through
    // `SliceViewPanelRenderLayer` subclasses (annotation/cursor overlays),
    // which do NOT invoke this volume layer. There is therefore no
    // separate picking-pass shader for this layer to clip.
    if (parameters.editBboxActive) {
      this.bboxAlphaHook.bind(gl, shader, {
        bboxNm: displayState.editBboxLoHi?.value,
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

  protected override onBeginChunk(
    gl: GL,
    shader: ShaderProgram,
    chunk: VolumeChunk,
  ) {
    // Bind both patch-overlay samplers (mask + value) for the current chunk.
    //
    // The texture-unit indices are read from the ACTIVE SHADER PROGRAM, not
    // from instance fields. The base layer memoizes its compiled shader per
    // *class* + parameters (`parameterizedContextDependentShaderGetter`,
    // `memoizeKey: volume/RenderLayer:<constructorId>`), so two
    // `SegmentationRenderLayer` instances with identical parameters SHARE one
    // program. `defineShader` runs only on the cache-miss (the first instance),
    // so a per-instance unit field set there would be `undefined` on a second
    // writable layer reusing the shared program — it would never sample the
    // patch and its strokes would render nowhere (TM-303). Reading the unit
    // off the program is correct for every instance that draws with it.
    //
    // `textureUnit` returns `undefined` for a shader compiled WITHOUT the patch
    // path (no active session) — that keeps non-session renders byte-identical
    // to the pre-hook implementation.
    const maskUnit: number | undefined = shader.textureUnit(
      SegmentationRenderLayer.patchedMaskSamplerSymbol,
    );
    const valueUnit: number | undefined = shader.textureUnit(
      SegmentationRenderLayer.patchValueSamplerSymbol,
    );
    if (maskUnit === undefined || valueUnit === undefined) {
      return;
    }
    const provider = this.displayState.editPatchOverlay?.value;
    if (provider === undefined) return;
    const prevActive = gl.getParameter(
      WebGL2RenderingContext.ACTIVE_TEXTURE,
    ) as number;
    // The provider handles its own zero-fallback when no patches exist
    // for the chunk, so callers don't need to branch on a return value.
    provider.bindPatchedMaskTexture(gl, maskUnit, chunk.chunkGridPosition);
    provider.bindPatchValueTexture(gl, valueUnit, chunk.chunkGridPosition);
    gl.activeTexture(prevActive);
  }
}
