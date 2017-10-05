/**
 * @license
 * Copyright 2016 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {VertexAttributeInfo} from 'neuroglancer/skeleton/base';

export enum VolumeChunkEncoding {
  RAW,
  JPEG,
  COMPRESSED_SEGMENTATION
}

export class VolumeChunkSourceParameters {
  baseUrls: string[];
  path: string;
  encoding: VolumeChunkEncoding;

  static stringify(parameters: VolumeChunkSourceParameters) {
    return `precomputed:volume:${parameters.baseUrls[0]}/${parameters.path}`;
  }

  static RPC_ID = 'precomputed/VolumeChunkSource';
}


export class MeshSourceParameters {
  baseUrls: string[];
  path: string;
  lod: number;

  static stringify(parameters: MeshSourceParameters) {
    return `precomputed:mesh:${parameters.baseUrls[0]}/${parameters.path}/${parameters.lod}`;
  }

  static RPC_ID = 'precomputed/MeshSource';
}


export class SkeletonSourceParameters {
  baseUrls: string[];
  key: string;
  vertexAttributes: Map<string, VertexAttributeInfo>;

  static stringify(parameters: SkeletonSourceParameters) {
    return `precomputed:skeleton:${parameters['baseUrls'][0]}/${parameters['key']}`;
  }

  static RPC_ID = 'precomputed/SkeletonSource';
}
