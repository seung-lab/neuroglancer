import { AnnotationGeometryData, AnnotationMetadataChunk, AnnotationSource } from "src/neuroglancer/annotation/backend";
import { AnnotationSubsetGeometryChunk } from "src/neuroglancer/annotation/backend";
import { WithParameters } from "src/neuroglancer/chunk_manager/backend";
import { WithSharedCredentialsProviderCounterpart } from "src/neuroglancer/credentials_provider/shared_counterpart";
import { CancellationToken } from "src/neuroglancer/util/cancellation";
import { responseJson } from "src/neuroglancer/util/http_request";
import { SpecialProtocolCredentials } from "src/neuroglancer/util/special_protocol_request";
import { registerSharedObject } from "src/neuroglancer/worker_rpc";
import { AnnotationSourceParameters, API_STRING } from "./base";
import {cancellableFetchSpecialOk} from 'neuroglancer/util/special_protocol_request';

import {vec3} from 'neuroglancer/util/geom';
import { AnnotationBase, AnnotationSerializer, AnnotationType, Line, Point, makeAnnotationPropertySerializers } from "src/neuroglancer/annotation";


const annotationPropertySerializers =
    makeAnnotationPropertySerializers(/*rank=*/ 3, /*propertySpecs=*/[]);


function parseCaveAnnototations(annotationsJson: any[], parameters: AnnotationSourceParameters) {
  parameters;
  const serializer = new AnnotationSerializer(annotationPropertySerializers);

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
      id: x.id,
      description: `size: ${x.size}`,
      properties: [],
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

  for (const annotation of annotations) {
    serializer.add(annotation);
  }
  return Object.assign(new AnnotationGeometryData(), serializer.serialize());;
}

@registerSharedObject() //
export class CaveAnnotationSourceBackend extends (WithParameters(WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(AnnotationSource), AnnotationSourceParameters)) {  
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
    //   "timestamp": "${timestamp}",
    //   "limit": 10000,
    //   "table": "synapses_pni_2"
    // }`;
    const response = await cancellableFetchSpecialOk(this.credentialsProvider, url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: payload,
    }, responseJson, cancellationToken);
    if (response !== undefined) {
      chunk.data = parseCaveAnnototations(response, this.parameters)
      // chunk.data = parseAnnotations(response, this.parameters, this.annotationPropertySerializer);
    }
  }

  async downloadMetadata(chunk: AnnotationMetadataChunk, cancellationToken: CancellationToken) {
    cancellationToken;
    const {parameters} = this;
    console.log('downloadMetadata', chunk.key, chunk.annotation, parameters);
    // if (response === undefined) {
      chunk.annotation = null;
    // } else {
    //   chunk.annotation = parseSingleAnnotation(
    //       response, this.parameters, this.annotationPropertySerializer, chunk.key!);
    // }
  }
}
