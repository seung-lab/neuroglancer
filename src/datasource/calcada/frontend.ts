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

import "#src/datasource/calcada/calcada.css";
import { debounce } from "lodash-es";
import {
  AnnotationDisplayState,
  AnnotationLayerState,
} from "#src/annotation/annotation_layer_state.js";
import type { MultiscaleAnnotationSource } from "#src/annotation/frontend_source.js";
import type {
  Annotation,
  AnnotationReference,
  AnnotationSource,
  Line,
  Point,
} from "#src/annotation/index.js";
import {
  AnnotationType,
  LocalAnnotationSource,
  makeDataBoundsBoundingBoxAnnotationSet,
} from "#src/annotation/index.js";
import { LayerChunkProgressInfo } from "#src/chunk_manager/base.js";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { WithParameters } from "#src/chunk_manager/frontend.js";
import { makeIdentityTransform } from "#src/coordinate_transform.js";
import type {
  ChunkedGraphChunkSource as ChunkedGraphChunkSourceInterface,
  ChunkedGraphChunkSpecification,
  HttpSource,
  MultiscaleMeshMetadata,
} from "#src/datasource/calcada/base.js";
import {
  parseGrapheneError,
  CHUNKED_GRAPH_LAYER_RPC_ID,
  CHUNKED_GRAPH_RENDER_LAYER_UPDATE_SOURCES_RPC_ID,
  ChunkedGraphSourceParameters,
  getGrapheneFragmentKey,
  GRAPHENE_MESH_NEW_SEGMENT_RPC_ID,
  CALCADA_BULK_LINK_RPC_ID,
  isBaseSegmentId,
  makeChunkedGraphChunkSpecification,
  MeshSourceParameters,
  PYCG_APP_VERSION,
  VolumeChunkSourceParameters as CalcadaVolumeChunkSourceParameters,
  getHttpSource,
} from "#src/datasource/calcada/base.js";
import type {
  DataSource,
  DataSourceLookupResult,
  DataSubsourceEntry,
  GetKvStoreBasedDataSourceOptions,
  KvStoreBasedDataSourceProvider,
} from "#src/datasource/index.js";
import type { ShardingParameters } from "#src/datasource/precomputed/base.js";
import {
  DataEncoding,
  ShardingHashFunction,
} from "#src/datasource/precomputed/base.js";
import type { MultiscaleVolumeInfo } from "#src/datasource/precomputed/frontend.js";
import {
  getSegmentPropertyMap,
  parseMultiscaleVolumeInfo,
  PrecomputedMultiscaleVolumeChunkSource,
} from "#src/datasource/precomputed/frontend.js";
import { WithSharedKvStoreContext } from "#src/kvstore/chunk_source_frontend.js";
import type { SharedKvStoreContext } from "#src/kvstore/frontend.js";
import {
  ensureEmptyUrlSuffix,
  kvstoreEnsureDirectoryPipelineUrl,
  pipelineUrlJoin,
} from "#src/kvstore/url.js";
import { ImageUserLayer } from "#src/layer/image/index.js";
import type {
  LayerView,
  MouseSelectionState,
  VisibleLayerInfo,
} from "#src/layer/index.js";
import { makeLayer } from "#src/layer/index.js";
import type { LoadedDataSubsource } from "#src/layer/layer_data_source.js";
import { LoadedLayerDataSource } from "#src/layer/layer_data_source.js";
import { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import { MeshSource } from "#src/mesh/frontend.js";
import type { DisplayDimensionRenderInfo } from "#src/navigation_state.js";
import type {
  ChunkTransformParameters,
  RenderLayerTransformOrError,
} from "#src/render_coordinate_transform.js";
import {
  getChunkPositionFromCombinedGlobalLocalPositions,
  getChunkTransformParameters,
} from "#src/render_coordinate_transform.js";
import type { RenderLayer } from "#src/renderlayer.js";
import { RenderLayerRole } from "#src/renderlayer.js";
import type {
  SegmentationDisplayState3D,
  Uint64MapEntry,
} from "#src/segmentation_display_state/frontend.js";
import {
  augmentSegmentId,
  resetTemporaryVisibleSegmentsState,
  SegmentationLayerSharedObject,
  SegmentWidgetFactory,
} from "#src/segmentation_display_state/frontend.js";
import { VisibleSegmentEquivalencePolicy } from "#src/segmentation_graph/segment_id.js";
import type {
  ComputedSplit,
  SegmentationGraphSourceTab,
} from "#src/segmentation_graph/source.js";
import {
  SegmentationGraphSource,
  SegmentationGraphSourceConnection,
} from "#src/segmentation_graph/source.js";
import type { SharedDisjointUint64Sets } from "#src/shared_disjoint_sets.js";
import { SharedWatchableValue } from "#src/shared_watchable_value.js";
import type {
  FrontendTransformedSource,
  SliceViewSingleResolutionSource,
} from "#src/sliceview/frontend.js";
import {
  getVolumetricTransformedSources,
  serializeAllTransformedSources,
  SliceViewChunkSource,
} from "#src/sliceview/frontend.js";
import {
  SliceViewPanelRenderLayer,
  SliceViewRenderLayer,
} from "#src/sliceview/renderlayer.js";
import type { VolumeSourceOptions } from "#src/sliceview/volume/base.js";
import { makeDefaultVolumeChunkSpecifications } from "#src/sliceview/volume/base.js";
import { VolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import { StatusMessage } from "#src/status.js";
import {
  TrackableBoolean,
  TrackableBooleanCheckbox,
} from "#src/trackable_boolean.js";
import type {
  NestedStateManager,
  WatchableValueInterface,
} from "#src/trackable_value.js";
import {
  makeCachedLazyDerivedWatchableValue,
  registerNested,
  TrackableValue,
  WatchableSet,
  WatchableValue,
} from "#src/trackable_value.js";
import {
  AnnotationLayerView,
  makeAnnotationListElement,
  MergedAnnotationStates,
  PlaceLineTool,
} from "#src/ui/annotations.js";
import { getDefaultAnnotationListBindings } from "#src/ui/default_input_event_bindings.js";
import type { ToolActivation } from "#src/ui/tool.js";
import {
  LayerTool,
  makeToolActivationStatusMessageWithHeader,
  makeToolButton,
  registerLegacyTool,
  registerTool,
} from "#src/ui/tool.js";
import { Uint64Set } from "#src/uint64_set.js";
import { transposeNestedArrays } from "#src/util/array.js";
import { packColor } from "#src/util/color.js";
import type { Owned } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import { removeChildren } from "#src/util/dom.js";
import type { ValueOrError } from "#src/util/error.js";
import { makeValueOrError, valueOrThrow } from "#src/util/error.js";
import { EventActionMap } from "#src/util/event_action_map.js";
import { mat4, vec3, vec4 } from "#src/util/geom.js";
import { fetchOk, HttpError } from "#src/util/http_request.js";
import {
  parseArray,
  parseFixedLengthArray,
  parseUint64,
  verify3dVec,
  verifyBoolean,
  verifyEnumString,
  verifyFiniteFloat,
  verifyFinitePositiveFloat,
  verifyFloatArray,
  verifyInt,
  verifyIntegerArray,
  verifyNonnegativeInt,
  verifyObject,
  verifyObjectProperty,
  verifyOptionalObjectProperty,
  verifyOptionalString,
  verifyPositiveInt,
  verifyString,
  verifyStringArray,
} from "#src/util/json.js";
import { MouseEventBinder } from "#src/util/mouse_bindings.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import { ProgressSpan } from "#src/util/progress_listener.js";
import { NullarySignal } from "#src/util/signal.js";
import type { Trackable } from "#src/util/trackable.js";
import { DateTimeInputWidget } from "#src/widget/datetime.js";
import { makeDeleteButton } from "#src/widget/delete_button.js";
import type { DependentViewContext } from "#src/widget/dependent_view_widget.js";
import { makeIcon } from "#src/widget/icon.js";
import type { LayerControlFactory } from "#src/widget/layer_control.js";
import {
  addLayerControlToOptionsTab,
  registerLayerControl,
} from "#src/widget/layer_control.js";
import type { RPC } from "#src/worker_rpc.js";
import { registerRPC } from "#src/worker_rpc.js";

function vec4FromVec3(vec: vec3, alpha = 0) {
  const res = vec4.clone([...vec]);
  res[3] = alpha;
  return res;
}

const RED_COLOR = vec3.fromValues(1, 0, 0);
const BLUE_COLOR = vec3.fromValues(0, 0, 1);
const RED_COLOR_SEGMENT = vec4FromVec3(RED_COLOR, 0.5);
const BLUE_COLOR_SEGMENT = vec4FromVec3(BLUE_COLOR, 0.5);
const RED_COLOR_HIGHLIGHT = vec4FromVec3(RED_COLOR, 0.25);
const BLUE_COLOR_HIGHTLIGHT = vec4FromVec3(BLUE_COLOR, 0.25);
const TRANSPARENT_COLOR = vec4.fromValues(0.5, 0.5, 0.5, 0.01);
const RED_COLOR_SEGMENT_PACKED = BigInt(packColor(RED_COLOR_SEGMENT));
const BLUE_COLOR_SEGMENT_PACKED = BigInt(packColor(BLUE_COLOR_SEGMENT));
const TRANSPARENT_COLOR_PACKED = BigInt(packColor(TRANSPARENT_COLOR));
const MULTICUT_OFF_COLOR = vec4.fromValues(0, 0, 0, 0.5);
const WHITE_COLOR = vec3.fromValues(1, 1, 1);

class GrapheneMeshSource extends WithParameters(
  WithSharedKvStoreContext(MeshSource),
  MeshSourceParameters,
) {
  // Live branch value shared with the backend counterpart. parameters.branchId
  // only captures the branch at datasource-creation time; switching branches
  // via the Graph-tab dropdown mutates GrapheneState.branchId on the same
  // datasource, and manifest requests must follow it or they resolve against
  // main and return empty piece lists for branch-only roots.
  private readonly liveBranchId: WatchableValueInterface<number> | undefined;

  constructor(chunkManager: ChunkManager, options: any) {
    super(chunkManager, options);
    this.liveBranchId = options.branchId;
  }

  initializeCounterpart(rpc: RPC, options: any) {
    if (this.liveBranchId !== undefined) {
      options.branchId = this.registerDisposer(
        SharedWatchableValue.makeFromExisting(rpc, this.liveBranchId),
      ).rpcId;
    }
    super.initializeCounterpart(rpc, options);
  }

  getFragmentKey(objectKey: string | null, fragmentId: string) {
    objectKey;
    return getGrapheneFragmentKey(fragmentId);
  }
}

class AppInfo {
  segmentationUrl: string;
  meshingUrl: string;
  l2CacheUrl: string;
  table: string;
  supported_api_versions: number[];
  constructor(infoUrl: string, obj: any) {
    // .../1.0/... is the legacy link style
    // .../table/... is the current, version agnostic link style (for retrieving the info file)
    const linkStyle =
      /^((?:middleauth\+)?)(https?:\/\/[.\w:\-/]+)\/segmentation\/(?:1\.0|table)\/([^/]+)\/?$/;
    const match = infoUrl.match(linkStyle);
    if (match === null) {
      throw Error(`Graph URL invalid: ${infoUrl}`);
    }
    this.table = match[3];
    const { table } = this;
    this.segmentationUrl = `${match[1]}${match[2]}/segmentation/api/v${PYCG_APP_VERSION}/table/${table}`;
    this.meshingUrl = `${match[1]}${match[2]}/meshing/api/v${PYCG_APP_VERSION}/table/${table}`;
    this.l2CacheUrl = `${match[2]}/l2cache/api/v${PYCG_APP_VERSION}`;

    try {
      verifyObject(obj);
      this.supported_api_versions = verifyObjectProperty(
        obj,
        "supported_api_versions",
        (x) => parseArray(x, verifyNonnegativeInt),
      );
    } catch {
      // Dealing with a prehistoric graph server with no version information
      this.supported_api_versions = [0];
    }
    if (this.supported_api_versions.includes(PYCG_APP_VERSION) === false) {
      const redirectMsg = `This Neuroglancer branch requires Graph Server version ${PYCG_APP_VERSION}, but the server only supports version(s) ${this.supported_api_versions}.`;
      throw new Error(redirectMsg);
    }
  }
}

const N_BITS_FOR_LAYER_ID_DEFAULT = 8;

class GraphInfo {
  chunkSize: vec3;
  nBitsForLayerId: number;
  constructor(obj: any) {
    verifyObject(obj);
    this.chunkSize = verifyObjectProperty(obj, "chunk_size", (x) =>
      parseFixedLengthArray(vec3.create(), x, verifyPositiveInt),
    );
    this.nBitsForLayerId = verifyOptionalObjectProperty(
      obj,
      "n_bits_for_layer_id",
      verifyPositiveInt,
      N_BITS_FOR_LAYER_ID_DEFAULT,
    );
  }
}

interface GrapheneMultiscaleVolumeInfo extends MultiscaleVolumeInfo {
  dataUrl: string;
  app: AppInfo;
  graph: GraphInfo;
}

function parseGrapheneMultiscaleVolumeInfo(
  obj: unknown,
  url: string,
): GrapheneMultiscaleVolumeInfo {
  const volumeInfo = parseMultiscaleVolumeInfo(obj);
  const dataUrl = verifyObjectProperty(obj, "data_dir", verifyString);
  const app = verifyObjectProperty(obj, "app", (x) => new AppInfo(url, x));
  const graph = verifyObjectProperty(obj, "graph", (x) => new GraphInfo(x));
  return {
    ...volumeInfo,
    app,
    graph,
    dataUrl,
  };
}

// Frontend chunk source that pairs with CalcadaVolumeChunkSource backend.
// Uses the calcada RPC_ID ("graphene/VolumeChunkSource") so the backend
// can intercept downloads and extract the piece→root LUT trailer.
class CalcadaVolumeChunkSource extends WithParameters(
  WithSharedKvStoreContext(VolumeChunkSource),
  CalcadaVolumeChunkSourceParameters,
) {}

class GrapheneMultiscaleVolumeChunkSource extends PrecomputedMultiscaleVolumeChunkSource {
  // URL for the /precomputed_rp/ endpoint (piece_ids + LUT trailer)
  private rpUrl: string;

  timestampMs = 0;
  branchId = 0;
  generation = 0;

  constructor(
    sharedKvStoreContext: SharedKvStoreContext,
    public info: GrapheneMultiscaleVolumeInfo,
  ) {
    super(sharedKvStoreContext, info.dataUrl, info);
    // Build /precomputed_rp/ URL from raw data URL
    this.rpUrl = info.dataUrl.replace("/precomputed", "/precomputed_rp");
  }

  // Override to use CalcadaVolumeChunkSource (with LUT trailer handling)
  // pointing to /precomputed_rp/ endpoint.
  getSources(volumeSourceOptions: VolumeSourceOptions) {
    const modelResolution = this.info.scales[0].resolution;
    const { rank } = this;
    return transposeNestedArrays(
      this.info.scales
        .filter((x) => !x.hidden)
        .filter((x) => x.key !== "placeholder")
        .map((scaleInfo) => {
          const { resolution } = scaleInfo;
          const stride = rank + 1;
          const chunkToMultiscaleTransform = new Float32Array(stride * stride);
          chunkToMultiscaleTransform[chunkToMultiscaleTransform.length - 1] = 1;
          const { lowerBounds: baseLowerBound, upperBounds: baseUpperBound } =
            this.info.modelSpace.boundingBoxes[0].box;
          const lowerClipBound = new Float32Array(rank);
          const upperClipBound = new Float32Array(rank);
          for (let i = 0; i < 3; ++i) {
            const relativeScale = resolution[i] / modelResolution[i];
            chunkToMultiscaleTransform[stride * i + i] = relativeScale;
            const voxelOffsetValue = scaleInfo.voxelOffset[i];
            chunkToMultiscaleTransform[stride * rank + i] =
              voxelOffsetValue * relativeScale;
            lowerClipBound[i] =
              baseLowerBound[i] / relativeScale - voxelOffsetValue;
            upperClipBound[i] =
              baseUpperBound[i] / relativeScale - voxelOffsetValue;
          }
          return makeDefaultVolumeChunkSpecifications({
            rank,
            dataType: this.dataType,
            chunkToMultiscaleTransform,
            upperVoxelBound: scaleInfo.size,
            volumeType: this.volumeType,
            chunkDataSizes: scaleInfo.chunkSizes,
            baseVoxelOffset: scaleInfo.voxelOffset,
            compressedSegmentationBlockSize:
              scaleInfo.compressedSegmentationBlockSize,
            volumeSourceOptions,
          }).map(
            (spec): SliceViewSingleResolutionSource<VolumeChunkSource> => ({
              chunkSource: this.chunkManager.getChunkSource(
                CalcadaVolumeChunkSource,
                {
                  sharedKvStoreContext: this.sharedKvStoreContext,
                  spec,
                  parameters: {
                    url: kvstoreEnsureDirectoryPipelineUrl(
                      this.sharedKvStoreContext.kvStoreContext.resolveRelativePath(
                        this.rpUrl,
                        scaleInfo.key,
                      ),
                    ),
                    encoding: scaleInfo.encoding as number,
                    sharding: scaleInfo.sharding,
                    timestampMs: this.timestampMs,
                    branchId: this.branchId,
                    generation: this.generation,
                  },
                },
              ),
              chunkToMultiscaleTransform,
              lowerClipBound,
              upperClipBound,
            }),
          );
        }),
    );
  }

  getChunkedGraphSource() {
    const { rank } = this;
    const scaleInfo = this.info.scales[0];

    const spec = makeChunkedGraphChunkSpecification({
      rank,
      dataType: this.info.dataType,
      upperVoxelBound: scaleInfo.size,
      chunkDataSize: Uint32Array.from(this.info.graph.chunkSize),
      baseVoxelOffset: scaleInfo.voxelOffset,
    });

    const stride = rank + 1;
    const chunkToMultiscaleTransform = new Float32Array(stride * stride);
    chunkToMultiscaleTransform[chunkToMultiscaleTransform.length - 1] = 1;
    const { lowerBounds: baseLowerBound, upperBounds: baseUpperBound } =
      this.info.modelSpace.boundingBoxes[0].box;
    const lowerClipBound = new Float32Array(rank);
    const upperClipBound = new Float32Array(rank);

    for (let i = 0; i < 3; ++i) {
      const relativeScale = 1;
      chunkToMultiscaleTransform[stride * i + i] = relativeScale;
      chunkToMultiscaleTransform[stride * rank + i] = scaleInfo.voxelOffset[i];
      lowerClipBound[i] = baseLowerBound[i];
      upperClipBound[i] = baseUpperBound[i];
    }
    return {
      chunkSource: this.chunkManager.getChunkSource(
        GrapheneChunkedGraphChunkSource,
        {
          spec,
          sharedKvStoreContext: this.sharedKvStoreContext,
          parameters: { url: `${this.info.app!.segmentationUrl}/node` },
        },
      ),
      chunkToMultiscaleTransform,
      lowerClipBound,
      upperClipBound,
    };
  }
}

function parseTransform(data: any): mat4 {
  return verifyObjectProperty(data, "transform", (value) => {
    const transform = mat4.create();
    if (value !== undefined) {
      parseFixedLengthArray(
        transform.subarray(0, 12),
        value,
        verifyFiniteFloat,
      );
    }
    mat4.transpose(transform, transform);
    return transform;
  });
}

interface ParsedMeshMetadata {
  metadata: MultiscaleMeshMetadata | undefined;
  segmentPropertyMap?: string | undefined;
}

function parseMeshMetadata(data: any): ParsedMeshMetadata {
  verifyObject(data);
  const t = verifyObjectProperty(data, "@type", verifyString);
  let metadata: MultiscaleMeshMetadata | undefined;
  if (t === "neuroglancer_legacy_mesh") {
    metadata = undefined;
  } else if (t !== "neuroglancer_multilod_draco") {
    throw new Error(`Unsupported mesh type: ${JSON.stringify(t)}`);
  } else {
    const lodScaleMultiplier = verifyObjectProperty(
      data,
      "lod_scale_multiplier",
      verifyFinitePositiveFloat,
    );
    const vertexQuantizationBits = verifyObjectProperty(
      data,
      "vertex_quantization_bits",
      verifyPositiveInt,
    );
    const transform = parseTransform(data);
    const sharding = verifyObjectProperty(
      data,
      "sharding",
      parseGrapheneShardingParameters,
    );
    metadata = {
      lodScaleMultiplier,
      transform,
      sharding,
      vertexQuantizationBits,
    };
  }
  const segmentPropertyMap = verifyObjectProperty(
    data,
    "segment_properties",
    verifyOptionalString,
  );
  return { metadata, segmentPropertyMap };
}

async function getMeshMetadata(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  options: Partial<ProgressOptions>,
): Promise<ParsedMeshMetadata> {
  const metadata = await getJsonMetadata(
    sharedKvStoreContext,
    url,
    /*required=*/ false,
    options,
  );
  if (metadata === undefined) {
    // If the info file is missing, assume it is the legacy
    // single-resolution mesh format.
    return { metadata: undefined };
  }
  return parseMeshMetadata(metadata);
}

function parseShardingEncoding(y: any): DataEncoding {
  if (y === undefined) return DataEncoding.RAW;
  return verifyEnumString(y, DataEncoding);
}

function parseShardingParameters(
  shardingData: any,
): ShardingParameters | undefined {
  if (shardingData === undefined) return undefined;
  verifyObject(shardingData);
  const t = verifyObjectProperty(shardingData, "@type", verifyString);
  if (t !== "neuroglancer_uint64_sharded_v1") {
    throw new Error(`Unsupported sharding format: ${JSON.stringify(t)}`);
  }
  const hash = verifyObjectProperty(shardingData, "hash", (y) =>
    verifyEnumString(y, ShardingHashFunction),
  );
  const preshiftBits = verifyObjectProperty(
    shardingData,
    "preshift_bits",
    verifyInt,
  );
  const shardBits = verifyObjectProperty(shardingData, "shard_bits", verifyInt);
  const minishardBits = verifyObjectProperty(
    shardingData,
    "minishard_bits",
    verifyInt,
  );
  const minishardIndexEncoding = verifyObjectProperty(
    shardingData,
    "minishard_index_encoding",
    parseShardingEncoding,
  );
  const dataEncoding = verifyObjectProperty(
    shardingData,
    "data_encoding",
    parseShardingEncoding,
  );
  return {
    hash,
    preshiftBits,
    shardBits,
    minishardBits,
    minishardIndexEncoding,
    dataEncoding,
  };
}

function parseGrapheneShardingParameters(
  shardingData: any,
): Array<ShardingParameters> | undefined {
  if (shardingData === undefined) return undefined;
  verifyObject(shardingData);
  const grapheneShardingParameters = new Array<ShardingParameters>();
  for (const layer in shardingData) {
    const index = Number(layer);
    grapheneShardingParameters[index] = parseShardingParameters(
      shardingData[index],
    )!;
  }
  return grapheneShardingParameters;
}

function getShardedMeshSource(
  sharedKvStoreContext: SharedKvStoreContext,
  parameters: MeshSourceParameters,
  branchId: WatchableValueInterface<number>,
) {
  // branchId rides alongside the mixin-typed options; the GrapheneMeshSource
  // constructor picks it up, but the WithParameters options type doesn't know
  // about it, hence the cast.
  return sharedKvStoreContext.chunkManager.getChunkSource(GrapheneMeshSource, {
    sharedKvStoreContext,
    parameters,
    branchId,
  } as never);
}

async function getMeshSource(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  fragmentUrl: string,
  nBitsForLayerId: number,
  branchId: WatchableValueInterface<number>,
  options: ProgressOptions,
) {
  const { metadata, segmentPropertyMap } = await getMeshMetadata(
    sharedKvStoreContext,
    fragmentUrl,
    options,
  );
  const parameters: MeshSourceParameters = {
    manifestUrl: url,
    fragmentUrl: fragmentUrl,
    lod: 0,
    sharding: metadata?.sharding,
    nBitsForLayerId,
    branchId: branchId.value,
  };
  const transform = metadata?.transform || mat4.create();
  return {
    source: getShardedMeshSource(sharedKvStoreContext, parameters, branchId),
    transform,
    segmentPropertyMap,
  };
}

export function getJsonMetadata(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  required: boolean,
  options: Partial<ProgressOptions>,
): Promise<any> {
  return sharedKvStoreContext.chunkManager.memoize.getAsync(
    {
      type: "precomputed:metadata",
      url,
    },
    options,
    async (options) => {
      const infoUrl = pipelineUrlJoin(url, "info");
      using _span = new ProgressSpan(options.progressListener, {
        message: `Reading graphene metadata from ${infoUrl}`,
      });
      const response = await sharedKvStoreContext.kvStoreContext.read(infoUrl, {
        ...options,
        throwIfMissing: required,
      });
      if (response === undefined) return undefined;
      return await response.response.json();
    },
  );
}

function getSubsourceToModelSubspaceTransform(info: MultiscaleVolumeInfo) {
  const m = mat4.create();
  const resolution = info.scales[0].resolution;
  for (let i = 0; i < 3; ++i) {
    m[5 * i] = 1 / resolution[i];
  }
  return m;
}

async function getVolumeDataSource(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  metadata: any,
  options: ProgressOptions,
  stateJson: any,
): Promise<DataSource> {
  const info = parseGrapheneMultiscaleVolumeInfo(metadata, url);
  const volume = new GrapheneMultiscaleVolumeChunkSource(
    sharedKvStoreContext,
    info,
  );
  const state = new GrapheneState();
  if (stateJson) {
    state.restoreState(stateJson);
  }
  // Sync the restored branchId onto the chunk source BEFORE NG starts
  // fetching chunks — otherwise the first /precomputed_rp/ requests go
  // out with branch_id=0 (the chunkSource default) and the user sees
  // main's view until refreshChunkSources() fires on a later UI toggle.
  volume.branchId = state.branchId.value;
  const segmentationGraph = new GrapheneGraphSource(info, volume, state);
  const { modelSpace } = info;
  const subsources: DataSubsourceEntry[] = [
    {
      id: "default",
      default: true,
      subsource: { volume },
    },
    {
      id: "graph",
      default: true,
      subsource: { segmentationGraph },
    },
    {
      id: "bounds",
      default: true,
      subsource: {
        staticAnnotations: makeDataBoundsBoundingBoxAnnotationSet(
          modelSpace.bounds,
        ),
      },
    },
  ];
  if (info.segmentPropertyMap !== undefined) {
    const mapUrl = kvstoreEnsureDirectoryPipelineUrl(
      sharedKvStoreContext.kvStoreContext.resolveRelativePath(
        url,
        info.segmentPropertyMap,
      ),
    );
    const metadata = await getJsonMetadata(
      sharedKvStoreContext,
      mapUrl,
      /*required=*/ true,
      options,
    );
    const segmentPropertyMap = getSegmentPropertyMap(metadata);
    subsources.push({
      id: "properties",
      default: true,
      subsource: { segmentPropertyMap },
    });
  }
  if (info.mesh !== undefined) {
    const { source: meshSource, transform } = await getMeshSource(
      sharedKvStoreContext,
      info.app!.meshingUrl,
      kvstoreEnsureDirectoryPipelineUrl(
        sharedKvStoreContext.kvStoreContext.resolveRelativePath(
          info.dataUrl,
          info.mesh,
        ),
      ),
      info.graph.nBitsForLayerId,
      state.branchId,
      options,
    );
    const subsourceToModelSubspaceTransform =
      getSubsourceToModelSubspaceTransform(info);
    mat4.multiply(
      subsourceToModelSubspaceTransform,
      subsourceToModelSubspaceTransform,
      transform,
    );
    subsources.push({
      id: "mesh",
      default: true,
      subsource: { mesh: meshSource },
      subsourceToModelSubspaceTransform,
    });
  }
  return {
    modelTransform: makeIdentityTransform(modelSpace),
    subsources,
    state,
  };
}

// Note: Graphene is not really a kvstore-based data source, since it relies on
// making arbitrary HTTP requests rather than just kvstore. It fails if the
// provided kvstore does not inherit from HttpKvStore.
export class CalcadaDataSource implements KvStoreBasedDataSourceProvider {
  get scheme() {
    return "calcada";
  }
  get description() {
    return "Calcada data source";
  }

  get(
    options: GetKvStoreBasedDataSourceOptions,
  ): Promise<DataSourceLookupResult> {
    ensureEmptyUrlSuffix(options.url);
    const url = kvstoreEnsureDirectoryPipelineUrl(options.kvStoreUrl);
    // Include options.state in the memoize key so two segmentation layers
    // sharing the same URL but different per-source state (e.g. main layer
    // with state={} and branch layer with state={calcadaBranch:N}) get
    // independent DataSource instances. Without this the second layer
    // silently reuses the first's GrapheneState/branchId and ignores its
    // restored state — the diff-link branch layer ends up showing "main".
    const stateKey = JSON.stringify(options.state ?? null);
    return options.registry.chunkManager.memoize.getAsync(
      { type: "calcada:get", url, stateKey },
      options,
      async (progressOptions) => {
        const metadata = await getJsonMetadata(
          options.registry.sharedKvStoreContext,
          url,
          /*required=*/ true,
          progressOptions,
        );
        verifyObject(metadata);
        const redirect = verifyOptionalObjectProperty(
          metadata,
          "redirect",
          verifyString,
        );
        const canonicalUrl = `${options.url.scheme}://${url}`;
        if (redirect !== undefined) {
          return { canonicalUrl, targetUrl: redirect };
        }
        const t = verifyOptionalObjectProperty(metadata, "@type", verifyString);
        switch (t) {
          case "neuroglancer_multiscale_volume":
          case undefined: {
            const dataSource = await getVolumeDataSource(
              options.registry.sharedKvStoreContext,
              url,
              metadata,
              progressOptions,
              options.state,
            );
            dataSource.canonicalUrl = canonicalUrl;
            return dataSource;
          }
          default:
            throw new Error(`Invalid type: ${JSON.stringify(t)}`);
        }
      },
    );
  }
}

function getGraphLoadedSubsource(layer: SegmentationUserLayer) {
  for (const dataSource of layer.dataSources) {
    const { loadState } = dataSource;
    if (loadState === undefined || loadState.error !== undefined) continue;
    for (const subsource of loadState.subsources) {
      if (subsource.enabled && subsource.subsourceEntry.id === "graph") {
        return subsource;
      }
    }
  }
  return undefined;
}

function makeColoredAnnotationState(
  layer: SegmentationUserLayer,
  loadedSubsource: LoadedDataSubsource,
  subsubsourceId: string,
  color: vec3,
) {
  const { subsourceEntry } = loadedSubsource;
  const source = new LocalAnnotationSource(
    loadedSubsource.loadedDataSource.transform,
    new WatchableValue([]),
    ["associated segments"],
  );

  const displayState = new AnnotationDisplayState();
  displayState.color.value.set(color);

  displayState.relationshipStates.set("associated segments", {
    segmentationState: new WatchableValue(layer.displayState),
    showMatches: new TrackableBoolean(false),
  });

  const state = new AnnotationLayerState({
    localPosition: layer.localPosition,
    transform: loadedSubsource.getRenderLayerTransform(),
    source,
    displayState,
    dataSource: loadedSubsource.loadedDataSource.layerDataSource,
    subsourceIndex: loadedSubsource.subsourceIndex,
    subsourceId: subsourceEntry.id,
    subsubsourceId,
    role: RenderLayerRole.ANNOTATION,
  });
  layer.addAnnotationLayerState(state, loadedSubsource);
  return state;
}

function getOptionalUint64(obj: any, key: string) {
  return verifyOptionalObjectProperty(obj, key, parseUint64);
}

function getUint64(obj: any, key: string) {
  return verifyObjectProperty(obj, key, parseUint64);
}

function restoreSegmentSelection(obj: any): SegmentSelection {
  const segmentId = getUint64(obj, SEGMENT_ID_JSON_KEY);
  const rootId = getUint64(obj, ROOT_ID_JSON_KEY);
  const position = verifyObjectProperty(obj, POSITION_JSON_KEY, (value) => {
    return verify3dVec(value);
  });
  return {
    segmentId,
    rootId,
    position,
  };
}

const segmentSelectionToJSON = (x: SegmentSelection) => {
  return {
    [SEGMENT_ID_JSON_KEY]: x.segmentId.toString(),
    [ROOT_ID_JSON_KEY]: x.rootId.toString(),
    [POSITION_JSON_KEY]: [...x.position],
  };
};

const ID_JSON_KEY = "id";
const SEGMENT_ID_JSON_KEY = "segmentId";
const ROOT_ID_JSON_KEY = "rootId";
const POSITION_JSON_KEY = "position";
const SINK_JSON_KEY = "sink";
const SOURCE_JSON_KEY = "source";

const MULTICUT_JSON_KEY = "multicut";
const FOCUS_SEGMENT_JSON_KEY = "focusSegment";
const SINKS_JSON_KEY = "sinks";
const SOURCES_JSON_KEY = "sources";

const MERGE_JSON_KEY = "merge";
const MERGES_JSON_KEY = "merges";
const AUTOSUBMIT_JSON_KEY = "autosubmit";
const LOCKED_JSON_KEY = "locked";
const MERGED_ROOT_JSON_KEY = "mergedRoot";
const ERROR_JSON_KEY = "error";

const FIND_PATH_JSON_KEY = "findPath";
const TARGET_JSON_KEY = "target";
const CENTROIDS_JSON_KEY = "centroids";
const PRECISION_MODE_JSON_KEY = "precision";

const PIECE_SPLIT_JSON_KEY = "pieceSplit";
const CALCADA_BRANCH_JSON_KEY = "calcadaBranch";

class GrapheneState extends RefCounted implements Trackable {
  changed = new NullarySignal();

  public multicutState = new MulticutState();
  public mergeState = new MergeState();
  public findPathState = new FindPathState();
  public pieceSplitState = new PieceSplitState();
  public branchId = new TrackableValue<number>(0, (x) =>
    typeof x === "number" && Number.isInteger(x) && x >= 0 ? x : 0,
  );

  constructor() {
    super();
    this.registerDisposer(
      this.multicutState.changed.add(() => {
        this.changed.dispatch();
      }),
    );
    this.registerDisposer(
      this.mergeState.changed.add(() => {
        this.changed.dispatch();
      }),
    );
    this.registerDisposer(
      this.findPathState.changed.add(() => {
        this.changed.dispatch();
      }),
    );
    this.registerDisposer(
      this.pieceSplitState.changed.add(() => {
        this.changed.dispatch();
      }),
    );
    this.registerDisposer(
      this.branchId.changed.add(() => {
        this.changed.dispatch();
      }),
    );
  }

  replaceSegments(oldValues: Uint64Set, newValues: Uint64Set) {
    this.multicutState.replaceSegments(oldValues, newValues);
    this.mergeState.replaceSegments(oldValues, newValues);
    this.findPathState.replaceSegments(oldValues, newValues);
    this.pieceSplitState.replaceSegments(oldValues, newValues);
  }

  reset() {
    this.multicutState.reset();
    this.mergeState.reset();
    this.findPathState.reset();
    this.pieceSplitState.reset();
  }

  toJSON() {
    return {
      [MULTICUT_JSON_KEY]: this.multicutState.toJSON(),
      [MERGE_JSON_KEY]: this.mergeState.toJSON(),
      [FIND_PATH_JSON_KEY]: this.findPathState.toJSON(),
      [PIECE_SPLIT_JSON_KEY]: this.pieceSplitState.toJSON(),
      [CALCADA_BRANCH_JSON_KEY]: this.branchId.toJSON(),
    };
  }

  restoreState(x: any) {
    verifyOptionalObjectProperty(x, MULTICUT_JSON_KEY, (value) => {
      this.multicutState.restoreState(value);
    });
    verifyOptionalObjectProperty(x, MERGE_JSON_KEY, (value) => {
      this.mergeState.restoreState(value);
    });
    verifyOptionalObjectProperty(x, FIND_PATH_JSON_KEY, (value) => {
      this.findPathState.restoreState(value);
    });
    verifyOptionalObjectProperty(x, PIECE_SPLIT_JSON_KEY, (value) => {
      this.pieceSplitState.restoreState(value);
    });
    verifyOptionalObjectProperty(x, CALCADA_BRANCH_JSON_KEY, (value) => {
      this.branchId.restoreState(value);
    });
  }
}

export interface SegmentSelection {
  segmentId: bigint;
  rootId: bigint;
  position: Float32Array;
  annotationReference?: AnnotationReference;
}

class MergeState extends RefCounted implements Trackable {
  changed = new NullarySignal();
  merges = new WatchableValue<MergeSubmission[]>([]);
  autoSubmit = new TrackableBoolean(false);

  constructor() {
    super();
    this.registerDisposer(this.merges.changed.add(this.changed.dispatch));
  }

  replaceSegments(oldValues: Uint64Set, newValues: Uint64Set) {
    const {
      merges: { value: merges },
    } = this;
    const newValue = newValues.size === 1 ? [...newValues][0] : undefined;
    for (const merge of merges) {
      if (merge.source && oldValues.has(merge.source.rootId)) {
        if (newValue) {
          merge.source.rootId = newValue;
        } else {
          this.reset();
          return;
        }
      }
      if (merge.sink && oldValues.has(merge.sink.rootId)) {
        if (newValue) {
          merge.sink.rootId = newValue;
        } else {
          this.reset();
          return;
        }
      }
    }
  }

  reset() {
    this.merges.value = [];
    this.autoSubmit.reset();
  }

  toJSON() {
    const { merges, autoSubmit } = this;

    const mergeToJSON = (x: MergeSubmission) => {
      const res: any = {
        [ID_JSON_KEY]: x.id,
        [LOCKED_JSON_KEY]: x.locked,
        [SINK_JSON_KEY]: segmentSelectionToJSON(x.sink),
        [SOURCE_JSON_KEY]: segmentSelectionToJSON(x.source!),
      };
      if (x.mergedRoot) {
        res[MERGED_ROOT_JSON_KEY] = x.mergedRoot.toString();
      }
      if (x.error) {
        res[ERROR_JSON_KEY] = x.error;
      }
      return res;
    };
    return {
      [MERGES_JSON_KEY]: merges.value.filter((x) => x.source).map(mergeToJSON),
      [AUTOSUBMIT_JSON_KEY]: autoSubmit.toJSON(),
    };
  }

  restoreState(x: any) {
    function restoreSubmission(obj: any): MergeSubmission {
      const mergedRoot = getOptionalUint64(obj, MERGED_ROOT_JSON_KEY);
      const id = verifyObjectProperty(obj, ID_JSON_KEY, verifyString);
      const error = verifyOptionalObjectProperty(
        obj,
        ERROR_JSON_KEY,
        verifyString,
      );
      const locked = false; // TODO(chrisj) verifyObjectProperty(obj, LOCKED_JSON_KEY, verifyBoolean);
      const sink = restoreSegmentSelection(obj[SINK_JSON_KEY]);
      const source = restoreSegmentSelection(obj[SOURCE_JSON_KEY]);
      return {
        id,
        locked,
        sink,
        source,
        mergedRoot,
        error,
      };
    }

    const submissionsValidator = (value: any) => {
      return parseArray(value, (x) => {
        return restoreSubmission(x);
      });
    };

    this.merges.value = verifyObjectProperty(
      x,
      MERGES_JSON_KEY,
      submissionsValidator,
    );
    this.autoSubmit.restoreState(
      verifyOptionalObjectProperty(x, AUTOSUBMIT_JSON_KEY, verifyBoolean),
    );
  }
}

class FindPathState extends RefCounted implements Trackable {
  changed = new NullarySignal();
  triggerPathUpdate = new NullarySignal();
  source = new TrackableValue<SegmentSelection | undefined>(
    undefined,
    (x) => x,
  );
  target = new TrackableValue<SegmentSelection | undefined>(
    undefined,
    (x) => x,
  );
  centroids = new TrackableValue<number[][]>([], (x) => x);
  precisionMode = new TrackableBoolean(true);

  constructor() {
    super();
    this.registerDisposer(
      this.source.changed.add(() => {
        this.centroids.reset();
        this.changed.dispatch();
      }),
    );
    this.registerDisposer(
      this.target.changed.add(() => {
        this.centroids.reset();
        this.changed.dispatch();
      }),
    );
    this.registerDisposer(this.centroids.changed.add(this.changed.dispatch));
  }

  get path() {
    const path: Line[] = [];
    const {
      source: { value: source },
      target: { value: target },
      centroids: { value: centroids },
    } = this;
    if (!source || !target || centroids.length === 0) {
      return path;
    }
    for (let i = 0; i < centroids.length - 1; i++) {
      const pointA = centroids[i];
      const pointB = centroids[i + 1];
      const line: Line = {
        pointA: vec3.fromValues(pointA[0], pointA[1], pointA[2]),
        pointB: vec3.fromValues(pointB[0], pointB[1], pointB[2]),
        id: "",
        type: AnnotationType.LINE,
        properties: [],
      };
      path.push(line);
    }
    const firstLine: Line = {
      pointA: source.position,
      pointB: path[0].pointA,
      id: "",
      type: AnnotationType.LINE,
      properties: [],
    };
    const lastLine: Line = {
      pointA: path[path.length - 1].pointB,
      pointB: target.position,
      id: "",
      type: AnnotationType.LINE,
      properties: [],
    };

    return [firstLine, ...path, lastLine];
  }

  replaceSegments(oldValues: Uint64Set, newValues: Uint64Set) {
    const {
      source: { value: source },
      target: { value: target },
    } = this;
    const newValue = newValues.size === 1 ? [...newValues][0] : undefined;
    const sourceChanged = !!source && oldValues.has(source.rootId);
    const targetChanged = !!target && oldValues.has(target.rootId);
    if (newValue) {
      if (sourceChanged) {
        source.rootId = newValue;
      }
      if (targetChanged) {
        target.rootId = newValue;
      }
      // don't want to fire off multiple changed
      if (sourceChanged || targetChanged) {
        if (this.centroids.value.length) {
          this.centroids.reset();
          this.triggerPathUpdate.dispatch();
        } else {
          this.changed.dispatch();
        }
      }
    } else {
      if (sourceChanged || targetChanged) {
        this.reset();
      }
    }
  }

  reset() {
    this.source.reset();
    this.target.reset();
    this.centroids.reset();
    this.precisionMode.reset();
  }

  toJSON() {
    const {
      source: { value: source },
      target: { value: target },
      centroids,
      precisionMode,
    } = this;
    return {
      [SOURCE_JSON_KEY]: source ? segmentSelectionToJSON(source) : undefined,
      [TARGET_JSON_KEY]: target ? segmentSelectionToJSON(target) : undefined,
      [CENTROIDS_JSON_KEY]: centroids.toJSON(),
      [PRECISION_MODE_JSON_KEY]: precisionMode.toJSON(),
    };
  }

  restoreState(x: any) {
    verifyOptionalObjectProperty(x, SOURCE_JSON_KEY, (value) => {
      this.source.restoreState(restoreSegmentSelection(value));
    });
    verifyOptionalObjectProperty(x, TARGET_JSON_KEY, (value) => {
      this.target.restoreState(restoreSegmentSelection(value));
    });
    verifyOptionalObjectProperty(x, CENTROIDS_JSON_KEY, (value) => {
      this.centroids.restoreState(value);
    });
    verifyOptionalObjectProperty(x, PRECISION_MODE_JSON_KEY, (value) => {
      this.precisionMode.restoreState(value);
    });
  }
}

class MulticutState extends RefCounted implements Trackable {
  changed = new NullarySignal();

  sinks = new WatchableSet<SegmentSelection>();
  sources = new WatchableSet<SegmentSelection>();

  constructor(
    public focusSegment = new TrackableValue<bigint | undefined>(
      undefined,
      (x) => x,
    ),
    public blueGroup = new WatchableValue<boolean>(false),
  ) {
    super();

    const maybeResetFocusSegemnt = () => {
      if (this.sinks.size === 0 && this.sources.size === 0) {
        this.focusSegment.value = undefined;
      }
    };

    this.registerDisposer(focusSegment.changed.add(this.changed.dispatch));
    this.registerDisposer(this.sinks.changed.add(maybeResetFocusSegemnt));
    this.registerDisposer(this.sources.changed.add(maybeResetFocusSegemnt));

    this.registerDisposer(this.blueGroup.changed.add(this.changed.dispatch));
    this.registerDisposer(this.sinks.changed.add(this.changed.dispatch));
    this.registerDisposer(this.sources.changed.add(this.changed.dispatch));
  }

  replaceSegments(oldValues: Uint64Set, newValues: Uint64Set) {
    const newValue = newValues.size === 1 ? [...newValues][0] : undefined;
    const {
      focusSegment: { value: focusSegment },
    } = this;
    if (focusSegment && oldValues.has(focusSegment)) {
      if (newValue) {
        this.focusSegment.value = newValue;
        for (const sink of this.sinks) {
          sink.rootId = newValue;
        }
        for (const source of this.sources) {
          source.rootId = newValue;
        }
        this.changed.dispatch();
      } else {
        this.reset();
      }
    }
  }

  reset() {
    this.focusSegment.reset();
    this.blueGroup.value = false;
    this.sinks.clear();
    this.sources.clear();
  }

  toJSON() {
    const { focusSegment, sinks, sources } = this;
    return {
      [FOCUS_SEGMENT_JSON_KEY]: focusSegment.toJSON()?.toString(),
      [SINKS_JSON_KEY]: [...sinks].map(segmentSelectionToJSON),
      [SOURCES_JSON_KEY]: [...sources].map(segmentSelectionToJSON),
    };
  }

  restoreState(x: any) {
    const segmentSelectionsValidator = (value: any) => {
      return parseArray(value, (x) => {
        return restoreSegmentSelection(x);
      });
    };

    verifyOptionalObjectProperty(x, FOCUS_SEGMENT_JSON_KEY, (value) => {
      this.focusSegment.restoreState(parseUint64(value));
    });
    const sinks = verifyObjectProperty(
      x,
      SINKS_JSON_KEY,
      segmentSelectionsValidator,
    );
    const sources = verifyObjectProperty(
      x,
      SOURCES_JSON_KEY,
      segmentSelectionsValidator,
    );

    for (const sink of sinks) {
      this.sinks.add(sink);
    }

    for (const source of sources) {
      this.sources.add(source);
    }
  }

  swapGroup() {
    this.blueGroup.value = !this.blueGroup.value;
  }

  get activeGroup() {
    return this.blueGroup.value ? this.sources : this.sinks;
  }

  // following three functions are used to render multicut supervoxels in 2d (color them red/blue)
  get segments() {
    return [...this.redSegments, ...this.blueSegments];
  }

  get redSegments() {
    return [...this.sinks]
      .filter((x) => x.segmentId !== x.rootId)
      .map((x) => x.segmentId);
  }

  get blueSegments() {
    return [...this.sources]
      .filter((x) => x.segmentId !== x.rootId)
      .map((x) => x.segmentId);
  }
}

// VoxelPoint is an integer voxel coordinate placed by the user during piece
// split. We keep these in voxel-space (after the nm → voxel conversion using
// the graph's resolution) because the backend operates in voxel-space.
type VoxelPoint = [number, number, number];

// PointEntry stores both the voxel-space integer coordinate (used in the POST
// body) and the layer-space float coordinate (used for the 3D annotation
// marker shown in the viewer). The layer-space form is also persisted to JSON
// so reloads keep the markers exactly where they were placed.
interface PointEntry {
  voxel: VoxelPoint;
  layer: [number, number, number];
}

// PreviewResult is the parsed response from POST /piece/split_preview.
interface PreviewResult {
  bbox: [number, number, number, number, number, number];
  // Inline gzipped+base64 mask; empty when the server omitted it due to size.
  maskBase64: string;
  maskUrl: string;
  expiresAt: number; // unix-ms
  maskVoxels: number;
  sourceVoxels: number;
  sinkVoxels: number;
}

const PIECE_SPLIT_FOCUS_KEY = "focusPieceId";
const PIECE_SPLIT_BLUE_KEY = "blue";
const PIECE_SPLIT_RED_KEY = "red";
const PIECE_SPLIT_IMAGE_KEY = "imageSource";

// PieceSplitState holds the working state of the point-driven piece split
// tool: the focus piece, the two coloured point lists, the active colour, and
// the URL of the image volume used to weight the cut.
class PieceSplitState extends RefCounted implements Trackable {
  changed = new NullarySignal();

  focusPieceId = new TrackableValue<bigint | undefined>(undefined, (x) => x);
  blueGroup = new WatchableValue<boolean>(true);
  bluePoints = new WatchableValue<PointEntry[]>([]);
  redPoints = new WatchableValue<PointEntry[]>([]);
  imageSource = new TrackableValue<string>("", verifyString);
  preview = new WatchableValue<PreviewResult | undefined>(undefined);

  constructor() {
    super();
    const reemit = () => this.changed.dispatch();
    this.registerDisposer(this.focusPieceId.changed.add(reemit));
    this.registerDisposer(this.blueGroup.changed.add(reemit));
    this.registerDisposer(this.bluePoints.changed.add(reemit));
    this.registerDisposer(this.redPoints.changed.add(reemit));
    this.registerDisposer(this.imageSource.changed.add(reemit));
    this.registerDisposer(this.preview.changed.add(reemit));
  }

  reset() {
    this.focusPieceId.reset();
    this.blueGroup.value = true;
    this.bluePoints.value = [];
    this.redPoints.value = [];
    this.preview.value = undefined;
    // Intentionally do NOT clear imageSource — it's typically set once per session.
  }

  swapGroup() {
    this.blueGroup.value = !this.blueGroup.value;
  }

  // Returns a *new* array — callers should not mutate the existing value array.
  addPoint(p: PointEntry) {
    if (this.blueGroup.value) {
      this.bluePoints.value = [...this.bluePoints.value, p];
    } else {
      this.redPoints.value = [...this.redPoints.value, p];
    }
  }

  removePoint(group: "blue" | "red", index: number) {
    const src = group === "blue" ? this.bluePoints : this.redPoints;
    if (index < 0 || index >= src.value.length) return;
    const next = [...src.value];
    next.splice(index, 1);
    src.value = next;
  }

  // replaceSegments mirrors the contract of MulticutState.replaceSegments —
  // when a piece is split or merged externally, the saved focus may become
  // invalid and we should clear it. Points are voxel-space so they survive
  // graph mutations; the focus reference does not.
  replaceSegments(oldValues: Uint64Set, _newValues: Uint64Set) {
    const focus = this.focusPieceId.value;
    if (focus !== undefined && oldValues.has(focus)) {
      this.reset();
    }
  }

  toJSON() {
    return {
      [PIECE_SPLIT_FOCUS_KEY]: this.focusPieceId.toJSON()?.toString(),
      [PIECE_SPLIT_BLUE_KEY]: this.bluePoints.value.map(entryToJSON),
      [PIECE_SPLIT_RED_KEY]: this.redPoints.value.map(entryToJSON),
      [PIECE_SPLIT_IMAGE_KEY]: this.imageSource.value || undefined,
    };
  }

  restoreState(x: any) {
    verifyOptionalObjectProperty(x, PIECE_SPLIT_FOCUS_KEY, (value) => {
      this.focusPieceId.restoreState(parseUint64(value));
    });
    verifyOptionalObjectProperty(x, PIECE_SPLIT_BLUE_KEY, (value) => {
      this.bluePoints.value = parseArray(value, parseEntry);
    });
    verifyOptionalObjectProperty(x, PIECE_SPLIT_RED_KEY, (value) => {
      this.redPoints.value = parseArray(value, parseEntry);
    });
    verifyOptionalObjectProperty(x, PIECE_SPLIT_IMAGE_KEY, (value) => {
      this.imageSource.value = verifyString(value);
    });
  }
}

const VOXEL_KEY = "voxel";
const LAYER_KEY = "layer";

function entryToJSON(e: PointEntry) {
  return { [VOXEL_KEY]: e.voxel, [LAYER_KEY]: e.layer };
}

function parseEntry(value: any): PointEntry {
  // Tolerate the older JSON shape that stored just a voxel triplet at the top
  // level — fall back to using it for both fields so reloads from earlier
  // sessions don't lose data.
  if (Array.isArray(value)) {
    const arr = parseFixedLengthArray(
      [0, 0, 0] as VoxelPoint,
      value,
      verifyInt,
    );
    return { voxel: arr, layer: [arr[0], arr[1], arr[2]] };
  }
  const voxel = verifyObjectProperty(value, VOXEL_KEY, (v) =>
    parseFixedLengthArray([0, 0, 0] as VoxelPoint, v, verifyInt),
  );
  const layer = verifyObjectProperty(value, LAYER_KEY, (v) =>
    parseFixedLengthArray(
      [0, 0, 0] as [number, number, number],
      v,
      verifyFiniteFloat,
    ),
  );
  return { voxel, layer };
}

class GraphConnection extends SegmentationGraphSourceConnection {
  public annotationLayerStates: AnnotationLayerState[] = [];
  public mergeAnnotationState: AnnotationLayerState;
  public findPathAnnotationState: AnnotationLayerState;

  constructor(
    public graph: GrapheneGraphSource,
    private layer: SegmentationUserLayer,
    private chunkSource: GrapheneMultiscaleVolumeChunkSource,
    public state: GrapheneState,
  ) {
    super(graph, layer.displayState.segmentationGroupState.value);
    const segmentsState = layer.displayState.segmentationGroupState.value;
    this.previousVisibleSegmentCount = segmentsState.visibleSegments.size;
    segmentsState.selectedSegments.changed.add(
      (segmentIds: bigint[] | bigint | null, add: boolean) => {
        if (segmentIds !== null) {
          segmentIds =
            typeof segmentIds === "bigint" ? [segmentIds] : segmentIds;
        }
        this.selectedSegmentsChanged(segmentIds, add);
      },
    );
    segmentsState.visibleSegments.changed.add(
      (segmentIds: bigint[] | bigint | null, add: boolean) => {
        if (segmentIds !== null) {
          segmentIds =
            typeof segmentIds === "bigint" ? [segmentIds] : segmentIds;
        }
        this.visibleSegmentsChanged(segmentIds, add);
      },
    );
    const {
      annotationLayerStates,
      state: { multicutState, mergeState, findPathState },
    } = this;

    const { timestamp } = segmentsState;
    this.registerDisposer(
      timestamp.changed.add(async () => {
        const nonLatestRoots = await this.graph.graphServer.filterLatestRoots(
          [...segmentsState.selectedSegments],
          timestamp.value,
          true,
          this.graph.branchId.value,
        );
        segmentsState.selectedSegments.delete(nonLatestRoots);
        const unsetTimestamp = timestamp.value === undefined;
        if (unsetTimestamp) {
          const {
            focusSegment: { value: focusSegment },
          } = state.multicutState;
          if (focusSegment) {
            segmentsState.visibleSegments.add(focusSegment);
          }
        }
        this.refreshChunkSources();
      }),
    );

    this.registerDisposer(
      this.graph.branchId.changed.add(() => {
        // Drop selections + equivalences: piece IDs are branch-local, so
        // a selected piece from the previous branch may not exist in the
        // new one and triggers "piece not found" errors on getRoot.
        // refreshChunkSources re-populates equivalences from the new
        // branch's LUT trailers as chunks load.
        segmentsState.selectedSegments.clear();
        segmentsState.visibleSegments.clear();
        segmentsState.segmentEquivalences.clear();
        this.refreshChunkSources();
      }),
    );

    const loadedSubsource = getGraphLoadedSubsource(layer)!;
    const redGroup = makeColoredAnnotationState(
      layer,
      loadedSubsource,
      "sinks",
      RED_COLOR,
    );
    const blueGroup = makeColoredAnnotationState(
      layer,
      loadedSubsource,
      "sources",
      BLUE_COLOR,
    );
    synchronizeAnnotationSource(multicutState.sinks, redGroup);
    synchronizeAnnotationSource(multicutState.sources, blueGroup);
    annotationLayerStates.push(redGroup, blueGroup);

    if (layer.tool.value instanceof MergeSegmentsPlaceLineTool) {
      layer.tool.value = undefined;
    }

    this.mergeAnnotationState = makeColoredAnnotationState(
      layer,
      loadedSubsource,
      "grapheneMerge",
      RED_COLOR,
    );

    {
      const { mergeState } = state;
      const { merges, autoSubmit } = mergeState;
      const { mergeAnnotationState } = this;
      const { visibleSegments } = segmentsState;

      // load merges from state
      for (const merge of merges.value) {
        mergeAnnotationState.source.add(mergeToLine(merge));
      }

      // initialize source changes
      mergeAnnotationState.source.childAdded.add((x) => {
        const annotation = x as Line;
        const relatedSegments = annotation.relatedSegments![0];
        const visibles = Array.from(relatedSegments, (x) =>
          visibleSegments.has(x),
        );
        if (visibles[0] === false) {
          setTimeout(() => {
            const { tool } = layer;
            if (tool.value instanceof MergeSegmentsPlaceLineTool) {
              tool.value.deactivate();
            }
          }, 0);
          StatusMessage.showTemporaryMessage("Cannot merge a hidden segment.");
        } else if (merges.value.length < MAX_MERGE_COUNT) {
          merges.value = [...merges.value, lineToSubmission(annotation, true)];
        } else {
          setTimeout(() => {
            const { tool } = layer;
            if (tool.value instanceof MergeSegmentsPlaceLineTool) {
              tool.value.deactivate();
            }
          }, 0);
          StatusMessage.showTemporaryMessage(
            `Maximum of ${MAX_MERGE_COUNT} simultanous merges allowed.`,
          );
        }
      });

      mergeAnnotationState.source.childCommitted.add((x) => {
        const ref = mergeAnnotationState.source.getReference(x);
        const annotation = ref.value as Line | undefined;
        if (annotation) {
          const relatedSegments = annotation.relatedSegments![0];
          if (relatedSegments.length < 4) {
            mergeAnnotationState.source.delete(ref);
            StatusMessage.showTemporaryMessage(
              `Cannot merge segment with itself.`,
            );
          }
          const visibles: boolean[] = Array.from(relatedSegments, (x) =>
            visibleSegments.has(x),
          );
          if (visibles[2] === false) {
            mergeAnnotationState.source.delete(ref);
            StatusMessage.showTemporaryMessage(
              `Cannot merge a hidden segment.`,
            );
          }
          const existingSubmission = merges.value.find((x) => x.id === ref.id);
          if (existingSubmission && !existingSubmission?.locked) {
            //  how would it be locked?
            const newSubmission = lineToSubmission(annotation, false);
            existingSubmission.sink = newSubmission.sink;
            existingSubmission.source = newSubmission.source;
            merges.changed.dispatch();
            if (autoSubmit.value) {
              this.bulkMerge([existingSubmission]);
            }
          }
        }
        ref.dispose();
      });
      mergeAnnotationState.source.childDeleted.add((id) => {
        let changed = false;
        const filtered = merges.value.filter((x) => {
          const keep = x.id !== id || x.locked;
          if (!keep) {
            changed = true;
          }
          return keep;
        });
        if (changed) {
          merges.value = filtered;
        }
      });
    }

    const findPathGroup = makeColoredAnnotationState(
      layer,
      loadedSubsource,
      "findpath",
      WHITE_COLOR,
    );
    this.findPathAnnotationState = findPathGroup;
    findPathGroup.source.childDeleted.add((annotationId) => {
      if (
        findPathState.source.value?.annotationReference?.id === annotationId
      ) {
        findPathState.source.value = undefined;
      }
      if (
        findPathState.target.value?.annotationReference?.id === annotationId
      ) {
        findPathState.target.value = undefined;
      }
    });
    const findPathChanged = () => {
      const { path, source, target } = findPathState;
      const annotationSource = findPathGroup.source;
      if (source.value && !source.value.annotationReference) {
        addSelection(annotationSource, source.value, "find path source");
      }
      if (target.value && !target.value.annotationReference) {
        addSelection(annotationSource, target.value, "find path target");
      }
      for (const annotation of annotationSource) {
        if (
          annotation.id !== source.value?.annotationReference?.id &&
          annotation.id !== target.value?.annotationReference?.id
        ) {
          annotationSource.delete(annotationSource.getReference(annotation.id));
        }
      }
      for (const line of path) {
        // line.id = ''; // TODO, is it a bug that this is necessary? annotationMap is empty if I
        // step through it but logging shows it isn't empty
        annotationSource.add(line);
      }
    };
    this.registerDisposer(findPathState.changed.add(findPathChanged));

    // Piece-split annotations: blue + red point markers, kept in sync with the
    // VoxelPoint lists in state.pieceSplitState.
    const { pieceSplitState } = state;
    const pieceSplitBlueAnnotation = makeColoredAnnotationState(
      layer,
      loadedSubsource,
      "pieceSplitBlue",
      BLUE_COLOR,
    );
    const pieceSplitRedAnnotation = makeColoredAnnotationState(
      layer,
      loadedSubsource,
      "pieceSplitRed",
      RED_COLOR,
    );
    // Default marker rendering uses size=5px which is barely visible when the
    // viewer is zoomed in close to a slice — and the cross-section fade in
    // slice view further drops the alpha. Bump the size, force opaque interior,
    // and add a contrasting border so markers stand out at any zoom.
    const PIECE_SPLIT_POINT_SHADER = `
void main() {
  setPointMarkerSize(20.0);
  setPointMarkerBorderWidth(3.0);
  setColor(vec4(defaultColor(), 1.0));
  setPointMarkerBorderColor(vec4(1.0, 1.0, 1.0, 1.0));
}
`;
    pieceSplitBlueAnnotation.displayState.shader.value =
      PIECE_SPLIT_POINT_SHADER;
    pieceSplitRedAnnotation.displayState.shader.value =
      PIECE_SPLIT_POINT_SHADER;
    const syncPieceSplitAnnotations = (
      points: PointEntry[],
      state: AnnotationLayerState,
    ) => {
      const src = state.source;
      // Drop every existing annotation in the source, then re-add the current
      // points. Simpler than tracking per-point identity since the lists are
      // short (a handful of points).
      for (const a of [...src]) src.delete(src.getReference(a.id));
      for (const p of points) {
        const annotation: Point = {
          id: "",
          point: new Float32Array(p.layer),
          type: AnnotationType.POINT,
          properties: [],
          description: `(${p.voxel[0]}, ${p.voxel[1]}, ${p.voxel[2]})`,
        };
        src.add(annotation);
      }
    };
    this.registerDisposer(
      pieceSplitState.bluePoints.changed.add(() =>
        syncPieceSplitAnnotations(
          pieceSplitState.bluePoints.value,
          pieceSplitBlueAnnotation,
        ),
      ),
    );
    this.registerDisposer(
      pieceSplitState.redPoints.changed.add(() =>
        syncPieceSplitAnnotations(
          pieceSplitState.redPoints.value,
          pieceSplitRedAnnotation,
        ),
      ),
    );
    // Initial sync from restored state.
    syncPieceSplitAnnotations(
      pieceSplitState.bluePoints.value,
      pieceSplitBlueAnnotation,
    );
    syncPieceSplitAnnotations(
      pieceSplitState.redPoints.value,
      pieceSplitRedAnnotation,
    );

    this.registerDisposer(
      findPathState.triggerPathUpdate.add(() => {
        const loadedSubsource = getGraphLoadedSubsource(this.layer)!;
        const annotationToNanometers =
          loadedSubsource.loadedDataSource.transform.inputSpace.value.scales.map(
            (x) => x / 1e-9,
          );
        this.submitFindPath(
          findPathState.precisionMode.value,
          annotationToNanometers,
        ).then((success) => {
          success;
        });
      }),
    );
    findPathChanged(); // initial state
    const updateEditTimestampLock = () => {
      if (segmentsState.timestamp.value === undefined) {
        if (
          multicutState.focusSegment.value ||
          mergeState.merges.value.length > 0
        ) {
          // remind me why want to add ourselves compared to keeping it empty
          // if it is non empty, graphene knows there is a tool locking it
          segmentsState.timestampOwner.add(layer.managedLayer.name);
        } else {
          segmentsState.timestampOwner.delete(layer.managedLayer.name);
        }
      }
    };
    this.registerDisposer(state.changed.add(updateEditTimestampLock));
    updateEditTimestampLock();
  }

  private graphRenderLayer: SliceViewPanelChunkedGraphLayer | undefined;

  refreshChunkSources() {
    const segmentsState = this.layer.displayState.segmentationGroupState.value;
    this.chunkSource.timestampMs = segmentsState.timestamp.value ?? 0;
    this.chunkSource.branchId = this.graph.branchId.value;
    this.chunkSource.generation += 1;
    // Wipe equivalences from prior LUT trailers or unions persist across a time/branch switch.
    segmentsState.segmentEquivalences.clear();
    for (const renderLayer of this.layer.renderLayers) {
      if (renderLayer instanceof SliceViewRenderLayer) {
        // transform.changed is read-only on the interface; cast to reach the underlying NullarySignal.
        (renderLayer.transform.changed as unknown as NullarySignal).dispatch();
      }
    }
  }

  createRenderLayers(
    chunkManager: ChunkManager,
    displayState: SegmentationDisplayState3D,
    localPosition: WatchableValueInterface<Float32Array>,
  ): RenderLayer[] {
    this.graphRenderLayer = new SliceViewPanelChunkedGraphLayer(
      chunkManager,
      this.chunkSource.getChunkedGraphSource(),
      displayState,
      localPosition,
      this.graph.info.graph.nBitsForLayerId,
      this.graph.branchId,
    );
    return [this.graphRenderLayer];
  }

  private lastDeselectionMessage: StatusMessage | undefined;
  private lastDeselectionMessageExists = false;

  private previousVisibleSegmentCount: number;

  private visibleSegmentsChanged(segments: bigint[] | null, added: boolean) {
    const { segmentsState } = this;
    const { state } = this.graph;
    const {
      focusSegment: { value: focusSegment },
    } = state.multicutState;
    const { timestamp } = segmentsState;
    const unsetTimestamp = timestamp.value === undefined;
    if (
      unsetTimestamp &&
      focusSegment &&
      !segmentsState.visibleSegments.has(focusSegment)
    ) {
      if (segmentsState.selectedSegments.has(focusSegment)) {
        StatusMessage.showTemporaryMessage(
          `Can't hide active multicut segment.`,
          3000,
        );
      } else {
        StatusMessage.showTemporaryMessage(
          `Can't deselect active multicut segment.`,
          3000,
        );
      }
      segmentsState.visibleSegments.add(focusSegment);
      if (segments) {
        segments = segments.filter((segment) => segment !== focusSegment);
      }
    }
    if (segments === null) {
      // Don't clear equivalences — they come from LUT and must persist.
      StatusMessage.showTemporaryMessage(
        `Hid all ${this.previousVisibleSegmentCount} segment(s).`,
        3000,
      );
      return;
    }
    for (const segmentId of segments) {
      if (
        !added &&
        !isBaseSegmentId(segmentId, this.graph.info.graph.nBitsForLayerId)
      ) {
        // Don't call deleteSet — equivalences come from the LUT trailer
        // and must persist across select/deselect cycles.
        if (this.lastDeselectionMessage && this.lastDeselectionMessageExists) {
          this.lastDeselectionMessage.dispose();
          this.lastDeselectionMessageExists = false;
        }
        this.lastDeselectionMessage = StatusMessage.showMessage(`Hid segment.`);
        this.lastDeselectionMessageExists = true;
        setTimeout(() => {
          if (this.lastDeselectionMessageExists) {
            this.lastDeselectionMessage!.dispose();
            this.lastDeselectionMessageExists = false;
          }
        }, 2000);
      }
    }
    this.previousVisibleSegmentCount = segmentsState.visibleSegments.size;
  }

  private selectedSegmentsChanged(segments: bigint[] | null, added: boolean) {
    const { segmentsState } = this;
    if (segments === null) {
      const leafSegmentCount = this.segmentsState.selectedSegments.size;
      StatusMessage.showTemporaryMessage(
        `Deselected all ${leafSegmentCount} segment(s).`,
        3000,
      );
      return;
    }
    for (const segmentId of segments) {
      if (!added) continue;
      const nBits = this.graph.info.graph.nBitsForLayerId;
      const layerId = segmentId >> BigInt(64 - nBits);

      // Already a root (layer >= 2) — nothing to resolve
      if (layerId >= 2n) continue;

      const resolveAndReplace = (rootId: bigint) => {
        segmentsState.visibleSegments.add(rootId);
        segmentsState.selectedSegments.add(rootId);
        // Drop the source piece so the segment panel only lists the
        // resolved root. selectedSegments.delete cascades to
        // visibleSegments removal, but the volume shader resolves the
        // piece to its root via segmentEquivalences before consulting
        // visibleSegments — as long as root stays selected the voxel
        // still renders with the root's color.
        if (segmentId !== rootId) {
          segmentsState.selectedSegments.delete(segmentId);
        }
      };

      if (layerId === 1n) {
        this.graph
          .getRoot(segmentId, segmentsState.timestamp.value)
          .then(resolveAndReplace);
      } else {
        // Raw piece (layer 0) — check equivalences first, fallback to server
        const representative = segmentsState.segmentEquivalences.get(segmentId);
        if (representative !== segmentId) {
          resolveAndReplace(representative);
        } else {
          const pieceWithLayer =
            (segmentId & 0x00ffffffffffffffn) | (1n << 56n);
          this.graph
            .getRoot(pieceWithLayer, segmentsState.timestamp.value)
            .then((rootId) => {
              resolveAndReplace(rootId);
              segmentsState.segmentEquivalences.link(rootId, segmentId);
            });
        }
      }
    }
  }

  computeSplit(include: bigint, exclude: bigint): ComputedSplit | undefined {
    include;
    exclude;
    return undefined;
  }

  getMeshSource() {
    const { layer } = this;
    for (const dataSource of layer.dataSources) {
      const { loadState } = dataSource;
      if (loadState instanceof LoadedLayerDataSource) {
        const { subsources } = loadState.dataSource;
        const graphSubsource = subsources.filter(
          (subsource) => subsource.id === "graph",
        )[0];
        if (graphSubsource && graphSubsource.subsource.segmentationGraph) {
          if (graphSubsource.subsource.segmentationGraph !== this.graph) {
            continue;
          }
        }
        const meshSubsource = subsources.filter(
          (subsource) => subsource.id === "mesh",
        )[0];
        if (meshSubsource) {
          return meshSubsource.subsource.mesh;
        }
      }
    }
    return undefined;
  }

  private splitModeActive = false;
  private splitModeGeneration = 0;

  async enterSplitMode(focusSegment: bigint) {
    if (this.splitModeActive) return;
    this.splitModeActive = true;
    const generation = ++this.splitModeGeneration;
    try {
      const segmentsState =
        this.layer.displayState.segmentationGroupState.value;
      const pieces = await this.graph.graphServer.getLeaves(
        focusSegment,
        segmentsState.timestamp.value ?? 0,
        this.graph.branchId.value,
      );
      if (this.splitModeGeneration !== generation) return;
      for (const piece of pieces) {
        segmentsState.segmentEquivalences.link(focusSegment, piece);
      }
      segmentsState.segmentEquivalences.changed.dispatch();
    } catch (e) {
      console.warn("[calcada] failed to fetch pieces for split mode:", e);
    }
  }

  exitSplitMode() {
    if (!this.splitModeActive) return;
    this.splitModeActive = false;
    ++this.splitModeGeneration;
  }

  /**
   * After split, re-link equivalences directly from the components the
   * backend returned. The backend already knows which piece moved to
   * which new root — sending the mapping in the split response lets us
   * rebuild equivalences without round-tripping through /leaves (which
   * the ClickHouse materialised view backing it lags behind on writes)
   * or re-fetching chunks (which silently re-applies the stale LUT for
   * chunks the chunk manager still has cached).
   */
  updateAfterSplit(
    oldRoot: bigint,
    newRoots: bigint[],
    components: bigint[][],
  ) {
    const segmentsState = this.layer.displayState.segmentationGroupState.value;
    // Drop the old root entirely — its equivalence class no longer
    // represents anything, and leaving it in visibleSegments would let a
    // stray click on a stale chunk re-select the merged blob via cached
    // mesh data.
    segmentsState.segmentEquivalences.deleteSet(oldRoot);
    segmentsState.visibleSegments.delete(oldRoot);
    segmentsState.selectedSegments.delete(oldRoot);
    for (let i = 0; i < newRoots.length; ++i) {
      const newRoot = newRoots[i];
      segmentsState.visibleSegments.add(newRoot);
      segmentsState.selectedSegments.add(newRoot);
      const comp = components[i];
      if (!comp) continue;
      for (const piece of comp) {
        segmentsState.segmentEquivalences.link(newRoot, piece);
      }
    }
    segmentsState.segmentEquivalences.changed.dispatch();
    // Deliberately NOT calling refreshChunkSources: it would clear the
    // equivalences we just set, and the chunk re-fetch would race the
    // ClickHouse materialised view that backs the LUT — when the MV
    // hasn't propagated the new piece→root mapping yet, the refreshed
    // chunks restore the OLD mapping and the new roots stop rendering
    // until the user manually reloads. The pieces themselves haven't
    // moved in storage, so the cached chunk pixel data is still valid;
    // the in-memory equivalences here are what drive the shader.
  }

  meshAddNewSegments(segments: bigint[]) {
    const meshSource = this.getMeshSource();
    if (meshSource) {
      for (const segment of segments) {
        meshSource.rpc!.invoke(GRAPHENE_MESH_NEW_SEGMENT_RPC_ID, {
          rpcId: meshSource.rpcId!,
          segment,
        });
      }
    }
  }

  async submitMulticut(annotationToNanometers: Float64Array): Promise<boolean> {
    const {
      state: { multicutState },
    } = this;
    const { sinks, sources } = multicutState;
    if (sinks.size === 0 || sources.size === 0) {
      StatusMessage.showTemporaryMessage(
        "Must select both red and blue groups to perform a multi-cut.",
        7000,
      );
      return false;
    } else {
      const { roots: splitRoots, components } =
        await this.graph.graphServer.splitSegments(
          [...sinks].map((x) =>
            selectionInNanometers(x, annotationToNanometers),
          ),
          [...sources].map((x) =>
            selectionInNanometers(x, annotationToNanometers),
          ),
          this.graph.branchId.value,
        );
      if (splitRoots.length === 0) {
        StatusMessage.showTemporaryMessage(`No split found.`, 3000);
        return false;
      } else {
        const focusSegment = multicutState.focusSegment.value!;
        multicutState.reset(); // need to clear the focus segment before deleting the multicut segment
        const { segmentsState } = this;
        segmentsState.selectedSegments.delete(focusSegment);
        for (const segment of [...sinks, ...sources]) {
          segmentsState.selectedSegments.delete(segment.rootId);
        }
        this.meshAddNewSegments(splitRoots);
        segmentsState.selectedSegments.add(splitRoots);
        segmentsState.visibleSegments.add(splitRoots);
        const oldValues = new Uint64Set();
        oldValues.add(focusSegment);
        const newValues = new Uint64Set();
        newValues.add(splitRoots);
        this.state.replaceSegments(oldValues, newValues);
        this.updateAfterSplit(focusSegment, splitRoots, components);
        return true;
      }
    }
  }

  deleteMergeSubmission = (submission: MergeSubmission) => {
    const { mergeAnnotationState } = this;
    submission.locked = false;
    mergeAnnotationState.source.delete(
      mergeAnnotationState.source.getReference(submission.id),
    );
  };

  private submitMerge = async (
    submission: MergeSubmission,
    attempts = 1,
  ): Promise<bigint> => {
    this.graph;
    const loadedSubsource = getGraphLoadedSubsource(this.layer)!;
    const annotationToNanometers =
      loadedSubsource.loadedDataSource.transform.inputSpace.value.scales.map(
        (x) => x / 1e-9,
      );
    submission.error = undefined;
    for (let i = 1; i <= attempts; i++) {
      try {
        // Capture old root IDs BEFORE merge (replaceSegments modifies them)
        const oldRootA = submission.sink.rootId;
        const oldRootB = submission.source!.rootId;

        const { root: newRoot, pieces: mergedPieces } =
          await this.graph.graphServer.mergeSegments(
            selectionInNanometers(submission.sink, annotationToNanometers),
            selectionInNanometers(submission.source!, annotationToNanometers),
            this.graph.branchId.value,
          );
        const oldValues = new Uint64Set();
        oldValues.add(oldRootA);
        oldValues.add(oldRootB);
        const newValues = new Uint64Set();
        newValues.add(newRoot);
        this.state.replaceSegments(oldValues, newValues);

        const segmentsState =
          this.layer.displayState.segmentationGroupState.value;
        // Clear stale equivalences for old roots
        segmentsState.segmentEquivalences.deleteSet(oldRootA);
        segmentsState.segmentEquivalences.deleteSet(oldRootB);
        segmentsState.visibleSegments.add(newRoot);
        segmentsState.selectedSegments.add(newRoot);
        // Register the new root with the mesh source so its mesh fragments
        // are fetched — without this the post-merge 3D view rendered only
        // the slice of pieces that happened to load via residual chunks
        // and the full merged volume only appeared after a manual reload.
        this.meshAddNewSegments([newRoot]);
        // Populate equivalences directly from the merge response's `pieces`
        // field — server returns the union of pieces from both pre-merge
        // roots, so we avoid the post-edit /leaves round-trip that goes
        // through the lagging pieces_latest_by_root MV. Mirror
        // updateAfterSplit: deliberately NO refreshChunkSources here — it
        // clears the equivalences we just set and the chunk re-fetch races
        // the same MV, intermittently leaving one of the merged segments
        // unhighlighted in 2D until the MV catches up. The chunk pixel data
        // is unchanged by a merge; these in-memory links are all the shader
        // needs.
        if (mergedPieces.length > 0) {
          for (const piece of mergedPieces) {
            segmentsState.segmentEquivalences.link(newRoot, piece);
          }
          segmentsState.segmentEquivalences.changed.dispatch();
        } else {
          // Legacy-server fallback (no `pieces` in the merge response): keep
          // the old roots visible while the async /leaves resolves, and
          // refresh chunks so their LUT trailers rebuild the mapping.
          segmentsState.visibleSegments.add(oldRootA);
          segmentsState.visibleSegments.add(oldRootB);
          this.graph.graphServer
            .getLeaves(
              newRoot,
              segmentsState.timestamp.value ?? 0,
              this.graph.branchId.value,
            )
            .then((pieces) => {
              for (const piece of pieces) {
                segmentsState.segmentEquivalences.link(newRoot, piece);
              }
            })
            .catch((e: unknown) => {
              StatusMessage.showTemporaryMessage(
                `Failed to load pieces for ${newRoot}: ${e instanceof Error ? e.message : String(e)}`,
                6000,
              );
            });
          this.refreshChunkSources();
        }
        return newRoot;
      } catch (err) {
        if (i === attempts) {
          submission.error = err.message || "unknown";
          throw err;
        }
      }
    }

    return 0n; // appease typescript
  };

  async bulkMerge(submissions: MergeSubmission[]) {
    const { merges } = this.state.mergeState;
    const bulkMergeHelper = (
      submissions: MergeSubmission[],
    ): Promise<bigint[]> => {
      return new Promise((f) => {
        if (submissions.length === 0) {
          f([]);
          return;
        }
        const segmentsToRemove: bigint[] = [];
        let completed = 0;
        let activeLoops = 0;
        const loop = (completedAt: number, pending: MergeSubmission[]) => {
          if (completed === submissions.length || pending.length === 0) return;
          activeLoops++;
          let failed: MergeSubmission[] = [];
          const checkDone = () => {
            loopDone++;
            if (loopDone === pending.length) {
              activeLoops -= 1;
            }
            if (activeLoops === 0) {
              f(segmentsToRemove);
            }
          };
          let loopDone = 0;
          for (const submission of pending) {
            submission.locked = true;
            submission.status = "trying...";
            merges.changed.dispatch();
            const segments = [
              submission.source!.rootId,
              submission.sink.rootId,
            ];
            this.submitMerge(submission, 3)
              .then((mergedRoot) => {
                segmentsToRemove.push(...segments);
                submission.status = "done";
                submission.mergedRoot = mergedRoot;
                merges.changed.dispatch();
                completed += 1;
                loop(completed, failed);
                failed = [];
                checkDone();
                wait(5000).then(() => {
                  this.deleteMergeSubmission(submission);
                });
              })
              .catch(() => {
                merges.changed.dispatch();
                failed.push(submission);
                if (completed > completedAt) {
                  loop(completed, failed);
                  failed = [];
                }
                checkDone();
              });
          }
        };
        loop(completed, submissions);
      });
    };

    submissions = submissions.filter((x) => !x.locked && x.source);
    const segmentsToRemove = await bulkMergeHelper(submissions);
    const segmentsToAdd: bigint[] = [];
    for (const submission of submissions) {
      if (submission.error) {
        submission.locked = false;
        submission.status = submission.error;
      } else if (submission.mergedRoot) {
        segmentsToAdd.push(submission.mergedRoot);
      }
      const segmentsState =
        this.layer.displayState.segmentationGroupState.value;
      const latestRoots = await this.graph.graphServer.filterLatestRoots(
        segmentsToAdd,
        segmentsState.timestamp.value ?? 0,
        false,
        this.graph.branchId.value,
      );
      const { visibleSegments, selectedSegments } = segmentsState;
      selectedSegments.delete(segmentsToRemove);
      this.meshAddNewSegments(latestRoots);
      selectedSegments.add(latestRoots);
      visibleSegments.add(latestRoots);
      merges.changed.dispatch();
    }
    const segmentsState = this.layer.displayState.segmentationGroupState.value;
    const { visibleSegments, selectedSegments } = segmentsState;
    selectedSegments.delete(segmentsToRemove);
    const latestRoots = await this.graph.graphServer.filterLatestRoots(
      segmentsToAdd,
      segmentsState.timestamp.value ?? 0,
      false,
      this.graph.branchId.value,
    );
    selectedSegments.add(latestRoots);
    visibleSegments.add(latestRoots);
    // Clear stale equivalences for old roots and rebuild for new roots.
    // No chunk refetch needed — piece_ids unchanged, only mapping changes.
    for (const oldRoot of segmentsToRemove) {
      segmentsState.segmentEquivalences.deleteSet(oldRoot);
    }
    for (const newRoot of latestRoots) {
      this.graph.graphServer
        .getLeaves(
          newRoot,
          segmentsState.timestamp.value ?? 0,
          this.graph.branchId.value,
        )
        .then((pieces) => {
          for (const piece of pieces) {
            segmentsState.segmentEquivalences.link(newRoot, piece);
          }
        })
        .catch((e: unknown) => {
          StatusMessage.showTemporaryMessage(
            `Failed to load pieces for ${newRoot}: ${e instanceof Error ? e.message : String(e)}`,
            6000,
          );
        });
    }
    merges.changed.dispatch();
  }

  async submitFindPath(
    precisionMode: boolean,
    annotationToNanometers: Float64Array,
  ): Promise<boolean> {
    const {
      state: { findPathState },
    } = this;
    const { source, target } = findPathState;
    if (!source.value || !target.value) return false;
    const centroids = await this.graph.findPath(
      source.value,
      target.value,
      precisionMode,
      annotationToNanometers,
    );
    StatusMessage.showTemporaryMessage("Path found!", 5000);
    findPathState.centroids.value = centroids;
    return true;
  }
}

async function withErrorMessageHTTP<T>(
  promise: Promise<T>,
  options: {
    initialMessage?: string;
    errorPrefix: string;
  },
): Promise<T> {
  let status: StatusMessage | undefined = undefined;
  let dispose = () => {};
  if (options.initialMessage) {
    status = new StatusMessage(true);
    status.setText(options.initialMessage);
    dispose = status.dispose.bind(status);
  }
  try {
    const response = await promise;
    dispose();
    return response;
  } catch (e) {
    if (e instanceof HttpError && e.response) {
      const { errorPrefix = "" } = options;
      const msg = (await parseGrapheneError(e)) || "unknown error";
      if (!status) {
        status = new StatusMessage(true);
      }
      status.setErrorMessage(errorPrefix + msg);
      status.setVisible(true);
      throw new Error(`[${e.response.status}] ${errorPrefix}${msg}`);
    }
    throw e;
  }
}

const selectionInNanometers = (
  selection: SegmentSelection,
  annotationToNanometers: Float64Array,
): SegmentSelection => {
  const { rootId, segmentId, position } = selection;
  return {
    rootId,
    segmentId,
    position: position.map((val, i) => val * annotationToNanometers[i]),
  };
};

function defaultParentForNewBranch(_graph: GrapheneGraphSource): number {
  return 0;
}

function appendCoordParams(
  url: string,
  coord: { timestamp?: number; branchId?: number },
): string {
  const parts: string[] = [];
  if (coord.timestamp !== undefined && coord.timestamp > 0) {
    parts.push(`timestamp=${coord.timestamp / 1000}`);
  }
  if (coord.branchId !== undefined && coord.branchId !== 0) {
    parts.push(`branch_id=${coord.branchId}`);
  }
  if (parts.length === 0) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${parts.join("&")}`;
}

class GrapheneGraphServerInterface {
  constructor(private httpSource: HttpSource) {}

  async getTimestampLimit() {
    const { fetchOkImpl, baseUrl } = this.httpSource;
    const response = await fetchOkImpl(`${baseUrl}/oldest_timestamp`).then(
      (response) => response.json(),
    );
    const isoString = verifyObjectProperty(response, "iso", verifyString);
    return new Date(isoString).valueOf();
  }

  async getRoot(segment: bigint, timestamp = 0, branchId = 0) {
    const { fetchOkImpl, baseUrl } = this.httpSource;
    const jsonResp = await withErrorMessageHTTP(
      fetchOkImpl(
        appendCoordParams(
          `${baseUrl}/node/${String(segment)}/root?int64_as_str=1`,
          { timestamp, branchId },
        ),
        {},
      ).then((response) => response.json()),
      {
        initialMessage: `Retrieving root for segment ${segment}`,
        errorPrefix: "Could not fetch root: ",
      },
    );
    return parseUint64(jsonResp.root_id);
  }

  async getLeaves(
    segment: bigint,
    timestamp = 0,
    branchId = 0,
  ): Promise<bigint[]> {
    const { fetchOkImpl, baseUrl } = this.httpSource;
    const jsonResp = await withErrorMessageHTTP(
      fetchOkImpl(
        appendCoordParams(
          `${baseUrl}/node/${String(segment)}/leaves?int64_as_str=1`,
          { timestamp, branchId },
        ),
        {},
      ).then((response) => response.json()),
      {
        initialMessage: `Retrieving leaves for segment ${segment}`,
        errorPrefix: "Could not fetch leaves: ",
      },
    );
    const leafIds: string[] = jsonResp.leaf_ids || [];
    return leafIds.map(parseUint64);
  }

  async getEdgeComponents(
    segment: bigint,
    timestamp = 0,
    branchId = 0,
  ): Promise<bigint[][]> {
    const { fetchOkImpl, baseUrl } = this.httpSource;
    const jsonResp = await withErrorMessageHTTP(
      fetchOkImpl(
        appendCoordParams(
          `${baseUrl}/node/${String(segment)}/components?int64_as_str=1`,
          { timestamp, branchId },
        ),
        {},
      ).then((response) => response.json()),
      {
        initialMessage: `Retrieving components for segment ${segment}`,
        errorPrefix: "Could not fetch components: ",
      },
    );
    const components: string[][] = jsonResp.components || [];
    return components.map((c) => c.map(parseUint64));
  }

  async mergeSegments(
    first: SegmentSelection,
    second: SegmentSelection,
    branchId = 0,
  ): Promise<{ root: bigint; pieces: bigint[] }> {
    const { fetchOkImpl, baseUrl } = this.httpSource;
    const promise = fetchOkImpl(
      appendCoordParams(`${baseUrl}/merge?int64_as_str=1`, { branchId }),
      {
        method: "POST",
        body: JSON.stringify([
          [String(first.segmentId), ...first.position],
          [String(second.segmentId), ...second.position],
        ]),
      },
    );
    try {
      const response = await promise;
      const jsonResp = await response.json();
      const root = parseUint64(jsonResp.new_root_ids[0]);
      // Server returns the union of pieces from the two merged roots so the
      // client can populate equivalences without an extra /leaves round-trip
      // that goes through the lagging pieces_latest_by_root MV.
      const rawPieces: string[] = jsonResp.pieces ?? [];
      const pieces = rawPieces.map(parseUint64);
      return { root, pieces };
    } catch (e) {
      if (e instanceof HttpError) {
        const msg = await parseGrapheneError(e);
        throw new Error(msg);
      }
      throw e;
    }
  }

  async splitSegments(
    first: SegmentSelection[],
    second: SegmentSelection[],
    branchId = 0,
  ): Promise<{ roots: bigint[]; components: bigint[][] }> {
    const { fetchOkImpl, baseUrl } = this.httpSource;
    const promise = fetchOkImpl(
      appendCoordParams(`${baseUrl}/split?int64_as_str=1`, { branchId }),
      {
        method: "POST",
        body: JSON.stringify({
          sources: first.map((x) => [String(x.segmentId), ...x.position]),
          sinks: second.map((x) => [String(x.segmentId), ...x.position]),
        }),
      },
    );
    const response = await withErrorMessageHTTP(promise, {
      initialMessage: `Splitting ${first.length} sources from ${second.length} sinks`,
      errorPrefix: "Split failed: ",
    });
    const jsonResp = await response.json();
    const roots: bigint[] = new Array(jsonResp.new_root_ids.length);
    for (let i = 0; i < roots.length; ++i) {
      roots[i] = parseUint64(jsonResp.new_root_ids[i]);
    }
    const rawComponents: string[][] = jsonResp.components || [];
    const components = rawComponents.map((c) => c.map(parseUint64));
    return { roots, components };
  }

  async previewPieceSplit(
    pieceId: bigint,
    blue: VoxelPoint[],
    red: VoxelPoint[],
    imageSource: string,
    branchId = 0,
  ): Promise<PreviewResult> {
    const { fetchOkImpl, baseUrl } = this.httpSource;
    let response: Response;
    try {
      response = await fetchOkImpl(
        appendCoordParams(`${baseUrl}/piece/split_preview`, { branchId }),
        {
          method: "POST",
          body: JSON.stringify({
            // piece_id is a bigint > 2^53 (layer-byte 0x01 stamped) — sending as
            // a JS Number rounds to the nearest float64 and corrupts the value.
            // Backend uses a tagged uint64 that accepts both string and number.
            piece_id: pieceId.toString(),
            blue,
            red,
            image_source: imageSource,
          }),
        },
      );
    } catch (e) {
      throw await wrapCalcadaError(e);
    }
    const jsonResp = await response.json();
    const bboxArr = parseFixedLengthArray(
      new Array(6).fill(0) as [number, number, number, number, number, number],
      jsonResp.bbox,
      verifyInt,
    );
    return {
      bbox: bboxArr,
      maskBase64: typeof jsonResp.mask === "string" ? jsonResp.mask : "",
      maskUrl: verifyString(jsonResp.mask_url),
      expiresAt: jsonResp.expires_at
        ? new Date(jsonResp.expires_at).getTime()
        : Date.now() + 60 * 60 * 1000,
      maskVoxels: Number(jsonResp.mask_voxels ?? 0),
      sourceVoxels: Number(jsonResp.source_voxels ?? 0),
      sinkVoxels: Number(jsonResp.sink_voxels ?? 0),
    };
  }

  async applyPieceSplit(
    pieceId: bigint,
    maskUrl: string,
    branchId = 0,
  ): Promise<bigint[]> {
    const { fetchOkImpl, baseUrl } = this.httpSource;
    let response: Response;
    try {
      response = await fetchOkImpl(
        appendCoordParams(`${baseUrl}/piece/split?int64_as_str=1`, {
          branchId,
        }),
        {
          method: "POST",
          body: JSON.stringify({
            piece_id: pieceId.toString(),
            new_segmentation: maskUrl,
          }),
        },
      );
    } catch (e) {
      throw await wrapCalcadaError(e);
    }
    const jsonResp = await response.json();
    const rootIds: string[] = jsonResp.new_root_ids ?? [];
    return rootIds.map((x) => parseUint64(x));
  }

  async filterLatestRoots(
    segments: bigint[],
    timestamp = 0,
    flipResult = false,
    branchId = 0,
  ): Promise<bigint[]> {
    const { fetchOkImpl, baseUrl } = this.httpSource;
    const url = appendCoordParams(`${baseUrl}/is_latest_roots`, {
      timestamp,
      branchId,
    });
    const promise = fetchOkImpl(url, {
      method: "POST",
      body: JSON.stringify({ node_ids: segments.map((x) => x.toString()) }),
    });
    const jsonResp = await withErrorMessageHTTP(
      promise.then((response) => response.json()),
      {
        errorPrefix: "Could not check latest: ",
      },
    );
    const res: bigint[] = [];
    for (const [i, isLatest] of jsonResp.is_latest.entries()) {
      if (isLatest !== flipResult) {
        res.push(segments[i]);
      }
    }
    return res;
  }

  async findPath(
    first: SegmentSelection,
    second: SegmentSelection,
    precisionMode: boolean,
  ) {
    const { fetchOkImpl, baseUrl } = this.httpSource;
    const promise = fetchOkImpl(
      `${baseUrl}/graph/find_path?int64_as_str=1&precision_mode=${Number(
        precisionMode,
      )}`,
      {
        method: "POST",
        body: JSON.stringify([
          [String(first.rootId), ...first.position],
          [String(second.rootId), ...second.position],
        ]),
      },
    );
    const jsonResp = await withErrorMessageHTTP(
      promise.then((response) => response.json()),
      {
        initialMessage: `Finding path between ${first.segmentId} and ${second.segmentId}`,
        errorPrefix: "Path finding failed: ",
      },
    );
    const supervoxelCentroidsKey = "centroids_list";
    const centroids = verifyObjectProperty(
      jsonResp,
      supervoxelCentroidsKey,
      (x) => parseArray(x, verifyFloatArray),
    );
    const missingL2IdsKey = "failed_l2_ids";
    const missingL2Ids = jsonResp[missingL2IdsKey];
    if (missingL2Ids && missingL2Ids.length > 0) {
      StatusMessage.showTemporaryMessage(
        "Some level 2 meshes are missing, so the path shown may have a poor level of detail.",
      );
    }
    const l2_path = verifyOptionalObjectProperty(
      jsonResp,
      "l2_path",
      verifyStringArray,
    );
    return {
      centroids,
      l2_path,
    };
  }
}

class GrapheneGraphSource extends SegmentationGraphSource {
  public graphServer: GrapheneGraphServerInterface;
  private l2CacheAvailable: boolean | undefined = undefined;
  private httpSource: HttpSource;
  public timestampLimit = new TrackableValue<number>(0, (x) => x);
  public branches = new WatchableValue<
    { id: number; name: string; status: string }[]
  >([]);
  private branchesFetched = false;

  public get branchId(): TrackableValue<number> {
    return this.state.branchId;
  }

  constructor(
    public info: GrapheneMultiscaleVolumeInfo,
    private chunkSource: GrapheneMultiscaleVolumeChunkSource,
    public state: GrapheneState,
  ) {
    super();
    const url = info.app!.segmentationUrl;
    this.httpSource = getHttpSource(
      chunkSource.sharedKvStoreContext.kvStoreContext,
      url,
    );
    this.graphServer = new GrapheneGraphServerInterface(this.httpSource);
    this.graphServer.getTimestampLimit().then((limit) => {
      this.timestampLimit.value = limit;
    });
    this.startBranchRefreshWithRetry();
  }

  // startBranchRefreshWithRetry kicks off /branches and retries on failure —
  // the first call commonly races with the middleauth token handshake and
  // 401s. Without retry the dropdown stays stuck on "main" even after the
  // user is authenticated. Retries back off and stop after a few attempts so
  // a truly broken endpoint doesn't loop forever.
  private startBranchRefreshWithRetry(): void {
    const maxAttempts = 5;
    const baseDelayMs = 1500;
    let attempt = 0;
    const tick = () => {
      this.refreshBranches().catch((e) => {
        attempt++;
        if (attempt >= maxAttempts) {
          console.warn("Failed to fetch calcada branches:", e);
          return;
        }
        setTimeout(tick, baseDelayMs * attempt);
      });
    };
    tick();
  }

  private async refreshBranches(): Promise<void> {
    const { fetchOkImpl, baseUrl } = this.httpSource;
    // include_abandoned=true so the dropdown shows merged/abandoned branches
    // too — restoring state with branchId pointing at an abandoned branch
    // (e.g. an old diff link) needs that option to exist or the select falls
    // back to "main" and looks like the state didn't load. baseUrl is the
    // kvStore-resolved URL (no "middleauth+" prefix); fetchOkImpl on the raw
    // info.app.segmentationUrl fails because browser fetch() rejects the
    // middleauth+ scheme — the bug that left this dropdown empty all along.
    const url = `${baseUrl}/branches?include_abandoned=true`;
    const response = await fetchOkImpl(url);
    const data = await response.json();
    if (!Array.isArray(data)) {
      this.branches.value = [];
      return;
    }
    const parsed: { id: number; name: string; status: string }[] = [];
    for (const entry of data) {
      if (!entry || typeof entry !== "object") continue;
      const id = (entry as any).branch_id;
      const name = (entry as any).branch_name;
      const status = (entry as any).status;
      if (typeof id !== "number" || id === 0) continue;
      if (typeof name !== "string") continue;
      parsed.push({
        id,
        name,
        status: typeof status === "string" ? status : "active",
      });
    }
    this.branches.value = parsed;
    this.branchesFetched = true;
  }

  public get hasFetchedBranches(): boolean {
    return this.branchesFetched;
  }

  public triggerBranchRefresh(): void {
    this.refreshBranches().catch((e) => {
      console.warn("Failed to refresh calcada branches:", e);
    });
  }

  public async createBranch(
    branchName: string,
    parentBranchId: number,
  ): Promise<Response> {
    const { fetchOkImpl, baseUrl } = this.httpSource;
    return fetchOkImpl(`${baseUrl}/branch/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        branch_name: branchName,
        parent_branch_id: parentBranchId,
      }),
    });
  }

  connect(
    layer: SegmentationUserLayer,
  ): Owned<SegmentationGraphSourceConnection> {
    return new GraphConnection(this, layer, this.chunkSource, this.state);
  }

  get visibleSegmentEquivalencePolicy() {
    return (
      VisibleSegmentEquivalencePolicy.MAX_REPRESENTATIVE |
      VisibleSegmentEquivalencePolicy.NONREPRESENTATIVE_EXCLUDED
    );
  }

  getRoot(segment: bigint, timestamp?: number) {
    return this.graphServer.getRoot(segment, timestamp, this.branchId.value);
  }

  async isL2CacheUrlAvailable() {
    if (this.l2CacheAvailable !== undefined) {
      return this.l2CacheAvailable;
    }
    try {
      const { l2CacheUrl, table } = this.info.app;
      const tableMapping = await fetchOk(`${l2CacheUrl}/table_mapping`).then(
        (response) => response.json(),
      );
      verifyObject(tableMapping);
      this.l2CacheAvailable = !!(tableMapping && tableMapping[table]);
      return this.l2CacheAvailable;
    } catch (e) {
      console.error("L2 cache check failed:", e);
      return false;
    }
  }

  async getAttributesForL2Ids(
    l2CacheUrl: string,
    table: string,
    l2Ids: string[],
  ) {
    const { fetchOkImpl } = this.httpSource;
    const repCoordinatesUrl = `${l2CacheUrl}/table/${table}/attributes`;
    const promise = fetchOkImpl(repCoordinatesUrl, {
      method: "POST",
      body: JSON.stringify({
        l2_ids: l2Ids,
      }),
    }).then((response) => response.json());
    return verifyObject(promise);
  }

  async findPath(
    first: SegmentSelection,
    second: SegmentSelection,
    precisionMode: boolean,
    annotationToNanometers: Float64Array,
  ): Promise<number[][]> {
    const { l2CacheUrl, table } = this.info.app;
    const l2CacheAvailable =
      precisionMode && (await this.isL2CacheUrlAvailable());
    let { centroids, l2_path } = await this.graphServer.findPath(
      selectionInNanometers(first, annotationToNanometers),
      selectionInNanometers(second, annotationToNanometers),
      precisionMode && !l2CacheAvailable,
    );
    if (precisionMode && l2CacheAvailable && l2_path) {
      try {
        const attributes = await this.getAttributesForL2Ids(
          l2CacheUrl,
          table,
          l2_path,
        );
        // many reasons why an l2 id might not have info
        // l2 cache has a process that takes time for new ids (even hours)
        // maybe a small fraction have no info
        // sometime l2 is so small (single voxel), it is ignored by l2
        // best to just drop those points
        centroids = l2_path
          .map((id) => {
            return verifyOptionalObjectProperty(attributes, id, (x) => {
              return verifyIntegerArray(x["rep_coord_nm"]);
            });
          })
          .filter((x): x is number[] => x !== undefined);
      } catch (e) {
        console.error("centroids transform failed:", e);
      }
    }
    const centroidsTransformed = centroids.map((point: number[]) => {
      return point.map((val, i) => val / annotationToNanometers[i]);
    });
    return centroidsTransformed;
  }

  tabContents(
    layer: SegmentationUserLayer,
    context: DependentViewContext,
    tab: SegmentationGraphSourceTab,
  ) {
    const parent = document.createElement("div");
    parent.style.display = "contents";
    const toolbox = document.createElement("div");
    toolbox.className = "neuroglancer-segmentation-toolbox";
    parent.appendChild(
      addLayerControlToOptionsTab(tab, layer, tab.visibility, timeControl),
    );
    parent.appendChild(
      addLayerControlToOptionsTab(tab, layer, tab.visibility, branchControl),
    );
    toolbox.appendChild(
      makeToolButton(context, layer.toolBinder, {
        toolJson: CALCADA_MULTICUT_SEGMENTS_TOOL_ID,
        label: "Multicut",
        title: "Multicut segments",
      }),
    );
    toolbox.appendChild(
      makeToolButton(context, layer.toolBinder, {
        toolJson: CALCADA_MERGE_SEGMENTS_TOOL_ID,
        label: "Merge",
        title: "Merge segments",
      }),
    );
    toolbox.appendChild(
      makeToolButton(context, layer.toolBinder, {
        toolJson: CALCADA_FIND_PATH_TOOL_ID,
        label: "Find Path",
        title: "Find Path",
      }),
    );
    toolbox.appendChild(
      makeToolButton(context, layer.toolBinder, {
        toolJson: CALCADA_PIECE_SPLIT_TOOL_ID,
        label: "Piece Split",
        title: "Split a piece using blue/red points",
      }),
    );
    parent.appendChild(toolbox);

    const segmentationGroupStateValue =
      layer.displayState.segmentationGroupState.value;
    const updateReadOnlyClass = () => {
      toolbox.classList.toggle(
        "calcada-time-travel-readonly",
        segmentationGroupStateValue.timestamp.value !== undefined,
      );
    };
    updateReadOnlyClass();
    context.registerDisposer(
      segmentationGroupStateValue.timestamp.changed.add(updateReadOnlyClass),
    );

    parent.appendChild(
      context.registerDisposer(
        new MulticutAnnotationLayerView(layer, layer.annotationDisplayState),
      ).element,
    );
    const tabElement = tab.element;
    tabElement.classList.add("neuroglancer-annotations-tab");
    tabElement.classList.add("neuroglancer-graphene-tab");
    return parent;
  }

  // following not used

  async merge(a: bigint, b: bigint): Promise<bigint> {
    a;
    b;
    return 0n;
  }

  async split(
    include: bigint,
    exclude: bigint,
  ): Promise<{ include: bigint; exclude: bigint }> {
    return { include, exclude };
  }

  trackSegment(
    _id: bigint,
    _callback: (id: bigint | null) => void,
  ): () => void {
    return () => {};
  }
}

