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

// Import to register the shared object types.
import 'neuroglancer/shared_disjoint_sets';
import 'neuroglancer/uint64_set';
import 'neuroglancer/shared_visibility_count/backend';

import {ChunkManager} from 'neuroglancer/chunk_manager/backend';
import {VisibleSegmentsState} from 'neuroglancer/segmentation_display_state/base';
import {SharedDisjointUint64Sets} from 'neuroglancer/shared_disjoint_sets';
import {Uint64Set} from 'neuroglancer/uint64_set';
import {UseCount} from 'neuroglancer/util/use_count';
import {RPC, SharedObjectCounterpart} from 'neuroglancer/worker_rpc';
import {HashMapUint64} from 'neuroglancer/gpu_hash/hash_table';

export class SegmentationLayerSharedObjectCounterpart extends SharedObjectCounterpart implements
    VisibleSegmentsState {
  chunkManager: ChunkManager;
  visibleSegments: Uint64Set;
  segmentEquivalences: SharedDisjointUint64Sets;
  shattered: boolean = false;
  semanticHashMap: HashMapUint64;
  semanticMode: boolean = false;

  /**
   * Indicates whether this layer is actually visible.
   */
  visibilityCount = new UseCount();

  get visible() { return this.visibilityCount.value > 0; }

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    // No need to increase the reference count of chunkManager, visibleSegments or
    // segmentEquivalences since our owner will hold a reference to their owners.
    this.chunkManager = <ChunkManager>rpc.get(options['chunkManager']);
    this.visibleSegments = <Uint64Set>rpc.get(options['visibleSegments']);
    this.segmentEquivalences = <SharedDisjointUint64Sets>rpc.get(options['segmentEquivalences']);

    const scheduleUpdateChunkPriorities =
        () => { this.chunkManager.scheduleUpdateChunkPriorities(); };
    this.registerSignalBinding(this.visibleSegments.changed.add(scheduleUpdateChunkPriorities));
    this.registerSignalBinding(this.segmentEquivalences.changed.add(scheduleUpdateChunkPriorities));
    this.visibilityCount.becameZero.add(scheduleUpdateChunkPriorities);
    this.visibilityCount.becameNonZero.add(scheduleUpdateChunkPriorities);
  }
};
