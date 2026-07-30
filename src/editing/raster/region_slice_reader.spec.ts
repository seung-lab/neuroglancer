/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type {
  ChunkId,
  LayerId,
  ReadonlyChunkVoxelBuffer,
  Resolution,
  ScaleMetadata,
} from "@zettaai/edit-session";
import {
  ChunkId as ChunkIdCodec,
  layerId,
  Resolution as ResolutionCtor,
} from "@zettaai/edit-session";
import { describe, expect, it } from "vitest";

import {
  readBaselineImageSlice,
  type SliceWindow,
} from "#src/editing/raster/region_slice_reader.js";
import type { ReadChunkAt } from "#src/editing/tool_runtimes/painting_tools.js";

const IMAGE: LayerId = layerId("image");
const RES: Resolution = ResolutionCtor.from([8, 8, 8]);

type Vec3 = readonly [number, number, number];

/** Encode a global voxel's value so a stitched read can be verified per voxel. */
function encode(globalX: number, globalY: number, globalZ: number): number {
  return globalX * 10000 + globalY * 100 + globalZ;
}

function scaleOf(chunkDataSize: Vec3, voxelOffset: Vec3): ScaleMetadata {
  return {
    resolution: RES,
    voxelSizeNm: [8, 8, 8],
    voxelOffset,
    sizeVoxels: [1000, 1000, 1000],
    chunkDataSize,
  };
}

/**
 * A `readChunkAt` that synthesizes each chunk from its coordinate, filling every
 * voxel with `encode(globalX, globalY, globalZ)`. `bigint` produces a `uint64`
 * (`BigUint64Array`) chunk to exercise the widening path.
 */
function fakeReader(
  chunkDataSize: Vec3,
  voxelOffset: Vec3,
  kind: "number" | "bigint" = "number",
): ReadChunkAt {
  const [sizeX, sizeY, sizeZ] = chunkDataSize;
  return (_layerId: LayerId, _resolution: Resolution, chunkId: ChunkId) => {
    const coord = ChunkIdCodec.toCoord(chunkId);
    const length = sizeX * sizeY * sizeZ;
    const view =
      kind === "bigint" ? new BigUint64Array(length) : new Uint32Array(length);
    for (let localZ = 0; localZ < sizeZ; localZ++) {
      for (let localY = 0; localY < sizeY; localY++) {
        for (let localX = 0; localX < sizeX; localX++) {
          const globalX = coord.x * sizeX + voxelOffset[0] + localX;
          const globalY = coord.y * sizeY + voxelOffset[1] + localY;
          const globalZ = coord.z * sizeZ + voxelOffset[2] + localZ;
          const value = encode(globalX, globalY, globalZ);
          const index = localX + sizeX * (localY + sizeY * localZ);
          if (kind === "bigint") {
            (view as BigUint64Array)[index] = BigInt(value);
          } else {
            (view as Uint32Array)[index] = value;
          }
        }
      }
    }
    const buffer: ReadonlyChunkVoxelBuffer = {
      byteLength: view.byteLength,
      asView: () => view,
    };
    return Promise.resolve(buffer);
  };
}

/** The dense slice the reader should produce, computed independently. */
function expectedSlice(window: SliceWindow): number[] {
  const out: number[] = [];
  for (let y = 0; y < window.height; y++) {
    for (let x = 0; x < window.width; x++) {
      out.push(encode(window.originX + x, window.originY + y, window.z));
    }
  }
  return out;
}

describe("readBaselineImageSlice", () => {
  it("reads a window wholly inside one chunk", async () => {
    const chunkSize: Vec3 = [4, 4, 1];
    const offset: Vec3 = [0, 0, 0];
    const window: SliceWindow = {
      originX: 1,
      originY: 1,
      z: 0,
      width: 2,
      height: 2,
    };
    const result = await readBaselineImageSlice(
      fakeReader(chunkSize, offset),
      IMAGE,
      RES,
      scaleOf(chunkSize, offset),
      window,
    );
    expect([...result]).toEqual(expectedSlice(window));
  });

  it("stitches a window spanning four chunks in X and Y", async () => {
    const chunkSize: Vec3 = [2, 2, 1];
    const offset: Vec3 = [0, 0, 0];
    // origin (1,1) size 2x2 → each of the four voxels lands in a distinct chunk.
    const window: SliceWindow = {
      originX: 1,
      originY: 1,
      z: 0,
      width: 2,
      height: 2,
    };
    const result = await readBaselineImageSlice(
      fakeReader(chunkSize, offset),
      IMAGE,
      RES,
      scaleOf(chunkSize, offset),
      window,
    );
    expect([...result]).toEqual(expectedSlice(window));
  });

  it("honors a non-zero voxelOffset (offset-anchored chunk grid)", async () => {
    const chunkSize: Vec3 = [4, 4, 4];
    const offset: Vec3 = [10, 20, 5];
    const window: SliceWindow = {
      originX: 11,
      originY: 21,
      z: 6,
      width: 3,
      height: 3,
    };
    const result = await readBaselineImageSlice(
      fakeReader(chunkSize, offset),
      IMAGE,
      RES,
      scaleOf(chunkSize, offset),
      window,
    );
    expect([...result]).toEqual(expectedSlice(window));
  });

  it("selects the correct slice of a multi-Z chunk", async () => {
    const chunkSize: Vec3 = [4, 4, 4];
    const offset: Vec3 = [0, 0, 0];
    const window: SliceWindow = {
      originX: 0,
      originY: 0,
      z: 3, // localZ = 3 within chunk z=0
      width: 4,
      height: 4,
    };
    const result = await readBaselineImageSlice(
      fakeReader(chunkSize, offset),
      IMAGE,
      RES,
      scaleOf(chunkSize, offset),
      window,
    );
    expect([...result]).toEqual(expectedSlice(window));
  });

  it("widens uint64 (bigint) chunk values to numbers", async () => {
    const chunkSize: Vec3 = [2, 2, 1];
    const offset: Vec3 = [0, 0, 0];
    const window: SliceWindow = {
      originX: 0,
      originY: 0,
      z: 0,
      width: 2,
      height: 2,
    };
    const result = await readBaselineImageSlice(
      fakeReader(chunkSize, offset, "bigint"),
      IMAGE,
      RES,
      scaleOf(chunkSize, offset),
      window,
    );
    expect([...result]).toEqual(expectedSlice(window));
  });
});
