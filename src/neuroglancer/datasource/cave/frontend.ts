import { MultiscaleAnnotationSource } from "neuroglancer/annotation/frontend_source";
import { ChunkManager, WithParameters } from "neuroglancer/chunk_manager/frontend";
import { CoordinateSpace, coordinateSpaceFromJson, makeCoordinateSpace, makeIdentityTransform, makeIdentityTransformedBoundingBox } from "neuroglancer/coordinate_transform";
import { WithCredentialsProvider } from "neuroglancer/credentials_provider/chunk_source_frontend";
import { responseJson } from "neuroglancer/util/http_request";
import { parseFixedLengthArray, unparseQueryStringParameters, verifyEnumString, verifyFiniteFloat, verifyFinitePositiveFloat, verifyNonnegativeInt, verifyObject, verifyObjectAsMap, verifyObjectProperty, verifyOptionalObjectProperty, verifyString } from "neuroglancer/util/json";
import { getObjectId } from "neuroglancer/util/object_id";
import { cancellableFetchSpecialOk, parseSpecialUrl, SpecialProtocolCredentials, SpecialProtocolCredentialsProvider } from "neuroglancer/util/special_protocol_request";
import { CompleteUrlOptions, ConvertLegacyUrlOptions, DataSource, DataSourceProvider, GetDataSourceOptions, NormalizeUrlOptions, RedirectError } from "..";
import { parseProviderUrl } from "neuroglancer/datasource/precomputed/frontend";
import { AnnotationSourceParameters, API_STRING, API_STRING_V2 } from "neuroglancer/datasource/cave/base";
import { AnnotationType, parseAnnotationPropertySpecs } from "neuroglancer/annotation";
AnnotationType; // TODO
verifyEnumString; // TODO

