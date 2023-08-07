import { AnnotationGeometryChunk, AnnotationGeometryChunkSourceBackend, AnnotationGeometryData, AnnotationMetadataChunk, AnnotationSource } from "src/neuroglancer/annotation/backend";
import { AnnotationSubsetGeometryChunk } from "src/neuroglancer/annotation/backend";
import { WithParameters } from "src/neuroglancer/chunk_manager/backend";
import { WithSharedCredentialsProviderCounterpart } from "src/neuroglancer/credentials_provider/shared_counterpart";
import { CancellationToken } from "src/neuroglancer/util/cancellation";
import { responseArrayBuffer, responseJson } from "src/neuroglancer/util/http_request";
import { SpecialProtocolCredentials } from "src/neuroglancer/util/special_protocol_request";
import { registerSharedObject } from "src/neuroglancer/worker_rpc";
import { AnnotationSourceParameters, AnnotationSpatialIndexSourceParameters, API_STRING } from "./base";
import {cancellableFetchSpecialOk} from 'neuroglancer/util/special_protocol_request';
import {vec3} from 'neuroglancer/util/geom';
import {Annotation, AnnotationBase, AnnotationSerializer, AnnotationType, Line, Point, makeAnnotationPropertySerializers} from "src/neuroglancer/annotation";
import {Uint64} from "neuroglancer/util/uint64";


function parseCaveAnnototations(segmentId: Uint64, annotationsJson: any[], parameters: AnnotationSourceParameters) {
  console.log('parameters', parameters);
  const annotations: (Point|Line)[] = annotationsJson.map(x => {
    const points = parameters.relationships.map(rel => {
      return vec3.fromValues(
        x[`${rel}_position_x`],
        x[`${rel}_position_y`],
        x[`${rel}_position_z`]
      );
    });

    const res: AnnotationBase = {
      type: AnnotationType.POINT,
      id: `${segmentId}_${x.id}`,
      description: `size: ${x.size}`,
      properties: parameters.properties.map(p => x[p.identifier]),
    };
    if (points.length > 1) {
      return {
        ...res,
        type: AnnotationType.LINE,
        pointA: points[0],
        pointB: points[1],
      }
    } else {
      return {
        ...res,
        type: AnnotationType.POINT,
        point: points[0],
      }
    }    
  });

  return annotations;
}

@registerSharedObject() //
export class CaveAnnotationSpatialIndexSourceBackend extends (WithParameters(WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(AnnotationGeometryChunkSourceBackend), AnnotationSpatialIndexSourceParameters)) {
  parent: CaveAnnotationSourceBackend;
  async download(chunk: AnnotationGeometryChunk, cancellationToken: CancellationToken) {
    const {parent} = this;
    const {parameters} = parent; // we probably don't need separate spatial index for now
    const {datastack, table, timestamp, rank, properties} = parameters;
    const binaryFormat = false;
    const url = `${parameters.url}/${API_STRING}/datastack/${datastack}/query?return_pyarrow=${binaryFormat}&split_positions=false&count=false&allow_missing_lookups=false`;
    const payload = `{
      "timestamp": "${timestamp}",
      "limit": 10000,
      "table": "${table}"
    }`;
    const response = await cancellableFetchSpecialOk(this.credentialsProvider, url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: payload,
    }, binaryFormat ? responseArrayBuffer : responseJson, cancellationToken);
    if (response !== undefined) {
      if (binaryFormat) {
        console.log("got arraybuffer!", response.byteLength);
        return;
      }
      console.log("got annotations!", response.length);
      const annotations = parseCaveAnnototations(Uint64.ZERO, response, parameters);
      // this.annotationCache[chunk.objectId.toJSON()] = annotations;
      const propertySerializers = makeAnnotationPropertySerializers(rank, properties);
      const serializer = new AnnotationSerializer(propertySerializers);
      for (const annotation of annotations) {
        // this.annotationCache.set(annotation.id, annotation);
        serializer.add(annotation);
      }
      chunk.data = Object.assign(new AnnotationGeometryData(), serializer.serialize());
    } else {
      console.log('got no annotations');
    }
  }
}

@registerSharedObject() //
export class CaveAnnotationSourceBackend extends (WithParameters(WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(AnnotationSource), AnnotationSourceParameters)) {  
  annotationCache = new Map<string, Annotation>();
  
  async downloadSegmentFilteredGeometry(
      chunk: AnnotationSubsetGeometryChunk, relationshipIndex: number,
      cancellationToken: CancellationToken) {
    const {parameters} = this;
    const {datastack, table, relationships, timestamp, rank, properties} = parameters;
    const url = `${parameters.url}/${API_STRING}/datastack/${datastack}/query?return_pyarrow=false&split_positions=false&count=false&allow_missing_lookups=false`;
    const payload = `{
      "timestamp": "${timestamp}",
      "filter_in_dict": {
        "${table}":{
          "${relationships[relationshipIndex]}_root_id": [${chunk.objectId.toJSON()}]
        }
      },
      "table": "${table}"
    }`; // TODO (hardcoding `_root_id`)
    const response = await cancellableFetchSpecialOk(this.credentialsProvider, url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: payload,
    }, responseJson, cancellationToken);
    if (response !== undefined) {
      const annotations = parseCaveAnnototations(chunk.objectId, response, this.parameters);
      const propertySerializers = makeAnnotationPropertySerializers(rank, properties);
      const serializer = new AnnotationSerializer(propertySerializers);
      for (const annotation of annotations) {
        this.annotationCache.set(annotation.id, annotation);
        serializer.add(annotation);
      }
      chunk.data = Object.assign(new AnnotationGeometryData(), serializer.serialize());
    }
  }

  async downloadMetadata(chunk: AnnotationMetadataChunk, cancellationToken: CancellationToken) {
    cancellationToken;
    const {parameters} = this;
    console.log('downloadMetadata', chunk.key, chunk.annotation, parameters);
    if (!chunk.key) return;
    chunk.annotation = this.annotationCache.get(chunk.key) || null;
  }
}