class ChunkedGraphChunkSource
  extends SliceViewChunkSource
  implements ChunkedGraphChunkSourceInterface
{
  declare spec: ChunkedGraphChunkSpecification;
  declare OPTIONS: { spec: ChunkedGraphChunkSpecification };

  constructor(
    chunkManager: ChunkManager,
    options: {
      spec: ChunkedGraphChunkSpecification;
    },
  ) {
    super(chunkManager, options);
  }
}

class GrapheneChunkedGraphChunkSource extends WithParameters(
  WithSharedKvStoreContext(ChunkedGraphChunkSource),
  ChunkedGraphSourceParameters,
) {}

type ChunkedGraphLayerDisplayState = SegmentationDisplayState3D;

type TransformedChunkedGraphSource = FrontendTransformedSource<
  SliceViewRenderLayer,
  ChunkedGraphChunkSource
>;

interface AttachmentState {
  chunkTransform: ValueOrError<ChunkTransformParameters>;
  displayDimensionRenderInfo: DisplayDimensionRenderInfo;
  source?: NestedStateManager<TransformedChunkedGraphSource>;
}

class SliceViewPanelChunkedGraphLayer extends SliceViewPanelRenderLayer {
  layerChunkProgressInfo = new LayerChunkProgressInfo();
  sharedObject: SegmentationLayerSharedObject;
  readonly chunkTransform: WatchableValueInterface<
    ValueOrError<ChunkTransformParameters>
  >;

