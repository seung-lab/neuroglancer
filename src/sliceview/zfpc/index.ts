/**
 * @license
 * Copyright 2022 William Silvermsith
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

const libraryEnv = {
  emscripten_notify_memory_growth: () => {},
  proc_exit: (code: number) => {
    throw `proc exit: ${code}`;
  },
};

let zfpcModulePromise: Promise<WebAssembly.Instance> | undefined;

function getZfpcModulePromise() {
  if (zfpcModulePromise === undefined) {
    zfpcModulePromise = (async () => {
      const m = (
        await WebAssembly.instantiateStreaming(
          fetch(new URL("./libzfpc.wasm", import.meta.url)),
          {
            env: libraryEnv,
            wasi_snapshot_preview1: libraryEnv,
          },
        )
      ).instance;
      (m.exports._initialize as Function)();
      return m;
    })();
  }
  return zfpcModulePromise;
}

/**
 * malloc takes a u32 byte count, so any size at or above 2^32 wraps as it
 * crosses the JS/wasm boundary and quietly allocates the wrong amount.
 */
const MAX_ALLOCATION_BYTES = 2 ** 32;

/**
 * Number of bytes per sample for each zfpc data type code. zfpc stores the
 * code in the low three bits of header byte 5.
 */
const BYTES_PER_SAMPLE_BY_DATA_TYPE_CODE: Record<number, number> = {
  1: 4, // int32
  2: 8, // int64
  3: 4, // float32
  4: 8, // float64
};

// not a full implementation of read header, just the parts we need
function readHeader(buffer: Uint8Array): {
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  numChannels: number;
  bytesPerSample: number;
} {
  // check for header "zfpc"
  const magic =
    buffer[0] === "z".charCodeAt(0) &&
    buffer[1] === "f".charCodeAt(0) &&
    buffer[2] === "p".charCodeAt(0) &&
    buffer[3] === "c".charCodeAt(0);
  if (!magic) {
    throw new Error("zfpc: didn't match magic numbers");
  }
  const format = buffer[4];
  if (format > 0) {
    throw new Error("zfpc: didn't match format version");
  }

  const bufview = new DataView(buffer.buffer, buffer.byteOffset);

  const dataTypeCode = buffer[5] & 0b111;
  const bytesPerSample = BYTES_PER_SAMPLE_BY_DATA_TYPE_CODE[dataTypeCode];
  if (bytesPerSample === undefined) {
    throw new Error(`zfpc: unsupported data width: ${dataTypeCode}`);
  }

  const sizeX = bufview.getUint32(6, /*littleEndian=*/ true);
  const sizeY = bufview.getUint32(10, /*littleEndian=*/ true);
  const sizeZ = bufview.getUint32(14, /*littleEndian=*/ true);
  const numChannels = bufview.getUint32(18, /*littleEndian=*/ true);

  return { sizeX, sizeY, sizeZ, numChannels, bytesPerSample };
}

export async function decompressZfpc(
  buffer: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const m = await getZfpcModulePromise();

  const { sizeX, sizeY, sizeZ, numChannels, bytesPerSample } =
    readHeader(buffer);

  const samples = sizeX * sizeY * sizeZ * numChannels;
  const nbytes = samples * bytesPerSample;
  // The dimensions are unvalidated uint32s straight off the wire, so their
  // product is never negative — it is either implausibly large or, past 2^53,
  // imprecise. Sizes at or above MAX_ALLOCATION_BYTES silently wrap on the way
  // into wasm, which would hand the decoder a tiny buffer while telling it the
  // buffer is huge; reject them here instead.
  if (
    !Number.isInteger(nbytes) ||
    nbytes <= 0 ||
    nbytes >= MAX_ALLOCATION_BYTES
  ) {
    throw new Error(`zfpc: implausible decoded image size: ${nbytes} bytes`);
  }

  // heap must be referenced after creating bufPtr and imagePtr because
  // memory growth can detatch the buffer.
  const bufPtr = (m.exports.malloc as Function)(buffer.byteLength);
  const imagePtr = (m.exports.malloc as Function)(nbytes);

  try {
    // A size that fits in a u32 but exceeds available wasm memory makes malloc
    // return null; writing at that offset would corrupt the start of the heap.
    if (bufPtr === 0 || imagePtr === 0) {
      throw new Error(
        `zfpc: could not allocate ${nbytes} bytes to decode image`,
      );
    }

    const heap = new Uint8Array(
      (m.exports.memory as WebAssembly.Memory).buffer,
    );
    heap.set(buffer, bufPtr);

    const code = (m.exports.zfpc_decompress as Function)(
      bufPtr,
      buffer.byteLength,
      imagePtr,
      nbytes,
    );
    if (code !== 0) {
      throw new Error(`zfpc: Failed to decode image. decoder code: ${code}`);
    }

    // Likewise, we reference memory.buffer instead of heap.buffer
    // because memory growth during decompress could have detached
    // the buffer.
    const image = new Uint8Array(
      (m.exports.memory as WebAssembly.Memory).buffer,
      imagePtr,
      nbytes,
    );
    // copy the array so it can be memory managed by JS
    // and we can free the emscripten buffer
    return image.slice(0);
  } finally {
    (m.exports.free as Function)(bufPtr);
    (m.exports.free as Function)(imagePtr);
  }
}
