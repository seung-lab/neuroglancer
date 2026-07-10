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

import type { HashTableSnapshot } from "#src/gpu_hash/hash_table.js";
import { HashMapUint64 } from "#src/gpu_hash/hash_table.js";
import type { VisibleSegmentEquivalencePolicy } from "#src/segmentation_graph/segment_id.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { DisjointUint64Sets } from "#src/util/disjoint_sets.js";
import { parseArray, parseUint64 } from "#src/util/json.js";
import { NullarySignal } from "#src/util/signal.js";
import type { RPC } from "#src/worker_rpc.js";
import {
  registerRPC,
  registerSharedObject,
  SharedObjectCounterpart,
} from "#src/worker_rpc.js";

const RPC_TYPE_ID = "DisjointUint64Sets";
const ADD_METHOD_ID = "DisjointUint64Sets.add";
const CLEAR_METHOD_ID = "DisjointUint64Sets.clear";
const HIGH_BIT_REPRESENTATIVE_CHANGED_ID =
  "DisjointUint64Sets.highBitRepresentativeChanged";
const DELETE_SET_METHOD_ID = "DisjointUint64Sets.deleteSet";
const APPLY_DELTA_METHOD_ID = "DisjointUint64Sets.applyDelta";
const ENABLE_TABLE_MIRROR_ID = "DisjointUint64Sets.enableTableMirror";
const TABLE_MIRROR_SNAPSHOT_ID = "DisjointUint64Sets.tableMirrorSnapshot";
const TABLE_MIRROR_ACK_ID = "DisjointUint64Sets.tableMirrorAck";

/**
 * Interval between piece→representative table snapshots shipped from the
 * worker once table mirroring is enabled. Deliberately slightly above the
 * frontend's `EQUIVALENCES_BATCH_INTERVAL_MS` (200ms) consume cadence so at
 * most one snapshot is ever pending; more frequent shipping would only add
 * copy/transfer traffic without visible benefit.
 */
const TABLE_MIRROR_INTERVAL_MS = 250;

/**
 * Applies the pending delta of `disjointSets` to a piece→representative
 * HashMapUint64. consumeDirty() returns null only when the disjoint set was
 * cleared/deleted or a merge changed the representative of pre-existing
 * pieces — in those cases fall back to a full rebuild because
 * HashMapUint64.set is insert-only and can't express updates. Otherwise
 * every dirty piece is brand new (never previously inserted), so .set() is
 * guaranteed to take the insert branch. Reserving up front replaces the
 * ladder of doubling rehashes (each one re-inserts every existing entry)
 * with at most one.
 */
// Dev safety net: when true, every incremental patch is verified against the
// disjoint set's full mapping and throws on any desync. O(size) — leave OFF in
// production; flip on locally to catch delta bugs early.
const DEBUG_EQUIV = false;

export function updateHashMapFromDisjointSets(
  hashMap: HashMapUint64,
  disjointSets: DisjointUint64Sets,
  // calcada only: gate the reserve on real overflow (see the reserve block).
  // Left false, graphene/local/multicut keep the original unconditional reserve.
  largeEquivalencesExpected = false,
) {
  const dirty = disjointSets.consumeDirty();
  const valueDirty = disjointSets.consumeValueDirty();
  const deletedDirty = disjointSets.consumeDeletedDirty();
  if (dirty === null) {
    // Full rebuild (unchanged path). It already reflects any pending
    // value/deleted deltas, which were drained above.
    hashMap.clear();
    hashMap.reserve(Math.ceil(disjointSets.size / hashMap.loadFactor));
    for (const [pieceId, representativeId] of disjointSets.mappings()) {
      hashMap.set(pieceId, representativeId);
    }
    return;
  }
  if (dirty.length > 0) {
    if (largeEquivalencesExpected) {
      // Only reserve when the batch would actually overflow current capacity.
      // reserve() rehashes the WHOLE table (O(size)) via grow(); its own guard
      // compares a tableSize-scale argument against capacity
      // (=tableSize*loadFactor), so it re-fires this rehash every tick while
      // load sits in [loadFactor², loadFactor) even though no growth is needed.
      // At calcada's millions of entries that is a ~1s rehash per tick during
      // chunk loading. Gate on real overflow so a rehash happens at most once
      // per genuine doubling.
      const projectedSize = hashMap.size + dirty.length;
      if (projectedSize > hashMap.capacity) {
        hashMap.reserve(Math.ceil(projectedSize / hashMap.loadFactor));
      }
    } else {
      hashMap.reserve(
        Math.ceil((hashMap.size + dirty.length) / hashMap.loadFactor),
      );
    }
    for (const pieceId of dirty) {
      hashMap.set(pieceId, disjointSets.get(pieceId));
    }
  }
  // Existing pieces re-pointed by applyDelta: overwrite in place. If a piece is
  // somehow not yet present, insert it.
  for (const pieceId of valueDirty) {
    const rep = disjointSets.get(pieceId);
    if (!hashMap.update(pieceId, rep)) {
      hashMap.set(pieceId, rep);
    }
  }
  // Retired roots: drop their self-entry — but only if the key really left the
  // disjoint set. A key that was retired AND re-linked (so it also appears in
  // valueDirty) is still present and must keep its updated mapping, not be
  // deleted (which would silently desync the hash map from disjointSets).
  for (const key of deletedDirty) {
    if (!disjointSets.has(key)) {
      hashMap.delete(key);
    }
  }
  if (DEBUG_EQUIV) {
    for (const [piece, rep] of disjointSets.mappings()) {
      if (hashMap.get(piece) !== rep) {
        throw new Error(
          `equiv desync: ${piece} -> ${hashMap.get(piece)} != ${rep}`,
        );
      }
    }
  }
}

