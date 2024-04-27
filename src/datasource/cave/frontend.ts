import type { AnnotationGeometryChunkSpecification } from "#src/annotation/base.js";
import {
  AnnotationGeometryChunkSource,
  MultiscaleAnnotationSource,
} from "#src/annotation/frontend_source.js";
import type {
  AnnotationNumericPropertySpec,
  AnnotationPropertySpec,
} from "#src/annotation/index.js";
import { parseAnnotationPropertySpecs } from "#src/annotation/index.js";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { WithParameters } from "#src/chunk_manager/frontend.js";
import type { CoordinateSpace } from "#src/coordinate_transform.js";
import {
  coordinateSpaceFromJson,
  makeCoordinateSpace,
  makeIdentityTransform,
  makeIdentityTransformedBoundingBox,
} from "#src/coordinate_transform.js";
import { WithCredentialsProvider } from "#src/credentials_provider/chunk_source_frontend.js";
import {
  API_STRING,
  API_STRING_V2,
  AnnotationSourceParameters,
  AnnotationSpatialIndexSourceParameters,
} from "#src/datasource/cave/base.js";
import { getJsonMetadata } from "#src/datasource/graphene/frontend.js";
import type {
  CompleteUrlOptions,
  ConvertLegacyUrlOptions,
  DataSource,
  GetDataSourceOptions,
  NormalizeUrlOptions,
} from "#src/datasource/index.js";
import { DataSourceProvider } from "#src/datasource/index.js";
import {
  parseMultiscaleVolumeInfo,
  parseProviderUrl,
} from "#src/datasource/precomputed/frontend.js";
import type { SliceViewSingleResolutionSource } from "#src/sliceview/frontend.js";
import { responseJson } from "#src/util/http_request.js";
import {
  unparseQueryStringParameters,
  verifyFinitePositiveFloat,
  verifyNonnegativeInt,
  verifyObject,
  verifyObjectAsMap,
  verifyObjectProperty,
  verifyOptionalObjectProperty,
  verifyString,
  verifyStringArray,
} from "#src/util/json.js";
import * as matrix from "#src/util/matrix.js";
import { getObjectId } from "#src/util/object_id.js";
import type {
  SpecialProtocolCredentials,
  SpecialProtocolCredentialsProvider,
} from "#src/util/special_protocol_request.js";
import {
  cancellableFetchSpecialOk,
  parseSpecialUrl,
} from "#src/util/special_protocol_request.js";

class AnnotationMetadata {
  coordinateSpace: CoordinateSpace;
  parameters: AnnotationSourceParameters;
  size: Float64Array;
  constructor(
    public url: string,
    datastack: string,
    table: string,
    tableMetadata: TableMetadata,
    public lowerBounds: Float64Array,
    public upperBounds: Float64Array,
  ) {
    const { voxel_resolution_x, voxel_resolution_y, voxel_resolution_z } =
      tableMetadata;
    const baseCoordinateSpace = coordinateSpaceFromJson({
      x: [voxel_resolution_x, "nm"],
      y: [voxel_resolution_y, "nm"],
      z: [voxel_resolution_z, "nm"],
    });
    const { rank } = baseCoordinateSpace;
    const size: Float64Array = new Float64Array(rank);
    for (let i = 0; i < rank; i++) {
      size[i] = upperBounds[i] - lowerBounds[i];
    }
    this.size = size;
    this.coordinateSpace = makeCoordinateSpace({
      rank,
      names: baseCoordinateSpace.names,
      units: baseCoordinateSpace.units,
      scales: baseCoordinateSpace.scales,
      boundingBoxes: [
        makeIdentityTransformedBoundingBox({ lowerBounds, upperBounds }),
      ],
    });
    this.parameters = {
      url,
      datastack,
      table,
      timestamp: "",
      rank,
      relationships: tableMetadata.relationships,
      properties: tableMetadata.shaderProperties,
    };
  }
}

const MultiscaleAnnotationSourceBase = WithParameters(
  WithCredentialsProvider<SpecialProtocolCredentials>()(
    MultiscaleAnnotationSource,
  ),
  AnnotationSourceParameters,
);