  private leafRequestsActive: SharedWatchableValue<boolean>;
  private leafRequestsStatusMessage: StatusMessage | undefined;

  constructor(
    public chunkManager: ChunkManager,
    public source: SliceViewSingleResolutionSource<ChunkedGraphChunkSource>,
    public displayState: ChunkedGraphLayerDisplayState,
    public localPosition: WatchableValueInterface<Float32Array>,
    nBitsForLayerId: number,
    branchId: WatchableValueInterface<number>,
  ) {
    super();
    this.leafRequestsActive = this.registerDisposer(
      SharedWatchableValue.make(chunkManager.rpc!, true),
    );
    this.chunkTransform = this.registerDisposer(
      makeCachedLazyDerivedWatchableValue(
        (modelTransform) =>
          makeValueOrError(() =>
            getChunkTransformParameters(valueOrThrow(modelTransform)),
          ),
        this.displayState.transform,
      ),
    );
    const sharedObject =
      (this.sharedObject =
      this.backend =
        this.registerDisposer(
          new SegmentationLayerSharedObject(
            chunkManager,
            displayState,
            this.layerChunkProgressInfo,
          ),
        ));
    sharedObject.RPC_TYPE_ID = CHUNKED_GRAPH_LAYER_RPC_ID;
    sharedObject.initializeCounterpartWithChunkManager({
      source: source.chunkSource.addCounterpartRef(),
      localPosition: this.registerDisposer(
        SharedWatchableValue.makeFromExisting(
          chunkManager.rpc!,
          this.localPosition,
        ),
      ).rpcId,
      leafRequestsActive: this.leafRequestsActive.rpcId,
      nBitsForLayerId: this.registerDisposer(
        SharedWatchableValue.make(chunkManager.rpc!, nBitsForLayerId),
      ).rpcId,
      // Shared with backend so the chunked-graph layer can identify its
      // own chunks: CalcadaVolumeChunkSource.download filters layers by
      // matching branchId before applying a chunk's piece→root LUT.
      branchId: this.registerDisposer(
        SharedWatchableValue.makeFromExisting(chunkManager.rpc!, branchId),
      ).rpcId,
    });
    this.registerDisposer(sharedObject.visibility.add(this.visibility));

    this.registerDisposer(
      this.leafRequestsActive.changed.add(() => {
        this.showOrHideMessage(this.leafRequestsActive.value);
      }),
    );
  }