@registerSharedObject(RPC_TYPE_ID)
export class SharedDisjointUint64Sets
  extends SharedObjectCounterpart
  implements WatchableValueInterface<SharedDisjointUint64Sets>
{
  disjointSets = new DisjointUint64Sets();
  changed = new NullarySignal();

  /**
   * For compatibility with `WatchableValueInterface`.
   */
  get value() {
    return this;
  }

  static makeWithCounterpart(
    rpc: RPC,
    highBitRepresentative: WatchableValueInterface<VisibleSegmentEquivalencePolicy>,
  ) {
    const obj = new SharedDisjointUint64Sets();
    obj.disjointSets.visibleSegmentEquivalencePolicy = highBitRepresentative;
    obj.registerDisposer(
      highBitRepresentative.changed.add(() => {
        updateHighBitRepresentative(obj);
      }),
    );
    obj.initializeCounterpart(rpc);
    if (highBitRepresentative.value) {
      updateHighBitRepresentative(obj);
    }
    return obj;
  }

  link(a: bigint, b: bigint) {
    if (this.disjointSets.link(a, b)) {
      const { rpc } = this;
      if (rpc) {
        rpc.invoke(ADD_METHOD_ID, {
          id: this.rpcId,
          a: a,
          b: b,
        });
      }
      this.changed.dispatch();
      return true;
    }
    return false;
  }

  linkAll(ids: bigint[]) {
    for (let i = 1, length = ids.length; i < length; ++i) {
      this.link(ids[0], ids[i]);
    }
  }

  has(x: bigint): boolean {
    return this.disjointSets.has(x);
  }

  get(x: bigint): bigint {
    return this.disjointSets.get(x);
  }

  clear() {
    if (this.disjointSets.clear()) {
      const { rpc } = this;
      if (rpc) {
        rpc.invoke(CLEAR_METHOD_ID, { id: this.rpcId });
      }
      this.changed.dispatch();
    }
  }

  setElements(a: bigint) {
    return this.disjointSets.setElements(a);
  }

  deleteSet(x: bigint) {
    if (this.disjointSets.deleteSet(x)) {
      const { rpc } = this;
      if (rpc) {
        rpc.invoke(DELETE_SET_METHOD_ID, {
          id: this.rpcId,
          x,
        });
      }
      this.changed.dispatch();
    }
  }

  /**
   * Interactive merge/split delta: re-point each group's pieces under its root
   * and retire the roots in `retire`. When `largeEquivalencesExpected` is off
   * (graphene, local layers) this is byte-identical to the legacy
   * deleteSet+link path. When on (calcada) it records value-dirty deltas so the
   * hash table is patched in place — not rebuilt from scratch — and mirrors the
   * delta to the worker.
   */
  applyEquivalenceDelta(
    groups: { root: bigint; pieces: bigint[] }[],
    retire: bigint[],
  ): void {
    if (!this.largeEquivalencesExpected) {
      for (const r of retire) this.deleteSet(r);
      for (const g of groups) {
        for (const p of g.pieces) this.link(g.root, p);
      }
      return;
    }
    this.disjointSets.applyDelta(groups, retire);
    const { rpc } = this;
    if (rpc) {
      rpc.invoke(APPLY_DELTA_METHOD_ID, { id: this.rpcId, groups, retire });
    }
    this.changed.dispatch();
  }

  /**
   * Worker side: ship a mirror snapshot immediately instead of waiting for the
   * next interval tick. Called after an interactive delta so the frontend's 2D
   * recolour lands within a round-trip, not up to TABLE_MIRROR_INTERVAL_MS.
   * No-op on the frontend (it does not maintain the mirror).
   */
  flushTableMirror() {
    if (this.tableMirror !== undefined) {
      this.tableMirrorTick();
    }
  }

  get size() {
    return this.disjointSets.size;
  }

  /**
   * Datasource opt-in: set when this equivalences set is expected to reach
   * chunk-LUT scale (millions of pieces — calcada, where every chunk
   * carries a piece→root LUT). `EquivalencesHashMap.update()` then
   * escalates to interval batching and worker-side table mirroring. Left
   * off (the default) table maintenance keeps the original
   * consume-on-every-change behavior — graphene and local layers are
   * untouched by these optimizations.
   */
  largeEquivalencesExpected = false;

  /**
   * Frontend side: set when a large equivalences map should be maintained on
   * the worker instead of the main thread. Once requested, the worker ships
   * `HashTableSnapshot`s and the frontend stops doing O(size) insert/rehash
   * work (see `EquivalencesHashMap.update()`).
   */
  tableMirrorRequested = false;
  private latestTableMirrorSnapshot: HashTableSnapshot | undefined;
  private latestTableMirrorSnapshotAcked = false;

  // Worker side: mirror table + shipping loop state.
  private tableMirror: HashMapUint64 | undefined;
  private tableMirrorTimer: ReturnType<typeof setInterval> | undefined;
  private tableMirrorGeneration = -1;
  // Ships only after the frontend consumed the previous snapshot (set back
  // to true by the ack RPC handler) — a hidden tab never draws, and copying
  // tens of MB per tick at it would be wasted.
  tableMirrorAcked = true;

  /** Frontend side: ask the worker to take over table maintenance. */
  requestTableMirror() {
    if (this.tableMirrorRequested) return;
    this.tableMirrorRequested = true;
    // Nothing on this side consumes the dirty list once the worker owns the
    // table; without a consumer it would grow unboundedly.
    this.disjointSets.disableDirtyTracking();
    this.rpc?.invoke(ENABLE_TABLE_MIRROR_ID, { id: this.rpcId });
  }

  /**
   * Frontend side: the latest worker-built snapshot. Kept until replaced so
   * that EVERY consumer bound to this group adopts it — linked segmentation
   * layers share one instance across several render layers. Consumers adopt
   * the same table by reference, which is safe: in mirror mode nothing
   * mutates it outside the transient munge during GPU upload.
   */
  get tableMirrorSnapshot(): HashTableSnapshot | undefined {
    return this.latestTableMirrorSnapshot;
  }

  /**
   * Frontend side: called by the first consumer that adopts the current
   * snapshot (subsequent consumers no-op). Acking on adoption rather than
   * receipt keeps the worker from shipping to a tab that never draws.
   */
  ackTableMirrorSnapshot() {
    if (this.latestTableMirrorSnapshotAcked) return;
    this.latestTableMirrorSnapshotAcked = true;
    this.rpc?.invoke(TABLE_MIRROR_ACK_ID, { id: this.rpcId });
  }

  /** Frontend side: called by the snapshot RPC handler. */
  receiveTableMirrorSnapshot(snapshot: HashTableSnapshot) {
    this.latestTableMirrorSnapshot = snapshot;
    this.latestTableMirrorSnapshotAcked = false;
    this.changed.dispatch();
  }

  /** Worker side: start maintaining and shipping the mirror table. */
  startTableMirror() {
    if (this.tableMirror !== undefined) return;
    this.tableMirror = new HashMapUint64();
    this.tableMirrorTick();
    this.tableMirrorTimer = setInterval(
      () => this.tableMirrorTick(),
      TABLE_MIRROR_INTERVAL_MS,
    );
  }

  private tableMirrorTick() {
    const { disjointSets } = this;
    if (!this.tableMirrorAcked) return;
    if (this.tableMirrorGeneration === disjointSets.generation) return;
    this.tableMirrorGeneration = disjointSets.generation;
    const mirror = this.tableMirror!;
    // The worker-side dirty list has accumulated since object creation
    // (nothing consumed it before mirroring started), so the first
    // incremental pass naturally covers the full backlog. The worker mirror
    // only ever runs for calcada, so the large-equivalences reserve gate
    // always applies here.
    updateHashMapFromDisjointSets(mirror, disjointSets, true);
    this.tableMirrorAcked = false;
    const snapshot = mirror.takeSnapshot();
    this.rpc?.invoke(TABLE_MIRROR_SNAPSHOT_ID, { id: this.rpcId, snapshot }, [
      snapshot.table.buffer,
    ]);
  }

  disposed() {
    if (this.tableMirrorTimer !== undefined) {
      clearInterval(this.tableMirrorTimer);
      this.tableMirrorTimer = undefined;
    }
    super.disposed();
  }

  toJSON() {
    return this.disjointSets.toJSON();
  }

  /**
   * Restores the state from a JSON representation.
   */
  restoreState(obj: any) {
    if (obj !== undefined) {
      parseArray(obj, (z) => {
        let prev: bigint | undefined;
        parseArray(z, (s) => {
          const cur = parseUint64(s);
          if (prev !== undefined) {
            this.link(prev, cur);
          }
          prev = cur;
        });
      });
    }
  }

  assignFrom(other: SharedDisjointUint64Sets | DisjointUint64Sets) {
    this.clear();
    if (other instanceof SharedDisjointUint64Sets) {
      other = other.disjointSets;
    }
    for (const [a, b] of other) {
      this.link(a, b);
    }
  }
}

