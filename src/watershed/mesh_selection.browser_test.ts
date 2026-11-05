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

import "#src/util/polyfills.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import { deleteLayer, makeLayer } from "#src/layer/index.js";
import { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import { statusMessages } from "#src/status.js";
import { makeMinimalViewer } from "#src/ui/minimal_viewer.js";
import { DEFAULT_WATERSHED_OPTIONS } from "#src/watershed/base.js";
import type { PreparedAffinityInput } from "#src/watershed/input.js";
import { LiveWatershed } from "#src/watershed/live.js";
import {
  MAX_WATERSHED_MESH_SEGMENTS,
  WatershedMeshSelection,
} from "#src/watershed/mesh_selection.js";

// The real scheduler/readiness/epochs and real layer/RPC segmentation groups run
// in Chrome. Only the expensive watershed computation and affinity reads are fake.
vi.mock("#src/async_computation/request.js", () => ({
  requestAsyncComputation: vi.fn(),
}));

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  vi.restoreAllMocks();
  expect(statusMessages.size).toBe(0);
});
beforeEach(() => {
  vi.mocked(requestAsyncComputation).mockReset();
  vi.mocked(requestAsyncComputation).mockImplementation(
    async (_computation, _signal, _transfers, _affinities, shape) =>
      new Uint32Array((shape as number[]).reduce((a, b) => a * b, 1)).fill(7),
  );
});

function fixture() {
  const target = document.createElement("div");
  document.body.append(target);
  const viewer = makeMinimalViewer({
    target,
    showLayerDialog: false,
    resetStateWhenEmpty: false,
    showUIControls: false,
  });
  cleanup.push(() => {
    viewer.dispose();
    viewer.display.dispose();
    target.remove();
  });
  const addLayer = (name: string) => {
    const owner = makeLayer(viewer.layerSpecification, name, {
      type: "segmentation",
      source: [],
    });
    viewer.layerSpecification.add(owner);
    expect(owner.layer).toBeInstanceOf(SegmentationUserLayer);
    return { owner, user: owner.layer as SegmentationUserLayer };
  };
  const { owner, user } = addLayer("watershed");
  const invalidation = new AbortController();
  const input: PreparedAffinityInput = {
    lowerBoundXYZ: [0, 0, 0],
    upperBoundXYZ: [16, 16, 16],
    originXYZ: [0, 0, 0],
    spacingXYZ: [1, 1, 1],
    unitsXYZ: ["m", "m", "m"],
    channelCount: 3,
    signal: invalidation.signal,
    isValid: () => !invalidation.signal.aborted,
    assertValid: vi.fn(() => invalidation.signal.throwIfAborted()),
    readRegion: vi.fn<PreparedAffinityInput["readRegion"]>(
      async (_lower, shape, channels) =>
        new Float32Array(
          shape.reduce((a, b) => a * b, 1) * channels.length,
        ).fill(0.75),
    ),
    dispose: () => invalidation.abort(),
  };
  const live = new LiveWatershed(
    input,
    [0, 1, 2],
    DEFAULT_WATERSHED_OPTIONS,
    vi.fn(),
    0,
  );
  cleanup.push(() => live.dispose());
  const attach = () => {
    const selection = new WatershedMeshSelection(live, owner);
    cleanup.push(() => {
      if (selection.refCount !== 0) selection.dispose();
    });
    return selection;
  };
  const group = user.displayState.segmentationGroupState.value;
  const ready = async () => {
    live.setRegion([0, 0, 0], [4, 4, 4]);
    await expect.poll(() => live.hasCompletedResult).toBe(true);
  };
  return {
    viewer,
    owner,
    user,
    addLayer,
    invalidation,
    input,
    live,
    attach,
    group,
    visible: group.visibleSegments,
    ready,
  };
}

function warning(text = "re-select segments for the new region") {
  return Array.from(statusMessages).find((status) =>
    status.element.textContent?.includes(text),
  );
}

