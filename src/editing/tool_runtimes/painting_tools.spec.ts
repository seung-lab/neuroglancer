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
  Edit,
  EditMeta,
  EditSession,
  LayerId,
  LayerMetadata,
  ReadonlyChunkVoxelBuffer,
  Resolution,
} from "@zettaai/edit-session";
import { Resolution as ResolutionCtor, layerId } from "@zettaai/edit-session";
import { describe, it, expect } from "vitest";

import type {
  BrushApplyInput,
  BrushStrokeInput,
  FillInput,
  PaintCompute,
  PaintWriteBatch,
} from "#src/editing/tool_runtimes/paint_types.js";
import {
  ConsumerPaintingTools,
  type PaintingSharedState,
} from "#src/editing/tool_runtimes/painting_tools.js";
import type {
  PointerCancelEvent,
  PointerDownEvent,
  PointerMoveEvent,
  PointerUpEvent,
} from "#src/editing/tool_runtimes/tool_input.js";
import { NO_MODIFIERS } from "#src/editing/tool_runtimes/tool_input.js";
import { EditScope } from "#src/editing/tooling/edit_scope.js";

const RES: Resolution = ResolutionCtor.from([8, 8, 40]);
const TARGET: LayerId = layerId("target");
const CHUNK = 64;

function meta(): LayerMetadata {
  return {
    layerId: TARGET,
    voxelDataType: "uint32",
    channels: 1,
    scales: [
      {
        resolution: RES,
        voxelSizeNm: [8, 8, 40],
        voxelOffset: [0, 0, 0],
        sizeVoxels: [CHUNK, CHUNK, CHUNK],
        chunkDataSize: [CHUNK, CHUNK, CHUNK],
      },
    ],
  };
}

const EMPTY_BATCH: PaintWriteBatch = {
  targetLayerId: TARGET,
  targetResolution: RES,
  chunks: [],
};

interface EditLog {
  readonly metas: EditMeta[];
  records: number;
  discards: number;
  writeRegions: number;
}

/** A fake `Edit` that records lifecycle calls; writes are no-ops (empty batch). */
function makeFakeEdit(log: EditLog, meta: EditMeta): Edit {
  log.metas.push(meta);
  return {
    readChunk: async () =>
      ({
        byteLength: 0,
        asView: () => new Uint32Array(0),
      }) as ReadonlyChunkVoxelBuffer,
    beginWrite: async () => {
      throw new Error("not used in this test");
    },
    commitWrites: () => {},
    writeRegion: async () => {
      log.writeRegions++;
    },
    readRegion: async () => {
      throw new Error("not used");
    },
    sessionVoxelBoundsFor: () => undefined,
    withBatch: <R>(fn: () => R): R => fn(),
    record: () => {
      log.records++;
      return true;
    },
    discard: async () => {
      log.discards++;
    },
  };
}

function fakeSession(log: EditLog): EditSession {
  return {
    beginEdit: (m: EditMeta) => makeFakeEdit(log, m),
  } as unknown as EditSession;
}

interface ComputeCalls {
  applyBrush: BrushApplyInput[];
  applyBrushStroke: BrushStrokeInput[];
  fill3d: FillInput[];
}

function fakeCompute(calls: ComputeCalls): PaintCompute {
  return {
    async applyBrush(input) {
      calls.applyBrush.push(input);
      return EMPTY_BATCH;
    },
    async applyBrushStroke(input) {
      calls.applyBrushStroke.push(input);
      return EMPTY_BATCH;
    },
    async fill3d(input) {
      calls.fill3d.push(input);
      return EMPTY_BATCH;
    },
  };
}

function initialState(): PaintingSharedState {
  return {
    targetLayerId: TARGET,
    targetResolution: RES,
    radius: 3,
    radiusCycle: [1, 3, 5],
    activeValue: 7,
    eraseValue: 0,
    mask: undefined,
  };
}

function setup() {
  const log: EditLog = { metas: [], records: 0, discards: 0, writeRegions: 0 };
  const calls: ComputeCalls = {
    applyBrush: [],
    applyBrushStroke: [],
    fill3d: [],
  };
  const metadataByLayer = new Map<LayerId, LayerMetadata>([[TARGET, meta()]]);
  const tools = new ConsumerPaintingTools({
    scope: new EditScope(fakeSession(log)),
    compute: fakeCompute(calls),
    metadataByLayer,
    readChunkAt: async (
      _l: LayerId,
      _r: Resolution,
      _c: ChunkId,
    ): Promise<ReadonlyChunkVoxelBuffer> => ({
      byteLength: 0,
      asView: () => new Uint32Array(0),
    }),
    initialState: initialState(),
  });
  return { tools, log, calls };
}

