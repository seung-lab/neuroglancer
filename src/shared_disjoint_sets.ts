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
export function updateHashMapFromDisjointSets(
  hashMap: HashMapUint64,
  disjointSets: DisjointUint64Sets,
) {
  const dirty = disjointSets.consumeDirty();
  if (dirty === null) {
    hashMap.clear();
    hashMap.reserve(Math.ceil(disjointSets.size / hashMap.loadFactor));
    for (const [pieceId, representativeId] of disjointSets.mappings()) {
      hashMap.set(pieceId, representativeId);
    }
  } else {
    hashMap.reserve(
      Math.ceil((hashMap.size + dirty.length) / hashMap.loadFactor),
    );
    for (const pieceId of dirty) {
      hashMap.set(pieceId, disjointSets.get(pieceId));
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

  get size() {
    return this.disjointSets.size;
  }

  /**
   * Frontend side: set when a large equivalences map should be maintained on
   * the worker instead of the main thread. Once requested, the worker ships
   * `HashTableSnapshot`s and the frontend stops doing O(size) insert/rehash
   * work (see `EquivalencesHashMap.update()`).
   */
  tableMirrorRequested = false;
  private pendingTableMirrorSnapshot: HashTableSnapshot | undefined;

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

  /** Frontend side: hand out the latest worker-built snapshot (once). */
  takeTableMirrorSnapshot(): HashTableSnapshot | undefined {
    const snapshot = this.pendingTableMirrorSnapshot;
    if (snapshot !== undefined) {
      this.pendingTableMirrorSnapshot = undefined;
      this.rpc?.invoke(TABLE_MIRROR_ACK_ID, { id: this.rpcId });
    }
    return snapshot;
  }

  /** Frontend side: called by the snapshot RPC handler. */
  receiveTableMirrorSnapshot(snapshot: HashTableSnapshot) {
    this.pendingTableMirrorSnapshot = snapshot;
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
    // incremental pass naturally covers the full backlog.
    updateHashMapFromDisjointSets(mirror, disjointSets);
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