class CaveAnnotationSpatialIndexSource extends WithParameters(
  WithCredentialsProvider<SpecialProtocolCredentials>()(
    AnnotationGeometryChunkSource,
  ),
  AnnotationSpatialIndexSourceParameters,
) {}

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
  constructor(
    chunkManager: ChunkManager,
    options: PrecomputedAnnotationSourceOptions,
  ) {
    const { parameters } = options;
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

  getSources(
    _unused: any,
  ): SliceViewSingleResolutionSource<AnnotationGeometryChunkSource>[][] {
    const { credentialsProvider, rank, metadata } = this;
    const { lowerBounds, upperBounds, size } = metadata;

    const chunkToMultiscaleTransform = matrix.createIdentity(
      Float32Array,
      rank + 1,
    );
    for (let i = 0; i < rank; ++i) {
      chunkToMultiscaleTransform[(rank + 1) * rank + i] = lowerBounds[i];
    }

    const spec: AnnotationGeometryChunkSpecification = {
      rank,
      chunkToMultiscaleTransform,
      lowerChunkBound: new Float32Array([0, 0, 0]),
      upperChunkBound: new Float32Array([1, 1, 1]),
      limit: 0,
      chunkDataSize: new Float32Array(size),
      lowerVoxelBound: new Float32Array(lowerBounds),
      upperVoxelBound: new Float32Array(upperBounds),
    };
    const { url, datastack, table } = this.parameters;
    return [
      [
        {
          chunkSource: this.chunkManager.getChunkSource(
            CaveAnnotationSpatialIndexSource,
            {
              credentialsProvider,
              parameters: {
                url,
                datastack,
                table,
              }, // parent.paramters has all we need, but memoize doesn't seem to care about the parent parameters
              parent: this,
              spec,
            },
          ),
          chunkToMultiscaleTransform: spec.chunkToMultiscaleTransform,
        },
      ],
    ];
  }
}

// TODO, find a better generic caching mechanism
async function getLatestVersion(
  credentialsProvider: SpecialProtocolCredentialsProvider,
  url: string,
  datastack: string,
) {
  const existing = getLatestVersion.cache[`${url}_${datastack}`];
  if (existing) return existing;

  const versonsURL = `${url}/${API_STRING_V2}/datastack/${datastack}/versions`;
  const versions = await cancellableFetchSpecialOk(
    credentialsProvider,
    versonsURL,
    {},
    responseJson,
  );
  const latestVersion = Math.max(...versions);

  getLatestVersion.cache[`${url}_${datastack}`] = latestVersion;
  return latestVersion;
}
getLatestVersion.cache = {} as { [key: string]: number };

async function getLatestTimestamp(
  credentialsProvider: SpecialProtocolCredentialsProvider,
  url: string,
  datastack: string,
  version: number,
) {
  const existing = getLatestTimestamp.cache[`${url}_${datastack}_${version}`];
  if (existing) return existing;

  const versionMetadataURL = `${url}/${API_STRING_V2}/datastack/${datastack}/version/${version}`;
  const versionMetadata = await cancellableFetchSpecialOk(
    credentialsProvider,
    versionMetadataURL,
    {},
    responseJson,
  );
  const res = versionMetadata.time_stamp as string;

  getLatestTimestamp.cache[`${url}_${datastack}_${version}`] = res;
  return res;
}
getLatestTimestamp.cache = {} as { [key: string]: string };

async function getTables(
  credentialsProvider: SpecialProtocolCredentialsProvider,
  url: string,
  datastack: string,
  version: number,
) {
  const existing = getTables.cache[`${url}_${datastack}_${version}`];
  if (existing) return existing;

  const tablesURL = `${url}/${API_STRING}/datastack/${datastack}/version/${version}/tables`;
  const tables = (await cancellableFetchSpecialOk(
    credentialsProvider,
    tablesURL,
    {},
    responseJson,
  )) as string[];

  getTables.cache[`${url}_${datastack}_${version}`] = tables;
  return tables;
}
getTables.cache = {} as { [key: string]: string[] };

async function getDatastacks(
  credentialsProvider: SpecialProtocolCredentialsProvider,
) {
  const existing = getDatastacks.cache.datastacks;
  if (existing) return existing as string[];

  const datastacksURL = `https://global.daf-apis.com/info/api/v2/datastacks`;
  const datastacks = (await cancellableFetchSpecialOk(
    credentialsProvider,
    datastacksURL,
    {},
    responseJson,
  )) as string[];

  getDatastacks.cache.datastacks = datastacks;
  return datastacks;
}
getDatastacks.cache = { datastacks: undefined as any };

interface TableMetadata {
  schemaType: string;
  voxel_resolution_x: number;
  voxel_resolution_y: number;
  voxel_resolution_z: number;
  relationships: string[];
  shaderProperties: AnnotationPropertySpec[];
}

const schemaFormatToPropertyType: { [key: string]: string } = {
  float: "float32",
};