const down = (x: number, y: number, z: number): PointerDownEvent => ({
  kind: "pointer-down",
  button: "primary",
  voxelPosition: [x, y, z],
  screenPosition: [0, 0],
  panelHint: undefined,
  at: 0,
  modifiers: NO_MODIFIERS,
});
const move = (
  x: number,
  y: number,
  z: number,
  via?: readonly (readonly [number, number, number])[],
): PointerMoveEvent => ({
  kind: "pointer-move",
  button: "primary",
  voxelPosition: [x, y, z],
  ...(via !== undefined ? { viaVoxelPositions: via } : {}),
  screenPosition: [0, 0],
  panelHint: undefined,
  at: 0,
  modifiers: NO_MODIFIERS,
});
const up = (x: number, y: number, z: number): PointerUpEvent => ({
  kind: "pointer-up",
  button: "primary",
  voxelPosition: [x, y, z],
  at: 0,
  modifiers: NO_MODIFIERS,
});
const cancel = (): PointerCancelEvent => ({
  kind: "pointer-cancel",
  at: 0,
  modifiers: NO_MODIFIERS,
});

describe("ConsumerPaintingTools — stroke lifecycle (TM-315)", () => {
  it("one brush stroke = one beginEdit + one record", async () => {
    const { tools, log, calls } = setup();
    await tools.brush.handleInput(down(10, 10, 10));
    await tools.brush.handleInput(move(12, 10, 10));
    await tools.brush.handleInput(move(15, 12, 10, [[13, 11, 10]]));
    await tools.brush.handleInput(up(15, 12, 10));

    expect(log.metas).toHaveLength(1); // exactly one Edit opened
    expect(log.metas[0]).toMatchObject({
      description: "Brush stroke",
      tag: "painting.brush",
      redo: { kind: "image" },
    });
    expect(log.records).toBe(1);
    expect(log.discards).toBe(0);
    expect(calls.applyBrush).toHaveLength(1);
    expect(calls.applyBrushStroke).toHaveLength(2);
  });

  it("threads coalesced via points into applyBrushStroke", async () => {
    const { tools, calls } = setup();
    await tools.brush.handleInput(down(0, 0, 0));
    await tools.brush.handleInput(
      move(9, 0, 0, [
        [3, 0, 0],
        [6, 0, 0],
      ]),
    );
    await tools.brush.handleInput(up(9, 0, 0));

    expect(calls.applyBrushStroke).toHaveLength(1);
    const stroke = calls.applyBrushStroke[0]!;
    expect(stroke.from).toEqual([0, 0, 0]);
    expect(stroke.to).toEqual([9, 0, 0]);
    expect(stroke.via).toEqual([
      [3, 0, 0],
      [6, 0, 0],
    ]);
  });

  it("pointer-cancel discards the edit (no record)", async () => {
    const { tools, log } = setup();
    await tools.brush.handleInput(down(1, 1, 1));
    await tools.brush.handleInput(move(2, 2, 1));
    await tools.brush.handleInput(cancel());

    expect(log.records).toBe(0);
    expect(log.discards).toBe(1);
  });

  it("onDeactivate mid-stroke rolls back the open edit", async () => {
    const { tools, log } = setup();
    await tools.brush.handleInput(down(1, 1, 1));
    tools.brush.onDeactivate();
    // give the fire-and-forget discard a tick to run
    await Promise.resolve();
    expect(log.records).toBe(0);
    expect(log.discards).toBe(1);
  });

  it("eraser writes the erase value and tags as painting.erase", async () => {
    const { tools, log, calls } = setup();
    await tools.erase.handleInput(down(5, 5, 5));
    await tools.erase.handleInput(up(5, 5, 5));
    expect(log.metas[0]).toMatchObject({ tag: "painting.erase" });
    expect(calls.applyBrush[0]!.value).toBe(0); // eraseValue
  });

  it("eraser omits the shared mask; brush threads it (TM-297)", async () => {
    const { tools, calls } = setup();
    const mask = {
      imageLayerId: layerId("img"),
      imageResolution: RES,
      thresholdLow: 1,
      thresholdHigh: 255,
      minComponentSize: 0,
      binaryClosing: 0,
      filterComponentsFirst: false,
    };
    tools.state.patchState({ mask });
    await tools.brush.handleInput(down(0, 0, 0));
    await tools.brush.handleInput(up(0, 0, 0));
    await tools.erase.handleInput(down(0, 0, 0));
    await tools.erase.handleInput(up(0, 0, 0));
    expect(calls.applyBrush[0]!.mask).toEqual(mask); // brush passes the mask
    expect(calls.applyBrush[1]!.mask).toBeUndefined(); // eraser omits it
  });

  it("fill is one click = one beginEdit + one record", async () => {
    const { tools, log, calls } = setup();
    await tools.fill.handleInput(down(20, 20, 20));
    expect(log.metas).toHaveLength(1);
    expect(log.metas[0]).toMatchObject({ tag: "painting.fill" });
    expect(log.records).toBe(1);
    expect(calls.fill3d).toHaveLength(1);
    expect(calls.fill3d[0]!.value).toBe(7); // activeValue
  });

  it("shared state patch is visible to the next stroke", async () => {
    const { tools, calls } = setup();
    tools.state.patchState({ radius: 5, activeValue: 42 });
    await tools.brush.handleInput(down(0, 0, 0));
    await tools.brush.handleInput(up(0, 0, 0));
    expect(calls.applyBrush[0]!.radius).toBe(5);
    expect(calls.applyBrush[0]!.value).toBe(42);
  });
});
