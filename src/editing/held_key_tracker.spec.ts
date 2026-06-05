/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, describe, it, expect } from "vitest";

import { HeldKeyTracker } from "#src/editing/held_key_tracker.js";

const trackers: HeldKeyTracker[] = [];

function makeTracker(target: EventTarget): HeldKeyTracker {
  const tracker = new HeldKeyTracker(target);
  trackers.push(tracker);
  return tracker;
}

afterEach(() => {
  while (trackers.length > 0) trackers.pop()!.dispose();
});

describe("HeldKeyTracker", () => {
  it("tracks keydown/keyup by lowercased event.code", () => {
    const target = document.createElement("div");
    const tracker = makeTracker(target);

    expect(tracker.isHeld("keyl")).toBe(false);

    target.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyL" }));
    expect(tracker.isHeld("keyl")).toBe(true);
    expect(tracker.isHeld("keyh")).toBe(false);

    target.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyL" }));
    expect(tracker.isHeld("keyl")).toBe(false);
  });

  it("tracks multiple held keys independently", () => {
    const target = document.createElement("div");
    const tracker = makeTracker(target);

    target.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyL" }));
    target.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyH" }));
    expect(tracker.isHeld("keyl")).toBe(true);
    expect(tracker.isHeld("keyh")).toBe(true);

    target.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyL" }));
    expect(tracker.isHeld("keyl")).toBe(false);
    expect(tracker.isHeld("keyh")).toBe(true);
  });

  it("clears all held keys on window blur (missed keyup)", () => {
    const target = document.createElement("div");
    const tracker = makeTracker(target);

    target.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyL" }));
    expect(tracker.isHeld("keyl")).toBe(true);

    window.dispatchEvent(new Event("blur"));
    expect(tracker.isHeld("keyl")).toBe(false);
  });

  it("stops tracking after dispose", () => {
    const target = document.createElement("div");
    const tracker = makeTracker(target);

    tracker.dispose();
    trackers.pop(); // already disposed; avoid double dispose in afterEach

    target.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyL" }));
    expect(tracker.isHeld("keyl")).toBe(false);
  });
});
