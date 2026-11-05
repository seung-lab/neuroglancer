/**
 * @license
 * Copyright 2026 Google Inc.
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

import type { ManagedUserLayer } from "#src/layer/index.js";
import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import { StatusMessage, statusMessages } from "#src/status.js";
import type { Uint64Set } from "#src/uint64_set.js";
import { RefCounted, registerEventListener } from "#src/util/disposable.js";
import { NullarySignal } from "#src/util/signal.js";
import type { LiveWatershed } from "#src/watershed/live.js";

type GroupState =
  SegmentationUserLayer["displayState"]["segmentationGroupState"];

export const MAX_WATERSHED_MESH_SEGMENTS = 16;

/**
 * Per-owner consent to mesh ephemeral watershed IDs, never a second segmentation
 * controller. Restored/group-linked visibility is not consent for a new region.
 * Only explicit additions of final published uint32 IDs after completion count.
 * Add provenance is visibleSegments.changed(ids, true), not a user-input event;
 * restore existing state before attaching (in-place new adds have no provenance).
 * Manual equivalences and temporary selection modes are unsupported: refuse all
 * meshes until reset, never silently expand or partially mesh their membership.
 * The caller still checks that the requested ID occurs in its completed snapshot.
 */
export class WatershedMeshSelection extends RefCounted {
  readonly changed = new NullarySignal();
  private readonly approvedIDs = new Set<bigint>();
  private readonly budgetRefused = new Set<bigint>();
  private knownVisible = new Set<bigint>();
  private epoch: number;
  private modeGeneration = 0;
  private userLayer: SegmentationUserLayer | undefined;
  private groupState: GroupState | undefined;
  private group: GroupState["value"] | undefined;
  private visible: Uint64Set | undefined;
  private removeGroup: (() => void) | undefined;
  private readonly groupRemovers: Array<() => void> = [];
  private readonly removers: Array<() => void> = [];
  private stopped = false;
  private updating = false;
  private pending = false;
  private changedPending = false;
  private status: StatusMessage | undefined;
  private warning: "stale" | "unsupported" | "budget" | undefined;

  constructor(
    private readonly live: LiveWatershed,
    private readonly layer: ManagedUserLayer,
  ) {
    super();
    this.epoch = live.epoch;
    if (live.signal.aborted || layer.refCount === 0) {
      this.stopped = true;
      return;
    }
    layer.registerDisposer(this.stop);
    this.removers.push(
      () => layer.unregisterDisposer(this.stop),
      layer.layerChanged.add(() => this.update()),
      live.changed.add(() => this.update()),
      registerEventListener(live.signal, "abort", this.stop),
    );
    this.update();
  }

  allows(id: bigint, epoch: number): boolean {
    if (
      this.stopped ||
      this.layer.refCount === 0 ||
      this.live.signal.aborted ||
      this.layer.layer !== this.userLayer
    ) {
      return false;
    }
    // A linked-group getter can restore state/re-enter listeners. Check all
    // eligibility again afterwards, including when called before our listener.
    const group = this.groupState?.value;
    const ready = this.isReady();
    return (
      !this.stopped &&
      this.layer.refCount !== 0 &&
      this.layer.layer === this.userLayer &&
      ready &&
      this.epoch === epoch &&
      this.live.epoch === epoch &&
      group === this.group &&
      !this.isUnsupported(group) &&
      this.visible?.has(id) === true &&
      this.approvedIDs.has(id)
    );
  }

  private isReady(): boolean {
    if (this.stopped || this.live.signal.aborted) return false;
    try {
      return this.live.hasCompletedResult;
    } catch {
      // Source validation can abort/re-enter while reading readiness.
      this.stop();
      return false;
    }
  }

  private isUnsupported(group = this.group): boolean {
    return (
      group !== undefined &&
      (group.segmentEquivalences.size > 0 ||
        group.useTemporaryVisibleSegments.value ||
        group.useTemporarySegmentEquivalences.value)
    );
  }

  private unsupportedChanged(group: GroupState["value"]) {
    if (this.stopped || group !== this.group) return;
    // Reset on both entry and exit; disabling a preview/union is not a repick.
    ++this.modeGeneration;
    this.resetApprovals();
    this.update();
  }

  private clearStatus() {
    if (this.status !== undefined && statusMessages.has(this.status)) {
      this.status.dispose();
    }
    this.status = undefined;
    this.warning = undefined;
  }

  private resetApprovals() {
    this.budgetRefused.clear();
    if (this.approvedIDs.size !== 0) {
      this.approvedIDs.clear();
      this.changedPending = true;
    }
    this.clearStatus();
  }

