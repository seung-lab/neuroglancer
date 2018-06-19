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

// may want to consider using a worker pool
let fpzip_worker : Worker = new Worker('fpzip_worker.js');

let messageHandlers : any = {
  callbacks: {},
  count: 0,
};
    
fpzip_worker.onerror = function (error) {
  console.log(error);
};

fpzip_worker.onmessage = function (evt) {
  if (evt.data.callback !== undefined) {
    messageHandlers.callbacks[evt.data.callback](evt.data.msg);
  }
};

type TypedArray = Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Uint8ClampedArray | Float32Array | Float64Array | ArrayBuffer;

function sendWorkerMessage (
  type: string, msg: any, 
  transferrables: TypedArray[] | null) {

  return new Promise((fulfill) => {
    sendWorkerMessageCallback(type, msg, (res: TypedArray) => fulfill(res), transferrables);
  });
}
  
function sendWorkerMessageCallback (
  type: string, msg: any, callback: Function, 
  transferrables: TypedArray[] | null) {

  let unique : number = 0;
  if (callback) {
    unique = messageHandlers.count;
    messageHandlers.count++;

    messageHandlers.callbacks[unique] = (res: TypedArray) => {
      callback(res);  
      delete messageHandlers.callbacks[unique];
    };
  }

  fpzip_worker.postMessage({ 
    type: type, 
    msg: msg, 
    callback: unique,
  }, <any[]>transferrables);
}


export function decodeFpzipChunk(
    chunk: VolumeChunk, response: ArrayBuffer, endianness: Endianness = ENDIANNESS) {

  sendWorkerMessage('fpzip_decompress', {
    buffer: response,
  }, [ response ])
    .then(function (decoded: ArrayBuffer) {
      decodeRawChunk(chunk, decoded, endianness);
    });
}

export function decodeKempressedChunk(
    chunk: VolumeChunk, response: ArrayBuffer, endianness: Endianness = ENDIANNESS) {

  sendWorkerMessage('fpzip_dekempress', {
    buffer: response,
  }, [ response ])
    .then(function (decoded: ArrayBuffer) {
      decodeRawChunk(chunk, decoded, endianness);
    });
}