  attach(attachment: VisibleLayerInfo<LayerView, AttachmentState>) {
    super.attach(attachment);
    const chunkTransform = this.chunkTransform.value;
    const displayDimensionRenderInfo =
      attachment.view.displayDimensionRenderInfo.value;
    attachment.state = {
      chunkTransform,
      displayDimensionRenderInfo,
    };
    attachment.state!.source = attachment.registerDisposer(
      registerNested(
        (
          context: RefCounted,
          transform: RenderLayerTransformOrError,
          displayDimensionRenderInfo: DisplayDimensionRenderInfo,
        ) => {
          const transformedSources = getVolumetricTransformedSources(
            displayDimensionRenderInfo,
            transform,
            (_options) => [[this.source]],
            attachment.messages,
            this,
          ) as TransformedChunkedGraphSource[][];
          attachment.view.flushBackendProjectionParameters();
          this.sharedObject.rpc!.invoke(
            CHUNKED_GRAPH_RENDER_LAYER_UPDATE_SOURCES_RPC_ID,
            {
              layer: this.sharedObject.rpcId,
              view: attachment.view.rpcId,
              displayDimensionRenderInfo,
              sources: serializeAllTransformedSources(transformedSources),
            },
          );
          context;
          return transformedSources[0][0];
        },
        this.displayState.transform,
        attachment.view.displayDimensionRenderInfo,
      ),
    );
  }

