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
 * Annotation-linked side-by-side view sync ("alignment link").
 *
 * Keeps two layer-group viewers in sync through a transform fitted live from
 * line annotations — the correspondences a user draws between two consecutive
 * sections while aligning them. Unlike the built-in "relative" position link
 * (constant offset), the offset follows the local transform implied by the
 * annotations: 1 line behaves like "relative", 2 give a similarity, 3+ a full
 * affine, and by default a moving-least-squares "local affine" weighted
 * toward the correspondences nearest the current position
 * (alignment_link_math.ts).
 *
 * Mechanics:
 *  - The follower view's position link (and cross-section orientation link)
 *    is forced to UNLINKED while armed — under RELATIVE, writing the child
 *    position would propagate back to the global position (`makeLinked`) —
 *    and restored on disarm.
 *  - Positions sync bidirectionally via `navigationState.position.changed`
 *    with a re-entrancy guard; moving the follower maps back to the leader
 *    through a reverse fit.
 *  - The cross-section orientation syncs only within the z-plane: the
 *    follower is driven to a pure rotation about the data z axis (the
 *    leader's in-plane twist plus the fit's rotation angle). Out-of-plane
 *    tilts are never propagated; zoom is deliberately left independent.
 *    Mirrored fits (flipped sections, det < 0) sync positions with mirrored
 *    motion but leave orientations alone — no rotation can represent a
 *    mirror — and are surfaced via the status.
 *  - Uncommitted lines (mid-placement, tracked in the annotation source's
 *    `pending` set) and zero-length lines are excluded so an in-progress
 *    annotation never perturbs the fit.
 *  - Which line endpoint belongs to which view is auto-detected when lines
 *    are first seen: the assignment whose prediction best matches the actual
 *    follower position wins, and only commits when the two assignments are
 *    clearly separated (views roughly co-located on corresponding features);
 *    until then syncing is suspended. `state.reversed` overrides detection.
 *  - `viewer.layout.changed` aggregates all contained viewer state (including
 *    every position change), so the handler re-arms only after verifying the
 *    armed viewers were actually disposed by a layout rebuild.
 *
 * The session's `state` is a `Trackable` registered in the viewer state as
 * "alignmentLink", so an armed link survives reloads and shared URLs.
 */

