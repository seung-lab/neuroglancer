/**
 * @license
 * Copyright 2018 The Neuroglancer Authors
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

import {AnnotationSource, makeDataBoundsBoundingBox} from 'neuroglancer/annotation';
import {ChunkManager, WithParameters} from 'neuroglancer/chunk_manager/frontend';
import {RedirectError} from 'neuroglancer/datasource';
import {VolumeChunkSourceParameters} from 'neuroglancer/datasource/graphene/image/base';
import {DataType, VolumeChunkSpecification, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource, VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {parseArray, verifyEnumString, verifyObject, verifyObjectProperty, verifyOptionalString, verifyPositiveInt} from 'neuroglancer/util/json';

import {ScaleInfo} from 'neuroglancer/datasource/graphene/frontend';

class GrapheneImageVolumeChunkSource extends
(WithParameters(VolumeChunkSource, VolumeChunkSourceParameters)) {}

function resolvePath(a: string, b: string) {
  const outputParts = a.split('/');
  for (const part of b.split('/')) {
    if (part === '..') {
      if (outputParts.length !== 0) {
        outputParts.length = outputParts.length - 1;
        continue;
      }
    }
    outputParts.push(part);
  }
  return outputParts.join('/');
}

export class GrapheneImageMultiscaleVolumeChunkSource implements GenericMultiscaleVolumeChunkSource {
  dataType: DataType;
  numChannels: number;
  volumeType: VolumeType;
  mesh: string|undefined;
  skeletons: string|undefined;
  segmentMetadata: string|undefined;
  scales: ScaleInfo[];

  getMeshSource() {
    return null;
  }

  constructor(public chunkManager: ChunkManager, public url: string, obj: any) {
    verifyObject(obj);
    const redirect = verifyObjectProperty(obj, 'redirect', verifyOptionalString);
    if (redirect !== undefined) {
      throw new RedirectError(redirect);
    }

    const t = verifyObjectProperty(obj, '@type', verifyOptionalString);
    if (t !== undefined && t !== 'neuroglancer_multiscale_volume') {
      throw new Error(`Invalid type: ${JSON.stringify(t)}`);
    }
    this.dataType = verifyObjectProperty(obj, 'data_type', x => verifyEnumString(x, DataType));
    this.numChannels = verifyObjectProperty(obj, 'num_channels', verifyPositiveInt);
    this.volumeType = verifyObjectProperty(obj, 'type', x => verifyEnumString(x, VolumeType));
    this.mesh = verifyObjectProperty(obj, 'mesh', verifyOptionalString);
    this.skeletons = verifyObjectProperty(obj, 'skeletons', verifyOptionalString);
    this.scales = verifyObjectProperty(obj, 'scales', x => parseArray(x, y => new ScaleInfo(y)));
    this.segmentMetadata = verifyObjectProperty(obj, 'segmentMetadata', verifyOptionalString);
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    return this.scales.map(scaleInfo => {
      return VolumeChunkSpecification
          .getDefaults({
            voxelSize: scaleInfo.resolution,
            dataType: this.dataType,
            numChannels: this.numChannels,
            transform: mat4.fromTranslation(
                mat4.create(),
                vec3.multiply(vec3.create(), scaleInfo.resolution, scaleInfo.voxelOffset)),
            upperVoxelBound: scaleInfo.size,
            volumeType: this.volumeType,
            chunkDataSizes: scaleInfo.chunkSizes,
            baseVoxelOffset: scaleInfo.voxelOffset,
            compressedSegmentationBlockSize: scaleInfo.compressedSegmentationBlockSize,
            volumeSourceOptions,
          })
          .map(spec => this.chunkManager.getChunkSource(GrapheneImageVolumeChunkSource, {
            spec,
            parameters: {
              url: resolvePath(this.url, scaleInfo.key),
              encoding: scaleInfo.encoding,
              sharding: scaleInfo.sharding,
            }
          }));
    });
  }

  getStaticAnnotations() {
    const baseScale = this.scales[0];
    const annotationSet =
        new AnnotationSource(mat4.fromScaling(mat4.create(), baseScale.resolution));
    annotationSet.readonly = true;
    annotationSet.add(makeDataBoundsBoundingBox(
        baseScale.voxelOffset, vec3.add(vec3.create(), baseScale.voxelOffset, baseScale.size)));
    return annotationSet;
  }
}
