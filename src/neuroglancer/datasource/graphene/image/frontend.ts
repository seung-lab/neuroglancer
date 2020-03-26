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
// import {RedirectError} from 'neuroglancer/datasource';
// import {VolumeChunkSourceParameters} from 'neuroglancer/datasource/graphene/base';
import {DataType, VolumeChunkSpecification, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource, VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {parseFixedLengthArray, parseArray, verifyEnumString, verifyObject, verifyObjectProperty, verifyOptionalString, verifyPositiveInt, verifyNonnegativeInt} from 'neuroglancer/util/json';

import {parseSpecialUrl} from 'neuroglancer/util/http_request';

import {ScaleInfo, resolvePath} from 'neuroglancer/datasource/graphene/frontend';

import {StatusMessage} from 'neuroglancer/status';

class GrapheneImageVolumeChunkSource extends
(WithParameters(VolumeChunkSource, VolumeChunkSourceParameters)) {}



import {PYCG_APP_VERSION, VolumeChunkSourceParameters} from 'neuroglancer/datasource/graphene/base';



class AppInfo {
  segmentationUrl: string;
  meshingUrl: string;
  supported_api_versions: number[];
  constructor(infoUrl: string, obj: any) {
    // .../1.0/... is the legacy link style
    // .../table/... is the current, version agnostic link style (for retrieving the info file)
    const linkStyle = /^(https?:\/\/[^\/]+)\/segmentation\/(?:1\.0|table)\/([^\/]+)\/?$/;
    let match = infoUrl.match(linkStyle);
    if (match === null) {
      throw Error(`Graph URL invalid: ${infoUrl}`);
    }
    this.segmentationUrl = `${match[1]}/segmentation/api/v${PYCG_APP_VERSION}/table/${match[2]}`;
    this.meshingUrl = `${match[1]}/meshing/api/v${PYCG_APP_VERSION}/table/${match[2]}`;

    try {
      verifyObject(obj);
      this.supported_api_versions = verifyObjectProperty(
          obj, 'supported_api_versions', x => parseArray(x, verifyNonnegativeInt));
    } catch (error) {
      // Dealing with a prehistoric graph server with no version information
      this.supported_api_versions = [0];
    }
    if (PYCG_APP_VERSION in this.supported_api_versions === false) {
      const redirectMsgBox = new StatusMessage();
      const redirectMsg = `This Neuroglancer branch requires Graph Server version ${
          PYCG_APP_VERSION}, but the server only supports version(s) ${
          this.supported_api_versions}.`;

      if (location.hostname.includes('neuromancer-seung-import.appspot.com')) {
        const redirectLoc = new URL(location.href);
        redirectLoc.hostname = `graphene-v${
            this.supported_api_versions.slice(-1)[0]}-dot-neuromancer-seung-import.appspot.com`;
        redirectMsgBox.setHTML(`Try <a href="${redirectLoc.href}">${redirectLoc.hostname}</a>?`);
      }
      throw new Error(redirectMsg);
    }
  }
}

class GraphInfo {
  chunkSize: vec3;
  constructor(obj: any) {
    verifyObject(obj);
    this.chunkSize = verifyObjectProperty(
        obj, 'chunk_size', x => parseFixedLengthArray(vec3.create(), x, verifyPositiveInt));
  }
}

export class GrapheneImageMultiscaleVolumeChunkSource implements GenericMultiscaleVolumeChunkSource {
  dataType: DataType;
  numChannels: number;
  volumeType: VolumeType;
  mesh: string|undefined;
  skeletons: string|undefined;
  segmentMetadata: string|undefined;
  scales: ScaleInfo[];

  dataUrl: string;
  app: AppInfo;
  graph: GraphInfo;

  getMeshSource() {
    return null;
  }

  constructor(public chunkManager: ChunkManager, infoUrl: string, obj: any) {
    verifyObject(obj);
    const t = verifyObjectProperty(obj, '@type', verifyOptionalString);
    if (t !== undefined && t !== 'neuroglancer_multiscale_volume') {
      throw new Error(`Invalid type: ${JSON.stringify(t)}`);
    }

    console.log('infoUrl', infoUrl);
    console.log('obj', obj);

    // this.dataUrl = verifyObjectProperty(obj, 'data_dir', x => parseSpecialUrl(x));

    if (obj.type === 'segmentation') {
      this.app = verifyObjectProperty(obj, 'app', x => new AppInfo(infoUrl, x));
      // this.dataUrl = verifyObjectProperty(obj, 'data_dir', x => parseSpecialUrl(x));
      this.graph = verifyObjectProperty(obj, 'graph', x => new GraphInfo(x));
      this.volumeType = VolumeType.SEGMENTATION_WITH_GRAPH;
    } else {
      this.dataUrl = infoUrl;
      this.volumeType = verifyObjectProperty(obj, 'type', x => verifyEnumString(x, VolumeType));
      // this.segmentMetadata = verifyObjectProperty(obj, 'segmentMetadata', verifyOptionalString);
    }
    this.dataType = verifyObjectProperty(obj, 'data_type', x => verifyEnumString(x, DataType));
    this.numChannels = verifyObjectProperty(obj, 'num_channels', verifyPositiveInt);
    this.mesh = verifyObjectProperty(obj, 'mesh', verifyOptionalString);
    this.skeletons = verifyObjectProperty(obj, 'skeletons', verifyOptionalString);
    this.scales = verifyObjectProperty(obj, 'scales', x => parseArray(x, y => new ScaleInfo(y)));
  }

  // constructor(public chunkManager: ChunkManager, public url: string, obj: any) {
  //   verifyObject(obj);
  //   const redirect = verifyObjectProperty(obj, 'redirect', verifyOptionalString);
  //   if (redirect !== undefined) {
  //     throw new RedirectError(redirect);
  //   }

  //   const t = verifyObjectProperty(obj, '@type', verifyOptionalString);
  //   if (t !== undefined && t !== 'neuroglancer_multiscale_volume') {
  //     throw new Error(`Invalid type: ${JSON.stringify(t)}`);
  //   }
  //   this.dataType = verifyObjectProperty(obj, 'data_type', x => verifyEnumString(x, DataType));
  //   this.numChannels = verifyObjectProperty(obj, 'num_channels', verifyPositiveInt);
  //   this.volumeType = verifyObjectProperty(obj, 'type', x => verifyEnumString(x, VolumeType));
  //   // this.mesh = verifyObjectProperty(obj, 'mesh', verifyOptionalString);
  //   // this.skeletons = verifyObjectProperty(obj, 'skeletons', verifyOptionalString);
  //   this.scales = verifyObjectProperty(obj, 'scales', x => parseArray(x, y => new ScaleInfo(y)));
  //   // this.segmentMetadata = verifyObjectProperty(obj, 'segmentMetadata', verifyOptionalString);
  // }

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
              url: resolvePath(this.dataUrl, scaleInfo.key),
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
