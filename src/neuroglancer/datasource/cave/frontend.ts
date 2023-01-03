import { AnnotationGeometryChunkSpecification } from "src/neuroglancer/annotation/base";
import { AnnotationGeometryChunkSource, MultiscaleAnnotationSource } from "src/neuroglancer/annotation/frontend_source";
import { ChunkManager, WithParameters } from "src/neuroglancer/chunk_manager/frontend";
import { CoordinateSpace, coordinateSpaceFromJson, makeCoordinateSpace, makeIdentityTransform, makeIdentityTransformedBoundingBox } from "src/neuroglancer/coordinate_transform";
import { WithCredentialsProvider } from "src/neuroglancer/credentials_provider/chunk_source_frontend";
import { SliceViewSingleResolutionSource } from "src/neuroglancer/sliceview/frontend";
import { completeHttpPath } from "src/neuroglancer/util/http_path_completion";
import { responseJson } from "src/neuroglancer/util/http_request";
import { parseArray, parseFixedLengthArray, unparseQueryStringParameters, verifyEnumString, verifyFiniteFloat, verifyFinitePositiveFloat, verifyObject, verifyObjectProperty, verifyOptionalObjectProperty, verifyPositiveInt, verifyString } from "src/neuroglancer/util/json";
import { getObjectId } from "src/neuroglancer/util/object_id";
import { cancellableFetchSpecialOk, parseSpecialUrl, SpecialProtocolCredentials, SpecialProtocolCredentialsProvider } from "src/neuroglancer/util/special_protocol_request";
import { CompleteUrlOptions, ConvertLegacyUrlOptions, DataSource, DataSourceProvider, GetDataSourceOptions, NormalizeUrlOptions, RedirectError } from "..";
import { parseKeyAndShardingSpec, parseProviderUrl } from "../precomputed/frontend";
import { AnnotationSourceParameters, AnnotationSpatialIndexSourceParameters } from "./base";
import * as matrix from 'neuroglancer/util/matrix';
import { makeSliceViewChunkSpecification } from "src/neuroglancer/sliceview/base";
import { AnnotationType, parseAnnotationPropertySpecs } from "src/neuroglancer/annotation";

interface AnnotationSpatialIndexLevelMetadata {
  parameters: AnnotationSpatialIndexSourceParameters;
  limit: number;
  spec: AnnotationGeometryChunkSpecification;
}

class AnnotationMetadata {
  coordinateSpace: CoordinateSpace;
  parameters: AnnotationSourceParameters;
  spatialIndices: AnnotationSpatialIndexLevelMetadata[];
  constructor(public url: string, metadata: any) {
    verifyObject(metadata);
    const baseCoordinateSpace =
        verifyObjectProperty(metadata, 'dimensions', coordinateSpaceFromJson);
    const {rank} = baseCoordinateSpace;
    const lowerBounds = verifyObjectProperty(
        metadata, 'lower_bound',
        boundJson => parseFixedLengthArray(new Float64Array(rank), boundJson, verifyFiniteFloat));
    const size = verifyObjectProperty(
        metadata, 'size',
        boundJson => parseFixedLengthArray(new Float64Array(rank), boundJson, verifyFiniteFloat));
    const upperBounds: Float64Array = new Float64Array(rank);
    for (let i = 0; i < rank; i++) {
      upperBounds[i] = lowerBounds[i] + size[i];
    }
    this.coordinateSpace = makeCoordinateSpace({
      rank,
      names: baseCoordinateSpace.names,
      units: baseCoordinateSpace.units,
      scales: baseCoordinateSpace.scales,
      boundingBoxes: [makeIdentityTransformedBoundingBox({lowerBounds, upperBounds})],
    });
    this.parameters = {
      type: verifyObjectProperty(
          metadata, 'annotation_type', typeObj => verifyEnumString(typeObj, AnnotationType)),
      rank,
      relationships: verifyObjectProperty(
          metadata, 'relationships',
          relsObj => parseArray(
              relsObj,
              relObj => {
                const common = parseKeyAndShardingSpec(url, relObj);
                const name = verifyObjectProperty(relObj, 'id', verifyString);
                return {...common, name};
              })),
      properties: verifyObjectProperty(metadata, 'properties', parseAnnotationPropertySpecs),
      // byId: verifyObjectProperty(metadata, 'by_id', obj => parseKeyAndShardingSpec(url, obj)),
    };
    this.spatialIndices = verifyObjectProperty(
        metadata, 'spatial',
        spatialObj => parseArray(spatialObj, levelObj => {
          const common: AnnotationSpatialIndexSourceParameters =
              parseKeyAndShardingSpec(url, levelObj);
          const gridShape = verifyObjectProperty(
              levelObj, 'grid_shape',
              j => parseFixedLengthArray(new Float32Array(rank), j, verifyPositiveInt));
          const chunkShape = verifyObjectProperty(
              levelObj, 'chunk_size',
              j => parseFixedLengthArray(new Float32Array(rank), j, verifyFinitePositiveFloat));
          const limit = verifyObjectProperty(levelObj, 'limit', verifyPositiveInt);
          const gridShapeInVoxels = new Float32Array(rank);
          for (let i = 0; i < rank; ++i) {
            gridShapeInVoxels[i] = gridShape[i] * chunkShape[i];
          }
          const chunkToMultiscaleTransform = matrix.createIdentity(Float32Array, rank + 1);
          for (let i = 0; i < rank; ++i) {
            chunkToMultiscaleTransform[(rank + 1) * rank + i] = lowerBounds[i];
          }
          const spec: AnnotationGeometryChunkSpecification = {
            limit,
            chunkToMultiscaleTransform,
            ...makeSliceViewChunkSpecification({
              rank,
              chunkDataSize: chunkShape,
              upperVoxelBound: gridShapeInVoxels,
            })
          };
          spec.upperChunkBound = gridShape;
          return {
            parameters: common,
            spec,
            limit,
          };
        }));
    this.spatialIndices.reverse();
  }
}


