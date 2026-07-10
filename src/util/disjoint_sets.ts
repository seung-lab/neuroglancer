/**
 * @license
 * Copyright 2016 Google Inc.
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

import { VisibleSegmentEquivalencePolicy } from "#src/segmentation_graph/segment_id.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { WatchableValue } from "#src/trackable_value.js";
import { bigintCompare } from "#src/util/bigint.js";

class Entry {
  rank: number = 0;
  parent: Entry = this;
  next: Entry = this;
  prev: Entry = this;
  min: bigint;

  constructor(public value: bigint) {
    this.min = value;
  }
}

function findRepresentative(v: Entry): Entry {
  // First pass: find the root, which will be stored in ancestor.
  let old = v;
  let ancestor = v.parent;
  while (ancestor !== v) {
    v = ancestor;
    ancestor = v.parent;
  }
  // Second pass: set all of the parent pointers along the path from the
  // original element `old' to refer directly to the root `ancestor'.
  v = old.parent;
  while (ancestor !== v) {
    old.parent = ancestor;
    old = v;
    v = old.parent;
  }
  return ancestor;
}

function linkUnequalSetRepresentatives(i: Entry, j: Entry): Entry {
  const iRank = i.rank;
  const jRank = j.rank;
  if (iRank > jRank) {
    j.parent = i;
    return i;
  }

  i.parent = j;
  if (iRank === jRank) {
    j.rank = jRank + 1;
  }
  return j;
}

function spliceCircularLists(i: Entry, j: Entry) {
  const iPrev = i.prev;
  const jPrev = j.prev;

  // Connect end of i to beginning of j.
  j.prev = iPrev;
  iPrev.next = j;

  // Connect end of j to beginning of i.
  i.prev = jPrev;
  jPrev.next = i;
}

function* setElementIterator(i: Entry): Generator<bigint> {
  let j = i;
  do {
    yield j.value;
    j = j.next;
  } while (j !== i);
}

function isRootElement(v: Entry) {
  return v.parent === v;
}

/**
 * Represents a collection of disjoint sets of uint64 values.
 *
 * Supports merging sets, retrieving the minimum uint64 value contained in a set (the representative
 * value), and iterating over the elements contained in a set.
 */
export class DisjointUint64Sets {
  private map = new Map<bigint, Entry>();
  // Tracks pieces whose hashMap representation needs (re-)insertion since the
  // last consumeDirty(). null = a full rebuild is required (an operation
  // changed the representative of pre-existing pieces, which we can't
  // efficiently express as a delta because HashMapUint64.set is insert-only).
  private dirty: bigint[] | null = [];
  // Existing pieces whose representative was reassigned by applyDelta (a value
  // change, not an insert). Applied to the hash map via HashMapUint64.update().
  private valueDirty: bigint[] = [];
  // Roots retired by retireRoot (all their pieces re-pointed elsewhere).
  // Applied to the hash map via HashMapUint64.delete().
  private deletedDirty: bigint[] = [];
  private dirtyTrackingEnabled = true;
  visibleSegmentEquivalencePolicy: WatchableValueInterface<VisibleSegmentEquivalencePolicy> =
    new WatchableValue<VisibleSegmentEquivalencePolicy>(
      VisibleSegmentEquivalencePolicy.MIN_REPRESENTATIVE,
    );
  generation = 0;

  has(x: bigint): boolean {
    return this.map.has(x);
  }

  get(x: bigint): bigint {
    const entry = this.map.get(x);
    if (entry === undefined) {
      return x;
    }
    return findRepresentative(entry).min;
  }

  isMinElement(x: bigint) {
    return x === this.get(x);
  }

  private makeSet(x: bigint): Entry {
    const { map } = this;
    let entry = map.get(x);
    if (entry === undefined) {
      entry = new Entry(x);
      map.set(x, entry);
      if (this.dirtyTrackingEnabled && this.dirty !== null) {
        this.dirty.push(x);
      }
      return entry;
    }
    return findRepresentative(entry);
  }

  /**
   * Returns and resets the list of pieces added since the last consume.
   * Returns null if a full rebuild is required (representative of pre-existing
   * pieces changed, set was cleared, etc.); the caller must re-iterate
   * `mappings()` instead.
   */
  consumeDirty(): bigint[] | null {
    const d = this.dirty;
    this.dirty = [];
    return d;
  }

  /**
   * Stops accumulating the dirty list. Called when hash-map maintenance
   * moves to the worker's copy of this set (table mirroring): nothing on
   * this side consumes the list anymore, and without a consumer it would
   * grow unboundedly.
   */
  disableDirtyTracking() {
    this.dirtyTrackingEnabled = false;
    this.dirty = [];
    this.valueDirty = [];
    this.deletedDirty = [];
  }

