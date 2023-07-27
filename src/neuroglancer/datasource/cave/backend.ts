import { AnnotationGeometryChunk, AnnotationGeometryChunkSourceBackend, AnnotationGeometryData, AnnotationMetadataChunk, AnnotationSource } from "src/neuroglancer/annotation/backend";
import { AnnotationSubsetGeometryChunk } from "src/neuroglancer/annotation/backend";
import { WithParameters } from "src/neuroglancer/chunk_manager/backend";
import { WithSharedCredentialsProviderCounterpart } from "src/neuroglancer/credentials_provider/shared_counterpart";
import { CancellationToken } from "src/neuroglancer/util/cancellation";
import { responseJson } from "src/neuroglancer/util/http_request";
import { SpecialProtocolCredentials } from "src/neuroglancer/util/special_protocol_request";
import { registerSharedObject } from "src/neuroglancer/worker_rpc";
import { AnnotationSourceParameters, AnnotationSpatialIndexSourceParameters, API_STRING } from "./base";
import {cancellableFetchSpecialOk} from 'neuroglancer/util/special_protocol_request';

import {vec3} from 'neuroglancer/util/geom';
import { Annotation, AnnotationBase, AnnotationSerializer, AnnotationType, Line, Point, makeAnnotationPropertySerializers } from "src/neuroglancer/annotation";
import {Uint64} from "src/neuroglancer/util/uint64";


const annotationPropertySerializers =
    makeAnnotationPropertySerializers(/*rank=*/ 3, /*propertySpecs=*/[]);



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
      properties: [], // [x.size]
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
  // private minishardIndexSource =
  //     getMinishardIndexDataSource(this.chunkManager, this.credentialsProvider, this.parameters);
  parent: CaveAnnotationSourceBackend;
  async download(chunk: AnnotationGeometryChunk, cancellationToken: CancellationToken) {
    console.log("SPATIAL DOWNLOAD!");
    cancellationToken;
    console.log('chunk', chunk);
        const {parent} = this;
    console.log('parent', parent);

    const {parameters} = parent; // we probably don't need separate spatial index for now

    this.parent.parameters.timestamp;



    const url = `${parameters.url}/${API_STRING}/datastack/${parameters.datastack}/query?return_pyarrow=false&split_positions=false&count=false&allow_missing_lookups=false`;
    const payload = `{
      "timestamp": "${parameters.timestamp}",
      "table": "${parameters.table}"
    }`;
    const response = await cancellableFetchSpecialOk(this.credentialsProvider, url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: payload,
    }, responseJson, cancellationToken);
    if (response !== undefined) {
      console.log("got annotations!", response.length);
      const annotations = parseCaveAnnototations(Uint64.ZERO, response, parameters);
      // this.annotationCache[chunk.objectId.toJSON()] = annotations;
      const serializer = new AnnotationSerializer(annotationPropertySerializers);
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
    const url = `${parameters.url}/${API_STRING}/datastack/${parameters.datastack}/query?return_pyarrow=false&split_positions=false&count=false&allow_missing_lookups=false`;
    const payload = `{
      "timestamp": "${parameters.timestamp}",
      "filter_in_dict": {
        "${parameters.table}":{
          "${parameters.relationships[relationshipIndex]}_root_id": [${chunk.objectId.toJSON()}]
        }
      },
      "table": "${parameters.table}"
    }`; // TODO (hardcooding _root_id)
    // parameters; for spatial
    // const payload = `{
    //   "timestamp": "${parameters.timestamp}",
    //   "limit": 10000,
    //   "table": "${parameters.table}"
    // }`;
    const response = await cancellableFetchSpecialOk(this.credentialsProvider, url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: payload,
    }, responseJson, cancellationToken);
    if (response !== undefined) {
      const annotations = parseCaveAnnototations(chunk.objectId, response, this.parameters);
      // this.annotationCache[chunk.objectId.toJSON()] = annotations;
      const serializer = new AnnotationSerializer(annotationPropertySerializers);
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



    // this.annotationCache[chunk.ob]

    // if (response === undefined) {
      // chunk.annotation = null;
    // } else {
    //   chunk.annotation = parseSingleAnnotation(
    //       response, this.parameters, this.annotationPropertySerializer, chunk.key!);
    // }
  }
}