  isReady() {
    return true;
  }

  private showOrHideMessage(leafRequestsActive: boolean) {
    if (this.leafRequestsStatusMessage && leafRequestsActive) {
      this.leafRequestsStatusMessage.dispose();
      this.leafRequestsStatusMessage = undefined;
      StatusMessage.showTemporaryMessage(
        "Loading chunked graph segmentation...",
        3000,
      );
    } else if (!this.leafRequestsStatusMessage && !leafRequestsActive) {
      this.leafRequestsStatusMessage = StatusMessage.showMessage(
        "At this zoom level, chunked graph segmentation will not be loaded. Please zoom in if you wish to load it.",
      );
    }
  }
}

const CALCADA_MULTICUT_SEGMENTS_TOOL_ID = "calcadaMulticutSegments";
const CALCADA_MERGE_SEGMENTS_TOOL_ID = "calcadaMergeSegments";
const CALCADA_FIND_PATH_TOOL_ID = "calcadaFindPath";
const CALCADA_PIECE_SPLIT_TOOL_ID = "calcadaPieceSplit";

class MulticutAnnotationLayerView extends AnnotationLayerView {
  declare private _annotationStates: MergedAnnotationStates;
  constructor(
    public layer: SegmentationUserLayer,
    public displayState: AnnotationDisplayState,
  ) {
    super(layer, displayState);
    const {
      graphConnection: { value: graphConnection },
    } = layer;
    if (graphConnection instanceof GraphConnection) {
      for (const state of graphConnection.annotationLayerStates) {
        this.annotationStates.add(state);
      }
    }
  }

