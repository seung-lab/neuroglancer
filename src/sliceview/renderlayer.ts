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

import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { ChunkRenderLayerFrontend } from "#src/chunk_manager/frontend.js";
import type { CoordinateSpace } from "#src/coordinate_transform.js";
import type { VisibleLayerInfo } from "#src/layer/index.js";
import type {
  ChunkTransformParameters,
  RenderLayerTransformOrError,
} from "#src/render_coordinate_transform.js";
import type { RenderScaleHistogram } from "#src/render_scale_statistics.js";
import { trackableRenderScaleTarget } from "#src/render_scale_statistics.js";
import type {
  ThreeDimensionalReadyRenderContext,
  ThreeDimensionalRenderContext,
} from "#src/renderlayer.js";
import { RenderLayer, VisibilityTrackedRenderLayer } from "#src/renderlayer.js";
import { SharedWatchableValue } from "#src/shared_watchable_value.js";
import type {
  SliceViewBase,
  SliceViewProjectionParameters,
  SliceViewSourceOptions,
  TransformedSource,
} from "#src/sliceview/base.js";
import {
  filterVisibleSources,
  SLICEVIEW_RENDERLAYER_RPC_ID,
} from "#src/sliceview/base.js";
import type {
  MultiscaleSliceViewChunkSource,
  SliceView,
  SliceViewChunkSource,
  SliceViewSingleResolutionSource,
} from "#src/sliceview/frontend.js";
import type { SliceViewPanel } from "#src/sliceview/panel.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { constantWatchableValue } from "#src/trackable_value.js";
import type { Borrowed } from "#src/util/disposable.js";
import { HistogramSpecifications } from "#src/webgl/empirical_cdf.js";
import type { ShaderModule } from "#src/webgl/shader.js";
import type { RpcId } from "#src/worker_rpc.js";

export interface SliceViewRenderLayerOptions {
  /**
   * Specifies the transform from the "model" coordinate space (specified by the multiscale source)
   * to the "render layer" coordinate space.
   */
  transform: WatchableValueInterface<RenderLayerTransformOrError>;
  renderScaleTarget?: WatchableValueInterface<number>;
  renderScaleHistogram?: RenderScaleHistogram;

  /**
   * Specifies the position within the "local" coordinate space.
   */
  localPosition: WatchableValueInterface<Float32Array>;
  dataHistogramSpecifications?: HistogramSpecifications;

  rpcTransfer?: { [index: string]: number | string | null };

  /**
   * Optional source-allow-list filter. When the watchable holds a function,
   * `SliceViewRenderLayer.getSources()` returns only the per-scale sources
   * for which the predicate returns true; when `undefined` no filtering is
   * applied. Used by the edit-session host to restrict displayed scales to
   * the user-selected resolutions while a session is active. Changes to the
   * watchable invalidate the SliceView's cached transformedSources.
   */
  allowedSourcePredicate?: WatchableValueInterface<
    | ((
        source: SliceViewSingleResolutionSource<SliceViewChunkSource>,
      ) => boolean)
    | undefined
  >;
}

export interface VisibleSourceInfo<Source extends SliceViewChunkSource> {
  source: Borrowed<Source>;
  refCount: number;
  chunkTransform: ChunkTransformParameters;
}

export interface SliceViewRenderContext {
  sliceView: SliceView;
  projectionParameters: SliceViewProjectionParameters;
  wireFrame: boolean;
}

export abstract class SliceViewRenderLayer<
  Source extends SliceViewChunkSource = SliceViewChunkSource,
  SourceOptions extends SliceViewSourceOptions = SliceViewSourceOptions,
