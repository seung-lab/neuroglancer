import type { AnnotationPropertySpec } from "#src/annotation/index.js";

export const API_STRING_V2 = "api/v2";
export const API_STRING = "api/v3";

export class AnnotationSourceParameters {
  url: string;
  datastack: string;
  table: string;
  timestamp: string;
  rank: number;
  relationships: string[];
  properties: AnnotationPropertySpec[];
  static RPC_ID = "cave/AnnotationSource";
}

export class AnnotationSpatialIndexSourceParameters {
  static RPC_ID = "cave/AnnotationSpatialIndexSource";
  url: string;
  datastack: string;
  table: string;
}
