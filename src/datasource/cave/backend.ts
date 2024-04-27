import { tableFromIPC } from "apache-arrow";
import type {
  AnnotationGeometryChunk,
  AnnotationMetadataChunk,
  AnnotationSubsetGeometryChunk,
} from "#src/annotation/backend.js";
import {
  AnnotationGeometryChunkSourceBackend,
  AnnotationGeometryData,
  AnnotationSource,
} from "#src/annotation/backend.js";

import type {
  AnnotationBase,
  AnnotationNumericPropertySpec,
  Line,
  Point,
} from "#src/annotation/index.js";
import {
  AnnotationSerializer,
  AnnotationType,
  makeAnnotationPropertySerializers,
} from "#src/annotation/index.js";

import { WithParameters } from "#src/chunk_manager/backend.js";
import { WithSharedCredentialsProviderCounterpart } from "#src/credentials_provider/shared_counterpart.js";
import {
  API_STRING,
  AnnotationSourceParameters,
  AnnotationSpatialIndexSourceParameters,
} from "#src/datasource/cave/base.js";
import type { CancellationToken } from "#src/util/cancellation.js";
import { vec3 } from "#src/util/geom.js";
import { responseJson } from "#src/util/http_request.js";
import type {
  SpecialProtocolCredentials,
  SpecialProtocolCredentialsProvider,
} from "#src/util/special_protocol_request.js";
import { cancellableFetchSpecialOk } from "#src/util/special_protocol_request.js";

import { registerSharedObject } from "#src/worker_rpc.js";

function parseCaveAnnototations(
  annotationsJson: any[],
  parameters: AnnotationSourceParameters,
) {
  const seenEnums = new Map<string, Set<string>>();
  const annotations: (Point | Line)[] = annotationsJson.map((x) => {
    const points = parameters.relationships.map((rel) => {
      return vec3.fromValues(
        Number(x[`${rel}_position_x`]),
        Number(x[`${rel}_position_y`]),
        Number(x[`${rel}_position_z`]),
      );
    });
    const res: AnnotationBase = {
      type: AnnotationType.POINT,
      id: x.id.toString(),
      properties: parameters.properties.map((p) => {
        const value = x[p.identifier];
        const maybeEnumProperty = p as AnnotationNumericPropertySpec;

        if (maybeEnumProperty.enumLabels && maybeEnumProperty.enumValues) {
          const enumIndex = maybeEnumProperty.enumLabels.indexOf(value);
          if (enumIndex > -1) {
            const setEnumsForIdentifier =
              seenEnums.get(p.identifier) || new Set();
            setEnumsForIdentifier.add(value);
            seenEnums.set(p.identifier, setEnumsForIdentifier);
            return maybeEnumProperty.enumValues[enumIndex];
          } else {
            console.warn("new enum", value, "refresh the page!");
          }
        }
        return Number(value);
      }),
    };
    if (points.length > 1) {
      return {
        ...res,
        type: AnnotationType.LINE,
        pointA: points[0],
        pointB: points[1],
      };
    } else {
      return {
        ...res,
        type: AnnotationType.POINT,
        point: points[0],
      };
    }
  });
  return annotations;
}

export const responseArrowIPC = async (x: any) => tableFromIPC(x);

async function queryAnnotations(
  credentialsProvider: SpecialProtocolCredentialsProvider,
  parameters: AnnotationSourceParameters,
  query: any,
  randomSample: number,
  cancellationToken: CancellationToken,
) {
  const { datastack } = parameters;
  const binaryFormat = true;
  const randomSampleUrl =
    randomSample > 0 ? `random_sample=${randomSample}` : "";
  const url = `${parameters.url}/${API_STRING}/datastack/${datastack}/query?return_pyarrow=${binaryFormat}&arrow_format=${binaryFormat}&ipc_compress=false&${randomSampleUrl}&split_positions=false&count=false&allow_missing_lookups=false`;
  let response = await cancellableFetchSpecialOk(
    credentialsProvider,
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof query === "string" ? query : JSON.stringify(query),
    },
    binaryFormat ? responseArrowIPC : responseJson,
    cancellationToken,
  );
  if (response === undefined) return;
  if (binaryFormat) {
    response = [...response];
  }
  return parseCaveAnnototations(response, parameters);
}

@registerSharedObject() //
export class CaveAnnotationSpatialIndexSourceBackend extends WithParameters(
  WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(
    AnnotationGeometryChunkSourceBackend,
  ),
  AnnotationSpatialIndexSourceParameters,
) {
  parent: CaveAnnotationSourceBackend;

  async download(
    chunk: AnnotationGeometryChunk,
    cancellationToken: CancellationToken,
  ) {
    const { credentialsProvider, parent } = this;
    const { parameters } = parent; // we probably don't need separate spatial index for now
    const { table, timestamp, rank, properties } = parameters;
    const annotations = await queryAnnotations(
      credentialsProvider,
      parameters,
      {
        timestamp,
        table,
        limit: 10000,
      },
      5,
      cancellationToken,
    );
    if (annotations) {
      const propertySerializers = makeAnnotationPropertySerializers(
        rank,
        properties,
      );
      const serializer = new AnnotationSerializer(propertySerializers);
      for (const annotation of annotations) {
        serializer.add(annotation);
      }
      chunk.data = Object.assign(
        new AnnotationGeometryData(),
        serializer.serialize(),
      );
    }
  }
}

@registerSharedObject() //
export class CaveAnnotationSourceBackend extends WithParameters(
  WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(
    AnnotationSource,
  ),
  AnnotationSourceParameters,
) {
  waitingFor: Promise<any> | undefined;

  async downloadSegmentFilteredGeometry(
    chunk: AnnotationSubsetGeometryChunk,
    relationshipIndex: number,
    cancellationToken: CancellationToken,
  ) {
    const { credentialsProvider, parameters } = this;
    const { timestamp, table, relationships, rank, properties } = parameters;
    const payload = `{
      "timestamp": "${timestamp}",
      "filter_in_dict": {
        "${table}":{
          "${relationships[relationshipIndex]}_root_id": [${chunk.objectId.toJSON()}]
        }
      },
      "table": "${table}"
    }`; // TODO (hardcoding `_root_id`)
    const annotations = await queryAnnotations(
      credentialsProvider,
      parameters,
      payload,
      0,
      cancellationToken,
    );
    if (annotations) {
      const propertySerializers = makeAnnotationPropertySerializers(
        rank,
        properties,
      );
      const serializer = new AnnotationSerializer(propertySerializers);
      for (const annotation of annotations) {
        serializer.add(annotation);
      }
      chunk.data = Object.assign(
        new AnnotationGeometryData(),
        serializer.serialize(),
      );
    }
  }

  async downloadMetadata(
    chunk: AnnotationMetadataChunk,
    cancellationToken: CancellationToken,
  ) {
    cancellationToken;
    if (!chunk.key) return;
    const { credentialsProvider, parameters } = this;
    const { timestamp, table } = parameters;
    const payload = `{
      "timestamp": "${timestamp}",
      "filter_in_dict": {
        "${table}":{
          "id": [${chunk.key}]
        }
      },
      "table": "${table}"
    }`;
    const annotations = await queryAnnotations(
      credentialsProvider,
      parameters,
      payload,
      0,
      cancellationToken,
    );
    if (annotations && annotations.length > 0) {
      chunk.annotation = annotations[0];
    }
  }
}
