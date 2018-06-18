/**
 * @license
 * Copyright 2018
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

import {decodeRawChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/raw';
import {VolumeChunk} from 'neuroglancer/sliceview/volume/backend';
import {DATA_TYPE_BYTES, DataType} from 'neuroglancer/util/data_type';
import {convertEndian16, convertEndian32, Endianness, ENDIANNESS} from 'neuroglancer/util/endian';

import {decompress} from 'fpzip'


let fpzip_worker = new Worker('fpzip_worker.js');

    fpzip_worker.postMessage({ 
      type: 'decompress_fpzip', 
      msg: { data: response }, 
      callback: unique,
    }, transferrables);


export function decodeFpzipChunk(
    chunk: VolumeChunk, response: ArrayBuffer, endianness: Endianness = ENDIANNESS) {

  // decode fpzip 
  decodeRawChunk(chunk, response, endianness);
}

export function decodeKempressedChunk(
    chunk: VolumeChunk, response: ArrayBuffer, endianness: Endianness = ENDIANNESS) {

  // decode fpzip 
  // dekempression
  decodeRawChunk(chunk, response, endianness);
}