const MultiscaleAnnotationSourceBase = (WithParameters(
    WithCredentialsProvider<SpecialProtocolCredentials>()(MultiscaleAnnotationSource),
    AnnotationSourceParameters));

interface PrecomputedAnnotationSourceOptions {
  metadata: AnnotationMetadata;
  parameters: AnnotationSourceParameters;
  credentialsProvider: SpecialProtocolCredentialsProvider;
}

class CaveAnnotationSpatialIndexSource extends
(WithParameters(WithCredentialsProvider<SpecialProtocolCredentials>()(AnnotationGeometryChunkSource), AnnotationSpatialIndexSourceParameters)) {}


export class CaveAnnotationSource extends MultiscaleAnnotationSourceBase {
  key: any;
  metadata: AnnotationMetadata;
  credentialsProvider: SpecialProtocolCredentialsProvider;
  OPTIONS: PrecomputedAnnotationSourceOptions;
  constructor(chunkManager: ChunkManager, options: PrecomputedAnnotationSourceOptions) {
    const {parameters} = options;
    super(chunkManager, {
      rank: parameters.rank,
      relationships: parameters.relationships.map(x => x.name),
      properties: parameters.properties,
      parameters,
    } as any);
    this.readonly = true;
    this.metadata = options.metadata;
    this.credentialsProvider = options.credentialsProvider;
  }

  getSources(): SliceViewSingleResolutionSource<AnnotationGeometryChunkSource>[][] {
    return [];
  }
}

async function getAnnotationDataSource(
    options: GetDataSourceOptions, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string, metadata: any): Promise<DataSource> {
  const info = new AnnotationMetadata(url, metadata);
  const dataSource: DataSource = {
    modelTransform: makeIdentityTransform(info.coordinateSpace),
    subsources: [
      {
        id: 'default',
        default: true,
        subsource: { // here
          annotation: options.chunkManager.getChunkSource(CaveAnnotationSource, {
            credentialsProvider,
            metadata: info,
            parameters: info.parameters,
          }),
        }
      },
    ],
  };
  return dataSource;
}

function unparseProviderUrl(url: string, parameters: any) {
  const fragment = unparseQueryStringParameters(parameters);
  if (fragment) {
    url += `#${fragment}`;
  }
  return url;
}

function getJsonMetadata(
    chunkManager: ChunkManager, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string): Promise<any> {
  return chunkManager.memoize.getUncounted(
      {'type': 'cave:metadata', url, credentialsProvider: getObjectId(credentialsProvider)},
      async () => {
        return await cancellableFetchSpecialOk(
            credentialsProvider, `${url}`, {}, responseJson); // /info
      });
}

export class CaveDataSource extends DataSourceProvider {
  get description() {
    return 'cave';
  }

  normalizeUrl(options: NormalizeUrlOptions): string {
    const {url, parameters} = parseProviderUrl(options.providerUrl);
    return options.providerProtocol + '://' + unparseProviderUrl(url, parameters);
  }

  convertLegacyUrl(options: ConvertLegacyUrlOptions): string {
    const {url, parameters} = parseProviderUrl(options.providerUrl);
    if (options.type === 'mesh') {
      parameters['type'] = 'mesh';
    }
    return options.providerProtocol + '://' + unparseProviderUrl(url, parameters);
  }

  get(options: GetDataSourceOptions): Promise<DataSource> {
    const {url: providerUrl, parameters} = parseProviderUrl(options.providerUrl);
    return options.chunkManager.memoize.getUncounted(
        {'type': 'cave:get', providerUrl, parameters}, async(): Promise<DataSource> => {
          const {url, credentialsProvider} =
              parseSpecialUrl(providerUrl, options.credentialsManager);
          let metadata: any;
          try {
            getJsonMetadata;
            metadata = {
  "@type" : "cave_annotations_v1",
  "annotation_type" : "POINT",
  "dimensions" : {
      "x" : [ 4e-09, "m" ],
      "y" : [ 4e-09, "m" ],
      "z" : [ 40e-09, "m" ]
   },
  "lower_bound" : [ 26285, 30208, 14826 ], // [26285, 30208, 14826]
  "size" : [ 192768, 131328, 13056 ], // 192768, 131328, 13056
  "spatial" : [],
  "properties" : [],
  "relationships": [{
         "id" : "pre_pt_root_id",
         "key" : "pre_pt_root_id"
      },
      {
         "id" : "post_pt_root_id",
         "key" : "post_pt_root_id"
      }]
};

            // metadata = await getJsonMetadata(options.chunkManager, credentialsProvider, url);
          } catch (e) {
            throw e;
          }
          verifyObject(metadata);
          const redirect = verifyOptionalObjectProperty(metadata, 'redirect', verifyString);
          if (redirect !== undefined) {
            throw new RedirectError(redirect);
          }
          const t = verifyOptionalObjectProperty(metadata, '@type', verifyString);
          switch (t) {
            case 'cave_annotations_v1': // this is the format
              return await getAnnotationDataSource(options, credentialsProvider, url, metadata);
            default:
              throw new Error(`Invalid type: ${JSON.stringify(t)}`);
          }
        });
  }
  completeUrl(options: CompleteUrlOptions) {
    return completeHttpPath(
        options.credentialsManager, options.providerUrl, options.cancellationToken);
  }
}