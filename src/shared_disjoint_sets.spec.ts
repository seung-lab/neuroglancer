/**
 * @license
 * Copyright 2024 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect } from "vitest";
import { HashMapUint64 } from "#src/gpu_hash/hash_table.js";
import { VisibleSegmentEquivalencePolicy } from "#src/segmentation_graph/segment_id.js";
import { updateHashMapFromDisjointSets } from "#src/shared_disjoint_sets.js";
import { WatchableValue } from "#src/trackable_value.js";
import { DisjointUint64Sets } from "#src/util/disjoint_sets.js";

function maxPolicySet() {
  const s = new DisjointUint64Sets();
  s.visibleSegmentEquivalencePolicy = new WatchableValue(
    VisibleSegmentEquivalencePolicy.MAX_REPRESENTATIVE,
  );
  return s;
}

describe("updateHashMapFromDisjointSets incremental value-dirty", () => {
  it("matches a full rebuild after a merge delta + root retire", () => {
    const s = maxPolicySet();
    s.link(10n, 1n);
    s.link(10n, 2n);
    s.link(11n, 3n);
    const m = new HashMapUint64();
    updateHashMapFromDisjointSets(m, s); // initial build via inserts
    expect(m.get(1n)).toBe(10n);
    expect(m.get(3n)).toBe(11n);

    s.applyDelta([{ root: 20n, pieces: [1n, 2n, 3n] }], [10n, 11n]); // merge 10 & 11 into 20
    updateHashMapFromDisjointSets(m, s); // incremental path

    for (const [piece, rep] of s.mappings()) {
      expect(m.get(piece)).toBe(rep);
    }
    expect(m.get(1n)).toBe(20n);
    expect(m.get(2n)).toBe(20n);
    expect(m.get(3n)).toBe(20n);
    expect(m.get(10n)).toBeUndefined();
    expect(m.get(11n)).toBeUndefined();
  });

  it("matches a full rebuild after a split delta", () => {
    const s = maxPolicySet();
    s.link(10n, 1n);
    s.link(10n, 2n);
    s.link(10n, 3n);
    s.link(10n, 4n);
    const m = new HashMapUint64();
    updateHashMapFromDisjointSets(m, s);
    s.applyDelta(
      [
        { root: 20n, pieces: [1n, 2n] },
        { root: 21n, pieces: [3n, 4n] },
      ],
      [10n],
    );
    updateHashMapFromDisjointSets(m, s);
    for (const [piece, rep] of s.mappings()) {
      expect(m.get(piece)).toBe(rep);
    }
    expect(m.get(1n)).toBe(20n);
    expect(m.get(2n)).toBe(20n);
    expect(m.get(3n)).toBe(21n);
    expect(m.get(4n)).toBe(21n);
    expect(m.get(10n)).toBeUndefined();
  });

  it("keeps a retired key that is also re-linked (no delete-after-update desync)", () => {
    const s = maxPolicySet();
    s.link(10n, 1n);
    const m = new HashMapUint64();
    updateHashMapFromDisjointSets(m, s); // m: 10->10, 1->10
    // Retire 10 but also re-link it as a piece under new root 20.
    s.applyDelta([{ root: 20n, pieces: [1n, 10n] }], [10n]);
    updateHashMapFromDisjointSets(m, s);
    // 10 was retired AND re-linked -> still in the set, must NOT be deleted.
    expect(s.has(10n)).toBe(true);
    expect(m.get(10n)).toBe(20n);
    expect(m.get(1n)).toBe(20n);
    for (const [piece, rep] of s.mappings()) {
      expect(m.get(piece)).toBe(rep);
    }
  });
});