  private publish() {
    if (this.stopped) return;
    const warning = this.isUnsupported()
      ? "unsupported"
      : this.budgetRefused.size !== 0
        ? "budget"
        : this.visible !== undefined &&
            Array.from(this.visible).some(
              (id) => id > 0n && !this.approvedIDs.has(id),
            )
          ? "stale"
          : undefined;
    if (warning !== this.warning) {
      this.clearStatus();
      this.warning = warning;
      if (warning !== undefined) {
        this.status = new StatusMessage();
        this.status.setErrorMessage(
          `Watershed ${this.layer.name}: ` +
            (warning === "unsupported"
              ? `manual equivalences and temporary segment selections are unsupported ` +
                `for watershed meshes. Reset them first, then re-select segments.`
              : warning === "budget"
                ? `At most ${MAX_WATERSHED_MESH_SEGMENTS} selected segments can have ` +
                  `watershed meshes. Deselect segments, then reselect refused IDs.`
                : `re-select segments for the new region after computation completes ` +
                  `(toggle visibility off, then on).`),
        );
      }
    }
    // A dismissed warning stays dismissed until selection/region/group changes.
    if (this.changedPending) {
      this.changedPending = false;
      this.changed.dispatch();
    }
  }

  private update(publish = true) {
    if (this.stopped) return;
    if (this.updating) {
      this.pending = true;
      return;
    }
    this.updating = true;
    try {
      do {
        this.pending = false;
        if (this.live.signal.aborted || this.layer.refCount === 0) {
          this.stop();
          return;
        }
        if (this.epoch !== this.live.epoch) {
          this.epoch = this.live.epoch;
          this.resetApprovals();
        }
        const userLayer = this.layer.layer;
        // Avoid a runtime import cycle through segmentation -> datasource restore.
        this.userLayer =
          userLayer?.type === "segmentation"
            ? (userLayer as SegmentationUserLayer)
            : undefined;
        const groupState = this.userLayer?.displayState.segmentationGroupState;
        if (groupState !== this.groupState) {
          this.removeGroup?.();
          this.resetApprovals();
          this.groupState = groupState;
          this.removeGroup = groupState?.changed.add(() => this.update());
        }
        const group = groupState?.value;
        const visible = group?.visibleSegments;
        if (this.stopped) return;
        if (group !== this.group) {
          for (const remove of this.groupRemovers.splice(0)) remove();
          this.resetApprovals();
          this.group = group;
          this.visible = visible;
          this.knownVisible = new Set(visible);
          if (group !== undefined) {
            this.groupRemovers.push(
              group.visibleSegments.changed.add((ids, add) =>
                this.visibleChanged(group.visibleSegments, ids, add),
              ),
              ...[
                group.segmentEquivalences,
                group.useTemporaryVisibleSegments,
                group.useTemporarySegmentEquivalences,
              ].map((state) =>
                state.changed.add(() => this.unsupportedChanged(group)),
              ),
            );
          }
        }
        for (const id of this.approvedIDs) {
          if (!visible?.has(id)) {
            this.approvedIDs.delete(id);
            this.changedPending = true;
          }
        }
        for (const id of this.budgetRefused) {
          if (!visible?.has(id)) this.budgetRefused.delete(id);
        }
      } while (this.pending && !this.stopped);
    } finally {
      this.updating = false;
    }
    if (publish) this.publish();
  }

  private visibleChanged(
    visible: Uint64Set,
    ids?: bigint | bigint[] | BigUint64Array | null,
    add?: boolean,
  ) {
    if (this.stopped || visible !== this.visible) return;
    if (this.updating) {
      // Changes caused by a linked-group getter/restore are never explicit consent.
      this.knownVisible = new Set(visible);
      this.pending = true;
      return;
    }
    const epoch = this.live.epoch;
    const modeGeneration = this.modeGeneration;
    const ready = this.isReady();
    if (this.stopped) return;
    this.update(false);
    if (visible !== this.visible) {
      this.publish();
      return;
    }
    if (ids == null) {
      // Clear or an RPC notification without individual add provenance.
      this.knownVisible = new Set(visible);
    } else {
      for (const id of typeof ids === "bigint" ? [ids] : ids) {
        if (visible.has(id)) {
          if (
            add === true &&
            !this.knownVisible.has(id) &&
            ready &&
            !this.isUnsupported() &&
            modeGeneration === this.modeGeneration &&
            epoch === this.epoch &&
            epoch === this.live.epoch &&
            id > 0n &&
            id <= 0xffff_ffffn
          ) {
            if (this.approvedIDs.size < MAX_WATERSHED_MESH_SEGMENTS) {
              this.approvedIDs.add(id);
              this.budgetRefused.delete(id);
            } else {
              this.budgetRefused.add(id);
            }
            this.changedPending = true;
          }
          this.knownVisible.add(id);
        } else {
          this.knownVisible.delete(id);
        }
      }
    }
    this.publish();
  }

  private stop = () => {
    if (this.stopped) return;
    this.stopped = true;
    for (const remove of this.groupRemovers.splice(0)) remove();
    this.removeGroup?.();
    for (const remove of this.removers.splice(0).reverse()) remove();
    this.approvedIDs.clear();
    this.budgetRefused.clear();
    this.knownVisible.clear();
    this.visible = undefined;
    this.group = undefined;
    this.groupState = undefined;
    this.userLayer = undefined;
    this.changedPending = false;
    this.clearStatus();
  };

  disposed() {
    this.stop();
  }
}
