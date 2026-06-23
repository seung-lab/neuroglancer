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
import { describe, it, expect, afterEach } from "vitest";

import { paintScheduler } from "#src/editing/tool_runtimes/paint_scheduler_config.js";

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
    sessionVoxelBoundsFor: () => ({
      loX: 0,
      loY: 0,
      loZ: 0,
      hiX: 64,
      hiY: 64,
      hiZ: 64,
    }),
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
  fill: FillInput[];
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
    async fill(input) {
      calls.fill.push(input);
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
    fillMode: "3d",
    // diameter 7 × 0.1 → clamped to a 1-voxel spacing, so canonical stamps land
    // on integer positions along an axis-aligned stroke (keeps assertions clean).
    spacingFraction: 0.1,
  };
}

function setup() {
  const log: EditLog = { metas: [], records: 0, discards: 0, writeRegions: 0 };
  const calls: ComputeCalls = {
    applyBrush: [],
    applyBrushStroke: [],
    fill: [],
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
  // Default scheduling is `latestWins` (TM-317) — bounded + drop-to-latest. Tests
  // that assert the coalesce/geometry resampling feature opt into `coalesce`;
  // restore the default after each.
  afterEach(() => {
    paintScheduler.mode = "latestWins";
    paintScheduler.maxStampSpacing = 0;
  });

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
      redo: { kind: "replay" }, // unmasked brush is deterministic (TM-319)
    });
    expect(log.records).toBe(1);
    expect(log.discards).toBe(0);
    expect(calls.applyBrush).toHaveLength(1);
    // Distance resampling (TM-318) drives one stroke segment per move plus a
    // trailing segment at pointer-up (the finalized tail the head stamp only
    // showed provisionally). The lifecycle invariant — one edit, one record —
    // is what matters here, not the exact segment count.
    expect(calls.applyBrushStroke.length).toBeGreaterThanOrEqual(1);
  });

  it("resamples coalesced samples into evenly-spaced canonical stamps (TM-318)", async () => {
    // This is the coalesce-mode resampling feature: the swept path is rebuilt
    // from the coalesced via-waypoints. latestWins deliberately drops via, so
    // pin coalesce here.
    paintScheduler.mode = "coalesce";
    const { tools, calls } = setup();
    await tools.brush.handleInput(down(0, 0, 0));
    await tools.brush.handleInput(
      move(9, 0, 0, [
        [3, 0, 0],
        [6, 0, 0],
      ]),
    );
    await tools.brush.handleInput(up(9, 0, 0));

    const strokes = calls.applyBrushStroke;
    expect(strokes.length).toBeGreaterThanOrEqual(1);
    // The painted path still spans the gesture exactly end-to-end.
    expect(strokes[0]!.from).toEqual([0, 0, 0]);
    expect(strokes[strokes.length - 1]!.to).toEqual([9, 0, 0]);

    // The raw coalesced waypoints ([3,0,0],[6,0,0]) are NOT forwarded verbatim;
    // they are replaced by canonical stamps resampled at the 1-voxel spacing —
    // on-axis, strictly increasing in x, ~1 apart.
    const via = strokes.flatMap((s) => s.via ?? []);
    expect(via.length).toBeGreaterThan(2);
    for (let i = 0; i < via.length; i++) {
      expect(via[i][1]).toBeCloseTo(0, 6);
      expect(via[i][2]).toBeCloseTo(0, 6);
      expect(via[i][0]).toBeGreaterThan(0);
      expect(via[i][0]).toBeLessThan(9);
      if (i > 0) {
        expect(via[i][0] - via[i - 1][0]).toBeCloseTo(1, 5);
      }
    }
  });

  it("latestWins drops a far move to a single disk at the latest cursor (TM-317)", async () => {
    // Default mode is latestWins; radius 3 → cap = 3. A move whose cursor outran
    // the cap is painted as ONE disk at the latest cursor (from === to), NOT a
    // swept capsule spanning the gap — true drop-to-latest, gap accepted.
    const { tools, calls } = setup();
    await tools.brush.handleInput(down(0, 0, 0));
    await tools.brush.handleInput(move(20, 0, 0)); // gap 20 > cap 3
    await tools.brush.handleInput(up(20, 0, 0));

    const strokes = calls.applyBrushStroke;
    const disk = strokes.find((s) => s.from[0] === 20 && s.to[0] === 20);
    expect(disk).toBeDefined();
    // Nothing connects the dropped span from the origin to the latest cursor.
    const spanning = strokes.find((s) => s.from[0] === 0 && s.to[0] === 20);
    expect(spanning).toBeUndefined();
  });

  it("latestWins keeps a bounded capsule when within the cap (TM-317)", async () => {
    // radius 3 → cap 3; a 2-voxel move stays a smooth capsule (no disk skip).
    const { tools, calls } = setup();
    await tools.brush.handleInput(down(0, 0, 0));
    await tools.brush.handleInput(move(2, 0, 0)); // gap 2 <= cap 3
    await tools.brush.handleInput(up(2, 0, 0));

    const seg = calls.applyBrushStroke.find(
      (s) => s.from[0] === 0 && s.to[0] === 2,
    );
    expect(seg).toBeDefined();
  });

  it("coalesce mode still sweeps the full span (A/B reference, TM-317)", async () => {
    paintScheduler.mode = "coalesce";
    const { tools, calls } = setup();
    await tools.brush.handleInput(down(0, 0, 0));
    await tools.brush.handleInput(move(20, 0, 0));
    await tools.brush.handleInput(up(20, 0, 0));
    // No disk-skip: the swept path reaches the cursor from the origin.
    const strokes = calls.applyBrushStroke;
    expect(strokes[0]!.from).toEqual([0, 0, 0]);
    expect(strokes[strokes.length - 1]!.to).toEqual([20, 0, 0]);
    const diskSkip = strokes.find((s) => s.from[0] === 20 && s.to[0] === 20);
    expect(diskSkip).toBeUndefined();
  });

  it("unmasked brush and eraser use replay redo; masked brush uses image (TM-319)", async () => {
    const { tools, log } = setup();

    await tools.brush.handleInput(down(0, 0, 0));
    await tools.brush.handleInput(up(0, 0, 0));
    expect(log.metas.at(-1)!.redo?.kind).toBe("replay");

    await tools.erase.handleInput(down(1, 1, 1));
    await tools.erase.handleInput(up(1, 1, 1));
    expect(log.metas.at(-1)!.redo?.kind).toBe("replay");

    tools.state.patchState({
      mask: {
        imageLayerId: layerId("img"),
        imageResolution: RES,
        thresholdLow: 1,
        thresholdHigh: 255,
        minComponentSize: 0,
        binaryClosing: 0,
        filterComponentsFirst: false,
      },
    });
    await tools.brush.handleInput(down(2, 2, 2));
    await tools.brush.handleInput(up(2, 2, 2));
    // Masked morphology is not decomposable across batches → keep image redo.
    expect(log.metas.at(-1)!.redo?.kind).toBe("image");
  });

  it("reapply re-issues the exact recorded paint operations (TM-319)", async () => {
    const { tools, log, calls } = setup();
    await tools.brush.handleInput(down(0, 0, 0));
    await tools.brush.handleInput(
      move(9, 0, 0, [
        [3, 0, 0],
        [6, 0, 0],
      ]),
    );
    await tools.brush.handleInput(up(9, 0, 0));

    // Snapshot the live ops (the down stamp + each painted segment).
    const liveStamp = calls.applyBrush.map((b) => b.voxelPosition);
    const liveStrokes = calls.applyBrushStroke.map((s) => ({
      from: s.from,
      to: s.to,
      via: s.via,
    }));
    expect(liveStamp).toHaveLength(1);
    expect(liveStrokes.length).toBeGreaterThanOrEqual(1);

    const redo = log.metas[0]!.redo!;
    expect(redo.kind).toBe("replay");

    // Re-run the replay against a fresh edit and capture what it issues.
    calls.applyBrush.length = 0;
    calls.applyBrushStroke.length = 0;
    const replayEdit: Edit = {
      readChunk: async () =>
        ({
          byteLength: 0,
          asView: () => new Uint32Array(0),
        }) as ReadonlyChunkVoxelBuffer,
      beginWrite: async () => {
        throw new Error("not used");
      },
      commitWrites: () => {},
      writeRegion: async () => {},
      readRegion: async () => {
        throw new Error("not used");
      },
      sessionVoxelBoundsFor: () => ({
        loX: 0,
        loY: 0,
        loZ: 0,
        hiX: 64,
        hiY: 64,
        hiZ: 64,
      }),
      withBatch: <R>(fn: () => R): R => fn(),
      record: () => true,
      discard: async () => {},
    };
    if (redo.kind === "replay") await redo.reapply(replayEdit);

    // Replay issues the identical down stamp and identical stroke segments, in
    // order — the basis for byte-for-byte redo (unmasked writes are absolute).
    expect(calls.applyBrush.map((b) => b.voxelPosition)).toEqual(liveStamp);
    expect(
      calls.applyBrushStroke.map((s) => ({
        from: s.from,
        to: s.to,
        via: s.via,
      })),
    ).toEqual(liveStrokes);
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
    expect(calls.fill).toHaveLength(1);
    expect(calls.fill[0]!.value).toBe(7); // activeValue
    expect(calls.fill[0]!.mode).toBe("3d"); // default mode
    // Bounds threaded from the edit's session voxel bounds (the flood wall).
    expect(calls.fill[0]!.bounds).toMatchObject({ hiX: 64, hiY: 64, hiZ: 64 });
  });

  it("fill passes the shared fillMode through to compute", async () => {
    const { tools, calls } = setup();
    tools.state.patchState({ fillMode: "2d" });
    await tools.fill.handleInput(down(20, 20, 20));
    expect(calls.fill).toHaveLength(1);
    expect(calls.fill[0]!.mode).toBe("2d");
  });

  it("Escape during a running fill aborts the operation (discard, no record)", async () => {
    const log: EditLog = {
      metas: [],
      records: 0,
      discards: 0,
      writeRegions: 0,
    };
    // A fill that never settles on its own — it only rejects when its abort
    // signal fires, mirroring a long flood the user cancels mid-flight.
    const blockingCompute: PaintCompute = {
      async applyBrush() {
        return EMPTY_BATCH;
      },
      async applyBrushStroke() {
        return EMPTY_BATCH;
      },
      fill(input) {
        return new Promise((_resolve, reject) => {
          input.signal?.addEventListener("abort", () =>
            reject(input.signal!.reason),
          );
        });
      },
    };
    const tools = new ConsumerPaintingTools({
      scope: new EditScope(fakeSession(log)),
      compute: blockingCompute,
      metadataByLayer: new Map<LayerId, LayerMetadata>([[TARGET, meta()]]),
      readChunkAt: async () => ({
        byteLength: 0,
        asView: () => new Uint32Array(0),
      }),
      initialState: initialState(),
    });
    // Start the fill but don't await — it stays in flight until canceled.
    const pending = tools.fill.handleInput(down(20, 20, 20));
    // Escape is delivered concurrently (the bridge does not serialize discrete
    // dispatch); it routes to the in-flight fill's abort controller.
    await tools.fill.handleInput({
      kind: "key",
      phase: "down",
      key: "Escape",
      at: 0,
      modifiers: NO_MODIFIERS,
    });
    await pending;
    // The operation was discarded (canceled): no history record landed.
    expect(log.records).toBe(0);
    expect(log.discards).toBe(1);
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
