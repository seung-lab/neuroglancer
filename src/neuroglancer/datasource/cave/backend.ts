import { AnnotationGeometryData, AnnotationMetadataChunk, AnnotationSource } from "src/neuroglancer/annotation/backend";
import { AnnotationSubsetGeometryChunk } from "src/neuroglancer/annotation/backend";
import { WithParameters } from "src/neuroglancer/chunk_manager/backend";
import { WithSharedCredentialsProviderCounterpart } from "src/neuroglancer/credentials_provider/shared_counterpart";
import { CancellationToken } from "src/neuroglancer/util/cancellation";
import { responseJson } from "src/neuroglancer/util/http_request";
import { SpecialProtocolCredentials } from "src/neuroglancer/util/special_protocol_request";
import { registerSharedObject } from "src/neuroglancer/worker_rpc";
import { AnnotationSourceParameters } from "./base";
import {cancellableFetchSpecialOk} from 'neuroglancer/util/special_protocol_request';

import {vec3} from 'neuroglancer/util/geom';
import { AnnotationSerializer, AnnotationType, Line, makeAnnotationPropertySerializers } from "src/neuroglancer/annotation";


const annotationPropertySerializers =
    makeAnnotationPropertySerializers(/*rank=*/ 3, /*propertySpecs=*/[]);


function parseCaveAnnototations(annotationsJson: any[], parameters: AnnotationSourceParameters) {
  parameters;
  const serializer = new AnnotationSerializer(annotationPropertySerializers);

  const annotations: Line[] = annotationsJson.map(x => {
    return {
      type: AnnotationType.LINE,
      id: x.pre_pt_supervoxel_id,
      pointA: vec3.fromValues(x.pre_pt_position_x, x.pre_pt_position_y, x.pre_pt_position_z),
      pointB: vec3.fromValues(x.post_pt_position_x, x.post_pt_position_y, x.post_pt_position_z),
      description: 'size: 916',
      properties: [],
      //relatedSegments: segments,
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
    cancellationToken;
    relationshipIndex
    const {parameters} = this;
    const url = `${parameters.url}/query?return_pyarrow=false&split_positions=false&count=false&allow_missing_lookups=false`;
    const payload = `{
      "timestamp": "${parameters.timestamp}",
      "filter_in_dict": {
        "synapses_pni_2":{
          "${parameters.relationships[relationshipIndex]}": [${chunk.objectId.toJSON()}]
        }
      },
      "table": "synapses_pni_2"
    }`;
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
