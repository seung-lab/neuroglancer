import { MultiscaleAnnotationSource } from "src/neuroglancer/annotation/frontend_source";
import { ChunkManager, WithParameters } from "src/neuroglancer/chunk_manager/frontend";
import { CoordinateSpace, coordinateSpaceFromJson, makeCoordinateSpace, makeIdentityTransform, makeIdentityTransformedBoundingBox } from "src/neuroglancer/coordinate_transform";
import { WithCredentialsProvider } from "src/neuroglancer/credentials_provider/chunk_source_frontend";
import { completeHttpPath } from "src/neuroglancer/util/http_path_completion";
import { responseJson } from "src/neuroglancer/util/http_request";
import { parseArray, parseFixedLengthArray, unparseQueryStringParameters, verifyEnumString, verifyFiniteFloat, verifyObject, verifyObjectProperty, verifyOptionalObjectProperty, verifyString } from "src/neuroglancer/util/json";
import { getObjectId } from "src/neuroglancer/util/object_id";
import { cancellableFetchSpecialOk, parseSpecialUrl, SpecialProtocolCredentials, SpecialProtocolCredentialsProvider } from "src/neuroglancer/util/special_protocol_request";
import { CompleteUrlOptions, ConvertLegacyUrlOptions, DataSource, DataSourceProvider, GetDataSourceOptions, NormalizeUrlOptions, RedirectError } from "..";
import { parseProviderUrl } from "../precomputed/frontend";
import { AnnotationSourceParameters } from "./base";
import { AnnotationType, parseAnnotationPropertySpecs } from "src/neuroglancer/annotation";


class AnnotationMetadata {
  coordinateSpace: CoordinateSpace;
  parameters: AnnotationSourceParameters;
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
      url,
      timestamp: '',
      type: verifyObjectProperty(
          metadata, 'annotation_type', typeObj => verifyEnumString(typeObj, AnnotationType)),
      rank,
      relationships: verifyObjectProperty(
          metadata, 'relationships',
          relsObj => parseArray(
              relsObj,
              relObj => {
                // const common = parseKeyAndShardingSpec(url, relObj);
                const name = verifyObjectProperty(relObj, 'id', verifyString);
                return name;
              })),
      properties: verifyObjectProperty(metadata, 'properties', parseAnnotationPropertySpecs),
    };
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

export class CaveAnnotationSource extends MultiscaleAnnotationSourceBase {
  key: any;
  metadata: AnnotationMetadata;
  credentialsProvider: SpecialProtocolCredentialsProvider;
  OPTIONS: PrecomputedAnnotationSourceOptions;
  constructor(chunkManager: ChunkManager, options: PrecomputedAnnotationSourceOptions) {
    const {parameters} = options;
    super(chunkManager, {
      rank: parameters.rank,
      relationships: parameters.relationships,
      properties: parameters.properties,
      parameters,
    } as any);
    this.readonly = true;
    this.metadata = options.metadata;
    this.credentialsProvider = options.credentialsProvider;
  }

  // no spatial sources
  getSources(_unused: any) {
    return [];
  }
}

async function getLatestTimestamp(credentialsProvider: SpecialProtocolCredentialsProvider, url: string, metadata: any) {
  console.log('metadata', metadata);
  const versonsURL = `${url}/versions`;
  const versions = await cancellableFetchSpecialOk(credentialsProvider, versonsURL, {}, responseJson);
  const latestVersion = Math.max(...versions);
  const versionMetadataURL = `${url}/version/${latestVersion}`;
  const versionMetadata = await cancellableFetchSpecialOk(credentialsProvider, versionMetadataURL, {}, responseJson);
  return versionMetadata.time_stamp;
}


async function getAnnotationDataSource(
    options: GetDataSourceOptions, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string, metadata: any): Promise<DataSource> {
  const info = new AnnotationMetadata(url, metadata);
  const timestamp = await getLatestTimestamp(credentialsProvider, url, metadata);
  const dataSource: DataSource = {
    modelTransform: makeIdentityTransform(info.coordinateSpace),
    subsources: [
      {
        id: 'default',
        default: true,
        subsource: {
          annotation: options.chunkManager.getChunkSource(CaveAnnotationSource, {
            credentialsProvider,
            metadata: info,
            parameters: {...info.parameters, timestamp},
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
  "annotation_type" : "POINT", // NOT USED
  "dimensions" : {
      "x" : [ 4e-09, "m" ],
      "y" : [ 4e-09, "m" ],
      "z" : [ 40e-09, "m" ]
   },
  "lower_bound" : [ 26285, 30208, 14826 ], // maybe these are only used for the spatial index?
  "size" : [ 192768, 131328, 13056 ],
  "spatial" : [],
  "properties" : [],
  "relationships": [{
         "id" : "pre_pt_root_id",
         "name" : "Pre root id"
      },
      {
         "id" : "post_pt_root_id",
         "name" : "Post root id"
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