  get annotationStates() {
    if (this._annotationStates === undefined) {
      this._annotationStates = this.registerDisposer(
        new MergedAnnotationStates(),
      );
    }
    return this._annotationStates;
  }
}

const addSelection = (
  source: AnnotationSource | MultiscaleAnnotationSource,
  selection: SegmentSelection,
  description?: string,
) => {
  const annotation: Point = {
    id: "",
    point: selection.position,
    type: AnnotationType.POINT,
    properties: [],
    relatedSegments: [BigUint64Array.of(selection.segmentId, selection.rootId)],
    description,
  };
  const ref = source.add(annotation);
  selection.annotationReference = ref;
};

const synchronizeAnnotationSource = (
  source: WatchableSet<SegmentSelection>,
  state: AnnotationLayerState,
) => {
  const annotationSource = state.source;
  annotationSource.childDeleted.add((annotationId) => {
    const selection = [...source].find(
      (selection) => selection.annotationReference?.id === annotationId,
    );
    if (selection) source.delete(selection);
  });

  source.changed.add((x, add) => {
    if (x === null) {
      for (const annotation of annotationSource) {
        annotationSource.delete(annotationSource.getReference(annotation.id));
      }
      return;
    }
    if (add) {
      addSelection(annotationSource, x);
    } else if (x.annotationReference) {
      annotationSource.delete(x.annotationReference);
    }
  });
  // load initial state
  for (const selection of source) {
    addSelection(annotationSource, selection);
  }
};

function getMousePositionInLayerCoordinates(
  unsnappedPosition: Float32Array,
  layer: SegmentationUserLayer,
): Float32Array | undefined {
  const loadedSubsource = getGraphLoadedSubsource(layer)!;
  const modelTransform = loadedSubsource.getRenderLayerTransform();
  const chunkTransform = makeValueOrError(() =>
    getChunkTransformParameters(valueOrThrow(modelTransform.value)),
  );
  if (chunkTransform.error !== undefined) return undefined;
  const chunkPosition = new Float32Array(
    chunkTransform.modelTransform.unpaddedRank,
  );
  if (
    !getChunkPositionFromCombinedGlobalLocalPositions(
      chunkPosition,
      unsnappedPosition,
      layer.localPosition.value,
      chunkTransform.layerRank,
      chunkTransform.combinedGlobalLocalToChunkTransform,
    )
  ) {
    return undefined;
  }
  return chunkPosition;
}

const getPoint = (
  layer: SegmentationUserLayer,
  mouseState: MouseSelectionState,
) => {
  if (mouseState.updateUnconditionally()) {
    return getMousePositionInLayerCoordinates(
      mouseState.unsnappedPosition,
      layer,
    );
  }
  return undefined;
};

const GRAPHENE_TIME_JSON_KEY = "grapheneTime";

const timeControl = {
  label: "Time",
  title: "View segmentation at earlier point of time",
  toolJson: GRAPHENE_TIME_JSON_KEY,
  ...timeLayerControl(),
};

registerLayerControl(SegmentationUserLayer, timeControl);

function branchLayerControl(): LayerControlFactory<SegmentationUserLayer> {
  return {
    makeControl: (layer, context) => {
      const segmentationGroupState =
        layer.displayState.segmentationGroupState.value;
      const {
        graph: { value: graph },
      } = segmentationGroupState;
      const branchId =
        graph instanceof GrapheneGraphSource
          ? graph.branchId
          : new TrackableValue<number>(0, (x) => x);

      const controlElement = document.createElement("div");
      controlElement.classList.add("neuroglancer-calcada-branch-control");

      const select = document.createElement("select");
      select.classList.add("neuroglancer-layer-control-control");
      select.title =
        "Calcada branch (main = 0). Switching clears segments not present on the new branch.";

      const renderOptions = () => {
        const branches =
          graph instanceof GrapheneGraphSource ? graph.branches.value : [];
        while (select.firstChild) {
          select.removeChild(select.firstChild);
        }
        const mainOption = document.createElement("option");
        mainOption.value = "0";
        mainOption.textContent = "main";
        select.appendChild(mainOption);
        // Show active branches in the dropdown. Non-active branches
        // (merged/abandoned) are hidden unless the layer state points at one
        // of them — restoring such state without that option would leave the
        // select stuck on "main" even though branchId.value is set, making
        // it look like state restore didn't work.
        const selectedId = branchId.value;
        for (const { id, name, status } of branches) {
          const isActive = status === "active";
          if (!isActive && id !== selectedId) continue;
          const opt = document.createElement("option");
          opt.value = String(id);
          opt.textContent = isActive ? name : `${name} (${status})`;
          select.appendChild(opt);
        }
        select.value = String(selectedId);
      };
      renderOptions();

      select.addEventListener("change", () => {
        const parsed = Number.parseInt(select.value, 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
          select.value = String(branchId.value);
          return;
        }
        if (parsed === branchId.value) return;
        // Drop selected segments synchronously before switching — the
        // branchId.changed listener also clears, but doing it here too
        // suppresses the "Could not fetch root: piece not found" spam
        // that would otherwise fire from any in-flight selectedSegments
        // changes referencing pieces local to the previous branch.
        segmentationGroupState.selectedSegments.clear();
        segmentationGroupState.visibleSegments.clear();
        segmentationGroupState.segmentEquivalences.clear();
        branchId.value = parsed;
      });

      select.addEventListener("focus", () => {
        if (graph instanceof GrapheneGraphSource) {
          graph.triggerBranchRefresh();
        }
      });

      const sync = () => {
        // Re-render so a non-active branch becomes a visible option when
        // branchId points at it; otherwise the select silently falls back
        // to "main" because the matching <option> doesn't exist.
        renderOptions();
      };
      context.registerDisposer(branchId.changed.add(sync));
      if (graph instanceof GrapheneGraphSource) {
        context.registerDisposer(graph.branches.changed.add(renderOptions));
      }
      controlElement.appendChild(select);

      const newBranchButton = document.createElement("button");
      newBranchButton.type = "button";
      newBranchButton.textContent = "+ New branch";
      controlElement.appendChild(newBranchButton);

      const createForm = document.createElement("div");
      createForm.style.display = "none";
      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.name = "branch_name";
      const createButton = document.createElement("button");
      createButton.type = "submit";
      createButton.textContent = "Create";
      const errorSpan = document.createElement("span");
      errorSpan.className = "branch-create-error";
      createForm.appendChild(nameInput);
      createForm.appendChild(createButton);
      createForm.appendChild(errorSpan);
      controlElement.appendChild(createForm);

      newBranchButton.addEventListener("click", () => {
        const isHidden = createForm.style.display === "none";
        createForm.style.display = isHidden ? "" : "none";
        if (isHidden) {
          nameInput.focus();
        }
      });

      const submitCreate = async () => {
        if (!(graph instanceof GrapheneGraphSource)) return;
        const name = String(nameInput.value).trim();
        if (name.length === 0) return;
        createButton.disabled = true;
        try {
          let response: Response;
          try {
            response = await graph.createBranch(
              name,
              defaultParentForNewBranch(graph),
            );
          } catch (e: any) {
            const resp: Response | undefined = e?.response;
            let msg = "";
            if (resp) {
              try {
                const errBody = await resp.json();
                msg = errBody?.error || errBody?.message || "";
              } catch {
                msg = "";
              }
              if (!msg) msg = `${resp.status} ${resp.statusText}`;
            } else {
              msg = e instanceof Error ? e.message : String(e);
            }
            errorSpan.textContent = msg;
            return;
          }
          let body: any = {};
          try {
            body = await response.json();
          } catch {
            body = {};
          }
          const newId = body?.branch_id;
          const newName = body?.branch_name;
          if (typeof newId !== "number" || typeof newName !== "string") {
            errorSpan.textContent = "Invalid response from server";
            return;
          }
          graph.branches.value = [
            ...graph.branches.value,
            { id: newId, name: newName, status: "active" },
          ];
          graph.branchId.value = newId;
          nameInput.value = "";
          createForm.style.display = "none";
          errorSpan.textContent = "";
          graph.triggerBranchRefresh();
        } finally {
          createButton.disabled = false;
        }
      };

      createButton.addEventListener("click", (e) => {
        e.preventDefault();
        submitCreate();
      });
      nameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submitCreate();
        }
      });

      const diffLink = document.createElement("a");
      diffLink.className = "calcada-open-diff";
      diffLink.textContent = "Open diff";
      diffLink.target = "_blank";
      diffLink.rel = "noopener";
      controlElement.appendChild(diffLink);

      const updateDiffLink = () => {
        if (!(graph instanceof GrapheneGraphSource)) {
          diffLink.style.display = "none";
          return;
        }
        // segmentationUrl may carry a "middleauth+" scheme prefix from the
        // kvstore parser; strip it before passing to new URL() so .origin
        // yields a plain https:// URL the browser can navigate to.
        const rawUrl = graph.info.app!.segmentationUrl.replace(
          /^middleauth\+/,
          "",
        );
        const adminOrigin = new URL(rawUrl).origin;
        diffLink.href = `${adminOrigin}/admin/graphs/${graph.info.app!.table}/branches/${branchId.value}/diff`;
        diffLink.style.display = branchId.value === 0 ? "none" : "";
      };
      updateDiffLink();
      context.registerDisposer(branchId.changed.add(updateDiffLink));

      return { controlElement, control: select };
    },
    activateTool: (_activation) => {},
  };
}

const branchControl = {
  label: "Branch",
  title: "Calcada branch (0 = main)",
  toolJson: CALCADA_BRANCH_JSON_KEY,
  ...branchLayerControl(),
};

registerLayerControl(SegmentationUserLayer, branchControl);

function timeLayerControl(): LayerControlFactory<SegmentationUserLayer> {
  return {
    makeControl: (layer, context) => {
      const segmentationGroupState =
        layer.displayState.segmentationGroupState.value;
      const {
        graph: { value: graph },
      } = segmentationGroupState;
      const timestamp =
        graph instanceof GrapheneGraphSource
          ? segmentationGroupState.timestamp
          : new WatchableValue<number | undefined>(undefined);
      const timestampLimit =
        graph instanceof GrapheneGraphSource
          ? graph.timestampLimit
          : new WatchableValue<number>(0);
      const timestampOwner =
        graph instanceof GrapheneGraphSource
          ? segmentationGroupState.timestampOwner
          : new WatchableSet<string>();

      const controlElement = document.createElement("div");
      controlElement.classList.add("neuroglancer-time-control");
      const intermediateTimestamp = new WatchableValue<number | undefined>(
        timestamp.value,
      );
      intermediateTimestamp.changed.add(async () => {
        if (intermediateTimestamp.value === timestamp.value) {
          return;
        }
        // resetting timestamp back to unset
        if (
          intermediateTimestamp.value === undefined &&
          segmentationGroupState.canSetTimestamp(layer.managedLayer.name)
        ) {
          timestamp.value = intermediateTimestamp.value;
          timestampOwner.delete(layer.managedLayer.name);
          return;
        }
        if (graph instanceof GrapheneGraphSource) {
          const selfLock = segmentationGroupState.timestampOwner.has(
            layer.managedLayer.name,
          );
          const canSetTimestamp = segmentationGroupState.canSetTimestamp(
            layer.managedLayer.name,
          );
          // if we have a lock while the timestamp is unset, it is a tool-based lock (this check can be improved)
          if (canSetTimestamp && (!selfLock || timestamp.value !== undefined)) {
            const nonLatestRoots = await graph.graphServer.filterLatestRoots(
              [...segmentationGroupState.selectedSegments],
              timestamp.value,
              true,
              graph.branchId.value,
            );
            if (
              !nonLatestRoots.length ||
              confirm(
                `Changing graphene time will clear ${nonLatestRoots.length} segment(s).`,
              )
            ) {
              timestamp.value = intermediateTimestamp.value;
              // is this where it is done
              timestampOwner.add(layer.managedLayer.name);
              return;
            }
          }
          intermediateTimestamp.value = timestamp.value;
          StatusMessage.showTemporaryMessage("Timestamp is locked.");
        }
      });
      const widget = context.registerDisposer(
        new DateTimeInputWidget(
          intermediateTimestamp,
          new Date(timestampLimit.value),
          new Date(),
        ),
      );
      timestampLimit.changed.add(() => {
        widget.setMin(new Date(timestampLimit.value));
      });
      timestamp.changed.add(() => {
        if (timestamp.value !== intermediateTimestamp.value) {
          intermediateTimestamp.value = timestamp.value;
        }
      });
      controlElement.appendChild(widget.element);
      return { controlElement, control: widget };
    },
    activateTool: (_activation) => {},
  };
}

const checkSegmentationOld = (
  timestamp: WatchableValue<number | undefined>,
  activation: ToolActivation,
) => {
  if (timestamp.value !== undefined) {
    StatusMessage.showTemporaryMessage(
      "Editing can not be performed with a segmentation at an older state.",
    );
    activation.cancel();
    return true;
  }
  return false;
};

const MULTICUT_SEGMENTS_INPUT_EVENT_MAP = EventActionMap.fromObject({
  "at:shift?+control+mousedown0": { action: "set-anchor" },
  "at:shift?+keyg": { action: "swap-group" },
  "at:shift?+enter": { action: "submit" },
});

class MulticutSegmentsTool extends LayerTool<SegmentationUserLayer> {
  toJSON() {
    return CALCADA_MULTICUT_SEGMENTS_TOOL_ID;
  }