registerRPC(ADD_METHOD_ID, function (x) {
  const obj = <SharedDisjointUint64Sets>this.get(x.id);
  if (obj.disjointSets.link(x.a, x.b)) {
    obj.changed.dispatch();
  }
});

registerRPC(CLEAR_METHOD_ID, function (x) {
  const obj = <SharedDisjointUint64Sets>this.get(x.id);
  if (obj.disjointSets.clear()) {
    obj.changed.dispatch();
  }
});

function updateHighBitRepresentative(obj: SharedDisjointUint64Sets) {
  obj.rpc!.invoke(HIGH_BIT_REPRESENTATIVE_CHANGED_ID, {
    id: obj.rpcId,
    value: obj.disjointSets.visibleSegmentEquivalencePolicy.value,
  });
}

registerRPC(HIGH_BIT_REPRESENTATIVE_CHANGED_ID, function (x) {
  const obj = this.get(x.id) as SharedDisjointUint64Sets;
  obj.disjointSets.visibleSegmentEquivalencePolicy.value = x.value;
});

registerRPC(DELETE_SET_METHOD_ID, function (x) {
  const obj = <SharedDisjointUint64Sets>this.get(x.id);
  if (obj.disjointSets.deleteSet(x.x)) {
    obj.changed.dispatch();
  }
});

registerRPC(APPLY_DELTA_METHOD_ID, function (x) {
  const obj = <SharedDisjointUint64Sets>this.get(x.id);
  const groups = x.groups as { root: bigint; pieces: bigint[] }[];
  const retire = x.retire as bigint[];
  obj.disjointSets.applyDelta(groups, retire);
  obj.changed.dispatch();
  // Ship the patched snapshot immediately so the frontend recolours within a
  // round-trip rather than up to the interval tick.
  obj.flushTableMirror();
});

registerRPC(ENABLE_TABLE_MIRROR_ID, function (x) {
  const obj = <SharedDisjointUint64Sets>this.get(x.id);
  obj.startTableMirror();
});

registerRPC(TABLE_MIRROR_SNAPSHOT_ID, function (x) {
  const obj = <SharedDisjointUint64Sets>this.get(x.id);
  obj.receiveTableMirrorSnapshot(x.snapshot);
});

registerRPC(TABLE_MIRROR_ACK_ID, function (x) {
  const obj = <SharedDisjointUint64Sets>this.get(x.id);
  obj.tableMirrorAcked = true;
});