const BOUND_SPATIAL_POINT = "BoundSpatialPoint";
const SPATIAL_POINT = "SpatialPoint";

async function getTableMetadata(
  credentialsProvider: SpecialProtocolCredentialsProvider,
  url: string,
  datastack: string,
  version: number,
  table: string,
): Promise<TableMetadata> {
  const metadataURL = `${url}/${API_STRING_V2}/datastack/${datastack}/version/${version}/table/${table}/metadata`;
  const metadata = await cancellableFetchSpecialOk(
    credentialsProvider,
    metadataURL,
    {},
    responseJson,
  );
  verifyObject(metadata);
  const schemaType = verifyObjectProperty(
    metadata,
    "schema_type",
    verifyString,
  );
  const voxel_resolution_x = verifyObjectProperty(
    metadata,
    "voxel_resolution_x",
    verifyFinitePositiveFloat,
  );
  const voxel_resolution_y = verifyObjectProperty(
    metadata,
    "voxel_resolution_y",
    verifyFinitePositiveFloat,
  );
  const voxel_resolution_z = verifyObjectProperty(
    metadata,
    "voxel_resolution_z",
    verifyFinitePositiveFloat,
  );

  const refToName = (x: string) => {
    const res = x.split("/").at(-1);
    if (!res) {
      throw new Error("bad $ref");
    }
    return res;
  };

  // TODO, break apart url so we can avoid hardcoding global.daf-apis.com
  const schemaURL = `https://global.daf-apis.com/schema/${API_STRING_V2}/type/${schemaType}`;
  // TODO, do we ever want to authenticate this request?
  const schema = await cancellableFetchSpecialOk(
    undefined,
    schemaURL,
    {},
    responseJson,
  );

  verifyObject(schema);
  const ref = verifyObjectProperty(schema, "$ref", verifyString);
  const definitionName = refToName(ref);
  const definitions = verifyObjectProperty(schema, "definitions", verifyObject);
  const definition = verifyObjectProperty(
    definitions,
    definitionName,
    verifyObject,
  );
  const [relationships, shaderProperties] = verifyObjectProperty(
    definition,
    "properties",
    (x) => {
      const relationships: string[] = [];
      const shaderProps: unknown[] = [];
      const result = verifyObjectAsMap(x, verifyObject);
      for (const [name, obj] of result) {
        verifyObject(obj);
        const ref = verifyOptionalObjectProperty(obj, "$ref", verifyString);
        const type = verifyOptionalObjectProperty(obj, "type", (x) => {
          try {
            const [type, defaultValue] = verifyStringArray(x);
            return {
              type,
              defaultValue,
            };
          } catch (_e) {
            const type = verifyString(x);
            return {
              type,
            };
          }
        });
        const format = verifyOptionalObjectProperty(
          obj,
          "format",
          verifyString,
        );
        if (ref) {
          const refName = refToName(ref);
          const order =
            verifyOptionalObjectProperty(obj, "order", verifyNonnegativeInt) ||
            0;
          if (refName === BOUND_SPATIAL_POINT) {
            // TODO, maybe we want to support SpatialPoint?
            relationships[order] = name;
          } else if (refName === SPATIAL_POINT) {
            // TODO
          }
        }

        if (type && type.type === "string") {
          shaderProps.push({
            id: name,
            type: "uint8",
            enum_values: [],
            enum_labels: [],
          });
        }

        if (format) {
          const shaderType = schemaFormatToPropertyType[format];
          if (shaderType) {
            shaderProps.push({
              id: name,
              type: shaderType,
            });
          }
        }
      }
      return [
        relationships.filter((x) => x !== undefined),
        parseAnnotationPropertySpecs(
          shaderProps,
        ) as AnnotationNumericPropertySpec[],
      ];
    },
  );

  const uniqueStringValues = await getUniqueStringValues(
    url,
    datastack,
    table,
    credentialsProvider,
  );
  // console.log("res", res);

  for (const prop of shaderProperties) {
    if (prop.enumLabels !== undefined) {
      const values = uniqueStringValues[prop.identifier];
      if (values) {
        prop.enumLabels = values;
        prop.enumValues = new Array(values.length)
          .fill(0)
          .map((_value, index) => index);
      }
      console.log("prop enumLabels", prop);
      // for (const row of response) {
      //   const value = row[prop.identifier];
      //   if (value !== undefined) {
      //     if (prop.enumLabels.indexOf(value) === -1) {
      //       prop.enumLabels.push(value);
      //     }
      //   }
      // }
      // prop.enumLabels.sort();
      // for (let i = 0; i < prop.enumLabels.length; i++) {
      //   prop.enumValues![i] = i + 1;
      // }
    }
  }

  // TEMPORARY CODE
  // {
  //   const responseArrowIPC = async (x: any) => tableFromIPC(x);
  //   const timestamp = await getLatestTimestamp(
  //     credentialsProvider,
  //     url,
  //     datastack,
  //     version,
  //   );
  //   const binaryFormat = false;
  //   const urlSample = `${url}/${API_STRING}/datastack/${datastack}/query?return_pyarrow=${binaryFormat}&arrow_format=${binaryFormat}&split_positions=false&count=false&allow_missing_lookups=false`;
  //   const payload = `{
  //     "timestamp": "${timestamp}",
  //     "table": "${table}"
  //   }`;
  //   const response = await cancellableFetchSpecialOk(
  //     credentialsProvider,
  //     urlSample,
  //     {
  //       method: "POST",
  //       headers: { "Content-Type": "application/json" },
  //       body: payload,
  //     },
  //     binaryFormat ? responseArrowIPC : responseJson,
  //     undefined,
  //   );
  //   if (response !== undefined) {
  //     // if (binaryFormat) {
  //     for (const prop of shaderProperties) {
  //       if (prop.enumLabels !== undefined) {
  //         for (const row of response) {
  //           const value = row[prop.identifier];
  //           if (value !== undefined) {
  //             if (prop.enumLabels.indexOf(value) === -1) {
  //               prop.enumLabels.push(value);
  //             }
  //           }
  //         }
  //         prop.enumLabels.sort();
  //         for (let i = 0; i < prop.enumLabels.length; i++) {
  //           prop.enumValues![i] = i + 1;
  //         }
  //       }
  //     }
  //     // }
  //   }
  // }

  // TODO, maybe use flat_segmentation_source to automatically link up the segmentation?
  // segmentation_source is empty
  return {
    schemaType,
    voxel_resolution_x,
    voxel_resolution_y,
    voxel_resolution_z,
    relationships,
    shaderProperties,
  };
}

