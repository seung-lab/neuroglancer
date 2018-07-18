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
import {Endianness, ENDIANNESS} from 'neuroglancer/util/endian';
import * as nbind from './nbind';
import * as LibTypes from './lib-types';

const lib = nbind.init<typeof LibTypes>().lib;

export function decodeFpzipChunk(
    chunk: VolumeChunk, response: ArrayBuffer, endianness: Endianness = ENDIANNESS) {

    let data = new Uint8Array(response);
    let fpzip = lib.Fpzip(data.buffer);

    function allocate_decode_buffer() {
      if (fpzip.get_type() == 0) {
        return new Float32Array(fpzip.nvoxels());
      }

      return new Float64Array(fpzip.nvoxels());
    }

    let decoded = allocate_decode_buffer();
    fpzip.decompress(data.buffer, decoded.buffer);

    decodeRawChunk(chunk, decoded.buffer, endianness);
}

export function decodeKempressedChunk(
    chunk: VolumeChunk, response: ArrayBuffer, endianness: Endianness = ENDIANNESS) {

    let data = new Uint8Array(response);
    let fpzip = lib.Fpzip(data.buffer);

    function allocate_decode_buffer() {
      if (fpzip.get_type() == 0) {
        return new Float32Array(fpzip.nvoxels());
      }

      return new Float64Array(fpzip.nvoxels());
    }

    let decoded = allocate_decode_buffer();
    fpzip.dekempress(data.buffer, decoded.buffer);

    decodeRawChunk(chunk, decoded.buffer, endianness);
}
