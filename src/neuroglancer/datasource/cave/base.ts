import { AnnotationPropertySpec, AnnotationType } from "src/neuroglancer/annotation";
// import { ShardingParameters } from "../precomputed/base";

// export class AnnotationSpatialIndexSourceParameters {
//   url: string;
//   // sharding: ShardingParameters|undefined;
//   static RPC_ID = 'cave/AnnotationSpatialIndexSource';
// }

export class AnnotationSourceParameters {
  url: string;
  timestamp: string;
  rank: number;
  relationships: string[];
  properties: AnnotationPropertySpec[];
  // byId: {url: string; sharding: ShardingParameters | undefined;};
  type: AnnotationType;
  static RPC_ID = 'cave/AnnotationSource';
}