> extends RenderLayer {
  rpcId: RpcId | null = null;
  rpcTransfer: { [index: string]: number | string | null } = {};

  localPosition: WatchableValueInterface<Float32Array>;
  channelCoordinateSpace: WatchableValueInterface<CoordinateSpace>;
  transform: WatchableValueInterface<RenderLayerTransformOrError>;

  renderScaleTarget: WatchableValueInterface<number>;
  renderScaleHistogram?: RenderScaleHistogram;

  // This is only used by `ImageRenderLayer` currently, but is defined here because
  // `sliceview/frontend.ts` is responsible for providing the texture buffers used for accumulating
  // histograms.
  dataHistogramSpecifications: HistogramSpecifications;

  getDataHistogramCount() {
    return this.dataHistogramSpecifications.visibleHistograms;
  }

  /**
   * Currently visible sources for this render layer.
   */
  private visibleSources = new Map<
    Borrowed<Source>,
    VisibleSourceInfo<Source>
  >();

  /**
   * Cached list of sources in `visibleSources`, ordered by voxel size.
   *
   * Truncated to zero length when `visibleSources` changes to indicate that it is invalid.
   */
  private visibleSourcesList_: VisibleSourceInfo<Source>[] = [];

  /**
   * Optional per-source allow-list filter. Mirrors
   * `SliceViewRenderLayerOptions.allowedSourcePredicate`.
   */
  allowedSourcePredicate?: WatchableValueInterface<
    | ((
        source: SliceViewSingleResolutionSource<SliceViewChunkSource>,
      ) => boolean)
    | undefined
  >;

  /**
   * Bumped whenever `allowedSourcePredicate.value` changes. Combined with
   * `transform.changed.count` into `sourcesGeneration`, which the SliceView
   * uses as the cache key for the per-render-layer `allSources` array.
   */
  private allowedSourcesGeneration = 0;

  /**
   * Cache-key for `SliceView.getTransformedSources` invalidation. Bumps when
   * either the layer transform changes OR the optional source-allow-list
   * predicate changes.
   */
  get sourcesGeneration(): number {
    return this.transform.changed.count + this.allowedSourcesGeneration;
  }

  getSources(
    options: SliceViewSourceOptions,
  ): SliceViewSingleResolutionSource<Source>[][] {
    const result = this.multiscaleSource.getSources(options as any);
    const predicate = this.allowedSourcePredicate?.value;
    if (predicate === undefined) return result;
    return result.map((perScale) => {
      const filtered = perScale.filter((s) =>
        predicate(s as SliceViewSingleResolutionSource<SliceViewChunkSource>),
      );
      // Fail open: never let the allow-list filter a scale list down to
      // *nothing* — an empty source list renders a blank layer. The
      // edit-session allow-list is built once at session-open from a
      // separate `getSources()` call (`NgLayerMetadataSource`), so a live
      // view that requests an orientation/scale whose canonicalized
      // resolution wasn't in that set would otherwise blank the layer
      // entirely ("chunks disappear"). Falling back to the unfiltered list
      // keeps the lock active whenever at least one allowed scale matches,
      // and only relaxes it in the case that would render nothing — showing
      // the wrong scale beats showing nothing.
      return filtered.length > 0 ? filtered : perScale;
    });
  }

  addSource(
    source: Borrowed<Source>,
    chunkTransform: ChunkTransformParameters,
  ) {
    const { visibleSources } = this;
    const info = visibleSources.get(source);
    if (info !== undefined) {
      ++info.refCount;
      info.chunkTransform = chunkTransform;
    } else {
      visibleSources.set(source, { source, refCount: 1, chunkTransform });
      this.visibleSourcesList_.length = 0;
    }
  }

  removeSource(source: Borrowed<Source>) {
    const { visibleSources } = this;
    const info = visibleSources.get(source)!;
    if (info.refCount !== 1) {
      --info.refCount;
    } else {
      visibleSources.delete(source);
      this.visibleSourcesList_.length = 0;
    }
  }

  get visibleSourcesList() {
    const { visibleSources, visibleSourcesList_ } = this;
    if (visibleSourcesList_.length === 0 && visibleSources.size !== 0) {
      for (const info of visibleSources.values()) {
        visibleSourcesList_.push(info);
      }
      // Sort by volume scaling factor.
      visibleSourcesList_.sort((a, b) => {
        return (
          Math.abs(a.chunkTransform.chunkToLayerTransformDet) -
          Math.abs(b.chunkTransform.chunkToLayerTransformDet)
        );
      });
    }
    return visibleSourcesList_;
  }

  constructor(
    public chunkManager: ChunkManager,
    public multiscaleSource: MultiscaleSliceViewChunkSource<
      Source,
      SourceOptions
    >,
    options: SliceViewRenderLayerOptions,
  ) {
    super();

    const { renderScaleTarget = trackableRenderScaleTarget(1) } = options;
    this.renderScaleTarget = renderScaleTarget;
    this.renderScaleHistogram = options.renderScaleHistogram;
    this.transform = options.transform;
    this.localPosition = options.localPosition;
    this.rpcTransfer = options.rpcTransfer || {};
    this.dataHistogramSpecifications = this.registerDisposer(
      options.dataHistogramSpecifications ??
        new HistogramSpecifications(
          constantWatchableValue([]),
          constantWatchableValue([]),
          constantWatchableValue([]),
        ),
    );
    this.registerDisposer(
      this.dataHistogramSpecifications.visibility.changed.add(
        this.redrawNeeded.dispatch,
      ),
    );
    if (options.allowedSourcePredicate !== undefined) {
      this.allowedSourcePredicate = options.allowedSourcePredicate;
      // Bump the cache-invalidation generation so the SliceView re-runs
      // getTransformedSources(); the SliceView also subscribes directly to
      // invalidate its allSources entry (see `bindVisibleRenderLayer`).
      this.registerDisposer(
        options.allowedSourcePredicate.changed.add(() => {
          ++this.allowedSourcesGeneration;
        }),
      );
    }
  }

  declare RPC_TYPE_ID: string;

  initializeCounterpart() {
    const sharedObject = this.registerDisposer(
      new ChunkRenderLayerFrontend(this.layerChunkProgressInfo),
    );
    const rpc = this.chunkManager.rpc!;
    sharedObject.RPC_TYPE_ID = this.RPC_TYPE_ID;
    sharedObject.initializeCounterpart(rpc, {
      localPosition: this.registerDisposer(
        SharedWatchableValue.makeFromExisting(rpc, this.localPosition),
      ).rpcId,
      renderScaleTarget: this.registerDisposer(
        SharedWatchableValue.makeFromExisting(rpc, this.renderScaleTarget),
      ).rpcId,
      ...this.rpcTransfer,
    });
    this.rpcId = sharedObject.rpcId;
  }

  get gl() {
    return this.chunkManager.chunkQueueManager.gl;
  }

  setGLBlendMode(gl: WebGL2RenderingContext, renderLayerNum: number): void {
    // Default blend mode for non-blend-mode-aware layers
    if (renderLayerNum > 0) {
      gl.enable(WebGL2RenderingContext.BLEND);
      gl.blendFunc(
        WebGL2RenderingContext.SRC_ALPHA,
        WebGL2RenderingContext.ONE_MINUS_SRC_ALPHA,
      );
    } else {
      gl.disable(WebGL2RenderingContext.BLEND);
    }
  }

  abstract draw(renderContext: SliceViewRenderContext): void;

  filterVisibleSources(
    sliceView: SliceViewBase,
    sources: readonly TransformedSource[],
  ): Iterable<TransformedSource> {
    return filterVisibleSources(sliceView, this, sources);
  }
}

SliceViewRenderLayer.prototype.RPC_TYPE_ID = SLICEVIEW_RENDERLAYER_RPC_ID;

export interface SliceViewPanelReadyRenderContext
  extends ThreeDimensionalReadyRenderContext {
  sliceView: SliceView;
}

export interface SliceViewPanelRenderContext
  extends SliceViewPanelReadyRenderContext,
    ThreeDimensionalRenderContext {
  emitter: ShaderModule;

  /**
   * Specifies whether the emitted color value will be used.
   */
  emitColor: boolean;

  /**
   * Specifies whether the emitted pick ID will be used.
   */
  emitPickID: boolean;
}

export class SliceViewPanelRenderLayer<
  AttachmentState = unknown,
> extends VisibilityTrackedRenderLayer {
  draw(
    renderContext: SliceViewPanelRenderContext,
    attachment: VisibleLayerInfo<SliceViewPanel, AttachmentState>,
  ) {
    renderContext;
    attachment;
    // Must be overridden by subclasses.
  }

  isReady(
    renderContext: SliceViewPanelReadyRenderContext,
    attachment: VisibleLayerInfo<SliceViewPanel, AttachmentState>,
  ) {
    renderContext;
    attachment;
    return true;
  }
}