  activate(activation: ToolActivation<this>) {
    const { layer } = this;
    const {
      graphConnection: { value: graphConnection },
    } = layer;
    if (!graphConnection || !(graphConnection instanceof GraphConnection))
      return;
    const {
      state: { multicutState },
      segmentsState,
    } = graphConnection;
    if (multicutState === undefined) return;
    if (checkSegmentationOld(segmentsState.timestamp, activation)) {
      return;
    }

    // When focus segment is set, enter split mode to show pieces.
    // Watch for focusSegment changes to trigger split mode.
    const splitModeDisposer = multicutState.focusSegment.changed.add(() => {
      const focus = multicutState.focusSegment.value;
      if (focus !== undefined) {
        graphConnection.enterSplitMode(focus);
      }
    });
    // If focus segment already set (e.g. restored from state), enter immediately
    if (multicutState.focusSegment.value !== undefined) {
      graphConnection.enterSplitMode(multicutState.focusSegment.value);
    }
    activation.registerDisposer(() => {
      splitModeDisposer();
      graphConnection.exitSplitMode();
    });

    const { body, header } =
      makeToolActivationStatusMessageWithHeader(activation);
    header.textContent = "Multicut segments";
    body.classList.add("graphene-tool-status", "graphene-multicut");
    body.appendChild(
      makeIcon({
        text: "Swap",
        title: "Swap group",
        onClick: () => {
          multicutState.swapGroup();
        },
      }),
    );
    body.appendChild(
      makeIcon({
        text: "Clear",
        title: "Clear multicut",
        onClick: () => {
          multicutState.reset();
        },
      }),
    );
    const submitAction = async () => {
      submitIcon.classList.toggle("disabled", true);
      const loadedSubsource = getGraphLoadedSubsource(this.layer)!;
      const annotationToNanometers =
        loadedSubsource.loadedDataSource.transform.inputSpace.value.scales.map(
          (x) => x / 1e-9,
        );
      graphConnection.submitMulticut(annotationToNanometers).then((success) => {
        submitIcon.classList.toggle("disabled", false);
        if (success) {
          activation.cancel();
        }
      });
    };
    const submitIcon = makeIcon({
      text: "Submit",
      title: "Submit multicut",
      onClick: () => {
        submitAction();
      },
    });
    body.appendChild(submitIcon);
    const activeGroupIndicator = document.createElement("div");
    activeGroupIndicator.className = "activeGroupIndicator";
    activeGroupIndicator.innerHTML = "Active Group: ";
    body.appendChild(activeGroupIndicator);

    const { displayState } = this.layer;
    // Ensure we use the same segmentationGroupState while activated.
    const segmentationGroupState = displayState.segmentationGroupState.value;
    const priorBaseSegmentHighlighting =
      displayState.baseSegmentHighlighting.value;
    const priorHighlightColor = displayState.highlightColor.value;
    const priorHideSegmentZero = displayState.hideSegmentZero.value;

    activation.bindInputEventMap(MULTICUT_SEGMENTS_INPUT_EVENT_MAP);
    activation.registerDisposer(() => {
      resetMulticutDisplay();
      displayState.baseSegmentHighlighting.value = priorBaseSegmentHighlighting;
      displayState.highlightColor.value = priorHighlightColor;
      displayState.hideSegmentZero.value = priorHideSegmentZero;
    });
    const resetMulticutDisplay = () => {
      resetTemporaryVisibleSegmentsState(segmentationGroupState);
      displayState.useTempSegmentStatedColors2d.value = false;
      displayState.tempSegmentStatedColors2d.value.clear(); // TODO, should only clear those that are in temp sets
      displayState.tempSegmentDefaultColor2d.value = undefined;
      displayState.highlightColor.value = undefined;
    };
    const updateMulticutDisplay = () => {
      resetMulticutDisplay();
      activeGroupIndicator.classList.toggle(
        "blueGroup",
        multicutState.blueGroup.value,
      );
      const focusSegment = multicutState.focusSegment.value;
      if (focusSegment === undefined) return;
      displayState.baseSegmentHighlighting.value = true;
      displayState.highlightColor.value = multicutState.blueGroup.value
        ? BLUE_COLOR_HIGHTLIGHT
        : RED_COLOR_HIGHLIGHT;
      displayState.hideSegmentZero.value = false;
      segmentsState.useTemporaryVisibleSegments.value = true;
      segmentsState.useTemporarySegmentEquivalences.value = true;
      // add focus segment and red/blue segments
      segmentsState.temporaryVisibleSegments.add(focusSegment);
      for (const segment of multicutState.segments) {
        segmentsState.temporaryVisibleSegments.add(segment);
      }
      // all other segments are added to the focus segment equivalences
      for (const equivalence of segmentsState.segmentEquivalences.setElements(
        focusSegment,
      )) {
        if (!segmentsState.temporaryVisibleSegments.has(equivalence)) {
          segmentsState.temporarySegmentEquivalences.link(
            focusSegment,
            equivalence,
          );
        }
      }
      // set colors
      displayState.tempSegmentDefaultColor2d.value = MULTICUT_OFF_COLOR;
      displayState.tempSegmentStatedColors2d.value.set(
        focusSegment,
        TRANSPARENT_COLOR_PACKED,
      );
      for (const segment of multicutState.redSegments) {
        displayState.tempSegmentStatedColors2d.value.set(
          segment,
          RED_COLOR_SEGMENT_PACKED,
        );
      }
      for (const segment of multicutState.blueSegments) {
        displayState.tempSegmentStatedColors2d.value.set(
          segment,
          BLUE_COLOR_SEGMENT_PACKED,
        );
      }

      displayState.useTempSegmentStatedColors2d.value = true;
    };
    updateMulticutDisplay();
    activation.registerDisposer(
      multicutState.changed.add(updateMulticutDisplay),
    );
    activation.registerDisposer(
      segmentationGroupState.segmentEquivalences.changed.add(
        debounce(() => updateMulticutDisplay(), 0),
      ),
    );
    activation.bindAction("swap-group", (event) => {
      event.stopPropagation();
      multicutState.swapGroup();
    });
    activation.bindAction("set-anchor", (event) => {
      event.stopPropagation();
      const currentSegmentSelection = maybeGetSelection(
        this,
        segmentationGroupState.visibleSegments,
      );
      if (!currentSegmentSelection) return;
      const { rootId, segmentId } = currentSegmentSelection;
      const { focusSegment, segments } = multicutState;
      if (focusSegment.value === undefined) {
        focusSegment.value = rootId;
      }
      if (focusSegment.value !== rootId) {
        StatusMessage.showTemporaryMessage(
          `The selected supervoxel has root segment ${rootId}, but the supervoxels already selected have root ${focusSegment.value}`,
          12000,
        );
        return;
      }
      const isRoot = rootId === segmentId;
      if (!isRoot) {
        for (const segment of segments) {
          if (segment === segmentId) {
            StatusMessage.showTemporaryMessage(
              `Supervoxel ${segmentId} has already been selected`,
              7000,
            );
            return;
          }
        }
      }
      multicutState.activeGroup.add(currentSegmentSelection);
    });
    activation.bindAction("submit", (event) => {
      event.stopPropagation();
      submitAction();
    });
  }

  get description() {
    return "multicut";
  }
}

const maybeGetSelection = (
  tool: LayerTool<SegmentationUserLayer>,
  visibleSegments: Uint64Set,
): SegmentSelection | undefined => {
  const { layer, mouseState } = tool;
  const {
    segmentSelectionState: { value, baseValue },
  } = layer.displayState;
  if (!baseValue || !value) return;
  if (!visibleSegments.has(value)) {
    StatusMessage.showTemporaryMessage(
      "The selected supervoxel is of an unselected segment",
      7000,
    );
    return;
  }
  const point = getPoint(layer, mouseState);
  if (point === undefined) return;
  return {
    rootId: value,
    segmentId: baseValue,
    position: point,
  };
};

const wait = (t: number) => {
  return new Promise((f, _r) => {
    setTimeout(f, t);
  });
};

interface MergeSubmission {
  id: string;
  locked: boolean;
  error?: string;
  status?: string;
  sink: SegmentSelection;
  source?: SegmentSelection;
  mergedRoot?: bigint;
}

export class MergeSegmentsPlaceLineTool extends PlaceLineTool {
  getBaseSegment = true;
  constructor(
    layer: SegmentationUserLayer,
    private annotationState: AnnotationLayerState,
  ) {
    super(layer, {});
    const { inProgressAnnotation } = this;
    const { displayState } = annotationState;
    if (!displayState) return; // TODO, this happens when reloading the page when a toggle tool is up
    const { disablePicking } = displayState;
    this.registerDisposer(
      inProgressAnnotation.changed.add(() => {
        disablePicking.value = inProgressAnnotation.value !== undefined;
      }),
    );
  }
  get annotationLayer() {
    return this.annotationState;
  }
  get description() {
    return "merge line";
  }
  toJSON() {
    return ANNOTATE_MERGE_LINE_TOOL_ID;
  }
}

function lineToSubmission(line: Line, pending: boolean): MergeSubmission {
  const relatedSegments = line.relatedSegments![0];
  const res: MergeSubmission = {
    id: line.id,
    locked: false,
    sink: {
      position: line.pointA.slice(),
      rootId: relatedSegments[0],
      segmentId: relatedSegments[1],
    },
  };
  if (!pending) {
    res.source = {
      position: line.pointB.slice(),
      rootId: relatedSegments[2],
      segmentId: relatedSegments[3],
    };
  }
  return res;
}

function mergeToLine(submission: MergeSubmission): Line {
  const { sink, source } = submission;
  const res: Line = {
    id: submission.id,
    type: AnnotationType.LINE,
    pointA: sink.position.slice(),
    pointB: source!.position.slice(),
    relatedSegments: [
      BigUint64Array.of(
        sink.rootId,
        sink.segmentId,
        source!.rootId,
        source!.segmentId,
      ),
    ],
    properties: [],
  };
  return res;
}

const MAX_MERGE_COUNT = 20;

const MERGE_SEGMENTS_INPUT_EVENT_MAP = EventActionMap.fromObject({
  "at:shift?+enter": { action: "submit" },
});

class MergeSegmentsTool extends LayerTool<SegmentationUserLayer> {
  activate(activation: ToolActivation<this>) {
    const {
      graphConnection: { value: graphConnection },
      tool,
    } = this.layer;
    if (!graphConnection || !(graphConnection instanceof GraphConnection)) {
      activation.cancel();
      return;
    }
    const {
      state: { mergeState },
      segmentsState: { timestamp },
      mergeAnnotationState,
    } = graphConnection;
    if (checkSegmentationOld(timestamp, activation)) {
      return;
    }
    const { merges, autoSubmit } = mergeState;
    const lineTool = new MergeSegmentsPlaceLineTool(
      this.layer,
      mergeAnnotationState,
    );
    tool.value = lineTool;
    activation.registerDisposer(() => {
      tool.value = undefined;
    });
    const { body, header } =
      makeToolActivationStatusMessageWithHeader(activation);
    header.textContent = "Merge segments";
    body.classList.add("graphene-tool-status", "graphene-merge-segments");
    activation.bindInputEventMap(MERGE_SEGMENTS_INPUT_EVENT_MAP);
    const submitAction = async () => {
      if (merges.value.filter((x) => x.locked).length) return;
      submitIcon.classList.toggle("disabled", true);
      await graphConnection.bulkMerge(merges.value);
      submitIcon.classList.toggle("disabled", false);
    };
    const submitIcon = makeIcon({
      text: "Submit",
      title: "Submit merge",
      onClick: async () => {
        submitAction();
      },
    });
    body.appendChild(submitIcon);
    activation.bindAction("submit", async (event) => {
      event.stopPropagation();
      submitAction();
    });
    body.appendChild(
      makeIcon({
        text: "Clear",
        title: "Clear pending merges",
        onClick: () => {
          lineTool.deactivate();
          for (const merge of merges.value) {
            if (!merge.locked) {
              graphConnection.deleteMergeSubmission(merge);
            }
          }
        },
      }),
    );
    const checkbox = activation.registerDisposer(
      new TrackableBooleanCheckbox(autoSubmit),
    );
    const label = document.createElement("label");
    label.appendChild(document.createTextNode("auto-submit"));
    label.title = "auto-submit merges";
    label.appendChild(checkbox.element);
    body.appendChild(label);
    const points = document.createElement("div");
    points.classList.add("graphene-merge-segments-merges");
    body.appendChild(points);

    const segmentWidgetFactory = SegmentWidgetFactory.make(
      this.layer.displayState,
      /*includeUnmapped=*/ true,
    );
    const makeWidget = (id: Uint64MapEntry) => {
      const row = segmentWidgetFactory.getWithNormalizedId(id);
      row.classList.add("neuroglancer-segment-list-entry-double-line");
      return row;
    };

    const createPointElement = (id: bigint) => {
      const containerEl = document.createElement("div");
      containerEl.classList.add("graphene-merge-segments-point");
      const widget = makeWidget(augmentSegmentId(this.layer.displayState, id));
      containerEl.appendChild(widget);
      return containerEl;
    };

    const createSubmissionElement = (submission: MergeSubmission) => {
      const containerEl = document.createElement("div");
      containerEl.classList.add("graphene-merge-segments-submission");
      containerEl.appendChild(createPointElement(submission.sink.rootId));
      if (submission.source) {
        containerEl.appendChild(document.createElement("div")).textContent =
          "ꕹ";
        containerEl.appendChild(createPointElement(submission.source.rootId));
      }
      if (!submission.locked) {
        containerEl.appendChild(
          makeDeleteButton({
            title: "Delete merge",
            onClick: (event) => {
              event.stopPropagation();
              event.preventDefault();
              graphConnection.deleteMergeSubmission(submission);
            },
          }),
        );
      }
      if (submission.status) {
        const statusEl = document.createElement("div");
        statusEl.classList.add("graphene-merge-segments-submission-status");
        statusEl.textContent = submission.status;
        containerEl.appendChild(statusEl);
      }
      return containerEl;
    };

    const updateUI = () => {
      while (points.firstChild) {
        points.removeChild(points.firstChild);
      }
      for (const submission of merges.value) {
        points.appendChild(createSubmissionElement(submission));
      }
    };
    activation.registerDisposer(merges.changed.add(updateUI));
    updateUI();
  }

  toJSON() {
    return CALCADA_MERGE_SEGMENTS_TOOL_ID;
  }

  get description() {
    return "merge segments";
  }
}

const FIND_PATH_INPUT_EVENT_MAP = EventActionMap.fromObject({
  "at:shift?+enter": { action: "submit" },
  "at:shift?+control+mousedown0": { action: "add-point" },
});

class FindPathTool extends LayerTool<SegmentationUserLayer> {
  activate(activation: ToolActivation<this>) {
    const { layer } = this;
    const {
      graphConnection: { value: graphConnection },
    } = layer;
    if (!graphConnection || !(graphConnection instanceof GraphConnection))
      return;
    const {
      state: { findPathState },
      findPathAnnotationState,
    } = graphConnection;
    const { source, target, precisionMode } = findPathState;
    // Ensure we use the same segmentationGroupState while activated.
    const segmentationGroupState =
      this.layer.displayState.segmentationGroupState.value;
    if (checkSegmentationOld(segmentationGroupState.timestamp, activation)) {
      return;
    }
    const { body, header } =
      makeToolActivationStatusMessageWithHeader(activation);
    header.textContent = "Find Path";
    body.classList.add("graphene-tool-status", "graphene-find-path");
    const submitAction = () => {
      findPathState.triggerPathUpdate.dispatch();
    };
    body.appendChild(
      makeIcon({
        text: "Submit",
        title: "Submit Find Path",
        onClick: () => {
          submitAction();
        },
      }),
    );
    body.appendChild(
      makeIcon({
        text: "Clear",
        title: "Clear Find Path",
        onClick: () => {
          findPathState.source.reset();
          findPathState.target.reset();
          findPathState.centroids.reset();
        },
      }),
    );
    const checkbox = activation.registerDisposer(
      new TrackableBooleanCheckbox(precisionMode),
    );
    const label = document.createElement("label");
    const labelText = document.createElement("span");
    labelText.textContent = "Precision mode: ";
    label.appendChild(labelText);
    label.title =
      "Precision mode returns a more accurate path, but takes longer.";
    label.appendChild(checkbox.element);
    body.appendChild(label);
    const annotationElements = document.createElement("div");
    annotationElements.classList.add("find-path-annotations");
    body.appendChild(annotationElements);
    const bindings = getDefaultAnnotationListBindings();
    this.registerDisposer(new MouseEventBinder(annotationElements, bindings));
    const updateAnnotationElements = () => {
      removeChildren(annotationElements);
      const maxColumnWidths = [0, 0, 0];
      const globalDimensionIndices = [0, 1, 2];
      const localDimensionIndices: number[] = [];
      const template =
        "[symbol] 2ch [dim] var(--neuroglancer-column-0-width) [dim] var(--neuroglancer-column-1-width) [dim] var(--neuroglancer-column-2-width) [delete] min-content";
      const endpoints = [source, target];
      const endpointAnnotations = endpoints
        .map((x) => x.value?.annotationReference?.value)
        .filter((x) => x) as Annotation[];
      for (const annotation of endpointAnnotations) {
        const [element, elementColumnWidths] = makeAnnotationListElement(
          this.layer,
          annotation,
          findPathAnnotationState,
          template,
          globalDimensionIndices,
          localDimensionIndices,
        );
        for (const [column, width] of elementColumnWidths.entries()) {
          maxColumnWidths[column] = width;
        }
        annotationElements.appendChild(element);
      }
      for (const [column, width] of maxColumnWidths.entries()) {
        annotationElements.style.setProperty(
          `--neuroglancer-column-${column}-width`,
          `${width + 2}ch`,
        );
      }
    };
    findPathState.changed.add(updateAnnotationElements);
    updateAnnotationElements();
    activation.bindInputEventMap(FIND_PATH_INPUT_EVENT_MAP);
    activation.bindAction("submit", (event) => {
      event.stopPropagation();
      submitAction();
    });
    activation.bindAction("add-point", (event) => {
      event.stopPropagation();
      (async () => {
        if (!source.value) {
          // first selection
          const selection = maybeGetSelection(
            this,
            segmentationGroupState.visibleSegments,
          );
          if (selection) {
            source.value = selection;
          }
        } else if (!target.value) {
          const selection = maybeGetSelection(
            this,
            segmentationGroupState.visibleSegments,
          );
          if (selection) {
            target.value = selection;
          }
        }
      })();
    });
  }

  toJSON() {
    return CALCADA_FIND_PATH_TOOL_ID;
  }

  get description() {
    return "find path";
  }
}

const PIECE_SPLIT_INPUT_EVENT_MAP = EventActionMap.fromObject({
  "at:shift?+control+mousedown0": { action: "place-point" },
  "at:shift?+keyg": { action: "swap-group" },
  "at:shift?+enter": { action: "preview" },
});

// An image layer the user can pick as the weighting source for the cut.
interface ImageLayerChoice {
  name: string;
  // The neuroglancer-style URL as it appears in the layer spec
  // (e.g. "precomputed://gs://bucket/path" or "zarr://gs://..."). Kept
  // for display.
  rawUrl: string;
  // The cloud URL with the neuroglancer datasource prefix stripped, ready to
  // hand to the backend (e.g. "gs://bucket/path").
  cloudUrl: string;
}

const IMAGE_URL_PREFIX =
  /^(?:[a-z0-9]+\+)?(?:precomputed|zarr|n5|nifti|render|deepzoom|brainmaps|boss|vtk|nggraph|python|obj):\/\//i;

function cloudUrlFromLayerSpec(rawUrl: string): string {
  if (!rawUrl) return "";
  // Newer neuroglancer URL shape uses pipe-separated form:
  //   "<kvstore-url>|<driver-name>:"
  // e.g. "gs://bucket/path/|neuroglancer-precomputed:" — strip the pipe suffix
  // so what remains is the raw kvstore URL the backend can hand to tensorstore.
  let cleaned = rawUrl;
  const pipeIdx = cleaned.indexOf("|");
  if (pipeIdx > 0) {
    cleaned = cleaned.slice(0, pipeIdx);
  }
  cleaned = cleaned.replace(IMAGE_URL_PREFIX, "");
  cleaned = cleaned.replace(/^middleauth\+/i, "");
  // Drop a trailing slash so e.g. "gs://bucket/path/" matches "gs://bucket/path"
  // that the backend's graph_metadata.piece_source typically uses.
  return cleaned.replace(/\/+$/, "");
}

// wrapCalcadaError turns an HttpError from a Calcada endpoint into a regular
// Error whose message is the server's `error` field (or `message`, or the raw
// body). Calcada's error envelope is `{"code":"X","error":"...","message":""}`,
// which `parseGrapheneError` mis-handles because it only reads `.message`.
async function wrapCalcadaError(e: unknown): Promise<Error> {
  if (!(e instanceof HttpError)) {
    return e instanceof Error ? e : new Error(String(e));
  }
  const resp = e.response;
  if (!resp) return e;
  try {
    if ((resp.headers.get("content-type") || "").includes("application/json")) {
      const j = await resp.json();
      const msg = j?.error || j?.message || JSON.stringify(j);
      return new Error(msg);
    }
    const text = await resp.text();
    return new Error(text || `HTTP ${resp.status}`);
  } catch {
    return new Error(`HTTP ${resp.status}`);
  }
}

function listImageLayers(layer: SegmentationUserLayer): ImageLayerChoice[] {
  const out: ImageLayerChoice[] = [];
  const layers = layer.manager?.rootLayers?.managedLayers ?? [];
  for (const managed of layers) {
    const userLayer = managed.layer;
    if (!(userLayer instanceof ImageUserLayer)) continue;
    const sources = userLayer.dataSources;
    if (!sources || sources.length === 0) continue;
    const rawUrl = sources[0].spec.url ?? "";
    if (!rawUrl) continue;
    out.push({
      name: managed.name,
      rawUrl,
      cloudUrl: cloudUrlFromLayerSpec(rawUrl),
    });
  }
  return out;
}

// Convert a layer-space point (the form returned by getPoint) into integer
// voxel coordinates using the graph's resolution. Both arrays are expected
// to be in the conventional (x, y, z) order. The conversion truncates toward
// zero — matching the integer-division semantics the merge handler documents.
function layerPointToVoxel(
  layerPoint: Float32Array,
  annotationToNanometers: Float64Array,
  graphResolution: [number, number, number],
): VoxelPoint {
  return [
    Math.floor(
      (layerPoint[0] * annotationToNanometers[0]) / graphResolution[0],
    ),
    Math.floor(
      (layerPoint[1] * annotationToNanometers[1]) / graphResolution[1],
    ),
    Math.floor(
      (layerPoint[2] * annotationToNanometers[2]) / graphResolution[2],
    ),
  ];
}

