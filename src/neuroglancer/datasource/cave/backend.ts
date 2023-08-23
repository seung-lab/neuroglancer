import {AnnotationGeometryChunk, AnnotationGeometryChunkSourceBackend, AnnotationGeometryData, AnnotationMetadataChunk, AnnotationSource} from "neuroglancer/annotation/backend";
import {AnnotationSubsetGeometryChunk} from "neuroglancer/annotation/backend";
import {WithParameters} from "neuroglancer/chunk_manager/backend";
import {WithSharedCredentialsProviderCounterpart} from "neuroglancer/credentials_provider/shared_counterpart";
import {CancellationToken} from "neuroglancer/util/cancellation";
import {responseJson} from "neuroglancer/util/http_request";
import {SpecialProtocolCredentials} from "neuroglancer/util/special_protocol_request";
import {registerSharedObject} from "neuroglancer/worker_rpc";
import {AnnotationSourceParameters, AnnotationSpatialIndexSourceParameters, API_STRING} from "./base";
import {cancellableFetchSpecialOk} from 'neuroglancer/util/special_protocol_request';
import {vec3} from 'neuroglancer/util/geom';
import {AnnotationBase, AnnotationSerializer, AnnotationType, Line, Point, makeAnnotationPropertySerializers} from "neuroglancer/annotation";
import {Uint64} from "neuroglancer/util/uint64";
import {tableFromIPC} from "apache-arrow";



function parseCaveAnnototations(segmentId: Uint64, annotationsJson: any[], parameters: AnnotationSourceParameters) {  
  const seenEnums = new Map<String, Set<String>>();
  const annotations: (Point|Line)[] = annotationsJson.map(x => {
    const points = parameters.relationships.map(rel => {
      return vec3.fromValues(
        Number(x[`${rel}_position_x`]),
        Number(x[`${rel}_position_y`]),
        Number(x[`${rel}_position_z`])
      );
    });
    const res: AnnotationBase = {
      type: AnnotationType.POINT,
      id: `${segmentId}_${x.id}`,
      description: `size: ${x.size}`,
      properties: parameters.properties.map(p => {
        const value = x[p.identifier];
        if (p.type === "uint8") { // todo, not the right way to check
          const setEnumsForIdentifier = seenEnums.get(p.identifier) || new Set();
          setEnumsForIdentifier.add(value);
          seenEnums.set(p.identifier, setEnumsForIdentifier);
          return Number([...setEnumsForIdentifier].indexOf(value));
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
      }
    } else {
      return {
        ...res,
        type: AnnotationType.POINT,
        point: points[0],
      }
    }    
  });

  console.log('seenEnums', seenEnums);
  return annotations;
}

export const responseArrowIPC = async (x: any) => tableFromIPC(x);

@registerSharedObject() //
export class CaveAnnotationSpatialIndexSourceBackend extends (WithParameters(WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(AnnotationGeometryChunkSourceBackend), AnnotationSpatialIndexSourceParameters)) {
  parent: CaveAnnotationSourceBackend;
  async download(chunk: AnnotationGeometryChunk, cancellationToken: CancellationToken) {
    const {parent} = this;
    const {parameters} = parent; // we probably don't need separate spatial index for now
    const {datastack, table, timestamp, rank, properties} = parameters;
    const binaryFormat = true;
    const url = `${parameters.url}/${API_STRING}/datastack/${datastack}/query?random_sample=1000&arrow_format=${binaryFormat}&split_positions=false&count=false&allow_missing_lookups=false`;
    const payload = `{
      "timestamp": "${timestamp}",
      "table": "${table}"
    }`;
    let response = await cancellableFetchSpecialOk(this.credentialsProvider, url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: payload,
    }, binaryFormat ? responseArrowIPC : responseJson, cancellationToken);
    if (response !== undefined) {
      console.log("got annotations!", response.length);
      if (binaryFormat) {
        response = [...response];
      }
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
    const binaryFormat = true;
    const url = `${parameters.url}/${API_STRING}/datastack/${datastack}/query?arrow_format=${binaryFormat}&split_positions=false&count=false&allow_missing_lookups=false`;
    const payload = `{
      "timestamp": "${timestamp}",
      "filter_in_dict": {
        "${table}":{
          "${relationships[relationshipIndex]}_root_id": [${chunk.objectId.toJSON()}]
        }
      },
      "table": "${table}"
    }`; // TODO (hardcoding `_root_id`)
    let response = await cancellableFetchSpecialOk(this.credentialsProvider, url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: payload,
    }, binaryFormat ? responseArrowIPC : responseJson, cancellationToken);
    if (response !== undefined) {
      if (binaryFormat) {
        response = [...response];
      }
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
