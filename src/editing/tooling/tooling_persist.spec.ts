/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { LayerId, Resolution } from "@zettaai/edit-session";
import { Resolution as ResolutionCtor, layerId } from "@zettaai/edit-session";
import { describe, it, expect } from "vitest";

import type { PaintingSharedState } from "#src/editing/tool_runtimes/painting_tools.js";
import {
  paintingPatchFromPersist,
  parseTooling,
  serializeTooling,
} from "#src/editing/tooling/tooling_persist.js";

const RES: Resolution = ResolutionCtor.from([8, 8, 40]);
const TARGET: LayerId = layerId("target");
const IMAGE: LayerId = layerId("image");

function state(over: Partial<PaintingSharedState> = {}): PaintingSharedState {
  return {
    targetLayerId: TARGET,
    targetResolution: RES,
    radius: 9,
    radiusCycle: [1, 3, 5],
    activeValue: 42n,
    eraseValue: 0n,
    mask: undefined,
    fillMode: "3d",
    spacingFraction: 0.1,
    ...over,
  };
}

/** Round-trip through JSON like the URL hash would. */
function roundTrip(x: unknown): unknown {
  return JSON.parse(JSON.stringify(x));
}

describe("tooling_persist", () => {
  it("round-trips active tool + painting config (bigint preserved)", () => {
    const serialized = serializeTooling("painting.brush", state());
    const parsed = parseTooling(roundTrip(serialized));
    expect(parsed?.activeToolId).toBe("painting.brush");
    const patch = paintingPatchFromPersist(
      parsed!.painting!,
      new Set([TARGET]),
    );
    expect(patch).toMatchObject({
      targetLayerId: TARGET,
      targetResolution: RES,
      radius: 9,
      activeValue: 42n, // bigint survives JSON round-trip via type tag
      eraseValue: 0n,
      mask: undefined,
    });
  });

  it("round-trips the fill mode", () => {
    const serialized = serializeTooling(
      "painting.fill",
      state({ fillMode: "2d" }),
    );
    const parsed = parseTooling(roundTrip(serialized));
    const patch = paintingPatchFromPersist(
      parsed!.painting!,
      new Set([TARGET]),
    );
    expect(patch!.fillMode).toBe("2d");
  });

  it("defaults the fill mode to 2d for legacy configs lacking the field", () => {
    // Pre-TM-269 persisted painting blocks have no `fillMode`; parsing must
    // succeed and default to 2D (the app default).
    const parsed = parseTooling({
      activeToolId: "painting.fill",
      painting: {
        targetLayerId: "target",
        targetResolution: RES.toString(),
        radius: 9,
        activeValue: { t: "b", v: "42" },
        eraseValue: { t: "n", v: 0 },
        mask: null,
      },
    });
    const patch = paintingPatchFromPersist(
      parsed!.painting!,
      new Set([TARGET]),
    );
    expect(patch!.fillMode).toBe("2d");
  });

  it("preserves a number activeValue as a number (uint8 layer)", () => {
    const serialized = serializeTooling(
      "painting.brush",
      state({ activeValue: 200, eraseValue: 0 }),
    );
    const parsed = parseTooling(roundTrip(serialized));
    const patch = paintingPatchFromPersist(
      parsed!.painting!,
      new Set([TARGET]),
    );
    expect(patch!.activeValue).toBe(200);
    expect(typeof patch!.activeValue).toBe("number");
  });

  it("round-trips a mask config", () => {
    const mask = {
      imageLayerId: IMAGE,
      imageResolution: RES,
      thresholdLow: 10,
      thresholdHigh: 200,
      coverageThreshold: 0.75,
      minComponentSize: 4,
      binaryClosing: 1,
      filterComponentsFirst: true,
    };
    const serialized = serializeTooling("painting.brush", state({ mask }));
    const parsed = parseTooling(roundTrip(serialized));
    const patch = paintingPatchFromPersist(
      parsed!.painting!,
      new Set([TARGET, IMAGE]),
    );
    expect(patch!.mask).toEqual(mask);
  });

  it("defaults coverageThreshold for legacy configs lacking the field", () => {
    // Pre-TM-339 persisted masks have no `coverageThreshold`; parsing must
    // still succeed and fill the default rather than reject the whole config.
    const legacy = {
      imageLayerId: IMAGE,
      imageResolution: RES,
      thresholdLow: 10,
      thresholdHigh: 200,
      minComponentSize: 4,
      binaryClosing: 1,
      filterComponentsFirst: true,
    };
    const serialized = serializeTooling(
      "painting.brush",
      state({ mask: legacy }),
    );
    const parsed = parseTooling(roundTrip(serialized));
    const patch = paintingPatchFromPersist(
      parsed!.painting!,
      new Set([TARGET, IMAGE]),
    );
    expect(patch!.mask).toEqual({ ...legacy, coverageThreshold: 0.5 });
  });

  it("cursor mode serializes activeToolId null", () => {
    const parsed = parseTooling(
      roundTrip(serializeTooling(undefined, state())),
    );
    expect(parsed?.activeToolId).toBeNull();
  });

  it("drops a stale target binding (target layer missing)", () => {
    const serialized = serializeTooling("painting.brush", state());
    const parsed = parseTooling(roundTrip(serialized));
    // Session no longer has the target layer → patch refused, keep defaults.
    expect(
      paintingPatchFromPersist(parsed!.painting!, new Set(["other"])),
    ).toBeUndefined();
  });

  it("drops a mask referencing a missing layer but keeps the rest", () => {
    const mask = {
      imageLayerId: IMAGE,
      imageResolution: RES,
      thresholdLow: 10,
      thresholdHigh: 200,
      minComponentSize: 4,
      binaryClosing: 1,
      filterComponentsFirst: true,
    };
    const serialized = serializeTooling("painting.brush", state({ mask }));
    const parsed = parseTooling(roundTrip(serialized));
    // IMAGE layer gone from the session → mask dropped, target still applies.
    const patch = paintingPatchFromPersist(
      parsed!.painting!,
      new Set([TARGET]),
    );
    expect(patch).toBeDefined();
    expect(patch!.mask).toBeUndefined();
  });

  it("round-trips per-user keybind overrides", () => {
    const serialized = serializeTooling("painting.brush", state(), {
      brush: ["control+keyq"],
      undo: ["control+keyu", "keyz"],
    });
    const parsed = parseTooling(roundTrip(serialized));
    expect(parsed?.keybinds).toEqual({
      brush: ["control+keyq"],
      undo: ["control+keyu", "keyz"],
    });
  });

  it("omits keybinds when there are no overrides", () => {
    const serialized = serializeTooling("painting.brush", state(), {});
    expect("keybinds" in serialized).toBe(false);
    const parsed = parseTooling(roundTrip(serialized));
    expect(parsed?.keybinds).toBeUndefined();
  });

  it("coerces a single-string keybind value to a one-element array", () => {
    // Hand-authored / legacy state may store a bare string instead of a list.
    const parsed = parseTooling({
      activeToolId: null,
      keybinds: { brush: "control+keyq" },
    });
    expect(parsed?.keybinds).toEqual({ brush: ["control+keyq"] });
  });

  it("skips malformed keybind entries but keeps the valid ones", () => {
    const parsed = parseTooling({
      activeToolId: null,
      keybinds: {
        brush: ["control+keyq"],
        bad: 42,
        empty: [],
        mixed: ["keya", 7, "keyb"],
      },
    });
    expect(parsed?.keybinds).toEqual({
      brush: ["control+keyq"],
      mixed: ["keya", "keyb"],
    });
  });

  it("ignores a non-object keybinds field without dropping the block", () => {
    const parsed = parseTooling({ activeToolId: null, keybinds: 42 });
    expect(parsed).toEqual({ activeToolId: null });
  });

  it("is tolerant of malformed input", () => {
    expect(parseTooling(undefined)).toBeUndefined();
    expect(parseTooling(null)).toBeUndefined();
    expect(parseTooling(42)).toBeUndefined();
    expect(parseTooling({})).toBeUndefined(); // no activeToolId
    // activeToolId present but painting malformed → whole block dropped.
    expect(
      parseTooling({
        activeToolId: "painting.brush",
        painting: { radius: "x" },
      }),
    ).toBeUndefined();
    // activeToolId without painting is valid (cursor / not-yet-configured).
    expect(parseTooling({ activeToolId: null })).toEqual({
      activeToolId: null,
    });
  });
});