class AnnotationMetadata {
  coordinateSpace: CoordinateSpace;
  parameters: AnnotationSourceParameters;
  constructor(public url: string, datastack: string, table: string, metadata: any, tableMetadata: TableMetadata) {
    verifyObject(metadata);
    const {voxel_resolution_x, voxel_resolution_y, voxel_resolution_z} = tableMetadata;
    const baseCoordinateSpace = coordinateSpaceFromJson({
      "x" : [ voxel_resolution_x, "nm" ],
      "y" : [ voxel_resolution_y, "nm" ],
      "z" : [ voxel_resolution_z, "nm" ]
    });
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
      datastack,
      table,
      timestamp: '',
      // type: verifyObjectProperty(
      //     metadata, 'annotation_type', typeObj => verifyEnumString(typeObj, AnnotationType)),
      rank,
      relationships: tableMetadata.properties,
      properties: verifyObjectProperty(metadata, 'properties', parseAnnotationPropertySpecs),
    };
    /*
    verifyObjectProperty(
          metadata, 'relationships',
          relsObj => parseArray(
              relsObj,
              relObj => {
                // const common = parseKeyAndShardingSpec(url, relObj);
                const name = verifyObjectProperty(relObj, 'id', verifyString);
                return name;
              })),
              */
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

async function getLatestVersion(credentialsProvider: SpecialProtocolCredentialsProvider, url: string, datastack: string) {
  const existing = getLatestVersion.cache[`${url}_${datastack}`];
  if (existing) return existing;

  const versonsURL = `${url}/${API_STRING_V2}/datastack/${datastack}/versions`;
  const versions = await cancellableFetchSpecialOk(credentialsProvider, versonsURL, {}, responseJson);
  const latestVersion = Math.max(...versions);

  getLatestVersion.cache[`${url}_${datastack}`] = latestVersion;
  return latestVersion;
}
getLatestVersion.cache = {} as {[key: string]: number};

async function getLatestTimestamp(credentialsProvider: SpecialProtocolCredentialsProvider, url: string, datastack: string, version: number) {
  const existing = getLatestTimestamp.cache[`${url}_${datastack}_${version}`];
  if (existing) return existing;
  
  const versionMetadataURL = `${url}/${API_STRING_V2}/datastack/${datastack}/version/${version}`;
  const versionMetadata = await cancellableFetchSpecialOk(credentialsProvider, versionMetadataURL, {}, responseJson);
  const res = versionMetadata.time_stamp as string;
  
  getLatestTimestamp.cache[`${url}_${datastack}_${version}`] = res;
  return res;
}
getLatestTimestamp.cache = {} as {[key: string]: string};

async function getTables(credentialsProvider: SpecialProtocolCredentialsProvider, url: string, datastack: string, version: number) {
  const existing = getTables.cache[`${url}_${datastack}_${version}`];
  if (existing) return existing;
  
  const tablesURL = `${url}/${API_STRING}/datastack/${datastack}/version/${version}/tables`;
  const tables = await cancellableFetchSpecialOk(credentialsProvider, tablesURL, {}, responseJson) as string[];

  getTables.cache[`${url}_${datastack}_${version}`] = tables;
  return tables;
}
getTables.cache = {} as {[key: string]: string[]};

async function getDatastacks(credentialsProvider: SpecialProtocolCredentialsProvider) {
  const existing = getDatastacks.cache.datastacks;
  if (existing) return existing as string[];
  
  const datastacksURL = `https://global.daf-apis.com/info/api/v2/datastacks`;
  const datastacks = await cancellableFetchSpecialOk(credentialsProvider, datastacksURL, {}, responseJson) as string[];

  getDatastacks.cache.datastacks = datastacks;
  return datastacks;
}
getDatastacks.cache = {datastacks: undefined as any};

interface TableMetadata {
  schemaType: string,
  voxel_resolution_x: number,
  voxel_resolution_y: number,
  voxel_resolution_z: number,
  properties: string[],
}

const BOUND_SPATIAL_POINT = 'BoundSpatialPoint';

async function getTableMetadata(credentialsProvider: SpecialProtocolCredentialsProvider, url: string, datastack: string, version: number, table: string): Promise<TableMetadata> {
  const metadataURL = `${url}/${API_STRING_V2}/datastack/${datastack}/version/${version}/table/${table}/metadata`;
  const metadata = await cancellableFetchSpecialOk(credentialsProvider, metadataURL, {}, responseJson);
  verifyObject(metadata);
  const schemaType = verifyObjectProperty(metadata, 'schema_type', verifyString);
  const voxel_resolution_x = verifyObjectProperty(metadata, 'voxel_resolution_x', verifyFinitePositiveFloat);
  const voxel_resolution_y = verifyObjectProperty(metadata, 'voxel_resolution_y', verifyFinitePositiveFloat);
  const voxel_resolution_z = verifyObjectProperty(metadata, 'voxel_resolution_z', verifyFinitePositiveFloat);
  
  const refToName = (x: string) => {
    const res = x.split('/').at(-1);
    if (!res) {
      throw new Error('bad $ref');
    }
    return res;
  };

  // TODO, break apart url so we can avoid hardcodingg global.daf-apis.com
  // TODO ADD CORS TO /schema
  const schemaURL = `https://global.daf-apis.com/schema/${API_STRING_V2}/type/${schemaType}`;
  // TODO, do we ever want to authenticate this request?
  const schema = await cancellableFetchSpecialOk(undefined, schemaURL, {}, responseJson);

  verifyObject(schema);
  const ref = verifyObjectProperty(schema, '$ref', verifyString);
  const definitionName = refToName(ref);
  const definitions = verifyObjectProperty(schema, 'definitions', verifyObject);
  const definition = verifyObjectProperty(definitions, definitionName, verifyObject);
  const properties = verifyObjectProperty(definition, 'properties', x => {
    const res = [];
    const result = verifyObjectAsMap(x, verifyObject);
    for (const [name, obj] of result) {
      verifyObject(obj);
      const ref = verifyOptionalObjectProperty(obj, '$ref', verifyString);
      if (!ref) continue;
      const refName = refToName(ref);
      const order = verifyOptionalObjectProperty(obj, 'order', verifyNonnegativeInt) || 0;
      if (refName === BOUND_SPATIAL_POINT) { // TODO, maybe we want to support SpatialPoint?
        res[order] = name;
      }
    }
    return res.filter(x => x !== undefined);
  });

  // TODO, maybe use flat_segmentation_source to automatically link up the segmentation?
  // segmentation_source is empty
  return {
    schemaType,
    voxel_resolution_x,
    voxel_resolution_y,
    voxel_resolution_z,
    properties,
  }
}


async function getAnnotationDataSource(
    options: GetDataSourceOptions, credentialsProvider: SpecialProtocolCredentialsProvider,
    url: string, datastack: string, table: string, metadata: any): Promise<DataSource> {
  const latestVersion = await getLatestVersion(credentialsProvider, url, datastack);
  const timestamp = await getLatestTimestamp(credentialsProvider, url, datastack, latestVersion);

  const tableMetadata = await getTableMetadata(credentialsProvider, url, datastack, latestVersion, table);// url: string, datastack: string, table: string)


  const info = new AnnotationMetadata(url, datastack, table, metadata, tableMetadata);

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

          const regex = /https:\/\/.*\/datastack\/(.*)\/table\/(.*)/;
          const res = url.match(regex);
          if (!res || res.length < 2) {
            throw 'bad url';
          }
          const [_, datastack, table] = res;
          const materializationUrl = url.split(`/${API_STRING}/`)[0];
          let metadata: any;
          try {
            getJsonMetadata;
            metadata = {
  "@type" : "cave_annotations_v1",
  // "annotation_type" : "LINE",
  // "dimensions" : {
  //     "x" : [ 4e-09, "m" ],
  //     "y" : [ 4e-09, "m" ],
  //     "z" : [ 40e-09, "m" ]
  //  },
  "lower_bound" : [ 26285, 30208, 14826 ], // maybe these are only used for the spatial index?
  "size" : [ 192768, 131328, 13056 ],
  "spatial" : [],
  "properties" : [],
  // "relationships": [{
  //        "id" : "pre_pt_root_id",
  //        "name" : "Pre root id"
  //     },
  //     {
  //        "id" : "post_pt_root_id",
  //        "name" : "Post root id"
  //     }]
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
              return await getAnnotationDataSource(options, credentialsProvider, materializationUrl, datastack, table, metadata);
            default:
              throw new Error(`Invalid type: ${JSON.stringify(t)}`);
          }
        });
  }
  async completeUrl(options: CompleteUrlOptions) {
    console.log('completeUrl', options);

    const {providerUrl} = options;

    const {url, credentialsProvider} =
              parseSpecialUrl(providerUrl, options.credentialsManager);

    
    {
      const regex = /.*https:\/\/.*\/datastack\/(.*)\/table\/(.*)/;
      const res = providerUrl.match(regex);
      if (res && res.length === 3) {
        const [full, datastack, table] = res;
        const offset = full.length - table.length;

        const materializationUrl = url.split(`/${API_STRING}/`)[0];
        const latestVersion = await getLatestVersion(credentialsProvider, materializationUrl, datastack);
        const tables = await getTables(credentialsProvider, materializationUrl, datastack, latestVersion);
        const tablesFiltered = tables.filter(x => x.startsWith(table));
        const completions = tablesFiltered.map(x => {
          return { value: x };
        });
        return {
          offset,
          completions,
        };
      }
    }

    {
      const regex = /.*https:\/\/.*\/datastack\/(\w*)$/;
      const res = providerUrl.match(regex);
      if (res && res.length === 2) {
        const [full, datastack] = res;
        const offset = full.length - datastack.length;
        const datastacks = await getDatastacks(credentialsProvider);
        const datastacksFiltered = datastacks.filter(x => x.startsWith(datastack));
        const completions = datastacksFiltered.map(x => {
          return { value: x };
        });
        return {
          offset,
          completions,
        };
      }
    }

    // const materializationUrl = url.split(`/${API_STRING}/`)[0];


    // const res = providerUrl.match(/.*\/table\/(\w*)/);

    // https://global.daf-apis.com/info/api/v2/datastacks

    // // https://minnie.microns-daf.com/materialize/api/v3/datastack/minnie65_phase3_v1/version/671/tables

    // if (res) {
    //   const [first, second] = res;
    //   const offset = first.length - second.length;
    //   return {
    //     offset,
    //     completions: [
    //       {
    //         value: 'bumble',
    //         desciptiono: `it's a fricken bee!`,
    //       },
    //       {
    //         value: 'something else',
    //         desciptiono: `not a bee!`,
    //       }
    //     ]
    //   }
    // }

    return {offset: options.providerUrl.length, completions: []};
    // return completeHttpPath(
    //     options.credentialsManager, options.providerUrl, options.cancellationToken);
  }
}