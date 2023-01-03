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
  // const geometryData = new AnnotationGeometryData();

  const serializer = new AnnotationSerializer(annotationPropertySerializers);


  // return {
  //       type: AnnotationType.LINE,
  //       id,
  //       pointA: corner,
  //       pointB: vec3.add(vec3.create(), corner, size),
  //       description,
  //       relatedSegments: segments,
  //       properties: [],
  //     };

  // const offset = [-26285 /  2, -30208 / 2, -14826 / 2];
  const offset = [0, 0, 0];

  // 286764 - 149091
  // 182902 - 89161
  // 16254 -> 16064

  const annotations: Line[] = annotationsJson.map(x => {
    return {
      type: AnnotationType.LINE,
      id: x.pre_pt_supervoxel_id,
      pointA: vec3.fromValues(x.pre_pt_position_x + offset[0], x.pre_pt_position_y + offset[1], x.pre_pt_position_z + offset[2]),
      pointB: vec3.fromValues(x.post_pt_position_x + offset[0], x.post_pt_position_y + offset[1], x.post_pt_position_z + offset[2]),
      description: 'size: 916',
      properties: [],
    }
  });

  for (const annotation of annotations) {
    //26285 , 30208, 14826
    serializer.add(annotation);
  }

  // const pre = {
    
  // }
  return Object.assign(new AnnotationGeometryData(), serializer.serialize());;
}

@registerSharedObject() //
export class CaveAnnotationSourceBackend extends (WithParameters(WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(AnnotationSource), AnnotationSourceParameters)) {
  // private byIdMinishardIndexSource = getMinishardIndexDataSource(
  //     this.chunkManager, this.credentialsProvider, this.parameters.byId);
  // private relationshipIndexSource = this.parameters.relationships.map(
  //     x => getMinishardIndexDataSource(this.chunkManager, this.credentialsProvider, x));
  // annotationPropertySerializer = new AnnotationPropertySerializer(
  //     this.parameters.rank,
  //     annotationTypeHandlers[this.parameters.type].serializedBytes(this.parameters.rank),
  //     this.parameters.properties);

  // using this?
  async downloadSegmentFilteredGeometry(
      chunk: AnnotationSubsetGeometryChunk, relationshipIndex: number,
      cancellationToken: CancellationToken) {
    cancellationToken;
    relationshipIndex
    const {parameters} = this;

    const url = `https://minnie.microns-daf.com/materialize/api/v3/datastack/minnie65_phase3_v1/query?return_pyarrow=false&split_positions=false&count=false&allow_missing_lookups=false`;

    const payload = `{
      "timestamp": "2022-12-13T20:16:52.111132",
      "filter_in_dict": {
        "synapses_pni_2":{
          "${parameters.relationships[relationshipIndex].name}": [${chunk.objectId.toJSON()}]
        }
      },
      "table": "synapses_pni_2"
    }`;

    const response = await cancellableFetchSpecialOk(this.credentialsProvider, url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: payload,
    }, responseJson, cancellationToken);


    // const response = await fetchByUint64(
    //     this.credentialsProvider, parameters.relationships[relationshipIndex].url, chunk,
    //     this.relationshipIndexSource[relationshipIndex], chunk.objectId, cancellationToken);
    if (response !== undefined) {
      chunk.data = parseCaveAnnototations(response, this.parameters)
      // chunk.data = parseAnnotations(response, this.parameters, this.annotationPropertySerializer);
    }
  }

  async downloadMetadata(chunk: AnnotationMetadataChunk, cancellationToken: CancellationToken) {
    cancellationToken;
    const {parameters} = this;
    console.log('downloadMetadata', chunk.key, chunk.annotation, parameters);
    // const id = Uint64.parseString(chunk.key!);
    // const response = await fetchByUint64(
    //     this.credentialsProvider, parameters.byId.url, chunk, this.byIdMinishardIndexSource, id,
    //     cancellationToken);
    // if (response === undefined) {
    //   chunk.annotation = null;
    // } else {
    //   chunk.annotation = parseSingleAnnotation(
    //       response, this.parameters, this.annotationPropertySerializer, chunk.key!);
    // }
  }
}