import type {
  AlignmentFit,
  AlignmentModel,
  AlignmentPair,
} from "#src/alignment_link/alignment_link_math.js";
import {
  alignmentIsMirrored,
  alignmentRotationAngle,
  applyAlignmentTransform,
  fitAlignmentTransform,
} from "#src/alignment_link/alignment_link_math.js";
import type { Annotation, Line } from "#src/annotation/index.js";
import { AnnotationType } from "#src/annotation/index.js";
import { NavigationLinkType } from "#src/navigation_state.js";
import { WatchableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import {
  verifyBoolean,
  verifyObject,
  verifyOptionalObjectProperty,
  verifyString,
} from "#src/util/json.js";
import { NullarySignal } from "#src/util/signal.js";
import type { Trackable } from "#src/util/trackable.js";

const ALIGNMENT_MODELS: readonly AlignmentModel[] = [
  "local",
  "translation",
  "similarity",
  "affine",
];

/**
 * Structural views of the neuroglancer objects the session touches. Typed
 * structurally (rather than importing Viewer/LayerGroupViewer) so the sync
 * logic is unit-testable against lightweight fakes; the real classes satisfy
 * these shapes.
 */
export interface AlignmentSignal {
  add(handler: () => void): unknown;
  remove(handler: () => void): unknown;
}

/** Signal the controller also dispatches (OrientationState's manual pattern). */
export interface AlignmentNotifySignal extends AlignmentSignal {
  dispatch(): void;
}

export interface AlignmentPositionState {
  value: Float32Array;
  changed: AlignmentSignal;
  coordinateSpace?: { value?: { names?: readonly string[] } };
}

export interface AlignmentOrientationState {
  orientation: Float32Array;
  changed: AlignmentNotifySignal;
}

interface LinkState {
  value: NavigationLinkType;
}

export interface AlignmentLayerGroupViewer {
  wasDisposed?: boolean;
  viewerNavigationState: {
    position: { link: LinkState };
    crossSectionOrientation?: { link: LinkState };
  };
  navigationState: {
    position: AlignmentPositionState;
    pose?: { orientation?: AlignmentOrientationState };
  };
}

export interface AlignmentAnnotationSource {
  annotationMap: ReadonlyMap<string, Annotation>;
  pending?: { has(id: string): boolean };
  changed: AlignmentSignal;
}

export interface AlignmentLinkHost {
  layout?: {
    container: { component: unknown };
    changed: AlignmentSignal;
  };
  layerManager: {
    managedLayers: readonly {
      name: string;
      layer: object | null | undefined;
    }[];
    layersChanged: AlignmentSignal;
  };
}

export interface AlignmentLinkStatus {
  enabled: boolean;
  error: string | undefined;
  /** Configured transform model. */
  model: AlignmentModel;
  /** Fit mode actually in use for the last sync. */
  fitMode: AlignmentFit["mode"] | undefined;
  lineCount: number;
  reversed: boolean;
  directionPending: boolean;
  /** In-plane rotation (degrees, leader -> follower) of the last fit. */
  rotationDeg: number | undefined;
  /**
   * True when the fitted transform contains a reflection (flipped section):
   * positions sync with mirrored motion, orientation stays untouched.
   */
  mirrored: boolean;
  /** Layer the fit is currently bound to. */
  annotationLayerName: string | undefined;
  /** Explicit layer selection from the state; undefined = auto. */
  configuredLayerName: string | undefined;
}

const DISABLED_STATUS: AlignmentLinkStatus = {
  enabled: false,
  error: undefined,
  model: "local",
  fitMode: undefined,
  lineCount: 0,
  reversed: false,
  directionPending: true,
  rotationDeg: undefined,
  mirrored: false,
  annotationLayerName: undefined,
  configuredLayerName: undefined,
};

/**
 * Persisted intent, registered in the viewer state as "alignmentLink". The
 * key's presence means enabled; `model` defaults to "local" and `reversed`
 * (line-direction override) is omitted when auto-detected.
 */
export class TrackableAlignmentLinkState implements Trackable {
  changed = new NullarySignal();
  private enabled_ = false;
  private model_: AlignmentModel = "local";
  private reversed_: boolean | undefined = undefined;
  private layerName_: string | undefined = undefined;

  get enabled() {
    return this.enabled_;
  }
  set enabled(value: boolean) {
    if (this.enabled_ === value) return;
    this.enabled_ = value;
    this.changed.dispatch();
  }

  get model() {
    return this.model_;
  }
  set model(value: AlignmentModel) {
    if (this.model_ === value) return;
    this.model_ = value;
    this.changed.dispatch();
  }

  get reversed() {
    return this.reversed_;
  }
  set reversed(value: boolean | undefined) {
    if (this.reversed_ === value) return;
    this.reversed_ = value;
    this.changed.dispatch();
  }

  /** Annotation layer to fit from; undefined = first layer with lines. */
  get layerName() {
    return this.layerName_;
  }
  set layerName(value: string | undefined) {
    if (this.layerName_ === value) return;
    this.layerName_ = value;
    this.changed.dispatch();
  }

  toJSON() {
    if (!this.enabled_) return undefined;
    const json: { model?: string; reversed?: boolean; layer?: string } = {};
    if (this.model_ !== "local") json.model = this.model_;
    if (this.reversed_ !== undefined) json.reversed = this.reversed_;
    if (this.layerName_ !== undefined) json.layer = this.layerName_;
    return json;
  }

  reset() {
    this.enabled_ = false;
    this.model_ = "local";
    this.reversed_ = undefined;
    this.layerName_ = undefined;
    this.changed.dispatch();
  }

  restoreState(obj: unknown) {
    if (obj === undefined || obj === null) {
      this.reset();
      return;
    }
    verifyObject(obj);
    const model = verifyOptionalObjectProperty(obj, "model", verifyString);
    this.model_ =
      model !== undefined && ALIGNMENT_MODELS.includes(model as AlignmentModel)
        ? (model as AlignmentModel)
        : "local";
    this.reversed_ = verifyOptionalObjectProperty(
      obj,
      "reversed",
      verifyBoolean,
    );
    this.layerName_ = verifyOptionalObjectProperty(obj, "layer", verifyString);
    this.enabled_ = true;
    this.changed.dispatch();
  }
}

export class AlignmentLinkSession extends RefCounted {
  readonly state = new TrackableAlignmentLinkState();
  readonly status = new WatchableValue<AlignmentLinkStatus>(DISABLED_STATUS);

  private armed = false;
  private syncing = false;
  private layoutHooked = false;
  private leader: AlignmentLayerGroupViewer | undefined;
  private follower: AlignmentLayerGroupViewer | undefined;
  private annotationSource: AlignmentAnnotationSource | undefined;
  private annotationLayerName: string | undefined;
  private prevFollowerPositionLink: NavigationLinkType | undefined;
  private prevFollowerOrientationLink: NavigationLinkType | undefined;
  private reversed = false;
  private directionPending = true;
  private directionWarned = false;
  private lastFitMode: AlignmentFit["mode"] | undefined;
  private lastCount = 0;
  private lastRotationDeg: number | undefined;
  private lastMirrored = false;
  private error: string | undefined;
  private armedSubscriptions: Array<[AlignmentSignal, () => void]> = [];
  private annotationSourceSubscription: (() => void) | undefined;
  private rearmTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(public host: AlignmentLinkHost) {
    super();
    const onStateChanged = () => this.applyState();
    this.state.changed.add(onStateChanged);
    this.registerDisposer(() => this.state.changed.remove(onStateChanged));
    // Layers restore asynchronously; retry arming as they appear.
    const onLayersChanged = () => {
      if (!this.state.enabled) return;
      if (!this.armed) {
        this.applyState();
        return;
      }
      // A late-restoring layer may be the real line layer (shared-URL load).
      if (this.maybeRebindAnnotationSource()) {
        this.syncFollowerFromLeader();
        this.updateStatus();
      }
    };
    this.host.layerManager.layersChanged.add(onLayersChanged);
    this.registerDisposer(() =>
      this.host.layerManager.layersChanged.remove(onLayersChanged),
    );
  }

  disposed() {
    this.disarm();
    super.disposed();
  }

  setEnabled(enabled: boolean) {
    this.state.enabled = enabled;
  }

  setModel(model: AlignmentModel) {
    this.state.model = model;
  }

  /** Selects the annotation layer to fit from; undefined = auto-detect. */
  setLayerName(name: string | undefined) {
    this.state.layerName = name;
  }

  /** Names of layers with local annotations, for the layer selector UI. */
  annotationLayerNames(): string[] {
    const names: string[] = [];
    for (const managedLayer of this.host.layerManager.managedLayers) {
      const source = (
        managedLayer.layer as
          | { localAnnotations?: AlignmentAnnotationSource }
          | null
          | undefined
      )?.localAnnotations;
      if (source?.annotationMap !== undefined) names.push(managedLayer.name);
    }
    return names;
  }

  /** Flips the line-endpoint assignment, overriding auto-detection. */
  swapDirection() {
    this.state.reversed = !this.effectiveReversed();
  }

  private effectiveReversed() {
    return this.state.reversed !== undefined
      ? this.state.reversed
      : this.reversed;
  }

  // The layout is constructed after the Viewer constructor runs, so the
  // layout.changed hook attaches lazily on the first state application.
  private ensureLayoutHook() {
    if (this.layoutHooked) return;
    const layout = this.host.layout;
    if (layout === undefined) return;
    const handler = () => this.onLayoutChanged();
    layout.changed.add(handler);
    this.registerDisposer(() => layout.changed.remove(handler));
    this.layoutHooked = true;
  }

  private applyState() {
    this.ensureLayoutHook();
    if (this.state.enabled) {
      if (this.state.reversed !== undefined) {
        this.reversed = this.state.reversed;
        this.directionPending = false;
      }
      if (!this.armed) {
        this.arm();
      } else {
        // Model/direction changed while armed: re-sync immediately.
        this.syncFollowerFromLeader();
      }
    } else if (this.armed) {
      this.disarm();
      this.error = undefined;
    }
    this.updateStatus();
  }

  private collectLayerGroupViewers(
    component: unknown,
    out: AlignmentLayerGroupViewer[],
  ) {
    if (component === null || typeof component !== "object") return;
    // Duck-typed walk (instead of instanceof) so it stays unit-testable and
    // tolerant of the SingletonLayerGroupViewer wrapper.
    const c = component as {
      layerGroupViewer?: unknown;
      viewerNavigationState?: unknown;
      navigationState?: unknown;
      length?: unknown;
      get?: unknown;
    };
    if (c.layerGroupViewer !== undefined) {
      this.collectLayerGroupViewers(c.layerGroupViewer, out);
      return;
    }
    if (
      c.viewerNavigationState !== undefined &&
      c.navigationState !== undefined
    ) {
      out.push(component as AlignmentLayerGroupViewer);
      return;
    }
    if (typeof c.get === "function" && typeof c.length === "number") {
      const stack = component as {
        length: number;
        get(i: number): { component: unknown };
      };
      for (let i = 0; i < stack.length; i++) {
        this.collectLayerGroupViewers(stack.get(i)?.component, out);
      }
    }
  }

  private layerGroupViewers(): AlignmentLayerGroupViewer[] {
    const out: AlignmentLayerGroupViewer[] = [];
    const layout = this.host.layout;
    if (layout !== undefined) {
      this.collectLayerGroupViewers(layout.container.component, out);
    }
    return out;
  }

  // A line is usable for fitting only when committed (an in-progress
  // two-click annotation is already in annotationMap but tracked in the
  // source's `pending` set; including it would inject a bogus correspondence
  // exactly while the user is placing the endpoint) and non-degenerate.
  private isUsableLine(
    source: AlignmentAnnotationSource,
    annotation: Annotation,
  ): annotation is Line {
    if (annotation.type !== AnnotationType.LINE) return false;
    if (source.pending?.has(annotation.id)) return false;
    const { pointA, pointB } = annotation as Line;
    if (!pointA || !pointB || pointA.length < 3 || pointB.length < 3) {
      return false;
    }
    if (
      pointA[0] === pointB[0] &&
      pointA[1] === pointB[1] &&
      pointA[2] === pointB[2]
    ) {
      return false;
    }
    return true;
  }

  private countLines(source: AlignmentAnnotationSource) {
    let n = 0;
    for (const annotation of source.annotationMap.values()) {
      if (this.isUsableLine(source, annotation)) n++;
    }
    return n;
  }

  private findAnnotationSource():
    | { name: string; source: AlignmentAnnotationSource }
    | undefined {
    const forced = this.state.layerName;
    let fallback:
      | { name: string; source: AlignmentAnnotationSource }
      | undefined;
    for (const managedLayer of this.host.layerManager.managedLayers) {
      const source = (
        managedLayer.layer as
          | { localAnnotations?: AlignmentAnnotationSource }
          | null
          | undefined
      )?.localAnnotations;
      if (source?.annotationMap === undefined) continue;
      if (forced !== undefined) {
        // An explicit selection binds regardless of line count (the user may
        // be about to draw into it).
        if (managedLayer.name === forced) {
          return { name: managedLayer.name, source };
        }
        continue;
      }
      if (this.countLines(source) > 0) {
        return { name: managedLayer.name, source };
      }
      fallback ??= { name: managedLayer.name, source };
    }
    return forced !== undefined ? undefined : fallback;
  }

  private linePairs(reversed: boolean): AlignmentPair[] {
    const pairs: AlignmentPair[] = [];
    const source = this.annotationSource;
    if (source === undefined) return pairs;
    for (const annotation of source.annotationMap.values()) {
      if (!this.isUsableLine(source, annotation)) continue;
      const { pointA, pointB } = annotation;
      pairs.push(
        reversed
          ? {
              p: [pointB[0], pointB[1], pointB[2]],
              q: [pointA[0], pointA[1], pointA[2]],
            }
          : {
              p: [pointA[0], pointA[1], pointA[2]],
              q: [pointB[0], pointB[1], pointB[2]],
            },
      );
    }
    return pairs;
  }

  private positionOf(lgv: AlignmentLayerGroupViewer): [number, number, number] {
    const v = lgv.navigationState.position.value;
    return [v[0], v[1], v[2]];
  }

  private writePosition(
    lgv: AlignmentLayerGroupViewer,
    xyz: readonly number[],
  ) {
    const position = lgv.navigationState.position;
    const current = position.value;
    if (current.length < 3) return;
    // Position.value dispatches changed unconditionally; skip no-op writes so
    // orientation-only updates do not churn state autosave.
    if (
      Math.fround(xyz[0]) === current[0] &&
      Math.fround(xyz[1]) === current[1] &&
      Math.fround(xyz[2]) === current[2]
    ) {
      return;
    }
    const out = new Float32Array(current.length);
    out.set(current);
    out[0] = xyz[0];
    out[1] = xyz[1];
    out[2] = xyz[2];
    position.value = out;
  }

  private orientationOf(
    lgv: AlignmentLayerGroupViewer,
  ): AlignmentOrientationState | undefined {
    const orientation = lgv.navigationState.pose?.orientation;
    return orientation !== undefined && orientation.orientation.length === 4
      ? orientation
      : undefined;
  }

  /**
   * In-plane (about-z) rotation angle of a quaternion: the twist component of
   * its swing-twist decomposition about the z axis.
   */
  private twistOf(orientation: AlignmentOrientationState) {
    const q = orientation.orientation;
    return 2 * Math.atan2(q[2], q[3]);
  }

  // The cross-section orientation is synced only within the z-plane: the
  // target is a pure rotation about the data z axis; out-of-plane tilts are
  // never propagated.
  private writeZOrientation(
    orientation: AlignmentOrientationState,
    theta: number,
  ) {
    const q = orientation.orientation;
    const sz = Math.sin(theta / 2);
    const cw = Math.cos(theta / 2);
    // q and -q are the same rotation; skip the write when already there.
    const dot = q[2] * sz + q[3] * cw;
    if (q[0] === 0 && q[1] === 0 && Math.abs(dot) >= 1 - 1e-9) return;
    q[0] = 0;
    q[1] = 0;
    q[2] = sz;
    q[3] = cw;
    orientation.changed.dispatch();
  }

  private bindAnnotationSource(info: {
    name: string;
    source: AlignmentAnnotationSource;
  }) {
    this.unbindAnnotationSource();
    this.annotationSource = info.source;
    this.annotationLayerName = info.name;
    const handler = () => this.onAnnotationsChanged();
    info.source.changed.add(handler);
    this.annotationSourceSubscription = () =>
      info.source.changed.remove(handler);
  }

  private unbindAnnotationSource() {
    this.annotationSourceSubscription?.();
    this.annotationSourceSubscription = undefined;
    this.annotationSource = undefined;
    this.annotationLayerName = undefined;
  }

  /**
   * On a fresh load of a shared URL, layers restore asynchronously: arming
   * can happen while the line layer is still loading, leaving the source
   * bound to a lineless fallback (e.g. a point-annotation layer that
   * restored first). Whenever the bound source has no usable lines, look for
   * a layer that does and rebind.
   */
  private maybeRebindAnnotationSource(): boolean {
    if (!this.armed) return false;
    const forced = this.state.layerName;
    const current = this.annotationSource;
    if (forced !== undefined) {
      if (current !== undefined && this.annotationLayerName === forced) {
        return false;
      }
      const candidate = this.findAnnotationSource();
      if (candidate === undefined || candidate.source === current) {
        return false;
      }
      this.bindAnnotationSource(candidate);
      return true;
    }
    if (current !== undefined && this.countLines(current) > 0) return false;
    const candidate = this.findAnnotationSource();
    if (
      candidate === undefined ||
      candidate.source === current ||
      this.countLines(candidate.source) === 0
    ) {
      return false;
    }
    this.bindAnnotationSource(candidate);
    return true;
  }

  /**
   * Picks the endpoint->view assignment that best predicts where the
   * follower currently is. Commits only when the two assignments are clearly
   * separated (the views sit on roughly corresponding features); otherwise
   * stays pending — syncing is suspended until then so a wrong guess never
   * moves the views.
   */
  private chooseDirection() {
    const leader = this.leader!;
    const follower = this.follower!;
    const leaderPos = this.positionOf(leader);
    const followerPos = this.positionOf(follower);
    const errs = [false, true].map((reversed) => {
      const fit = fitAlignmentTransform(
        this.linePairs(reversed),
        leaderPos,
        this.state.model,
      );
      if (fit === null) return Infinity;
      const predicted = applyAlignmentTransform(fit, leaderPos);
      const dx = predicted[0] - followerPos[0];
      const dy = predicted[1] - followerPos[1];
      const dz = predicted[2] - followerPos[2];
      return dx * dx + dy * dy + dz * dz;
    });
    if (!isFinite(errs[0]) && !isFinite(errs[1])) return;
    if (Math.min(errs[0], errs[1]) > 0.25 * Math.max(errs[0], errs[1])) {
      // No clear signal (e.g. both views at the same position).
      if (!this.directionWarned) {
        this.directionWarned = true;
        console.info(
          "[alignment-link] line direction ambiguous — move both views onto " +
            "a matching feature to lock it, or use the swap direction control",
        );
      }
      return;
    }
    this.reversed = errs[1] < errs[0];
    this.directionPending = false;
    console.info(
      `[alignment-link] line direction: ${
        this.reversed ? "pointB -> pointA" : "pointA -> pointB"
      } (leader -> follower)`,
    );
  }

  /**
   * Shared preamble of both sync directions: resolve the line direction if
   * still pending. Returns the leader->follower pairs, or undefined when
   * syncing must not run yet.
   */
  private pairsForSync(): AlignmentPair[] | undefined {
    this.maybeRebindAnnotationSource();
    let pairs = this.linePairs(this.effectiveReversed());
    this.lastCount = pairs.length;
    if (this.directionPending && pairs.length > 0) {
      this.chooseDirection();
      pairs = this.linePairs(this.effectiveReversed());
    }
    if (this.directionPending) {
      this.lastFitMode = undefined;
      return undefined;
    }
    return pairs;
  }

  private syncFollowerFromLeader() {
    if (!this.armed || this.syncing) return;
    this.syncing = true;
    try {
      const pairs = this.pairsForSync();
      if (pairs === undefined) return;
      const leader = this.leader!;
      const follower = this.follower!;
      const leaderPos = this.positionOf(leader);
      const fit = fitAlignmentTransform(pairs, leaderPos, this.state.model);
      this.lastFitMode = fit?.mode;
      if (fit === null) return;
      this.writePosition(follower, applyAlignmentTransform(fit, leaderPos));
      this.lastMirrored = alignmentIsMirrored(fit);
      if (this.lastMirrored) {
        // No meaningful rotation exists for a reflection.
        this.lastRotationDeg = undefined;
        return;
      }
      const theta = alignmentRotationAngle(fit);
      this.lastRotationDeg = (theta * 180) / Math.PI;
      const leaderOrientation = this.orientationOf(leader);
      const followerOrientation = this.orientationOf(follower);
      if (
        leaderOrientation !== undefined &&
        followerOrientation !== undefined
      ) {
        this.writeZOrientation(
          followerOrientation,
          this.twistOf(leaderOrientation) + theta,
        );
      }
    } finally {
      this.syncing = false;
      this.updateStatus();
    }
  }

  private syncLeaderFromFollower() {
    if (!this.armed || this.syncing) return;
    this.syncing = true;
    try {
      const pairs = this.pairsForSync();
      if (pairs === undefined) return;
      const swapped = pairs.map((pair) => ({ p: pair.q, q: pair.p }));
      const leader = this.leader!;
      const follower = this.follower!;
      const followerPos = this.positionOf(follower);
      const fit = fitAlignmentTransform(swapped, followerPos, this.state.model);
      this.lastFitMode = fit?.mode;
      if (fit === null) return;
      this.writePosition(leader, applyAlignmentTransform(fit, followerPos));
      this.lastMirrored = alignmentIsMirrored(fit);
      if (this.lastMirrored) {
        this.lastRotationDeg = undefined;
        return;
      }
      const thetaReverse = alignmentRotationAngle(fit); // follower -> leader
      this.lastRotationDeg = (-thetaReverse * 180) / Math.PI;
      const leaderOrientation = this.orientationOf(leader);
      const followerOrientation = this.orientationOf(follower);
      if (
        leaderOrientation !== undefined &&
        followerOrientation !== undefined
      ) {
        this.writeZOrientation(
          leaderOrientation,
          this.twistOf(followerOrientation) + thetaReverse,
        );
      }
    } finally {
      this.syncing = false;
      this.updateStatus();
    }
  }

  private onAnnotationsChanged() {
    // Refresh the status counts only. The fit is recomputed on every position
    // change anyway, and snapping views while the user is dragging an
    // annotation endpoint would fight the edit.
    if (!this.armed) return;
    this.lastCount = this.linePairs(this.effectiveReversed()).length;
    this.updateStatus();
  }

  /**
   * True only when the armed viewers were disposed by an actual layout
   * rebuild (split/collapse). `layout.changed` also aggregates every
   * contained viewer's state — including each position change — so presence
   * must be re-checked instead of re-arming on every dispatch.
   */
  private armedViewersGone() {
    const viewers = this.layerGroupViewers();
    return (
      this.leader === undefined ||
      this.follower === undefined ||
      !viewers.includes(this.leader) ||
      !viewers.includes(this.follower) ||
      this.leader.wasDisposed === true ||
      this.follower.wasDisposed === true
    );
  }

  private onLayoutChanged() {
    if (!this.state.enabled || this.syncing || this.rearmTimer !== undefined) {
      return;
    }
    this.rearmTimer = setTimeout(() => {
      this.rearmTimer = undefined;
      if (!this.state.enabled) return;
      if (this.armed && !this.armedViewersGone()) return;
      // Carry the direction and the original link modes across the re-arm so
      // a rebuild neither re-guesses the line direction nor forgets what to
      // restore on disarm.
      const reversed = this.reversed;
      const directionPending = this.directionPending;
      const prevPositionLink = this.prevFollowerPositionLink;
      const prevOrientationLink = this.prevFollowerOrientationLink;
      const wasArmed = this.armed;
      // Collapsing the side-by-side layout while armed is treated as intent
      // to stop linking: with the layer-group menu gone there would be no UI
      // left to see or disable the still-enabled state, and it would silently
      // re-arm on the next split. (Restore-from-URL is unaffected: arm
      // attempts during restore never have wasArmed set.)
      if (wasArmed && this.layerGroupViewers().length < 2) {
        console.info(
          "[alignment-link] side-by-side layout closed — alignment link disabled",
        );
        this.state.enabled = false;
        return;
      }
      this.arm();
      if (this.armed && wasArmed) {
        this.reversed = reversed;
        this.directionPending = directionPending;
        if (prevPositionLink !== undefined) {
          this.prevFollowerPositionLink = prevPositionLink;
        }
        if (prevOrientationLink !== undefined) {
          this.prevFollowerOrientationLink = prevOrientationLink;
        }
      }
      this.updateStatus();
    }, 0);
  }

  private subscribe(signal: AlignmentSignal, handler: () => void) {
    signal.add(handler);
    this.armedSubscriptions.push([signal, handler]);
  }

  private fail(message: string) {
    this.disarm();
    this.error = message;
  }

  private arm() {
    this.disarm();
    this.error = undefined;

    const viewers = this.layerGroupViewers();
    if (viewers.length < 2) {
      this.fail(
        `needs a side-by-side layout with two viewers (got ${viewers.length})`,
      );
      return;
    }

    // Leader: first view whose position is linked to the global position.
    // Follower: first unlinked/relative view (matches the manual workflow
    // where the second view is set to "relative"). Fall back to layout order.
    let leader: AlignmentLayerGroupViewer | undefined;
    let follower: AlignmentLayerGroupViewer | undefined;
    for (const viewer of viewers) {
      const link = viewer.viewerNavigationState.position.link.value;
      if (link === NavigationLinkType.LINKED && leader === undefined) {
        leader = viewer;
      }
      if (link !== NavigationLinkType.LINKED && follower === undefined) {
        follower = viewer;
      }
    }
    leader ??= viewers[0];
    if (follower === undefined || follower === leader) {
      follower = viewers[0] === leader ? viewers[1] : viewers[0];
    }

    const annotationInfo = this.findAnnotationSource();
    if (annotationInfo === undefined) {
      this.fail(
        this.state.layerName !== undefined
          ? `annotation layer "${this.state.layerName}" not found`
          : "no local annotation layer found",
      );
      return;
    }

    if (
      leader.navigationState.position.value.length < 3 ||
      follower.navigationState.position.value.length < 3
    ) {
      this.fail("viewer position not ready");
      return;
    }

    // The fit treats indices 0-2 of positions and annotation points as
    // x/y/z; refuse dimension orders where that would silently map the wrong
    // axes (e.g. after dragging z to the front in the position widget).
    const names = leader.navigationState.position.coordinateSpace?.value?.names;
    if (
      names !== undefined &&
      (names[0] !== "x" || names[1] !== "y" || names[2] !== "z")
    ) {
      this.fail(
        `unsupported dimension order [${names.join(", ")}] — x, y, z must come first`,
      );
      return;
    }

    this.leader = leader;
    this.follower = follower;
    this.bindAnnotationSource(annotationInfo);
    this.directionPending = this.state.reversed === undefined;
    this.directionWarned = false;
    if (this.state.reversed !== undefined) {
      this.reversed = this.state.reversed;
    }
    this.prevFollowerPositionLink =
      follower.viewerNavigationState.position.link.value;
    follower.viewerNavigationState.position.link.value =
      NavigationLinkType.UNLINKED;
    const orientationLink =
      follower.viewerNavigationState.crossSectionOrientation;
    if (orientationLink !== undefined) {
      this.prevFollowerOrientationLink = orientationLink.link.value;
      orientationLink.link.value = NavigationLinkType.UNLINKED;
    }

    this.subscribe(leader.navigationState.position.changed, () =>
      this.syncFollowerFromLeader(),
    );
    this.subscribe(follower.navigationState.position.changed, () =>
      this.syncLeaderFromFollower(),
    );
    const leaderOrientation = this.orientationOf(leader);
    const followerOrientation = this.orientationOf(follower);
    if (leaderOrientation !== undefined && followerOrientation !== undefined) {
      this.subscribe(leaderOrientation.changed, () =>
        this.syncFollowerFromLeader(),
      );
      this.subscribe(followerOrientation.changed, () =>
        this.syncLeaderFromFollower(),
      );
    }
    this.armed = true;
    this.syncFollowerFromLeader();
  }

  private disarm() {
    for (const [signal, handler] of this.armedSubscriptions) {
      try {
        signal.remove(handler);
      } catch {
        // Viewer may already be disposed.
      }
    }
    this.armedSubscriptions = [];
    if (this.rearmTimer !== undefined) {
      clearTimeout(this.rearmTimer);
      this.rearmTimer = undefined;
    }
    const follower = this.follower;
    if (follower !== undefined) {
      // Restoring RELATIVE re-captures the offset at the current positions,
      // so the views keep their alignment when the mode is switched off.
      try {
        if (this.prevFollowerPositionLink !== undefined) {
          follower.viewerNavigationState.position.link.value =
            this.prevFollowerPositionLink;
        }
        if (
          this.prevFollowerOrientationLink !== undefined &&
          follower.viewerNavigationState.crossSectionOrientation !== undefined
        ) {
          follower.viewerNavigationState.crossSectionOrientation.link.value =
            this.prevFollowerOrientationLink;
        }
      } catch {
        // Viewer may already be disposed.
      }
    }
    this.armed = false;
    this.leader = undefined;
    this.follower = undefined;
    this.unbindAnnotationSource();
    this.prevFollowerPositionLink = undefined;
    this.prevFollowerOrientationLink = undefined;
    this.lastFitMode = undefined;
    this.lastCount = 0;
    this.lastRotationDeg = undefined;
    this.lastMirrored = false;
  }

  private updateStatus() {
    const next: AlignmentLinkStatus = {
      enabled: this.state.enabled,
      error: this.error,
      model: this.state.model,
      fitMode: this.lastFitMode,
      lineCount: this.lastCount,
      reversed: this.effectiveReversed(),
      directionPending: this.armed && this.directionPending,
      rotationDeg: this.lastRotationDeg,
      mirrored: this.lastMirrored,
      annotationLayerName: this.annotationLayerName,
      configuredLayerName: this.state.layerName,
    };
    const prev = this.status.value;
    for (const key of Object.keys(next) as (keyof AlignmentLinkStatus)[]) {
      if (next[key] !== prev[key]) {
        this.status.value = next;
        return;
      }
    }
  }
}
