import { AnnotationPropertySpec, AnnotationType } from "src/neuroglancer/annotation";
import { ShardingParameters } from "../precomputed/base";

export class AnnotationSpatialIndexSourceParameters {
  url: string;
  // sharding: ShardingParameters|undefined;
  static RPC_ID = 'cave/AnnotationSpatialIndexSource';
}

export class AnnotationSourceParameters {
  rank: number;
  relationships: {url: string; name: string; sharding: ShardingParameters | undefined;}[];
  properties: AnnotationPropertySpec[];
  // byId: {url: string; sharding: ShardingParameters | undefined;};
  type: AnnotationType;
  static RPC_ID = 'cave/AnnotationSource';
}
