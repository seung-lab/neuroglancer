/**
 * @license
 * Copyright 2026 Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Exercises the alignment-link sync behavior against lightweight fakes of the
 * layer-group viewers / annotation source. Like real neuroglancer, the fake
 * `layout.changed` aggregates every contained viewer's position and
 * orientation change (RootLayoutContainer.changed wires through each
 * LayerGroupViewer's CompoundTrackable state) — the controller must not treat
 * those dispatches as layout rebuilds.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AlignmentAnnotationSource,
  AlignmentLinkHost,
} from "#src/alignment_link/alignment_link_session.js";
import { AlignmentLinkSession } from "#src/alignment_link/alignment_link_session.js";
import type { Annotation, Line } from "#src/annotation/index.js";
import { AnnotationType } from "#src/annotation/index.js";

class FakeSignal {
  dispatches = 0;
  private handlers = new Set<() => void>();
  add(handler: () => void) {
    this.handlers.add(handler);
    return () => this.remove(handler);
  }
  remove(handler: () => void) {
    return this.handlers.delete(handler);
  }
  dispatch() {
    this.dispatches++;
    for (const handler of [...this.handlers]) handler();
  }
  get count() {
    return this.handlers.size;
  }
}

class FakePosition {
  changed = new FakeSignal();
  coordinateSpace?: { value: { names: string[] } };
  private coords: Float32Array;
  constructor(value: number[]) {
    this.coords = Float32Array.from(value);
  }
  get value() {
    return this.coords;
  }
  set value(next: Float32Array) {
    if (next.length !== this.coords.length) return;
    this.coords.set(next);
    this.changed.dispatch();
  }
}

const makeLgv = (position: number[], link = 0, dimNames?: string[]) => {
  const pos = new FakePosition(position);
  if (dimNames) pos.coordinateSpace = { value: { names: dimNames } };
  // OrientationState shape: quat mutated in place + manual changed dispatch.
  const orientation = {
    orientation: Float32Array.from([0, 0, 0, 1]),
    changed: new FakeSignal(),
  };
  return {
    viewerNavigationState: {
      position: { link: { value: link } },
      crossSectionOrientation: { link: { value: 0 } },
    },
    navigationState: { position: pos, pose: { orientation } },
  };
};

type FakeLgv = ReturnType<typeof makeLgv>;

const makeLine = (id: string, pointA: number[], pointB: number[]): Line =>
  ({
    id,
    type: AnnotationType.LINE,
    pointA: Float32Array.from(pointA),
    pointB: Float32Array.from(pointB),
    properties: [],
  }) as unknown as Line;

const makeHost = (lgvs: FakeLgv[], annotations: Line[]) => {
  const annotationMap = new Map<string, Annotation>(
    annotations.map((annotation) => [annotation.id, annotation]),
  );
  const annotationSource = {
    annotationMap,
    pending: new Set<string>(),
    changed: new FakeSignal(),
  } satisfies AlignmentAnnotationSource & { pending: Set<string> };
  const children = [...lgvs];
  const stack = {
    get length() {
      return children.length;
    },
    get(index: number) {
      return { component: children[index] };
    },
  };
  const layoutChanged = new FakeSignal();
  // Real NG: every viewer position/orientation change bubbles up to
  // layout.changed.
  const wireLayout = (lgv: FakeLgv) => {
    lgv.navigationState.position.changed.add(() => layoutChanged.dispatch());
    lgv.navigationState.pose.orientation.changed.add(() =>
      layoutChanged.dispatch(),
    );
  };
  children.forEach(wireLayout);
  const host: AlignmentLinkHost = {
    layout: {
      container: { component: stack },
      changed: layoutChanged,
    },
    layerManager: {
      managedLayers: [
        { name: "annotation", layer: { localAnnotations: annotationSource } },
      ],
      layersChanged: new FakeSignal(),
    },
  };
  return { host, annotationSource, children, layoutChanged, wireLayout };
};

const pos = (lgv: FakeLgv) => [...lgv.navigationState.position.value];

const moveTo = (lgv: FakeLgv, value: number[]) => {
  lgv.navigationState.position.value = Float32Array.from(value);
};

const quatOf = (lgv: FakeLgv) => [
  ...lgv.navigationState.pose.orientation.orientation,
];

const quatZ = (deg: number): number[] => [
  0,
  0,
  Math.sin((deg * Math.PI) / 360),
  Math.cos((deg * Math.PI) / 360),
];

const rotateTo = (lgv: FakeLgv, q: number[]) => {
  lgv.navigationState.pose.orientation.orientation.set(q);
  lgv.navigationState.pose.orientation.changed.dispatch();
};

const flushTimers = () => new Promise((resolve) => setTimeout(resolve, 15));

describe("TrackableAlignmentLinkState", () => {
  it("serializes only when enabled and round-trips", () => {
    const { host } = makeHost([], []);
    const controller = new AlignmentLinkSession(host);
    expect(controller.state.toJSON()).toBeUndefined();

    controller.state.enabled = true;
    controller.state.model = "affine";
    controller.state.reversed = true;
    controller.state.layerName = "my lines";
    expect(controller.state.toJSON()).toEqual({
      model: "affine",
      reversed: true,
      layer: "my lines",
    });

    const restored = new AlignmentLinkSession(makeHost([], []).host);
    restored.state.restoreState(controller.state.toJSON());
    expect(restored.state.enabled).toBe(true);
    expect(restored.state.model).toBe("affine");
    expect(restored.state.reversed).toBe(true);
    expect(restored.state.layerName).toBe("my lines");

    restored.state.restoreState(undefined);
    expect(restored.state.enabled).toBe(false);
    controller.dispose();
    restored.dispose();
  });
});

describe("AlignmentLinkSession", () => {
  let controller: AlignmentLinkSession | undefined;

  afterEach(async () => {
    controller?.dispose();
    controller = undefined;
    await flushTimers();
    vi.restoreAllMocks();
  });

  it("fails gracefully without a side-by-side layout", () => {
    const { host } = makeHost([makeLgv([0, 0, 0])], []);
    controller = new AlignmentLinkSession(host);
    controller.setEnabled(true);
    const status = controller.status.value;
    expect(status.enabled).toBe(true);
    expect(status.error).toMatch(/two viewers/);
  });

  it("rejects a coordinate space whose first dimensions are not x, y, z", () => {
    const leader = makeLgv([0, 0, 0], 0, ["z", "y", "x"]);
    const follower = makeLgv([0, 0, 0], 1);
    const { host } = makeHost([leader, follower], []);
    controller = new AlignmentLinkSession(host);
    controller.setEnabled(true);
    expect(controller.status.value.error).toMatch(/dimension order/);
  });

  it("arms, snaps the follower, and keeps both views in sync", () => {
    // At arm time the views already sit on roughly corresponding features
    // (the precondition for direction auto-detection).
    const leader = makeLgv([100, 100, 10], 0, ["x", "y", "z"]);
    const follower = makeLgv([340, 110, 11], 1); // "relative" manual workflow
    const { host } = makeHost(
      [leader, follower],
      [makeLine("l1", [100, 100, 10], [350, 120, 11])],
    );
    controller = new AlignmentLinkSession(host);
    controller.setEnabled(true);

    const status = controller.status.value;
    expect(status.error).toBeUndefined();
    expect(status.lineCount).toBe(1);
    expect(status.fitMode).toBe("translation");
    expect(status.reversed).toBe(false);
    // Follower links forced to UNLINKED while armed.
    expect(follower.viewerNavigationState.position.link.value).toBe(2);
    // Initial snap: leader sits on pointA, follower lands on pointB.
    expect(pos(follower)[0]).toBeCloseTo(350);
    expect(pos(follower)[1]).toBeCloseTo(120);
    expect(pos(follower)[2]).toBeCloseTo(11);

    // Leader moves; follower follows with the fitted offset.
    moveTo(leader, [110, 105, 10]);
    expect(pos(follower)[0]).toBeCloseTo(360);
    expect(pos(follower)[1]).toBeCloseTo(125);

    // Follower moves; leader follows the inverse map.
    moveTo(follower, [300, 100, 11]);
    expect(pos(leader)[0]).toBeCloseTo(50);
    expect(pos(leader)[1]).toBeCloseTo(80);
    expect(pos(leader)[2]).toBeCloseTo(10);
  });

  it("does not re-arm or re-guess direction on ordinary position changes", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const leader = makeLgv([100, 100, 10]);
    const follower = makeLgv([340, 110, 11], 1);
    const { host } = makeHost(
      [leader, follower],
      [makeLine("l1", [100, 100, 10], [350, 120, 11])],
    );
    controller = new AlignmentLinkSession(host);
    controller.setEnabled(true);
    moveTo(leader, [110, 105, 10]);
    moveTo(leader, [120, 105, 10]);
    // User drags the follower; the controller must not snap it back
    // afterwards (a naive layout.changed re-arm would do exactly that).
    moveTo(follower, [305, 100, 11]);
    const dragged = pos(follower);
    await flushTimers();
    expect(pos(follower)).toEqual(dragged);
    // Direction was decided exactly once (re-arms would log again).
    const directionLogs = infoSpy.mock.calls.filter((call) =>
      String(call[0]).includes("line direction:"),
    );
    expect(directionLogs).toHaveLength(1);
    // Still armed and responsive.
    moveTo(leader, [130, 105, 10]);
    expect(pos(follower)[0]).toBeCloseTo(380);
  });

  it("excludes pending and zero-length lines from the fit", () => {
    const leader = makeLgv([100, 100, 10]);
    const follower = makeLgv([340, 110, 11], 1);
    const { host, annotationSource } = makeHost(
      [leader, follower],
      [makeLine("l1", [100, 100, 10], [350, 120, 11])],
    );
    controller = new AlignmentLinkSession(host);
    controller.setEnabled(true);

    // A freshly started line (first click): added uncommitted with
    // pointB == pointA and tracked in the pending set.
    const inProgress = makeLine("p1", [500, 500, 10], [500, 500, 10]);
    (annotationSource.annotationMap as Map<string, Annotation>).set(
      inProgress.id,
      inProgress,
    );
    annotationSource.pending.add(inProgress.id);
    // A committed but degenerate zero-length line.
    const zeroLength = makeLine("z1", [700, 700, 10], [700, 700, 10]);
    (annotationSource.annotationMap as Map<string, Annotation>).set(
      zeroLength.id,
      zeroLength,
    );
    annotationSource.changed.dispatch();

    expect(controller.status.value.lineCount).toBe(1);
    // The fit is still the clean translation from the committed line.
    moveTo(leader, [110, 105, 10]);
    expect(pos(follower)[0]).toBeCloseTo(360);
    expect(pos(follower)[1]).toBeCloseTo(125);

    // Second click commits the line: now it participates.
    inProgress.pointB = Float32Array.from([750, 520, 11]);
    annotationSource.pending.delete(inProgress.id);
    annotationSource.changed.dispatch();
    expect(controller.status.value.lineCount).toBe(2);
  });

  it("auto-detects reversed line direction from the current view positions", () => {
    // Views sit on corresponding features, but the line was drawn from the
    // follower's section (pointA) to the leader's section (pointB).
    const leader = makeLgv([350, 120, 11]);
    const follower = makeLgv([100, 100, 10], 2);
    const { host } = makeHost(
      [leader, follower],
      [makeLine("l1", [100, 100, 10], [350, 120, 11])],
    );
    controller = new AlignmentLinkSession(host);
    controller.setEnabled(true);
    expect(controller.status.value.reversed).toBe(true);
    moveTo(leader, [360, 120, 11]);
    expect(pos(follower)[0]).toBeCloseTo(110);
  });

  it("resolves direction on a follower-first move", () => {
    const leader = makeLgv([120, 100, 10]);
    const follower = makeLgv([40, 60, 11], 2);
    const { host, annotationSource } = makeHost([leader, follower], []);
    controller = new AlignmentLinkSession(host);
    controller.setEnabled(true);
    // Line drawn from the follower's section to the leader's section.
    const line = makeLine("l1", [40, 60, 11], [120, 100, 10]);
    (annotationSource.annotationMap as Map<string, Annotation>).set(
      line.id,
      line,
    );
    annotationSource.changed.dispatch();

    // The very first interaction is a follower-side move; the controller must
    // resolve the direction there too, not apply the unvalidated default.
    moveTo(follower, [50, 70, 11]);
    expect(controller.status.value.reversed).toBe(true);
    expect(pos(leader)[0]).toBeCloseTo(130);
    expect(pos(leader)[1]).toBeCloseTo(110);
    expect(pos(leader)[2]).toBeCloseTo(10);
  });

  it("suspends syncing while the line direction is ambiguous", () => {
    // Both views at the same position: neither endpoint assignment is more
    // plausible, so the controller must not guess and teleport a view.
    const leader = makeLgv([100, 100, 10]);
    const follower = makeLgv([100, 100, 10], 2);
    const { host } = makeHost(
      [leader, follower],
      [makeLine("l1", [100, 100, 10], [350, 120, 11])],
    );
    controller = new AlignmentLinkSession(host);
    controller.setEnabled(true);
    const status = controller.status.value;
    expect(status.error).toBeUndefined();
    expect(status.directionPending).toBe(true);
    expect(status.fitMode).toBeUndefined();
    expect(pos(follower)).toEqual([100, 100, 10]); // no snap

    // The user moves the follower onto the corresponding feature: now there
    // is a clear signal, direction locks, and syncing starts.
    moveTo(follower, [340, 110, 11]);
    expect(controller.status.value.fitMode).toBe("translation");
    moveTo(leader, [110, 100, 10]);
    expect(pos(follower)[0]).toBeCloseTo(360);
  });

  it("honors an explicit direction override", () => {
    const leader = makeLgv([100, 100, 10]);
    const follower = makeLgv([100, 100, 10], 2); // co-located: no auto signal
    const { host } = makeHost(
      [leader, follower],
      [makeLine("l1", [350, 120, 11], [100, 100, 10])],
    );
    controller = new AlignmentLinkSession(host);
    controller.state.reversed = true;
    controller.setEnabled(true);
    const status = controller.status.value;
    expect(status.reversed).toBe(true);
    expect(status.directionPending).toBe(false);
    // pointB -> pointA mapping applied immediately.
    expect(pos(follower)[0]).toBeCloseTo(350);
  });

  it("swapDirection flips the effective direction", () => {
    const leader = makeLgv([100, 100, 10]);
    const follower = makeLgv([340, 110, 11], 1);
    const { host } = makeHost(
      [leader, follower],
      [makeLine("l1", [100, 100, 10], [350, 120, 11])],
    );
    controller = new AlignmentLinkSession(host);
    controller.setEnabled(true);
    expect(controller.status.value.reversed).toBe(false);
    controller.swapDirection();
    expect(controller.state.reversed).toBe(true);
    expect(controller.status.value.reversed).toBe(true);
  });

  it("scales movement when the correspondences imply a scale", () => {
    // Two lines implying a 2x horizontal stretch between the sections.
    const leader = makeLgv([0, 0, 0]);
    const follower = makeLgv([1000, 0, 0], 2);
    const { host } = makeHost(
      [leader, follower],
      [
        makeLine("l1", [0, 0, 0], [1000, 0, 0]),
        makeLine("l2", [100, 0, 0], [1200, 0, 0]),
      ],
    );
    controller = new AlignmentLinkSession(host);
    controller.setEnabled(true);
    expect(controller.status.value.fitMode).toBe("similarity");
    // Moving the leader by +50 in x moves the follower by +100.
    moveTo(leader, [50, 0, 0]);
    expect(pos(follower)[0]).toBeCloseTo(1100);
  });

  it("applies a model change while armed", () => {
    const leader = makeLgv([0, 0, 0]);
    const follower = makeLgv([1000, 0, 0], 2);
    const { host } = makeHost(
      [leader, follower],
      [
        makeLine("l1", [0, 0, 0], [1000, 0, 0]),
        makeLine("l2", [100, 0, 0], [1200, 0, 0]),
      ],
    );
    controller = new AlignmentLinkSession(host);
    controller.setEnabled(true);
    controller.setModel("translation");
    expect(controller.status.value.fitMode).toBe("translation");
    // Under translation the offset is the uniform mean of the line offsets
    // (1050) and the movement is no longer scaled.
    moveTo(leader, [50, 0, 0]);
    expect(pos(follower)[0]).toBeCloseTo(1100);
  });

  it("rotates the follower cross-section by the fitted in-plane angle", () => {
    // Two lines implying a 90-degree in-plane rotation between the sections.
    const leader = makeLgv([0, 0, 0]);
    const follower = makeLgv([1000, 0, 0], 2);
    const { host } = makeHost(
      [leader, follower],
      [
        makeLine("l1", [0, 0, 0], [1000, 0, 0]),
        makeLine("l2", [100, 0, 0], [1000, 100, 0]),
      ],
    );
    controller = new AlignmentLinkSession(host);
    controller.setEnabled(true);
    expect(controller.status.value.rotationDeg).toBeCloseTo(90, 0);
    expect(
      follower.viewerNavigationState.crossSectionOrientation.link.value,
    ).toBe(2);
    const [qx, qy, qz, qw] = quatOf(follower);
    expect(qx).toBeCloseTo(0);
    expect(qy).toBeCloseTo(0);
    expect(qz).toBeCloseTo(Math.SQRT1_2, 4);
    expect(qw).toBeCloseTo(Math.SQRT1_2, 4);
    expect(quatOf(leader)).toEqual([0, 0, 0, 1]);

    // Position mapping is rotated too: +x in the leader is +y in the follower.
    moveTo(leader, [50, 0, 0]);
    expect(pos(follower)[0]).toBeCloseTo(1000, 0);
    expect(pos(follower)[1]).toBeCloseTo(50, 0);
  });

  it("composes the leader's in-plane twist with the fitted angle, both ways", () => {
    const leader = makeLgv([0, 0, 0]);
    const follower = makeLgv([1000, 0, 0], 2);
    const { host } = makeHost(
      [leader, follower],
      [
        makeLine("l1", [0, 0, 0], [1000, 0, 0]),
        makeLine("l2", [100, 0, 0], [1000, 100, 0]),
      ],
    );
    controller = new AlignmentLinkSession(host);
    controller.setEnabled(true);

    // User rotates the leader in-plane by 30 degrees: the follower ends up
    // at 30 + 90 degrees.
    rotateTo(leader, quatZ(30));
    let [, , qz, qw] = quatOf(follower);
    expect(2 * Math.atan2(qz, qw)).toBeCloseTo((120 * Math.PI) / 180, 4);

    // User rotates the follower to 100 degrees: the leader lands at
    // 100 - 90 = 10 degrees.
    rotateTo(follower, quatZ(100));
    [, , qz, qw] = quatOf(leader);
    expect(2 * Math.atan2(qz, qw)).toBeCloseTo((10 * Math.PI) / 180, 4);
  });

  it("leaves orientations untouched for translation-only correspondences", () => {
    const leader = makeLgv([100, 100, 10]);
    const follower = makeLgv([340, 110, 11], 1);
    const { host } = makeHost(
      [leader, follower],
      [makeLine("l1", [100, 100, 10], [350, 120, 11])],
    );
    controller = new AlignmentLinkSession(host);
    controller.setEnabled(true);
    moveTo(leader, [110, 105, 10]);
    expect(quatOf(follower)).toEqual([0, 0, 0, 1]);
    expect(follower.navigationState.pose.orientation.changed.dispatches).toBe(
      0,
    );
  });

  it("handles flipped sections: mirrored positions, orientation untouched", () => {
    // Three lines implying a flip across x = 500: T(p) = (1000 - px, py).
    const leader = makeLgv([0, 0, 0]);
    const follower = makeLgv([1000, 0, 1], 2);
    const { host } = makeHost(
      [leader, follower],
      [
        makeLine("l1", [0, 0, 0], [1000, 0, 1]),
        makeLine("l2", [100, 0, 0], [900, 0, 1]),
        makeLine("l3", [0, 100, 0], [1000, 100, 1]),
      ],
    );
    controller = new AlignmentLinkSession(host);
    controller.setEnabled(true);
    const status = controller.status.value;
    expect(status.error).toBeUndefined();
    expect(status.fitMode).toBe("affine");
    expect(status.mirrored).toBe(true);
    expect(status.rotationDeg).toBeUndefined();

    // Positions sync with mirrored motion: leader +x means follower -x.
    moveTo(leader, [50, 20, 0]);
    expect(pos(follower)[0]).toBeCloseTo(950, 0);
    expect(pos(follower)[1]).toBeCloseTo(20, 0);
    // No meaningful rotation exists for a reflection: orientation untouched.
    expect(quatOf(follower)).toEqual([0, 0, 0, 1]);
    expect(follower.navigationState.pose.orientation.changed.dispatches).toBe(
      0,
    );
  });

  it("disarms cleanly: restores link modes and stops syncing", () => {
    const leader = makeLgv([100, 100, 10]);
    const follower = makeLgv([340, 110, 11], 1);
    const { host, annotationSource } = makeHost(
      [leader, follower],
      [makeLine("l1", [100, 100, 10], [350, 120, 11])],
    );
    // The layout wiring keeps one permanent handler on each position signal.
    const leaderBaseline = leader.navigationState.position.changed.count;
    const followerBaseline = follower.navigationState.position.changed.count;

    controller = new AlignmentLinkSession(host);
    controller.setEnabled(true);
    expect(
      follower.viewerNavigationState.crossSectionOrientation.link.value,
    ).toBe(2);
    controller.setEnabled(false);
    const status = controller.status.value;
    expect(status.enabled).toBe(false);
    expect(follower.viewerNavigationState.position.link.value).toBe(1);
    expect(
      follower.viewerNavigationState.crossSectionOrientation.link.value,
    ).toBe(0);
    expect(leader.navigationState.position.changed.count).toBe(leaderBaseline);
    expect(follower.navigationState.position.changed.count).toBe(
      followerBaseline,
    );
    expect((annotationSource.changed as FakeSignal).count).toBe(0);

    const followerBefore = pos(follower);
    moveTo(leader, [500, 500, 10]);
    expect(pos(follower)).toEqual(followerBefore);
  });

  it("re-arms against fresh viewers after a layout rebuild and keeps the original link mode", async () => {
    const leader = makeLgv([100, 100, 10]);
    const follower = makeLgv([340, 110, 11], 1); // originally "relative"
    const fake = makeHost(
      [leader, follower],
      [makeLine("l1", [100, 100, 10], [350, 120, 11])],
    );
    controller = new AlignmentLinkSession(fake.host);
    controller.setEnabled(true);

    // Layout rebuild: neuroglancer replaces the layer-group viewers with new
    // instances, restoring the serialized (armed) link state — UNLINKED.
    const newLeader = makeLgv([100, 100, 10]);
    const newFollower = makeLgv([340, 110, 11], 2);
    fake.children.splice(0, 2, newLeader, newFollower);
    fake.wireLayout(newLeader);
    fake.wireLayout(newFollower);
    fake.layoutChanged.dispatch();
    await flushTimers();

    expect(controller.status.value.enabled).toBe(true);
    expect(controller.status.value.error).toBeUndefined();
    moveTo(newLeader, [110, 100, 10]);
    expect(pos(newFollower)[0]).toBeCloseTo(360);
    // Old viewers are no longer driven (only the permanent layout wiring
    // remains subscribed).
    expect(leader.navigationState.position.changed.count).toBe(1);

    // Disarm restores the link mode from before arming, not the serialized
    // UNLINKED the rebuilt follower came back with.
    controller.setEnabled(false);
    expect(newFollower.viewerNavigationState.position.link.value).toBe(1);
  });

  it("disables itself when the side-by-side layout collapses while armed", async () => {
    const leader = makeLgv([100, 100, 10]);
    const follower = makeLgv([340, 110, 11], 1);
    const fake = makeHost(
      [leader, follower],
      [makeLine("l1", [100, 100, 10], [350, 120, 11])],
    );
    controller = new AlignmentLinkSession(fake.host);
    controller.setEnabled(true);
    expect(controller.status.value.enabled).toBe(true);

    // User removes the second layer group: the stack collapses to a single
    // view where no layer-group menu (the only alignment-link UI) exists, so
    // an enabled-but-hidden state would silently re-arm on the next split.
    fake.children.splice(1, 1);
    fake.layoutChanged.dispatch();
    await flushTimers();

    expect(controller.state.enabled).toBe(false);
    expect(controller.status.value.enabled).toBe(false);
    // Link mode restored on disarm.
    expect(follower.viewerNavigationState.position.link.value).toBe(1);
  });

  it("waits for lines when the annotation layer is empty", () => {
    const leader = makeLgv([100, 100, 10]);
    const follower = makeLgv([40, 60, 11], 2);
    const { host, annotationSource } = makeHost([leader, follower], []);
    controller = new AlignmentLinkSession(host);
    controller.setEnabled(true);
    const status = controller.status.value;
    expect(status.enabled).toBe(true);
    expect(status.fitMode).toBeUndefined();
    // No fit yet: follower stays put.
    const before = pos(follower);
    moveTo(leader, [120, 100, 10]);
    expect(pos(follower)).toEqual(before);

    // First line appears: direction is chosen and syncing starts.
    const line = makeLine("l1", [120, 100, 10], [40, 60, 11]);
    (annotationSource.annotationMap as Map<string, Annotation>).set(
      line.id,
      line,
    );
    annotationSource.changed.dispatch();
    moveTo(leader, [130, 110, 10]);
    expect(pos(follower)[0]).toBeCloseTo(50);
    expect(pos(follower)[1]).toBeCloseTo(70);
  });

  it("honors an explicit annotation layer selection", () => {
    const leader = makeLgv([100, 100, 10]);
    const follower = makeLgv([340, 110, 11], 1);
    const fake = makeHost(
      [leader, follower],
      [makeLine("l1", [100, 100, 10], [350, 120, 11])],
    );
    // A second line layer with a different mapping (+1000 x offset).
    const otherSource = {
      annotationMap: new Map<string, Annotation>([
        ["o1", makeLine("o1", [100, 100, 10], [1350, 120, 11])],
      ]),
      pending: new Set<string>(),
      changed: new FakeSignal(),
    };
    (
      fake.host.layerManager.managedLayers as Array<{
        name: string;
        layer: object | null;
      }>
    ).push({ name: "other", layer: { localAnnotations: otherSource } });

    controller = new AlignmentLinkSession(fake.host);
    controller.setEnabled(true);
    // Auto mode binds the first layer with lines.
    expect(controller.status.value.annotationLayerName).toBe("annotation");
    expect(controller.annotationLayerNames()).toEqual(["annotation", "other"]);

    controller.setLayerName("other");
    expect(controller.status.value.annotationLayerName).toBe("other");
    expect(controller.status.value.configuredLayerName).toBe("other");
    // Resynced using the selected layer's mapping.
    expect(pos(follower)[0]).toBeCloseTo(1350);

    // A selection that matches no layer surfaces an arm error.
    controller.setEnabled(false);
    controller.state.layerName = "missing";
    controller.setEnabled(true);
    expect(controller.status.value.error).toMatch(/missing/);
  });

  it("rebinds from a lineless fallback layer once the line layer restores (shared-URL load order)", () => {
    const leader = makeLgv([100, 100, 10]);
    const follower = makeLgv([340, 110, 11], 1);
    // The host starts with only a point-annotation layer ready (the line
    // layer restores later, as happens on a fresh load of a shared URL).
    const fake = makeHost([leader, follower], []);
    const managedLayers = fake.host.layerManager.managedLayers as Array<{
      name: string;
      layer: object | null;
    }>;
    managedLayers[0] = {
      name: "Slab Transitions",
      layer: managedLayers[0].layer,
    };
    managedLayers.push({ name: "annotation", layer: null });

    controller = new AlignmentLinkSession(fake.host);
    controller.state.restoreState({});
    // Armed, but bound to the lineless fallback.
    let status = controller.status.value;
    expect(status.enabled).toBe(true);
    expect(status.error).toBeUndefined();
    expect(status.lineCount).toBe(0);

    // The line layer finishes restoring.
    const lineSource = {
      annotationMap: new Map<string, Annotation>([
        ["l1", makeLine("l1", [100, 100, 10], [350, 120, 11])],
      ]),
      pending: new Set<string>(),
      changed: new FakeSignal(),
    };
    managedLayers[1] = {
      name: "annotation",
      layer: { localAnnotations: lineSource },
    };
    (fake.host.layerManager.layersChanged as FakeSignal).dispatch();

    status = controller.status.value;
    expect(status.annotationLayerName).toBe("annotation");
    expect(status.lineCount).toBe(1);
    // Rebinding also snapped the follower onto the correspondence.
    expect(pos(follower)[0]).toBeCloseTo(350);
    // Live edits on the rebound source are picked up.
    moveTo(leader, [110, 105, 10]);
    expect(pos(follower)[0]).toBeCloseTo(360);
  });

  it("arms automatically when the state is restored from a shared URL", () => {
    const leader = makeLgv([100, 100, 10]);
    const follower = makeLgv([340, 110, 11], 1);
    const { host } = makeHost(
      [leader, follower],
      [makeLine("l1", [100, 100, 10], [350, 120, 11])],
    );
    controller = new AlignmentLinkSession(host);
    controller.state.restoreState({ model: "similarity" });
    const status = controller.status.value;
    expect(status.enabled).toBe(true);
    expect(status.model).toBe("similarity");
    expect(status.error).toBeUndefined();
    moveTo(leader, [110, 105, 10]);
    expect(pos(follower)[0]).toBeCloseTo(360);
  });
});
