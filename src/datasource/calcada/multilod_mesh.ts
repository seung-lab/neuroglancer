/**
 * @license
 * Copyright 2024 Google Inc.
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

// Pure helpers for decoding a calcada per-piece neuroglancer_multilod_draco
// mesh. Kept free of chunk-source imports so the async-computation worker
// bundle can pull the decoder without dragging in the whole backend.

import type { RawMeshData } from "#src/mesh/backend.js";
import { decodeDracoPartitioned } from "#src/mesh/draco/index.js";

interface MultilodLod {
  numFragments: number;
  // Fragment grid positions, stored column-major (all X, then all Y, then all
  // Z). Fragment i is (positions[i], positions[n+i], positions[2n+i]).
  positions: Uint32Array;
  // Cumulative byte offsets into the Draco blob, length numFragments + 1.
  fragOffsets: number[];
}

// A neuroglancer_multilod_draco per-object manifest, parsed from the bytes the
// sharded kvstore returns for a piece id (the Draco blob sits immediately
// before it in the shard). Layout matches igneous/tensorstore output; see the
// `_parse_multilod_manifest` reference in scripts/ts_server.py.
export interface MultilodManifest {
  chunkShape: [number, number, number];
  gridOrigin: [number, number, number];
  numLods: number;
  vertexOffsets: [number, number, number][];
  lods: MultilodLod[];
  totalDracoSize: number;
}

export function parseMultilodManifest(data: Uint8Array): MultilodManifest {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let off = 0;
  const readVec3f = (): [number, number, number] => {
    const v: [number, number, number] = [
      dv.getFloat32(off, true),
      dv.getFloat32(off + 4, true),
      dv.getFloat32(off + 8, true),
    ];
    off += 12;
    return v;
  };
  const chunkShape = readVec3f();
  const gridOrigin = readVec3f();
  const numLods = dv.getUint32(off, true);
  off += 4;
  off += 4 * numLods; // lod_scales (unused: LOD 0 scale is 1)
  const vertexOffsets: [number, number, number][] = [];
  for (let i = 0; i < numLods; i++) vertexOffsets.push(readVec3f());
  const numFragmentsPerLod = new Uint32Array(numLods);
  for (let i = 0; i < numLods; i++) {
    numFragmentsPerLod[i] = dv.getUint32(off, true);
    off += 4;
  }
  const lods: MultilodLod[] = [];
  let globalByteOffset = 0;
  for (let lod = 0; lod < numLods; lod++) {
    const n = numFragmentsPerLod[lod];
    const positions = new Uint32Array(n * 3);
    for (let k = 0; k < n * 3; k++) {
      positions[k] = dv.getUint32(off, true);
      off += 4;
    }
    const fragOffsets: number[] = [globalByteOffset];
    for (let i = 0; i < n; i++) {
      const size = dv.getUint32(off, true);
      off += 4;
      fragOffsets.push(fragOffsets[fragOffsets.length - 1] + size);
    }
    globalByteOffset = fragOffsets[fragOffsets.length - 1];
    lods.push({ numFragments: n, positions, fragOffsets });
  }
  return {
    chunkShape,
    gridOrigin,
    numLods,
    vertexOffsets,
    lods,
    totalDracoSize: globalByteOffset,
  };
}

// Decode every LOD-`targetLod` Draco fragment of a piece, dequantize+position
// into voxel coordinates, and merge into a single mesh. The mesh source's
// transform (voxel→physical) is applied downstream. Returns undefined when the
// piece has no drawable geometry at this LOD. Mirrors ts_server's
// `_decode_merge_encode_lod`, minus the re-encode (we hand raw arrays to the
// renderer instead of round-tripping through Draco).
export async function decodeMultilodPieceMesh(
  manifest: MultilodManifest,
  dracoU8: Uint8Array,
  vertexQuantizationBits: number,
  targetLod: number,
): Promise<RawMeshData | undefined> {
  if (manifest.totalDracoSize === 0 || targetLod >= manifest.numLods) {
    return undefined;
  }
  const lodInfo = manifest.lods[targetLod];
  const n = lodInfo.numFragments;
  if (n === 0) return undefined;
  const qMax = 2 ** vertexQuantizationBits - 1;
  const [csx, csy, csz] = manifest.chunkShape;
  const [gox, goy, goz] = manifest.gridOrigin;
  const [vox, voy, voz] = manifest.vertexOffsets[targetLod];
  const lodScale = 2 ** targetLod;
  const vertGroups: Float32Array[] = [];
  const idxGroups: Uint32Array[] = [];
  let vertexCount = 0;
  for (let i = 0; i < n; i++) {
    const start = lodInfo.fragOffsets[i];
    const end = lodInfo.fragOffsets[i + 1];
    if (end <= start) continue;
    const decoded = await decodeDracoPartitioned(
      dracoU8.subarray(start, end),
      vertexQuantizationBits,
      /*partition=*/ false,
      /*skipDequantization=*/ true,
    );
    const raw = decoded.vertexPositions as Uint32Array; // quantized [0, qMax]
    const indices = decoded.indices as Uint32Array;
    if (indices.length === 0) continue;
    const nv = raw.length / 3;
    const fx = lodInfo.positions[i];
    const fy = lodInfo.positions[n + i];
    const fz = lodInfo.positions[2 * n + i];
    const verts = new Float32Array(nv * 3);
    for (let v = 0; v < nv; v++) {
      verts[v * 3] = gox + vox + csx * lodScale * (fx + raw[v * 3] / qMax);
      verts[v * 3 + 1] =
        goy + voy + csy * lodScale * (fy + raw[v * 3 + 1] / qMax);
      verts[v * 3 + 2] =
        goz + voz + csz * lodScale * (fz + raw[v * 3 + 2] / qMax);
    }
    const shifted = new Uint32Array(indices.length);
    for (let k = 0; k < indices.length; k++) {
      shifted[k] = indices[k] + vertexCount;
    }
    vertexCount += nv;
    vertGroups.push(verts);
    idxGroups.push(shifted);
  }
  if (vertGroups.length === 0) return undefined;
  const totalVerts = vertGroups.reduce((a, b) => a + b.length, 0);
  const totalIdx = idxGroups.reduce((a, b) => a + b.length, 0);
  const vertexPositions = new Float32Array(totalVerts);
  const indices = new Uint32Array(totalIdx);
  let vOff = 0;
  for (const g of vertGroups) {
    vertexPositions.set(g, vOff);
    vOff += g.length;
  }
  let iOff = 0;
  for (const g of idxGroups) {
    indices.set(g, iOff);
    iOff += g.length;
  }
  return { vertexPositions, indices };
}
