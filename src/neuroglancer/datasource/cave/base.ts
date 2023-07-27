import { AnnotationPropertySpec, AnnotationType } from "src/neuroglancer/annotation";
// import { ShardingParameters } from "../precomputed/base";

export const API_STRING_V2 = 'api/v2';
export const API_STRING = 'api/v3';


// export class AnnotationSpatialIndexSourceParameters {
//   url: string;
//   // sharding: ShardingParameters|undefined;
//   static RPC_ID = 'cave/AnnotationSpatialIndexSource';
// }

AnnotationType; // TODO

export class AnnotationSourceParameters {
  url: string;
  datastack: string;
  table: string;
  timestamp: string;
  rank: number;
  relationships: string[];
  properties: AnnotationPropertySpec[];
  // byId: {url: string; sharding: ShardingParameters | undefined;};
  // type: AnnotationType;
  static RPC_ID = 'cave/AnnotationSource';
}

export class AnnotationSpatialIndexSourceParameters {
  static RPC_ID = 'cave/AnnotationSpatialIndexSource';
}