async function getAnnotationDataSource(
  options: GetDataSourceOptions,
  credentialsProvider: SpecialProtocolCredentialsProvider,
  url: string,
  datastack: string,
  table: string,
): Promise<DataSource> {
  const latestVersion = await getLatestVersion(
    credentialsProvider,
    url,
    datastack,
  );
  const timestamp = await getLatestTimestamp(
    credentialsProvider,
    url,
    datastack,
    latestVersion,
  );
  const tableMetadata = await getTableMetadata(
    credentialsProvider,
    url,
    datastack,
    latestVersion,
    table,
  ); // url: string, datastack: string, table: string)

  const origin = new URL(url).origin;
  const authInfo = await fetch(`${origin}/auth_info`).then((res) => res.json());
  const { login_url } = authInfo;
  const infoServiceOrigin = new URL(login_url).origin;
  const datastackInfo = await getDatastackMetadata(
    options.chunkManager,
    credentialsProvider,
    `${infoServiceOrigin}/info/api/v2/datastack/${datastack}`,
  );
  const segmentationSource = verifyObjectProperty(
    datastackInfo,
    "segmentation_source",
    verifyString,
  );
  const [_protocol, grapheneUrl] = segmentationSource.split("graphene://"); // TODO, do we only support graphene?
  _protocol; // TODO (chrisj)
  const grapheneMetadata = await getJsonMetadata(
    options.chunkManager,
    credentialsProvider,
    grapheneUrl,
  );
  const volumeInfo = parseMultiscaleVolumeInfo(grapheneMetadata);
  const { modelSpace } = volumeInfo;
  const { lowerBounds, upperBounds } = modelSpace.boundingBoxes[0].box;

  const info = new AnnotationMetadata(
    url,
    datastack,
    table,
    tableMetadata,
    lowerBounds,
    upperBounds,
  );

  const dataSource: DataSource = {
    modelTransform: makeIdentityTransform(info.coordinateSpace),
    subsources: [
      {
        id: "default",
        default: true,
        subsource: {
          annotation: options.chunkManager.getChunkSource(
            CaveAnnotationSource,
            {
              credentialsProvider,
              metadata: info,
              parameters: { ...info.parameters, timestamp },
            },
          ),
        },
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

function getDatastackMetadata(
  chunkManager: ChunkManager,
  credentialsProvider: SpecialProtocolCredentialsProvider,
  url: string,
): Promise<any> {
  return chunkManager.memoize.getUncounted(
    {
      type: "cave:datastack_metadata",
      url,
      credentialsProvider: getObjectId(credentialsProvider),
    },
    async () => {
      return await cancellableFetchSpecialOk(
        credentialsProvider,
        `${url}`,
        {},
        responseJson,
      );
    },
  );
}

async function getUniqueStringValues(
  url: string,
  datastack: string,
  table: string,
  credentialsProvider: SpecialProtocolCredentialsProvider,
) {
  // return chunkManager.memoize.getUncounted(
  //   {
  //     type: "cave:datastack_table_unique_string_values",
  //     datastack,
  //     table,
  //     credentialsProvider: getObjectId(credentialsProvider),
  //   },
  //   async () => {
  return await cancellableFetchSpecialOk(
    credentialsProvider,
    `${url}/${API_STRING}/datastack/${datastack}/table/${table}/unique_string_values`,
    {},
    responseJson,
  );
  // },
  // );
}

export class CaveDataSource extends DataSourceProvider {
  get description() {
    return "cave";
  }

  normalizeUrl(options: NormalizeUrlOptions): string {
    const { url, parameters } = parseProviderUrl(options.providerUrl);
    return (
      options.providerProtocol + "://" + unparseProviderUrl(url, parameters)
    );
  }

  convertLegacyUrl(options: ConvertLegacyUrlOptions): string {
    const { url, parameters } = parseProviderUrl(options.providerUrl);
    if (options.type === "mesh") {
      parameters["type"] = "mesh";
    }
    return (
      options.providerProtocol + "://" + unparseProviderUrl(url, parameters)
    );
  }

  get(options: GetDataSourceOptions): Promise<DataSource> {
    const { url: providerUrl, parameters } = parseProviderUrl(
      options.providerUrl,
    );
    return options.chunkManager.memoize.getUncounted(
      { type: "cave:get", providerUrl, parameters },
      async (): Promise<DataSource> => {
        const { url, credentialsProvider } = parseSpecialUrl(
          providerUrl,
          options.credentialsManager,
        );
        const regex = /https:\/\/.*\/datastack\/(.*)\/table\/(.*)/;
        const res = url.match(regex);
        if (!res || res.length < 2) {
          throw "bad url";
        }
        const [_, datastack, table] = res;
        _; // TODO (chrisj)
        const materializationUrl = url.split(`/${API_STRING}/`)[0];
        return await getAnnotationDataSource(
          options,
          credentialsProvider,
          materializationUrl,
          datastack,
          table,
        );
      },
    );
  }
  async completeUrl(options: CompleteUrlOptions) {
    const { providerUrl } = options;

    const { url, credentialsProvider } = parseSpecialUrl(
      providerUrl,
      options.credentialsManager,
    );

    {
      const regex = /.*https:\/\/.*\/datastack\/(.*)\/table\/(.*)/;
      const res = providerUrl.match(regex);
      if (res && res.length === 3) {
        const [full, datastack, table] = res;
        const offset = full.length - table.length;

        const materializationUrl = url.split(`/${API_STRING}/`)[0];
        const latestVersion = await getLatestVersion(
          credentialsProvider,
          materializationUrl,
          datastack,
        );
        const tables = await getTables(
          credentialsProvider,
          materializationUrl,
          datastack,
          latestVersion,
        );
        const tablesFiltered = tables.filter((x) => x.startsWith(table));
        const completions = tablesFiltered.map((x) => {
          return { value: x };
        });
        return {
          offset,
          completions,
        };
      }
    }

    {
      const regex = /.*https:\/\/.*\/datastack\/.*\/(\w*)$/;
      const res = providerUrl.match(regex);
      if (res && res.length === 2) {
        const [full, pathSegment] = res;
        const offset = full.length - pathSegment.length;
        const desiredSegment = "table/";
        const result = desiredSegment.match(new RegExp(pathSegment));
        if (result) {
          const completions = [{ value: desiredSegment }];
          return {
            offset,
            completions,
          };
        }
      }
    }

    {
      const regex = /.*https:\/\/.*\/datastack\/(\w*)$/;
      const res = providerUrl.match(regex);
      if (res && res.length === 2) {
        const [full, datastack] = res;
        const offset = full.length - datastack.length;
        const datastacks = await getDatastacks(credentialsProvider);
        const datastacksFiltered = datastacks.filter((x) =>
          x.startsWith(datastack),
        );
        const completions = datastacksFiltered.map((x) => {
          return { value: x + "/" };
        });
        return {
          offset,
          completions,
        };
      }
    }

    return { offset: options.providerUrl.length, completions: [] };
  }
}
