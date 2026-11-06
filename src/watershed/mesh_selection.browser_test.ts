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
import {
  DEFAULT_WATERSHED_OPTIONS,
  type WatershedOptions,
} from "#src/watershed/base.js";
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

function fixture(options: WatershedOptions = DEFAULT_WATERSHED_OPTIONS) {
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
  const onError = vi.fn();
  const live = new LiveWatershed(input, [0, 1, 2], options, onError, 0);
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
    onError,
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
    f.live.setRegion([0, 0, 0], [4, 4, 4]);
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
    f.group.selectedSegments.add(9n); // Starred but hidden restored ID.
    const selection = f.attach();
    expect(f.visible.toJSON()).toEqual(["7"]);
    expect(f.group.selectedSegments.toJSON()).toEqual(["7", "9"]);
    expect(selection.allows(7n, f.live.epoch)).toBe(false);
    f.live.changed.dispatch();
    expect(f.visible.toJSON()).toEqual(["7"]);
    expect(f.group.selectedSegments.toJSON()).toEqual(["7", "9"]);
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

  it("clears preexisting visible and starred IDs on the first region after attachment", async () => {
    const f = fixture();
    f.visible.add(7n);
    f.group.selectedSegments.add(9n);
    const selection = f.attach();
    expect(f.visible.toJSON()).toEqual(["7"]);
    expect(f.group.selectedSegments.toJSON()).toEqual(["7", "9"]);
    const epoch = f.live.epoch;
    f.live.changed.dispatch();
    expect(f.live.epoch).toBe(epoch);
    expect(f.visible.toJSON()).toEqual(["7"]);
    expect(f.group.selectedSegments.toJSON()).toEqual(["7", "9"]);
    f.live.setRegion([0, 0, 0], [4, 4, 4]);
    expect(f.live.epoch).toBeGreaterThan(epoch);
    expect(f.live.hasCompletedResult).toBe(false);
    expect(f.visible.toJSON()).toEqual([]);
    expect(f.group.selectedSegments.toJSON()).toEqual([]);
    expect(warning()).toBeUndefined();
    await expect.poll(() => f.live.hasCompletedResult).toBe(true);
    expect(f.visible.toJSON()).toEqual([]);
    expect(f.group.selectedSegments.toJSON()).toEqual([]);
    f.visible.add(7n);
    expect(selection.allows(7n, f.live.epoch)).toBe(true);
  });

  it.each([
    {
      name: "watershed parameters change",
      before: DEFAULT_WATERSHED_OPTIONS,
      after: {
        ...DEFAULT_WATERSHED_OPTIONS,
        dustThreshold: DEFAULT_WATERSHED_OPTIONS.dustThreshold + 1,
      },
    },
    {
      name: "agglomeration is enabled",
      before: DEFAULT_WATERSHED_OPTIONS,
      after: { ...DEFAULT_WATERSHED_OPTIONS, aggThreshold: 0.2 },
    },
    {
      name: "agglomeration is edited",
      before: { ...DEFAULT_WATERSHED_OPTIONS, aggThreshold: 0.2 },
      after: { ...DEFAULT_WATERSHED_OPTIONS, aggThreshold: 0.4 },
    },
    {
      name: "agglomeration is disabled",
      before: { ...DEFAULT_WATERSHED_OPTIONS, aggThreshold: 0.2 },
      after: DEFAULT_WATERSHED_OPTIONS,
    },
  ])(
    "clears visible and starred IDs immediately when $name",
    async ({ before, after }) => {
      const f = fixture(before);
      const selection = f.attach();
      await f.ready();
      f.visible.add(7n);
      f.group.selectedSegments.add(9n);
      expect(selection.allows(7n, f.live.epoch)).toBe(true);
      expect(f.visible.toJSON()).toEqual(["7"]);
      expect(f.group.selectedSegments.toJSON()).toEqual(["7", "9"]);
      const previous = f.live.epoch;
      const kernel = Promise.withResolvers<Uint32Array>();
      vi.mocked(requestAsyncComputation).mockImplementationOnce(
        () => kernel.promise,
      );
      f.live.setParameters([0, 1, 2], after, 0);
      expect(f.live.epoch).toBeGreaterThan(previous);
      expect(f.live.hasCompletedResult).toBe(false);
      expect(f.visible.toJSON()).toEqual([]);
      expect(f.group.selectedSegments.toJSON()).toEqual([]);
      expect(selection.allows(7n, previous)).toBe(false);
      expect(selection.allows(7n, f.live.epoch)).toBe(false);
      expect(warning()).toBeUndefined();
      await expect
        .poll(() => vi.mocked(requestAsyncComputation).mock.calls.length)
        .toBe(2);
      expect(f.visible.toJSON()).toEqual([]);
      expect(f.group.selectedSegments.toJSON()).toEqual([]);
      const epoch = f.live.epoch;
      kernel.resolve(new Uint32Array(64).fill(7));
      await expect.poll(() => f.live.hasCompletedResult).toBe(true);
      expect(f.live.epoch).toBe(epoch);
      expect(f.visible.toJSON()).toEqual([]);
      expect(f.group.selectedSegments.toJSON()).toEqual([]);
      f.visible.add(7n);
      f.group.selectedSegments.add(9n);
      expect(selection.allows(7n, epoch)).toBe(true);
      // Completion notifications without a new revision must not erase new picks.
      f.live.changed.dispatch();
      expect(f.visible.toJSON()).toEqual(["7"]);
      expect(f.group.selectedSegments.toJSON()).toEqual(["7", "9"]);
      expect(selection.allows(7n, epoch)).toBe(true);
    },
  );

  it("clears retired parameter selections but does not approve pending additions", async () => {
    const f = fixture();
    const selection = f.attach();
    await f.ready();
    f.visible.add(7n);
    f.group.selectedSegments.add(9n);
    const previous = f.live.epoch;
    f.live.setParameters(
      [0, 1, 2],
      {
        ...DEFAULT_WATERSHED_OPTIONS,
        dustThreshold: DEFAULT_WATERSHED_OPTIONS.dustThreshold + 1,
      },
      0,
    );
    expect(f.live.epoch).toBeGreaterThan(previous);
    expect(f.visible.toJSON()).toEqual([]);
    expect(f.group.selectedSegments.toJSON()).toEqual([]);
    expect(selection.allows(7n, previous)).toBe(false);
    expect(selection.allows(7n, f.live.epoch)).toBe(false);
    expect(warning()).toBeUndefined();
    f.visible.add(8n);
    await expect.poll(() => f.live.hasCompletedResult).toBe(true);
    expect(f.visible.toJSON()).toEqual(["8"]);
    expect(f.group.selectedSegments.toJSON()).toEqual(["8"]);
    expect(selection.allows(7n, f.live.epoch)).toBe(false);
    expect(selection.allows(8n, f.live.epoch)).toBe(false);
    f.visible.add(7n);
    expect(selection.allows(7n, f.live.epoch)).toBe(true);
    expect(selection.allows(7n, previous)).toBe(false);
    expect(warning()).toBeDefined(); // Pending addition 8 still needs a repick.
    f.visible.delete(8n);
    f.visible.add(8n);
    expect(selection.allows(8n, f.live.epoch)).toBe(true);
    expect(warning()).toBeUndefined();
  });

  it("clears selections before a replacement kernel fails and never restores them", async () => {
    const f = fixture();
    const selection = f.attach();
    await f.ready();
    f.visible.add(7n);
    f.group.selectedSegments.add(9n);
    expect(selection.allows(7n, f.live.epoch)).toBe(true);
    const kernel = Promise.withResolvers<Uint32Array>();
    vi.mocked(requestAsyncComputation).mockImplementationOnce(
      () => kernel.promise,
    );
    f.live.setParameters(
      [0, 1, 2],
      {
        ...DEFAULT_WATERSHED_OPTIONS,
        dustThreshold: DEFAULT_WATERSHED_OPTIONS.dustThreshold + 1,
      },
      0,
    );
    const epoch = f.live.epoch;
    expect(f.live.hasCompletedResult).toBe(false);
    expect(f.visible.toJSON()).toEqual([]);
    expect(f.group.selectedSegments.toJSON()).toEqual([]);
    await expect
      .poll(() => vi.mocked(requestAsyncComputation).mock.calls.length)
      .toBe(2);
    const error = new Error("replacement watershed failed");
    kernel.reject(error);
    await expect.poll(() => f.onError.mock.calls.length).toBe(1);
    expect(f.onError).toHaveBeenCalledWith(error);
    expect(f.live.epoch).toBe(epoch);
    expect(f.live.hasCompletedResult).toBe(false);
    expect(f.visible.toJSON()).toEqual([]);
    expect(f.group.selectedSegments.toJSON()).toEqual([]);
    f.live.changed.dispatch();
    expect(f.visible.toJSON()).toEqual([]);
    expect(f.group.selectedSegments.toJSON()).toEqual([]);
    expect(selection.allows(7n, epoch)).toBe(false);
    expect(warning()).toBeUndefined();
  });

  it("clears pending selections on retirement and ignores an obsolete kernel's late completion", async () => {
    const f = fixture();
    const selection = f.attach();
    await f.ready();
    f.visible.add(7n);
    f.group.selectedSegments.add(9n);
    const obsolete = Promise.withResolvers<Uint32Array>();
    const replacement = Promise.withResolvers<Uint32Array>();
    vi.mocked(requestAsyncComputation)
      .mockImplementationOnce(() => obsolete.promise)
      .mockImplementationOnce(() => replacement.promise);
    f.live.setParameters(
      [0, 1, 2],
      {
        ...DEFAULT_WATERSHED_OPTIONS,
        dustThreshold: DEFAULT_WATERSHED_OPTIONS.dustThreshold + 1,
      },
      0,
    );
    expect(f.visible.toJSON()).toEqual([]);
    expect(f.group.selectedSegments.toJSON()).toEqual([]);
    await expect
      .poll(() => vi.mocked(requestAsyncComputation).mock.calls.length)
      .toBe(2);
    f.visible.add(8n);
    f.group.selectedSegments.add(10n);
    expect(f.visible.toJSON()).toEqual(["8"]);
    expect(f.group.selectedSegments.toJSON()).toEqual(["8", "10"]);
    f.live.setRegion([8, 0, 0], [4, 4, 4]);
    const epoch = f.live.epoch;
    expect(f.live.hasCompletedResult).toBe(false);
    expect(f.visible.toJSON()).toEqual([]);
    expect(f.group.selectedSegments.toJSON()).toEqual([]);
    obsolete.resolve(new Uint32Array(64).fill(8));
    await expect
      .poll(() => vi.mocked(requestAsyncComputation).mock.calls.length)
      .toBe(3);
    expect(f.live.epoch).toBe(epoch);
    expect(f.live.hasCompletedResult).toBe(false);
    expect(f.visible.toJSON()).toEqual([]);
    expect(f.group.selectedSegments.toJSON()).toEqual([]);
    replacement.resolve(new Uint32Array(64).fill(7));
    await expect.poll(() => f.live.hasCompletedResult).toBe(true);
    expect(f.live.epoch).toBe(epoch);
    expect(f.visible.toJSON()).toEqual([]);
    expect(f.group.selectedSegments.toJSON()).toEqual([]);
    expect(selection.allows(7n, epoch)).toBe(false);
    expect(selection.allows(8n, epoch)).toBe(false);
    expect(f.onError).not.toHaveBeenCalled();
    f.visible.add(7n);
    expect(selection.allows(7n, epoch)).toBe(true);
  });

  it("clears only on retirement, not picks from an earlier same-epoch completion listener", async () => {
    const f = fixture();
    f.live.changed.add(() => {
      if (!f.live.hasCompletedResult) return;
      f.visible.add(7n);
      f.group.selectedSegments.add(9n);
    });
    const selection = f.attach();
    await f.ready();
    expect(f.visible.toJSON()).toEqual(["7"]);
    expect(f.group.selectedSegments.toJSON()).toEqual(["7", "9"]);
    expect(selection.allows(7n, f.live.epoch)).toBe(true);
    f.live.setParameters(
      [0, 1, 2],
      {
        ...DEFAULT_WATERSHED_OPTIONS,
        dustThreshold: DEFAULT_WATERSHED_OPTIONS.dustThreshold + 1,
      },
      0,
    );
    expect(f.visible.toJSON()).toEqual([]);
    expect(f.group.selectedSegments.toJSON()).toEqual([]);
    const epoch = f.live.epoch;
    await expect.poll(() => f.live.hasCompletedResult).toBe(true);
    expect(f.live.epoch).toBe(epoch);
    expect(f.visible.toJSON()).toEqual(["7"]);
    expect(f.group.selectedSegments.toJSON()).toEqual(["7", "9"]);
    expect(selection.allows(7n, epoch)).toBe(true);
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

  it("clears only on a navigation miss, preserving contained navigation and identical parameters", async () => {
    const f = fixture();
    const selection = f.attach();
    await f.ready();
    f.visible.add(7n);
    f.group.selectedSegments.add(9n);
    const epoch = f.live.epoch;
    const changed = vi.fn();
    selection.changed.add(changed);
    f.live.setRegion([1, 1, 1], [2, 2, 2]);
    f.live.setParameters([0, 1, 2], { ...DEFAULT_WATERSHED_OPTIONS }, 0);
    f.live.changed.dispatch();
    expect(f.live.epoch).toBe(epoch);
    expect(f.live.hasCompletedResult).toBe(true);
    expect(f.visible.toJSON()).toEqual(["7"]);
    expect(f.group.selectedSegments.toJSON()).toEqual(["7", "9"]);
    expect(selection.allows(7n, epoch)).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    expect(requestAsyncComputation).toHaveBeenCalledTimes(1);
    f.live.setRegion([8, 0, 0], [4, 4, 4]);
    expect(f.live.epoch).toBeGreaterThan(epoch);
    expect(f.live.hasCompletedResult).toBe(false);
    expect(f.visible.toJSON()).toEqual([]);
    expect(f.group.selectedSegments.toJSON()).toEqual([]);
    expect(selection.allows(7n, epoch)).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(warning()).toBeUndefined();
    await expect.poll(() => f.live.hasCompletedResult).toBe(true);
    expect(f.visible.toJSON()).toEqual([]);
    expect(f.group.selectedSegments.toJSON()).toEqual([]);
    expect(selection.allows(7n, f.live.epoch)).toBe(false);
  });

  it("clears shared visibility and starred IDs without unlinking or mutating other groups, equivalences, or temporary modes", async () => {
    const f = fixture();
    await f.ready();
    const linked = f.addLayer("linked");
    linked.user.displayState.linkedSegmentationGroup.linkToLayer(f.user);
    const linkedGroup = linked.user.displayState.segmentationGroupState.value;
    expect(linkedGroup).toBe(f.group);
    const unrelated = f.addLayer("unrelated");
    const unrelatedGroup =
      unrelated.user.displayState.segmentationGroupState.value;
    unrelatedGroup.visibleSegments.add(100n);
    unrelatedGroup.selectedSegments.add(101n);
    unrelatedGroup.segmentEquivalences.link(100n, 102n);
    const unrelatedSaved = {
      visible: unrelatedGroup.visibleSegments.toJSON(),
      selected: unrelatedGroup.selectedSegments.toJSON(),
      equivalences: unrelatedGroup.segmentEquivalences.toJSON(),
    };
    f.visible.add(7n);
    f.group.selectedSegments.add(9n);
    f.group.segmentEquivalences.link(7n, 42n);
    f.group.temporaryVisibleSegments.add(99n);
    f.group.temporarySegmentEquivalences.link(7n, 8n);
    f.group.useTemporaryVisibleSegments.value = true;
    f.group.useTemporarySegmentEquivalences.value = true;
    const selection = f.attach();
    expect(f.visible.toJSON()).toEqual(["7"]);
    expect(f.group.selectedSegments.toJSON()).toEqual(["7", "9"]);
    expect(selection.allows(7n, f.live.epoch)).toBe(false);
    expect(selection.allows(42n, f.live.epoch)).toBe(false);
    expect(warning("manual equivalences")).toBeDefined();
    const saved = {
      equivalences: f.group.segmentEquivalences.toJSON(),
      temporaryVisible: f.group.temporaryVisibleSegments.toJSON(),
      temporaryEquivalences: f.group.temporarySegmentEquivalences.toJSON(),
    };
    const mutated = vi.fn();
    const removers = [
      f.group.segmentEquivalences,
      f.group.temporaryVisibleSegments,
      f.group.temporarySegmentEquivalences,
      f.group.useTemporaryVisibleSegments,
      f.group.useTemporarySegmentEquivalences,
      unrelatedGroup.visibleSegments,
      unrelatedGroup.selectedSegments,
      unrelatedGroup.segmentEquivalences,
    ].map((state) => state.changed.add(mutated));
    f.live.setRegion([8, 0, 0], [4, 4, 4]);
    expect(f.live.hasCompletedResult).toBe(false);
    expect(f.visible.toJSON()).toEqual([]);
    expect(f.group.selectedSegments.toJSON()).toEqual([]);
    expect(linkedGroup.visibleSegments.toJSON()).toEqual([]);
    expect(linkedGroup.selectedSegments.toJSON()).toEqual([]);
    await expect.poll(() => f.live.hasCompletedResult).toBe(true);
    expect(f.user.displayState.segmentationGroupState.value).toBe(f.group);
    expect(linked.user.displayState.segmentationGroupState.value).toBe(f.group);
    expect(linkedGroup.visibleSegments.toJSON()).toEqual([]);
    expect(linkedGroup.selectedSegments.toJSON()).toEqual([]);
    expect(f.group.segmentEquivalences.toJSON()).toEqual(saved.equivalences);
    expect(f.group.temporaryVisibleSegments.toJSON()).toEqual(
      saved.temporaryVisible,
    );
    expect(f.group.temporarySegmentEquivalences.toJSON()).toEqual(
      saved.temporaryEquivalences,
    );
    expect(f.group.useTemporaryVisibleSegments.value).toBe(true);
    expect(f.group.useTemporarySegmentEquivalences.value).toBe(true);
    expect(unrelatedGroup.visibleSegments.toJSON()).toEqual(
      unrelatedSaved.visible,
    );
    expect(unrelatedGroup.selectedSegments.toJSON()).toEqual(
      unrelatedSaved.selected,
    );
    expect(unrelatedGroup.segmentEquivalences.toJSON()).toEqual(
      unrelatedSaved.equivalences,
    );
    expect(warning("manual equivalences")).toBeDefined();
    // Disposal is read-only, even for a shared unsupported group with new IDs.
    f.visible.add(8n);
    f.group.selectedSegments.add(10n);
    selection.dispose();
    expect(f.visible.toJSON()).toEqual(["8"]);
    expect(f.group.selectedSegments.toJSON()).toEqual(["8", "10"]);
    expect(mutated).not.toHaveBeenCalled();
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

  it("clears the newly current group on retirement, never the previously bound group", async () => {
    const f = fixture();
    await f.ready();
    const other = f.addLayer("other");
    const otherGroup = other.user.displayState.segmentationGroupState.value;
    otherGroup.visibleSegments.add(8n);
    otherGroup.selectedSegments.add(10n);
    const previous = f.live.epoch;
    // Run before selection's epoch listener to force binding and retirement into
    // the same update. Clearing the last bound group would mutate the wrong one.
    f.live.changed.add(() => {
      if (f.live.epoch !== previous) {
        f.user.displayState.linkedSegmentationGroup.linkToLayer(other.user);
      }
    });
    const selection = f.attach();
    f.visible.add(7n);
    f.group.selectedSegments.add(9n);
    expect(selection.allows(7n, previous)).toBe(true);
    expect(otherGroup.visibleSegments.toJSON()).toEqual(["8"]);
    expect(otherGroup.selectedSegments.toJSON()).toEqual(["8", "10"]);
    f.live.setRegion([8, 0, 0], [4, 4, 4]);
    expect(f.live.epoch).toBeGreaterThan(previous);
    expect(f.live.hasCompletedResult).toBe(false);
    expect(f.user.displayState.segmentationGroupState.value).toBe(otherGroup);
    expect(otherGroup.visibleSegments.toJSON()).toEqual([]);
    expect(otherGroup.selectedSegments.toJSON()).toEqual([]);
    expect(f.visible.toJSON()).toEqual(["7"]);
    expect(f.group.selectedSegments.toJSON()).toEqual(["7", "9"]);
    await expect.poll(() => f.live.hasCompletedResult).toBe(true);
    expect(otherGroup.visibleSegments.toJSON()).toEqual([]);
    expect(otherGroup.selectedSegments.toJSON()).toEqual([]);
    expect(f.visible.toJSON()).toEqual(["7"]);
    expect(f.group.selectedSegments.toJSON()).toEqual(["7", "9"]);
    expect(selection.allows(7n, f.live.epoch)).toBe(false);
    otherGroup.visibleSegments.add(8n);
    expect(selection.allows(8n, f.live.epoch)).toBe(true);
  });

  it.each(["owner deletion", "producer abort"] as const)(
    "stops cached visibility mutations after %s in a selected-clear callback",
    async (stop) => {
      const f = fixture();
      const selection = f.attach();
      await f.ready();
      f.visible.add(7n);
      f.group.selectedSegments.add(9n);
      expect(f.live.hasCompletedResult).toBe(true);
      expect(selection.allows(7n, f.live.epoch)).toBe(true);
      const group = f.group.addRef();
      cleanup.push(() => group.dispose());
      const clearVisible = vi.spyOn(f.visible, "clear");
      const stopDuringClear = vi.fn(() => {
        // NG's selectedSegments listener has already cleared visibility. There
        // must be no second call through the cached set after this stops us.
        expect(clearVisible).toHaveBeenCalledTimes(1);
        expect(f.visible.toJSON()).toEqual([]);
        if (stop === "owner deletion") deleteLayer(f.owner);
        else f.live.dispose();
      });
      cleanup.push(
        f.group.selectedSegments.changed.add((ids, add) => {
          if (ids === null && !add) stopDuringClear();
        }),
      );
      const previous = f.live.epoch;
      expect(() =>
        f.live.setParameters(
          [0, 1, 2],
          {
            ...DEFAULT_WATERSHED_OPTIONS,
            dustThreshold: DEFAULT_WATERSHED_OPTIONS.dustThreshold + 1,
          },
          0,
        ),
      ).not.toThrow();
      expect(f.live.epoch).toBeGreaterThan(previous);
      expect(stopDuringClear).toHaveBeenCalledTimes(1);
      expect(clearVisible).toHaveBeenCalledTimes(1);
      expect(f.visible.toJSON()).toEqual([]);
      expect(f.group.selectedSegments.toJSON()).toEqual([]);
      if (stop === "owner deletion") {
        expect(f.owner.refCount).toBe(0);
        expect(f.live.signal.aborted).toBe(false);
        expect(f.live.hasCompletedResult).toBe(false);
      } else {
        expect(f.live.signal.aborted).toBe(true);
        expect(() => f.live.hasCompletedResult).toThrow(
          "Live watershed stopped",
        );
      }
      expect(selection.allows(7n, f.live.epoch)).toBe(false);
      expect(statusMessages.size).toBe(0);
    },
  );

  it("preserves an explicit relink to a populated group in a selected-clear callback without approving its IDs", async () => {
    const f = fixture();
    const selection = f.attach();
    await f.ready();
    f.visible.add(7n);
    f.group.selectedSegments.add(9n);
    expect(selection.allows(7n, f.live.epoch)).toBe(true);
    const other = f.addLayer("other");
    const otherGroup = other.user.displayState.segmentationGroupState.value;
    otherGroup.visibleSegments.add(8n);
    otherGroup.selectedSegments.add(10n);
    const clearOtherVisible = vi.spyOn(otherGroup.visibleSegments, "clear");
    const clearOtherSelected = vi.spyOn(otherGroup.selectedSegments, "clear");
    const relinkDuringClear = vi.fn(() => {
      f.user.displayState.linkedSegmentationGroup.linkToLayer(other.user);
    });
    cleanup.push(
      f.group.selectedSegments.changed.add((ids, add) => {
        if (ids === null && !add) relinkDuringClear();
      }),
    );
    f.live.setParameters(
      [0, 1, 2],
      {
        ...DEFAULT_WATERSHED_OPTIONS,
        dustThreshold: DEFAULT_WATERSHED_OPTIONS.dustThreshold + 1,
      },
      0,
    );
    const epoch = f.live.epoch;
    expect(relinkDuringClear).toHaveBeenCalledTimes(1);
    expect(f.live.hasCompletedResult).toBe(false);
    expect(f.visible.toJSON()).toEqual([]);
    expect(f.group.selectedSegments.toJSON()).toEqual([]);
    expect(f.user.displayState.segmentationGroupState.value).toBe(otherGroup);
    expect(otherGroup.visibleSegments.toJSON()).toEqual(["8"]);
    expect(otherGroup.selectedSegments.toJSON()).toEqual(["8", "10"]);
    expect(selection.allows(8n, epoch)).toBe(false);
    await expect.poll(() => f.live.hasCompletedResult).toBe(true);
    expect(f.live.epoch).toBe(epoch);
    expect(f.user.displayState.segmentationGroupState.value).toBe(otherGroup);
    expect(f.visible.toJSON()).toEqual([]);
    expect(f.group.selectedSegments.toJSON()).toEqual([]);
    expect(otherGroup.visibleSegments.toJSON()).toEqual(["8"]);
    expect(otherGroup.selectedSegments.toJSON()).toEqual(["8", "10"]);
    expect(clearOtherVisible).not.toHaveBeenCalled();
    expect(clearOtherSelected).not.toHaveBeenCalled();
    expect(selection.allows(7n, epoch)).toBe(false);
    expect(selection.allows(8n, epoch)).toBe(false);
    expect(warning()).toBeDefined();
    otherGroup.visibleSegments.delete(8n);
    otherGroup.visibleSegments.add(8n);
    expect(selection.allows(8n, epoch)).toBe(true);
    expect(warning()).toBeUndefined();
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
    f.group.selectedSegments.add(9n);
    f.live.setRegion([8, 0, 0], [4, 4, 4]);
    f.live.changed.dispatch();
    expect(f.visible.toJSON()).toEqual(["7", "8"]);
    expect(f.group.selectedSegments.toJSON()).toEqual(["7", "8", "9"]);
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
    f.group.selectedSegments.add(9n);
    expect(() => selection.dispose()).not.toThrow();
    expect(f.visible.toJSON()).toEqual(["7"]);
    expect(f.group.selectedSegments.toJSON()).toEqual(["7", "9"]);
    await f.ready();
    expect(f.visible.toJSON()).toEqual(["7"]);
    expect(f.group.selectedSegments.toJSON()).toEqual(["7", "9"]);
    f.visible.delete(7n);
    f.visible.add(7n);
    lateLive();
    lateVisible(7n, true);
    f.group.segmentEquivalences.link(7n, 42n);
    f.group.useTemporaryVisibleSegments.value = true;
    f.group.useTemporarySegmentEquivalences.value = true;
    for (const lateMode of lateModes) lateMode();
    expect(f.visible.toJSON()).toEqual(["7"]);
    expect(f.group.selectedSegments.toJSON()).toEqual(["7", "9"]);
    expect(f.group.segmentEquivalences.size).toBeGreaterThan(0);
    expect(f.group.useTemporaryVisibleSegments.value).toBe(true);
    expect(f.group.useTemporarySegmentEquivalences.value).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    expect(selection.allows(7n, f.live.epoch)).toBe(false);
    expect(warning()).toBeUndefined();
  });

  it("stops on owner deletion without touching a retained linked group", async () => {
    const f = fixture();
    const selection = f.attach();
    await f.ready();
    f.visible.add(7n);
    f.group.selectedSegments.add(9n);
    const group = f.group.addRef();
    cleanup.push(() => group.dispose());
    const changed = vi.fn();
    selection.changed.add(changed);
    deleteLayer(f.owner);
    expect(f.owner.refCount).toBe(0);
    f.visible.delete(7n);
    f.visible.add(7n);
    f.live.setRegion([8, 0, 0], [4, 4, 4]);
    expect(f.live.hasCompletedResult).toBe(false);
    expect(f.visible.toJSON()).toEqual(["7"]);
    expect(f.group.selectedSegments.toJSON()).toEqual(["7", "9"]);
    await expect.poll(() => f.live.hasCompletedResult).toBe(true);
    f.live.changed.dispatch();
    expect(selection.allows(7n, f.live.epoch)).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    expect(f.visible.toJSON()).toEqual(["7"]);
    expect(f.group.selectedSegments.toJSON()).toEqual(["7", "9"]);
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
    f.live.setRegion([0, 0, 0], [4, 4, 4]);
    f.visible.add(7n);
    f.group.selectedSegments.add(9n);
    await expect.poll(() => finish).toBeDefined();
    expect(f.visible.toJSON()).toEqual(["7"]);
    expect(f.group.selectedSegments.toJSON()).toEqual(["7", "9"]);
    const count = f.live.changed.count;
    f.invalidation.abort();
    expect(f.visible.toJSON()).toEqual(["7"]);
    expect(f.group.selectedSegments.toJSON()).toEqual(["7", "9"]);
    finish(new Uint32Array(64).fill(7));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(f.visible.toJSON()).toEqual(["7"]);
    expect(f.group.selectedSegments.toJSON()).toEqual(["7", "9"]);
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
    f.group.selectedSegments.add(9n);
    f.live.changed.dispatch();
    expect(f.visible.toJSON()).toEqual(["7"]);
    expect(f.group.selectedSegments.toJSON()).toEqual(["7", "9"]);
    expect(add).not.toHaveBeenCalled();
    expect(selection.allows(7n, f.live.epoch)).toBe(false);
    expect(warning()).toBeUndefined();
  });

  it("tolerates abort during the cheap readiness check", async () => {
    const f = fixture();
    const selection = f.attach();
    await f.ready();
    f.visible.add(7n);
    f.group.selectedSegments.add(9n);
    const changed = vi.fn();
    selection.changed.add(changed);
    vi.mocked(f.input.assertValid).mockImplementationOnce(() => {
      f.invalidation.abort();
    });
    expect(selection.allows(7n, f.live.epoch)).toBe(false);
    f.live.changed.dispatch();
    expect(f.visible.toJSON()).toEqual(["7"]);
    expect(f.group.selectedSegments.toJSON()).toEqual(["7", "9"]);
    expect(changed).not.toHaveBeenCalled();
    expect(warning()).toBeUndefined();
  });
});