  /**
   * Apply an interactive merge/split delta: retire the old roots' sets and
   * re-partition their pieces under the new roots. Uses deleteSet + link, NOT
   * link alone — union-find link can only merge sets, never split one, so a
   * split must first deleteSet the old root (unlinking every piece) and only
   * then re-link each component into its own new root. deleteSet also cleanly
   * removes the old roots (no dangling circular-list references).
   *
   * Records the precise per-key hash-map operations — new roots to insert,
   * re-pointed pieces to update, retired roots to delete — instead of letting
   * deleteSet/link nullify dirty into a full ~1-2M-entry rebuild.
   */
  applyDelta(
    groups: { root: bigint; pieces: bigint[] }[],
    retire: bigint[],
  ): void {
    // Snapshot pending inserts before deleteSet nulls the dirty channel.
    const savedDirty = this.dirty;
    for (const root of retire) {
      this.deleteSet(root);
    }
    for (const g of groups) {
      for (const piece of g.pieces) {
        this.link(g.root, piece);
      }
    }
    if (!this.dirtyTrackingEnabled) {
      // This side does not maintain the hash map (the worker owns it).
      return;
    }
    if (savedDirty === null) {
      // A full rebuild was already pending; it covers this delta.
      return;
    }
    // deleteSet nulled dirty; restore the pre-delta inserts and record the exact
    // operations. New roots are new keys (insert); re-pointed pieces still exist
    // in the hash map with their old value (update); retired roots are gone
    // (delete).
    this.dirty = savedDirty;
    for (const g of groups) {
      this.dirty.push(g.root);
      for (const piece of g.pieces) {
        this.valueDirty.push(piece);
      }
    }
    for (const root of retire) {
      this.deletedDirty.push(root);
    }
  }

  consumeValueDirty(): bigint[] {
    const d = this.valueDirty;
    this.valueDirty = [];
    return d;
  }

  consumeDeletedDirty(): bigint[] {
    const d = this.deletedDirty;
    this.deletedDirty = [];
    return d;
  }

  /**
   * Union the sets containing `a` and `b`.
   * @returns `false` if `a` and `b` are already in the same set, otherwise `true`.
   */
  link(a: bigint, b: bigint): boolean {
    const aWasNew = !this.map.has(a);
    const bWasNew = !this.map.has(b);
    const aEntry = this.makeSet(a);
    const bEntry = this.makeSet(b);
    if (aEntry === bEntry) {
      return false;
    }
    this.generation++;
    const aOldMin = aEntry.min;
    const bOldMin = bEntry.min;
    const newNode = linkUnequalSetRepresentatives(aEntry, bEntry);
    spliceCircularLists(aEntry, bEntry);
    const isMax =
      (this.visibleSegmentEquivalencePolicy.value &
        VisibleSegmentEquivalencePolicy.MAX_REPRESENTATIVE) !==
      0;
    const newMin = aOldMin < bOldMin === isMax ? bOldMin : aOldMin;
    newNode.min = newMin;
    // If the representative changed for a pre-existing multi-element set,
    // every member of that set needs its hashMap mapping updated. We can't
    // express that incrementally with insert-only HashMapUint64.set, so fall
    // back to a full rebuild on the next consume. The chunk-LUT path
    // (`link(root_id, new_piece)`) never hits this: with MAX_REPRESENTATIVE
    // and calcada's layer-byte stamping the root_id is always the max, so
    // aOldMin === newMin for the existing root side.
    if (this.dirty !== null) {
      if (!aWasNew && aOldMin !== newMin) this.dirty = null;
      else if (!bWasNew && bOldMin !== newMin) this.dirty = null;
    }
    return true;
  }

  linkAll(ids: bigint[]) {
    for (let i = 1, length = ids.length; i < length; ++i) {
      this.link(ids[0], ids[i]);
    }
  }

  /**
   * Unlinks all members of the specified set.
   */
  deleteSet(x: bigint) {
    const { map } = this;
    let changed = false;
    for (const y of this.setElements(x)) {
      map.delete(y);
      changed = true;
    }
    if (changed) {
      ++this.generation;
      this.dirty = null;
    }
    return changed;
  }

  *setElements(a: bigint): IterableIterator<bigint> {
    const entry = this.map.get(a);
    if (entry === undefined) {
      yield a;
    } else {
      yield* setElementIterator(entry);
    }
  }

  clear() {
    const { map } = this;
    if (map.size === 0) {
      return false;
    }
    ++this.generation;
    map.clear();
    this.dirty = null;
    return true;
  }

  get size() {
    return this.map.size;
  }

  *mappings(): IterableIterator<[bigint, bigint]> {
    for (const entry of this.map.values()) {
      yield [entry.value, findRepresentative(entry).min];
    }
  }

  *roots(): IterableIterator<bigint> {
    for (const entry of this.map.values()) {
      if (isRootElement(entry)) {
        yield entry.value;
      }
    }
  }

  [Symbol.iterator](): IterableIterator<[bigint, bigint]> {
    return this.mappings();
  }

  /**
   * Returns an array of arrays of strings, where the arrays contained in the outer array correspond
   * to the disjoint sets, and the strings are the base-10 string representations of the members of
   * each set.  The members are sorted in numerical order, and the sets are sorted in numerical
   * order of their smallest elements.
   */
  toJSON(): string[][] {
    const sets = new Array<bigint[]>();
    for (const entry of this.map.values()) {
      if (isRootElement(entry)) {
        const members = new Array<bigint>();
        for (const member of setElementIterator(entry)) {
          members.push(member);
        }
        members.sort(bigintCompare);
        sets.push(members);
      }
    }
    sets.sort((a, b) => bigintCompare(a[0], b[0]));
    return sets.map((set) => set.map((element) => element.toString()));
  }
}