class PieceSplitTool extends LayerTool<SegmentationUserLayer> {
  toJSON() {
    return CALCADA_PIECE_SPLIT_TOOL_ID;
  }

  get description() {
    return "piece split";
  }

  activate(activation: ToolActivation<this>) {
    const { layer } = this;
    const {
      graphConnection: { value: graphConnection },
    } = layer;
    if (!graphConnection || !(graphConnection instanceof GraphConnection)) {
      return;
    }
    const segmentationGroupState =
      layer.displayState.segmentationGroupState.value;
    if (checkSegmentationOld(segmentationGroupState.timestamp, activation)) {
      return;
    }
    const {
      state: { pieceSplitState },
    } = graphConnection;

    const { body, header } =
      makeToolActivationStatusMessageWithHeader(activation);
    header.textContent = "Piece split";
    body.classList.add("graphene-tool-status", "graphene-piece-split");

    // Dim the segmentation overlay (same mechanism as MulticutSegmentsTool) so
    // the bright point annotations stand out. The focus piece's root keeps
    // its outline visible via TRANSPARENT_COLOR_PACKED; every other segment
    // gets MULTICUT_OFF_COLOR. Save and restore the prior display state on
    // tool deactivation so the segmentation returns to its normal rendering.
    const { displayState } = layer;
    const priorHideSegmentZero = displayState.hideSegmentZero.value;

    const resetPieceSplitDisplay = () => {
      resetTemporaryVisibleSegmentsState(segmentationGroupState);
      displayState.useTempSegmentStatedColors2d.value = false;
      displayState.tempSegmentStatedColors2d.value.clear();
      displayState.tempSegmentDefaultColor2d.value = undefined;
    };
    const updatePieceSplitDisplay = () => {
      resetPieceSplitDisplay();
      // Render the segmentation overlay as transparent for the focus piece's
      // root (so the image and our preview-mask shine through) and dim every
      // other segment with MULTICUT_OFF_COLOR. We intentionally do NOT enable
      // baseSegmentHighlighting — that follows the cursor's hovered piece,
      // not the focus piece, and ends up tinting whatever segment the cursor
      // happens to cross.
      displayState.hideSegmentZero.value = false;
      displayState.tempSegmentDefaultColor2d.value = MULTICUT_OFF_COLOR;
      const focus = pieceSplitState.focusPieceId.value;
      if (focus !== undefined) {
        const focusRoot = segmentationGroupState.segmentEquivalences.get(focus);
        displayState.tempSegmentStatedColors2d.value.set(
          focusRoot,
          TRANSPARENT_COLOR_PACKED,
        );
      }
      displayState.useTempSegmentStatedColors2d.value = true;
    };
    activation.registerDisposer(() => {
      resetPieceSplitDisplay();
      displayState.hideSegmentZero.value = priorHideSegmentZero;
    });
    activation.registerDisposer(
      pieceSplitState.changed.add(updatePieceSplitDisplay),
    );
    updatePieceSplitDisplay();

    // --- Layout ---
    const focusRow = document.createElement("div");
    focusRow.className = "piece-split-focus";
    body.appendChild(focusRow);

    const imageRow = document.createElement("div");
    imageRow.className = "piece-split-image-row";
    const imageLabel = document.createElement("label");
    imageLabel.textContent = "Image layer: ";
    const imageSelect = document.createElement("select");
    imageSelect.title =
      "Image layer used to weight the cut (edges across dark pixels are cheap to cut)";
    const imageHint = document.createElement("div");
    imageHint.className = "piece-split-image-hint";
    imageRow.appendChild(imageLabel);
    imageRow.appendChild(imageSelect);
    body.appendChild(imageRow);
    body.appendChild(imageHint);

    const refreshImageOptions = () => {
      const choices = listImageLayers(layer);
      const current = pieceSplitState.imageSource.value;
      removeChildren(imageSelect);
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent =
        choices.length === 0
          ? "— no image layers in viewer —"
          : "— pick image layer —";
      imageSelect.appendChild(placeholder);
      let matched = "";
      for (const c of choices) {
        const opt = document.createElement("option");
        opt.value = c.cloudUrl;
        opt.textContent = `${c.name}  (${c.cloudUrl})`;
        if (c.cloudUrl === current) {
          opt.selected = true;
          matched = c.cloudUrl;
        }
        imageSelect.appendChild(opt);
      }
      // If the stored imageSource was set previously but doesn't match any
      // current layer (e.g. layer removed from viewer), show its value with a
      // hint so the user knows what's being used.
      imageHint.textContent =
        current && !matched ? `Using saved URL: ${current}` : "";
    };
    imageSelect.addEventListener("change", () => {
      pieceSplitState.imageSource.value = imageSelect.value;
      refreshImageOptions();
    });
    // Prevent the tool's input-event bindings from swallowing the native
    // dropdown's mousedown — without this the picker may refuse to open.
    for (const evt of ["mousedown", "click", "keydown"] as const) {
      imageSelect.addEventListener(evt, (e) => e.stopPropagation());
    }
    refreshImageOptions();
    // Refresh dropdown whenever layers are added/removed in the viewer.
    const layerManager = layer.manager?.rootLayers;
    if (layerManager) {
      activation.registerDisposer(
        layerManager.layersChanged.add(refreshImageOptions),
      );
    }

    const groupRow = document.createElement("div");
    groupRow.className = "piece-split-group-row";
    body.appendChild(groupRow);

    const pointsContainer = document.createElement("div");
    pointsContainer.className = "piece-split-points";
    body.appendChild(pointsContainer);

    const previewSummary = document.createElement("div");
    previewSummary.className = "piece-split-preview-summary";
    body.appendChild(previewSummary);

    const actions = document.createElement("div");
    actions.className = "piece-split-actions";
    body.appendChild(actions);

    // ----- Preview overlay layer management -----
    const PREVIEW_LAYER_NAME = `__piece_split_preview`;
    const PREVIEW_SHADER = `
void main() {
  uint v = getDataValue().value;
  if (v == 0u) {
    emitTransparent();
  } else if (v == 1u) {
    // Bright blue for the source-side voxels.
    emitRGB(vec3(0.1, 0.4, 1.0));
  } else {
    // Bright red for the sink-side voxels.
    emitRGB(vec3(1.0, 0.1, 0.1));
  }
}
`;
    const findPreviewLayer = () => {
      const layers = layer.manager?.rootLayers?.managedLayers ?? [];
      for (const m of layers) {
        if (m.name === PREVIEW_LAYER_NAME) return m;
      }
      return undefined;
    };
    const removePreviewLayer = () => {
      const ml = findPreviewLayer();
      if (ml) {
        layer.manager?.rootLayers?.removeManagedLayer(ml);
      }
    };
    const addPreviewLayer = (preview: PreviewResult) => {
      removePreviewLayer();
      const manager = layer.manager;
      if (!manager) return;
      // The mask zarr is written as (z, y, x) starting at voxel (0,0,0) in
      // its own local space — but it should overlay the focus piece at the
      // bbox origin in world voxel-space. Without an explicit transform NG
      // renders the zarr at world (0,0,0) using abstract d0/d1/d2 axes,
      // which is invisible to the user (it's "off-screen" relative to where
      // they're zoomed in). Pin it into the image's world coord system
      // (x@16nm, y@16nm, z@45nm) and translate by the bbox min.
      const graphResolution = graphConnection.graph.info.scales[0]
        .resolution as unknown as [number, number, number];
      const [minX, minY, minZ] = preview.bbox;
      const spec = {
        type: "image",
        source: {
          url: `${preview.maskUrl}/|zarr2:`,
          transform: {
            outputDimensions: {
              x: [graphResolution[0] * 1e-9, "m"],
              y: [graphResolution[1] * 1e-9, "m"],
              z: [graphResolution[2] * 1e-9, "m"],
            },
            inputDimensions: {
              d0: [graphResolution[2] * 1e-9, "m"],
              d1: [graphResolution[1] * 1e-9, "m"],
              d2: [graphResolution[0] * 1e-9, "m"],
            },
            matrix: [
              [0, 0, 1, minX],
              [0, 1, 0, minY],
              [1, 0, 0, minZ],
            ],
          },
        },
        shader: PREVIEW_SHADER,
        opacity: 0.85,
      };
      try {
        const ml = makeLayer(manager, PREVIEW_LAYER_NAME, spec);
        manager.add(ml);
      } catch (e) {
        StatusMessage.showTemporaryMessage(
          `Failed to add preview overlay: ${e instanceof Error ? e.message : String(e)}`,
          6000,
        );
      }
    };
    const syncPreviewLayer = () => {
      const preview = pieceSplitState.preview.value;
      if (preview) {
        addPreviewLayer(preview);
      } else {
        removePreviewLayer();
      }
    };
    activation.registerDisposer(
      pieceSplitState.preview.changed.add(syncPreviewLayer),
    );
    activation.registerDisposer(removePreviewLayer);
    syncPreviewLayer();

    const swapButton = makeIcon({
      text: "Swap",
      title: "Toggle blue/red (G)",
      onClick: () => pieceSplitState.swapGroup(),
    });
    const clearButton = makeIcon({
      text: "Clear",
      title: "Remove all points and reset focus piece",
      onClick: () => {
        pieceSplitState.reset();
      },
    });
    const previewButton = makeIcon({
      text: "Preview",
      title: "Compute split mask (shift+enter)",
      onClick: () => void runPreview(),
    });
    const applyButton = makeIcon({
      text: "Apply",
      title: "Commit the previewed split",
      onClick: () => void runApply(),
    });
    actions.appendChild(swapButton);
    actions.appendChild(clearButton);
    actions.appendChild(previewButton);
    actions.appendChild(applyButton);

    const setApplyEnabled = (enabled: boolean) => {
      applyButton.classList.toggle("disabled", !enabled);
    };

    const render = () => {
      // Focus piece label.
      const focus = pieceSplitState.focusPieceId.value;
      focusRow.textContent =
        focus !== undefined
          ? `Focus piece: ${focus.toString()}`
          : "Shift+Ctrl+click on a piece to set focus and place the first point.";

      // Active-colour indicator.
      removeChildren(groupRow);
      const indicator = document.createElement("span");
      indicator.className = pieceSplitState.blueGroup.value
        ? "active-blue"
        : "active-red";
      indicator.textContent = pieceSplitState.blueGroup.value
        ? "Active: BLUE (will place blue point on click)"
        : "Active: RED (will place red point on click)";
      groupRow.appendChild(indicator);

      // Point lists.
      removeChildren(pointsContainer);
      const renderList = (
        label: string,
        cssClass: string,
        points: PointEntry[],
        group: "blue" | "red",
      ) => {
        const section = document.createElement("div");
        section.className = cssClass;
        const title = document.createElement("div");
        title.textContent = `${label} (${points.length})`;
        section.appendChild(title);
        for (let i = 0; i < points.length; i++) {
          const row = document.createElement("div");
          row.className = "piece-split-point-row";
          const text = document.createElement("span");
          const [x, y, z] = points[i].voxel;
          text.textContent = `  (${x}, ${y}, ${z})`;
          row.appendChild(text);
          const del = makeDeleteButton({
            title: "Remove point",
            onClick: () => pieceSplitState.removePoint(group, i),
          });
          row.appendChild(del);
          section.appendChild(row);
        }
        pointsContainer.appendChild(section);
      };
      renderList(
        "Blue points",
        "piece-split-blue",
        pieceSplitState.bluePoints.value,
        "blue",
      );
      renderList(
        "Red points",
        "piece-split-red",
        pieceSplitState.redPoints.value,
        "red",
      );

      // Preview summary.
      const preview = pieceSplitState.preview.value;
      removeChildren(previewSummary);
      if (preview !== undefined) {
        const [minX, minY, minZ, maxX, maxY, maxZ] = preview.bbox;
        const line1 = document.createElement("div");
        line1.textContent = `Preview ready — bbox [${minX},${minY},${minZ}] → [${maxX},${maxY},${maxZ}]`;
        previewSummary.appendChild(line1);
        const line2 = document.createElement("div");
        line2.textContent =
          `Voxels: ${preview.maskVoxels} in piece` +
          ` (source=${preview.sourceVoxels}, sink=${preview.sinkVoxels})`;
        previewSummary.appendChild(line2);
        const line3 = document.createElement("div");
        line3.textContent = `Mask: ${preview.maskUrl}`;
        line3.style.fontSize = "0.85em";
        line3.style.opacity = "0.75";
        previewSummary.appendChild(line3);
        setApplyEnabled(true);
      } else {
        setApplyEnabled(false);
      }
    };
    render();
    activation.registerDisposer(pieceSplitState.changed.add(render));

    // --- Actions ---
    const runPreview = async () => {
      const focus = pieceSplitState.focusPieceId.value;
      if (focus === undefined) {
        StatusMessage.showTemporaryMessage(
          "Select exactly one piece to split first",
          5000,
        );
        return;
      }
      if (pieceSplitState.bluePoints.value.length === 0) {
        StatusMessage.showTemporaryMessage(
          "Place at least one blue point",
          5000,
        );
        return;
      }
      if (pieceSplitState.redPoints.value.length === 0) {
        StatusMessage.showTemporaryMessage(
          "Place at least one red point",
          5000,
        );
        return;
      }
      if (!pieceSplitState.imageSource.value) {
        StatusMessage.showTemporaryMessage(
          "Set an image source URL in the side panel first",
          5000,
        );
        return;
      }
      previewButton.classList.toggle("disabled", true);
      try {
        const result =
          await graphConnection.graph.graphServer.previewPieceSplit(
            focus,
            pieceSplitState.bluePoints.value.map((p) => p.voxel),
            pieceSplitState.redPoints.value.map((p) => p.voxel),
            pieceSplitState.imageSource.value,
            graphConnection.graph.branchId.value,
          );
        pieceSplitState.preview.value = result;
        StatusMessage.showTemporaryMessage("Preview computed", 2500);
      } catch (e: unknown) {
        StatusMessage.showTemporaryMessage(
          `Preview failed: ${e instanceof Error ? e.message : String(e)}`,
          8000,
        );
      } finally {
        previewButton.classList.toggle("disabled", false);
      }
    };

    const runApply = async () => {
      const focus = pieceSplitState.focusPieceId.value;
      const preview = pieceSplitState.preview.value;
      if (focus === undefined || preview === undefined) {
        StatusMessage.showTemporaryMessage("Run Preview before applying", 5000);
        return;
      }
      if (
        layer.displayState.segmentationGroupState.value.timestamp.value !==
        undefined
      ) {
        StatusMessage.showTemporaryMessage(
          "Apply disabled: segmentation is time-travelling (read-only).",
          5000,
        );
        return;
      }
      applyButton.classList.toggle("disabled", true);
      // segmentEquivalences returns the input id (not undefined) when there's no entry — resolve via backend.
      let preApplyOldRoot: bigint | undefined;
      try {
        const candidate = await graphConnection.graph.graphServer.getRoot(
          focus,
          0,
          graphConnection.graph.branchId.value,
        );
        if (candidate !== 0n && candidate !== focus) {
          preApplyOldRoot = candidate;
        }
      } catch (e) {
        StatusMessage.showTemporaryMessage(
          `Could not resolve old root before split (${e instanceof Error ? e.message : String(e)}); old segment may stay in the selection panel.`,
          6000,
        );
        const fallback =
          layer.displayState.segmentationGroupState.value.segmentEquivalences.get(
            focus,
          );
        if (fallback !== undefined && fallback !== focus && fallback !== 0n) {
          preApplyOldRoot = fallback;
        }
      }
      try {
        const newRoots =
          await graphConnection.graph.graphServer.applyPieceSplit(
            focus,
            preview.maskUrl,
            graphConnection.graph.branchId.value,
          );
        const segmentsState = layer.displayState.segmentationGroupState.value;
        // Deselect root 0 or a stray background click paints every orphan piece as one blob.
        const toRemove: bigint[] = [focus, 0n];
        if (preApplyOldRoot !== undefined) {
          toRemove.push(preApplyOldRoot);
        }
        for (const id of toRemove) {
          segmentsState.selectedSegments.delete(id);
          segmentsState.visibleSegments.delete(id);
        }
        for (const newRoot of newRoots) {
          if (newRoot === 0n) continue;
          segmentsState.selectedSegments.add(newRoot);
          segmentsState.visibleSegments.add(newRoot);
        }
        graphConnection.refreshChunkSources();
        StatusMessage.showTemporaryMessage(
          `Piece split applied — ${newRoots.length} new root(s)`,
          5000,
        );
        pieceSplitState.reset();
        activation.cancel();
      } catch (e: unknown) {
        StatusMessage.showTemporaryMessage(
          `Apply failed: ${e instanceof Error ? e.message : String(e)}`,
          8000,
        );
        applyButton.classList.toggle("disabled", false);
      }
    };

    // --- Click placement ---
    activation.bindInputEventMap(PIECE_SPLIT_INPUT_EVENT_MAP);
    activation.bindAction("place-point", (event) => {
      event.stopPropagation();
      const { mouseState } = this;
      const point = getPoint(layer, mouseState);
      if (point === undefined) return;
      // baseValue is the piece (super-voxel) at the clicked voxel; value is its
      // aggregated root. We split pieces, so always work with baseValue.
      const baseValue = layer.displayState.segmentSelectionState.baseValue;
      if (baseValue === undefined || baseValue === null || baseValue === 0n) {
        StatusMessage.showTemporaryMessage(
          "No piece is selected at the click position",
          3000,
        );
        return;
      }
      const currentFocus = pieceSplitState.focusPieceId.value;
      if (currentFocus === undefined) {
        // First click sets the focus piece.
        pieceSplitState.focusPieceId.value = baseValue;
      } else if (baseValue !== currentFocus) {
        StatusMessage.showTemporaryMessage(
          `Point must be inside piece ${currentFocus.toString()} (clicked: ${baseValue.toString()}). Press Clear to reset focus.`,
          6000,
        );
        return;
      }
      const loadedSubsource = getGraphLoadedSubsource(layer)!;
      const annotationToNanometers =
        loadedSubsource.loadedDataSource.transform.inputSpace.value.scales.map(
          (x: number) => x / 1e-9,
        );
      const graphResolution = graphConnection.graph.info.scales[0]
        .resolution as unknown as [number, number, number];
      const voxel = layerPointToVoxel(
        point,
        new Float64Array(annotationToNanometers),
        graphResolution,
      );
      pieceSplitState.addPoint({
        voxel,
        layer: [point[0], point[1], point[2]],
      });
    });
    activation.bindAction("swap-group", (event) => {
      event.stopPropagation();
      pieceSplitState.swapGroup();
    });
    activation.bindAction("preview", (event) => {
      event.stopPropagation();
      void runPreview();
    });
  }
}

registerTool(SegmentationUserLayer, CALCADA_PIECE_SPLIT_TOOL_ID, (layer) => {
  return new PieceSplitTool(layer, true);
});

registerTool(
  SegmentationUserLayer,
  CALCADA_MULTICUT_SEGMENTS_TOOL_ID,
  (layer) => {
    return new MulticutSegmentsTool(layer, true);
  },
);

registerTool(SegmentationUserLayer, CALCADA_MERGE_SEGMENTS_TOOL_ID, (layer) => {
  return new MergeSegmentsTool(layer, true);
});

registerTool(SegmentationUserLayer, CALCADA_FIND_PATH_TOOL_ID, (layer) => {
  return new FindPathTool(layer, true);
});

const ANNOTATE_MERGE_LINE_TOOL_ID = "annotateMergeLine";

registerLegacyTool(
  ANNOTATE_MERGE_LINE_TOOL_ID,
  (layer, options) =>
    new MergeSegmentsPlaceLineTool(<SegmentationUserLayer>layer, options),
);

// Bulk link handler — receives all piece→root pairs from the worker in one
// transferable buffer. ONE postMessage instead of 52K individual link() RPCs.
// changed.dispatch is coalesced across all chunks that arrive in the same
// animation frame: re-uploading the equivalences hash map to the GPU is the
// expensive part (10-50ms per dispatch), so firing it once a frame instead of
// once per chunk turns 10 paralellel chunk arrivals from ~500ms of
// main-thread jank into ~50ms.
const pendingDispatch = new Set<SharedDisjointUint64Sets>();
let dispatchScheduled = false;

registerRPC(CALCADA_BULK_LINK_RPC_ID, function (x) {
  const obj = this.get(x.id) as SharedDisjointUint64Sets;
  const buf = new BigUint64Array(x.pairs);
  let linked = 0;
  for (let i = 0; i < buf.length; i += 2) {
    if (obj.disjointSets.link(buf[i], buf[i + 1])) {
      linked++;
    }
  }
  if (linked === 0) return;
  pendingDispatch.add(obj);
  if (dispatchScheduled) return;
  dispatchScheduled = true;
  requestAnimationFrame(() => {
    dispatchScheduled = false;
    const targets = Array.from(pendingDispatch);
    pendingDispatch.clear();
    for (const target of targets) {
      target.changed.dispatch();
    }
  });
});
