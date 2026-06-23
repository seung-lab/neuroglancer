/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { Resolution } from "@zettaai/edit-session";
import { Resolution as ResolutionCtor } from "@zettaai/edit-session";
import { describe, it, expect } from "vitest";

import type { PaintingSharedState } from "#src/editing/tool_runtimes/painting_tools.js";
import {
  parseEditPreferences,
  validateRememberedResolutions,
} from "#src/editing/tooling/edit_preferences.js";
import { serializeTooling } from "#src/editing/tooling/tooling_persist.js";

const RES_HI: Resolution = ResolutionCtor.from([8, 8, 40]);
const RES_LO: Resolution = ResolutionCtor.from([16, 16, 40]);
const RES_GONE: Resolution = ResolutionCtor.from([32, 32, 40]);

/** Round-trip through JSON like the URL hash would. */
function roundTrip(x: unknown): unknown {
  return JSON.parse(JSON.stringify(x));
}

function painting(): PaintingSharedState {
  return {
    targetLayerId: "target" as PaintingSharedState["targetLayerId"],
    targetResolution: RES_HI,
    radius: 9,
    radiusCycle: [1, 3, 5],
    activeValue: 42n,
    eraseValue: 0n,
    mask: undefined,
    fillMode: "3d",
    spacingFraction: 0.1,
  };
}

describe("edit_preferences", () => {
  it("round-trips resolutions + tooling through JSON", () => {
    const prefs = {
      resolutions: { target: [RES_HI], image: [RES_LO] },
      tooling: serializeTooling("painting.brush", painting()),
    };
    const parsed = parseEditPreferences(roundTrip(prefs));
    expect(parsed?.resolutions).toEqual({ target: [RES_HI], image: [RES_LO] });
    expect(parsed?.tooling?.activeToolId).toBe("painting.brush");
    // bigint survives via the tooling type-tag round-trip.
    expect(parsed?.tooling?.painting?.activeValue).toEqual({ t: "b", v: "42" });
  });

  it("returns null for empty / absent input", () => {
    expect(parseEditPreferences(null)).toBeNull();
    expect(parseEditPreferences(undefined)).toBeNull();
    expect(parseEditPreferences({})).toBeNull();
  });

  it("drops a malformed sub-block but keeps the valid one", () => {
    // resolutions is the wrong type → dropped; tooling still parses.
    const parsed = parseEditPreferences({
      resolutions: "nonsense",
      tooling: serializeTooling("painting.brush", painting()),
    });
    expect(parsed?.resolutions).toBeUndefined();
    expect(parsed?.tooling?.activeToolId).toBe("painting.brush");
  });

  it("skips non-string and empty resolution entries", () => {
    const parsed = parseEditPreferences({
      resolutions: {
        target: [RES_HI, 5, null], // non-strings filtered out
        empty: [], // empty list dropped entirely
      },
    });
    expect(parsed?.resolutions).toEqual({ target: [RES_HI] });
  });

  describe("validateRememberedResolutions", () => {
    it("keeps remembered entries still offered, in available order", () => {
      const kept = validateRememberedResolutions(
        [RES_LO, RES_HI],
        [RES_HI, RES_LO], // available order is hi → lo
      );
      expect(kept).toEqual([RES_HI, RES_LO]);
    });

    it("drops stale entries no longer offered", () => {
      const kept = validateRememberedResolutions(
        [RES_GONE, RES_HI],
        [RES_HI, RES_LO],
      );
      expect(kept).toEqual([RES_HI]);
    });

    it("returns undefined (→ keep default) when nothing survives", () => {
      expect(
        validateRememberedResolutions([RES_GONE], [RES_HI, RES_LO]),
      ).toBeUndefined();
    });

    it("returns undefined when nothing was remembered", () => {
      expect(
        validateRememberedResolutions(undefined, [RES_HI, RES_LO]),
      ).toBeUndefined();
    });
  });
});