describe("watershed mesh selection", () => {
  it("requires a new explicit add after completion, with no snapshot copies", async () => {
    const f = fixture();
    const selection = f.attach();
    const changed = vi.fn();
    selection.changed.add(changed);
    const snapshot = vi.spyOn(f.live, "getCompletedSnapshot");
    f.visible.add(7n);
    expect(selection.allows(7n, f.live.epoch)).toBe(false);
    await f.ready();
    expect(selection.allows(7n, f.live.epoch)).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    expect(warning()).toBeDefined();
    f.visible.delete(7n);
    f.visible.add(7n);
    expect(selection.allows(7n, f.live.epoch)).toBe(true);
    expect(selection.allows(7n, f.live.epoch - 1)).toBe(false);
    expect(selection.allows(8n, f.live.epoch)).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(warning()).toBeUndefined();
    // Completion and clear are the same signal, not separate content epochs.
    f.live.changed.dispatch();
    expect(selection.allows(7n, f.live.epoch)).toBe(true);
    f.visible.delete(7n);
    expect(selection.allows(7n, f.live.epoch)).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("does not approve restored visibility or old IDs included in a batch add", async () => {
    const f = fixture();
    await f.ready();
    f.visible.add(7n);
    const selection = f.attach();
    expect(selection.allows(7n, f.live.epoch)).toBe(false);
    f.visible.add([7n, 8n]);
    expect(selection.allows(7n, f.live.epoch)).toBe(false);
    expect(selection.allows(8n, f.live.epoch)).toBe(true);
    expect(warning()).toBeDefined(); // Restored 7 is still stale.
    f.visible.delete(7n);
    expect(warning()).toBeUndefined();
    f.visible.add([0n, 0x1_0000_0000n, 0xffff_ffff_ffff_ffffn]);
    for (const id of [0n, 0x1_0000_0000n, 0xffff_ffff_ffff_ffffn]) {
      expect(selection.allows(id, f.live.epoch)).toBe(false);
    }
    f.visible.clear();
    expect(selection.allows(8n, f.live.epoch)).toBe(false);
    // No individual add provenance (e.g. an RPC/reserve notification).
    f.visible.add_(BigUint64Array.of(9n));
    f.visible.changed.dispatch(undefined!, undefined!);
    expect(selection.allows(9n, f.live.epoch)).toBe(false);
  });

  it("refuses stale IDs after a parameter rerun and pending additions", async () => {
    const f = fixture();
    const selection = f.attach();
    await f.ready();
    f.visible.add(7n);
    const previous = f.live.epoch;
    f.live.setParameters([0, 1, 2], {
      ...DEFAULT_WATERSHED_OPTIONS,
      dustThreshold: DEFAULT_WATERSHED_OPTIONS.dustThreshold + 1,
    });
    expect(f.live.epoch).toBeGreaterThan(previous);
    expect(selection.allows(7n, previous)).toBe(false);
    expect(selection.allows(7n, f.live.epoch)).toBe(false);
    expect(warning()?.element.textContent).toContain("re-select segments");
    f.visible.add(8n);
    await expect.poll(() => f.live.hasCompletedResult).toBe(true);
    expect(selection.allows(7n, f.live.epoch)).toBe(false);
    expect(selection.allows(8n, f.live.epoch)).toBe(false);
    f.visible.delete(7n);
    f.visible.add(7n);
    expect(selection.allows(7n, f.live.epoch)).toBe(true);
    expect(selection.allows(7n, previous)).toBe(false);
    expect(warning()).toBeDefined(); // Pending addition 8 still needs a repick.
    f.visible.delete(8n);
    f.visible.add(8n);
    expect(selection.allows(8n, f.live.epoch)).toBe(true);
    expect(warning()).toBeUndefined();
  });

  it("revokes all approvals for manual equivalences until reset and repicked", async () => {
    const f = fixture();
    const selection = f.attach();
    await f.ready();
    f.visible.add(7n);
    expect(selection.allows(7n, f.live.epoch)).toBe(true);
    const changed = vi.fn();
    selection.changed.add(changed);
    f.group.segmentEquivalences.link(40n, 42n); // Unrelated unions also block.
    expect(selection.allows(7n, f.live.epoch)).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(warning("manual equivalences")?.element.textContent).toContain(
      "Reset them first",
    );
    f.visible.add(8n);
    expect(selection.allows(8n, f.live.epoch)).toBe(false);
    expect(f.group.segmentEquivalences.size).toBeGreaterThan(0);
    f.group.segmentEquivalences.clear();
    expect(selection.allows(7n, f.live.epoch)).toBe(false);
    expect(selection.allows(8n, f.live.epoch)).toBe(false);
    expect(warning()).toBeDefined();
    f.visible.delete(7n);
    f.visible.add(7n);
    expect(selection.allows(7n, f.live.epoch)).toBe(true);
    expect(warning()).toBeDefined();
    f.visible.delete(8n);
    expect(warning()).toBeUndefined();
  });

  it.each([
    "useTemporaryVisibleSegments",
    "useTemporarySegmentEquivalences",
  ] as const)(
    "refuses %s and requires repicks after it is disabled",
    async (key) => {
      const f = fixture();
      const selection = f.attach();
      await f.ready();
      f.group.temporaryVisibleSegments.add(99n);
      f.group.temporarySegmentEquivalences.link(7n, 8n);
      f.visible.add(7n);
      expect(selection.allows(7n, f.live.epoch)).toBe(true);
      const changed = vi.fn();
      selection.changed.add(changed);
      f.group[key].value = true;
      expect(selection.allows(7n, f.live.epoch)).toBe(false);
      expect(changed).toHaveBeenCalledTimes(1);
      const status = warning("temporary segment selections")!;
      expect(status.element.textContent).toContain("unsupported");
      f.visible.add(8n);
      expect(selection.allows(8n, f.live.epoch)).toBe(false);
      status.element.querySelector<HTMLButtonElement>("button")!.click();
      expect(() => (f.group[key].value = false)).not.toThrow();
      expect(selection.allows(7n, f.live.epoch)).toBe(false);
      expect(selection.allows(8n, f.live.epoch)).toBe(false);
      f.visible.delete(7n);
      f.visible.add(7n);
      expect(selection.allows(7n, f.live.epoch)).toBe(true);
      expect(warning()).toBeDefined();
      f.visible.delete(8n);
      f.visible.add(8n);
      expect(selection.allows(8n, f.live.epoch)).toBe(true);
      expect(statusMessages.size).toBe(0);
      expect(f.group.temporaryVisibleSegments.toJSON()).toEqual(["99"]);
      expect(f.group.temporarySegmentEquivalences.size).toBeGreaterThan(0);
      // A reset during an add's readiness check must not promote that old add.
      vi.spyOn(f.live, "hasCompletedResult", "get").mockImplementationOnce(
        () => {
          f.group[key].value = true;
          f.group[key].value = false;
          return true;
        },
      );
      f.visible.add(9n);
      expect(selection.allows(9n, f.live.epoch)).toBe(false);
      f.visible.delete(9n);
      f.visible.add(9n);
      expect(selection.allows(9n, f.live.epoch)).toBe(true);
    },
  );

  it("caps approvals at 16 without changing visibility or automatically filling freed slots", async () => {
    const f = fixture();
    const selection = f.attach();
    await f.ready();
    expect(MAX_WATERSHED_MESH_SEGMENTS).toBe(16);
    const ids = Array.from({ length: MAX_WATERSHED_MESH_SEGMENTS }, (_, i) =>
      BigInt(i + 1),
    );
    const changed = vi.fn();
    selection.changed.add(changed);
    f.visible.add(ids);
    for (const id of ids) expect(selection.allows(id, f.live.epoch)).toBe(true);
    f.visible.add(17n);
    expect(selection.allows(17n, f.live.epoch)).toBe(false);
    expect(f.visible.size).toBe(17);
    expect(f.group.selectedSegments.size).toBe(17);
    expect(changed).toHaveBeenCalledTimes(2); // Refusal also invalidates caches.
    expect(
      warning("At most 16 selected segments")?.element.textContent,
    ).toContain("reselect refused IDs");
    f.visible.delete(1n);
    expect(selection.allows(17n, f.live.epoch)).toBe(false);
    f.visible.add(17n); // Already-visible add is not a repick.
    expect(selection.allows(17n, f.live.epoch)).toBe(false);
    f.visible.delete(17n);
    expect(statusMessages.size).toBe(0);
    f.visible.add(17n);
    expect(selection.allows(17n, f.live.epoch)).toBe(true);
    for (const id of ids.slice(1))
      expect(selection.allows(id, f.live.epoch)).toBe(true);
    expect(statusMessages.size).toBe(0);
    f.visible.clear();
    f.visible.add(18n);
    expect(selection.allows(18n, f.live.epoch)).toBe(true);
  });

  it("keeps approvals for contained navigation but not a new region", async () => {
    const f = fixture();
    const selection = f.attach();
    await f.ready();
    f.visible.add(7n);
    const epoch = f.live.epoch;
    const changed = vi.fn();
    selection.changed.add(changed);
    f.live.setRegion([1, 1, 1], [2, 2, 2]);
    f.live.setParameters([0, 1, 2], DEFAULT_WATERSHED_OPTIONS, 0);
    expect(f.live.epoch).toBe(epoch);
    expect(selection.allows(7n, epoch)).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    f.live.setRegion([8, 0, 0], [4, 4, 4]);
    expect(selection.allows(7n, epoch)).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
    await expect.poll(() => f.live.hasCompletedResult).toBe(true);
    expect(selection.allows(7n, f.live.epoch)).toBe(false);
  });

  it("leaves linked groups untouched while visibly refusing manual equivalences", async () => {
    const f = fixture();
    const linked = f.addLayer("linked");
    linked.user.displayState.linkedSegmentationGroup.linkToLayer(f.user);
    const linkedGroup = linked.user.displayState.segmentationGroupState.value;
    expect(linkedGroup).toBe(f.group);
    f.group.selectedSegments.add([7n, 9n]);
    f.group.segmentEquivalences.link(7n, 42n);
    const selection = f.attach();
    await f.ready();
    f.visible.add(7n);
    expect(selection.allows(7n, f.live.epoch)).toBe(false);
    expect(selection.allows(42n, f.live.epoch)).toBe(false);
    expect(warning("manual equivalences")).toBeDefined();
    const saved = {
      visible: f.visible.toJSON(),
      selected: f.group.selectedSegments.toJSON(),
      equivalences: f.group.segmentEquivalences.toJSON(),
    };
    const mutated = vi.fn();
    const removers = [
      f.visible.changed.add(mutated),
      f.group.selectedSegments.changed.add(mutated),
      f.group.segmentEquivalences.changed.add(mutated),
    ];
    f.live.setRegion([8, 0, 0], [4, 4, 4]);
    await expect.poll(() => f.live.hasCompletedResult).toBe(true);
    selection.dispose();
    expect(mutated).not.toHaveBeenCalled();
    expect(linkedGroup.visibleSegments.toJSON()).toEqual(saved.visible);
    expect(linkedGroup.selectedSegments.toJSON()).toEqual(saved.selected);
    expect(linkedGroup.segmentEquivalences.toJSON()).toEqual(
      saved.equivalences,
    );
    for (const remove of removers) remove();
  });

  it("does not autoapprove a group switch or the state copied back on unlink", async () => {
    const f = fixture();
    const other = f.addLayer("other");
    const otherGroup = other.user.displayState.segmentationGroupState.value;
    otherGroup.visibleSegments.add([7n, 8n]);
    const selection = f.attach();
    await f.ready();
    f.visible.add(7n);
    expect(selection.allows(7n, f.live.epoch)).toBe(true);
    f.user.displayState.linkedSegmentationGroup.linkToLayer(other.user);
    expect(selection.allows(7n, f.live.epoch)).toBe(false);
    expect(selection.allows(8n, f.live.epoch)).toBe(false);
    otherGroup.visibleSegments.delete(8n);
    otherGroup.visibleSegments.add(8n);
    expect(selection.allows(8n, f.live.epoch)).toBe(true);
    // Old group's listeners have been removed.
    f.visible.delete(7n);
    f.visible.add(7n);
    f.group.segmentEquivalences.link(7n, 42n);
    f.group.useTemporaryVisibleSegments.value = true;
    f.group.useTemporarySegmentEquivalences.value = true;
    expect(selection.allows(7n, f.live.epoch)).toBe(false);
    expect(selection.allows(8n, f.live.epoch)).toBe(true);
    f.group.segmentEquivalences.clear();
    f.group.useTemporaryVisibleSegments.value = false;
    f.group.useTemporarySegmentEquivalences.value = false;
    f.user.displayState.linkedSegmentationGroup.isolate();
    expect(f.visible.toJSON()).toEqual(["7", "8"]);
    expect(selection.allows(7n, f.live.epoch)).toBe(false);
    expect(selection.allows(8n, f.live.epoch)).toBe(false);
    f.visible.delete(8n);
    f.visible.add(8n);
    expect(selection.allows(8n, f.live.epoch)).toBe(true);
  });

  it("keeps linked owners' listeners and warnings independent", async () => {
    const f = fixture();
    const other = f.addLayer("other");
    other.user.displayState.linkedSegmentationGroup.linkToLayer(f.user);
    const first = f.attach();
    const second = new WatershedMeshSelection(f.live, other.owner);
    cleanup.push(() => second.dispose());
    f.live.setRegion([0, 0, 0], [4, 4, 4]);
    f.visible.add(7n);
    expect(statusMessages.size).toBe(2);
    await expect.poll(() => f.live.hasCompletedResult).toBe(true);
    first.dispose();
    expect(statusMessages.size).toBe(1);
    f.visible.delete(7n);
    f.visible.add(7n);
    expect(first.allows(7n, f.live.epoch)).toBe(false);
    expect(second.allows(7n, f.live.epoch)).toBe(true);
    expect(statusMessages.size).toBe(0);
  });

  it("rejects a new epoch even before its live.changed listener runs", async () => {
    const f = fixture();
    const observed: boolean[] = [];
    f.live.changed.add(() => {
      observed.push(selection.allows(7n, f.live.epoch));
    });
    const selection = f.attach();
    await f.ready();
    f.visible.add(7n);
    expect(selection.allows(7n, f.live.epoch)).toBe(true);
    observed.length = 0;
    f.live.setRegion([8, 0, 0], [4, 4, 4]);
    await expect.poll(() => f.live.hasCompletedResult).toBe(true);
    expect(observed).toEqual([false, false]);
  });

  it("handles reentrant reselection and disposal from changed callbacks", async () => {
    const f = fixture();
    const selection = f.attach();
    await f.ready();
    f.visible.add(7n);
    const remove = selection.changed.add(() => {
      if (!f.visible.has(7n)) f.visible.add(7n);
    });
    f.visible.delete(7n);
    expect(selection.allows(7n, f.live.epoch)).toBe(true);
    remove();
    const changed = vi.fn(() => selection.dispose());
    selection.changed.add(changed);
    f.visible.add(8n);
    expect(changed).toHaveBeenCalledTimes(1);
    f.visible.delete(7n);
    f.visible.add(7n);
    f.live.changed.dispatch();
    expect(selection.allows(7n, f.live.epoch)).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(warning()).toBeUndefined();
  });

  it("honors warning dismissal and removes even captured callbacks on dispose", async () => {
    const f = fixture();
    const addLive = vi.spyOn(f.live.changed, "add");
    const addVisible = vi.spyOn(f.visible.changed, "add");
    const addModes = [
      f.group.segmentEquivalences,
      f.group.useTemporaryVisibleSegments,
      f.group.useTemporarySegmentEquivalences,
    ].map((state) => vi.spyOn(state.changed, "add"));
    const selection = f.attach();
    const lateLive = addLive.mock.calls[0][0];
    const lateVisible = addVisible.mock.calls[0][0];
    const lateModes = addModes.map((add) => add.mock.calls[0][0]);
    const changed = vi.fn();
    selection.changed.add(changed);
    f.visible.add(7n);
    const status = warning()!;
    status.element.querySelector<HTMLButtonElement>("button")!.click();
    expect(statusMessages.has(status)).toBe(false);
    f.live.changed.dispatch();
    expect(warning()).toBeUndefined();
    expect(changed).not.toHaveBeenCalled();
    expect(() => selection.dispose()).not.toThrow();
    await f.ready();
    f.visible.delete(7n);
    f.visible.add(7n);
    lateLive();
    lateVisible(7n, true);
    f.group.segmentEquivalences.link(7n, 42n);
    f.group.useTemporaryVisibleSegments.value = true;
    f.group.useTemporarySegmentEquivalences.value = true;
    for (const lateMode of lateModes) lateMode();
    expect(changed).not.toHaveBeenCalled();
    expect(selection.allows(7n, f.live.epoch)).toBe(false);
    expect(warning()).toBeUndefined();
  });

  it("stops on owner deletion without touching a retained linked group", async () => {
    const f = fixture();
    const selection = f.attach();
    await f.ready();
    f.visible.add(7n);
    const group = f.group.addRef();
    cleanup.push(() => group.dispose());
    const changed = vi.fn();
    selection.changed.add(changed);
    deleteLayer(f.owner);
    expect(f.owner.refCount).toBe(0);
    f.visible.delete(7n);
    f.visible.add(7n);
    f.live.changed.dispatch();
    expect(selection.allows(7n, f.live.epoch)).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    expect(f.visible.toJSON()).toEqual(["7"]);
  });

  it("stops on abort with a kernel in flight and ignores late completion", async () => {
    const f = fixture();
    let finish!: (labels: Uint32Array) => void;
    vi.mocked(requestAsyncComputation).mockImplementationOnce(
      () => new Promise<Uint32Array>((resolve) => (finish = resolve)),
    );
    const selection = f.attach();
    const changed = vi.fn();
    selection.changed.add(changed);
    f.visible.add(7n);
    f.live.setRegion([0, 0, 0], [4, 4, 4]);
    await expect.poll(() => finish).toBeDefined();
    const count = f.live.changed.count;
    f.invalidation.abort();
    finish(new Uint32Array(64).fill(7));
    await new Promise((resolve) => setTimeout(resolve, 200));
    f.visible.delete(7n);
    f.visible.add(7n);
    f.live.changed.dispatch();
    expect(f.live.changed.count).toBe(count + 1); // Only our manual dispatch.
    f.group.segmentEquivalences.link(7n, 42n);
    f.group.useTemporaryVisibleSegments.value = true;
    f.group.useTemporarySegmentEquivalences.value = true;
    expect(selection.allows(7n, f.live.epoch)).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    expect(warning()).toBeUndefined();
  });

  it("does not bind an already-aborted producer", () => {
    const f = fixture();
    f.live.dispose();
    const add = vi.spyOn(f.visible.changed, "add");
    const selection = f.attach();
    f.visible.add(7n);
    expect(add).not.toHaveBeenCalled();
    expect(selection.allows(7n, f.live.epoch)).toBe(false);
    expect(warning()).toBeUndefined();
  });

  it("tolerates abort during the cheap readiness check", async () => {
    const f = fixture();
    const selection = f.attach();
    await f.ready();
    f.visible.add(7n);
    const changed = vi.fn();
    selection.changed.add(changed);
    vi.mocked(f.input.assertValid).mockImplementationOnce(() => {
      f.invalidation.abort();
    });
    expect(selection.allows(7n, f.live.epoch)).toBe(false);
    f.live.changed.dispatch();
    expect(changed).not.toHaveBeenCalled();
    expect(warning()).toBeUndefined();
  });
});
