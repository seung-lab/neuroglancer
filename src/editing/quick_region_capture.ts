/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * @file Quick edit-region capture (TM-290).
 *
 * Drives the "hotkey → draw a 2-corner box → open the Enter-Edit-Session
 * modal" flow. On `start()` it:
 *
 *   1. find-or-creates a dedicated `edit-region` local annotation layer and
 *      makes it the selected layer (the `annotate` action targets the
 *      selected layer's tool — see `viewer.ts` `bindAction("annotate", …)`),
 *   2. arms neuroglancer's existing `PlaceBoundingBoxTool` on it,
 *   3. shadows plain left-click onto the `annotate` action on both rendered
 *      panels so the user places the two corners without holding a modifier
 *      (the default binding is `at:control+mousedown0`), and binds Escape to
 *      cancel,
 *   4. on the second click the box commits (`source.childCommitted`) — we
 *      tear down the capture bindings and fire `host.requestSessionEntry`
 *      with the new bbox's selection key so the modal opens pre-selected.
 *
 * This reuses the battle-tested two-step placement machinery in
 * `src/ui/annotations.ts` rather than reimplementing click handling, and the
 * `addParent(map, priority)` binder idiom already used by
 * `EditSessionHotkeyBinder`.
 */

import type { Annotation } from "#src/annotation/index.js";
import { AnnotationType } from "#src/annotation/index.js";
import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { AnnotationUserLayer } from "#src/layer/annotation/index.js";
import type { ManagedUserLayer } from "#src/layer/index.js";
import { makeLayer } from "#src/layer/index.js";
import { PlaceBoundingBoxTool } from "#src/ui/annotations.js";
import { RefCounted } from "#src/util/disposable.js";
import {
  EventActionMap,
  registerActionListener,
} from "#src/util/event_action_map.js";

/** Name of the auto-managed local annotation layer the box is drawn into. */
const EDIT_REGION_LAYER_NAME = "edit-region";

// Must be > 0 so the temporary capture map overrides the panels' direct
// bindings (e.g. the default `at:mousedown0 → translate-via-mouse-drag`).
const QUICK_CAPTURE_PRIORITY = 100;

const CANCEL_ACTION = "edit-session-quick-region-cancel";

/**
 * Owns a single in-flight quick-region capture. Constructed lazily and owned
 * by `EditSessionHost`; `start()` is idempotent (a fresh call cancels any
 * prior capture and restarts).
 */
export class QuickRegionCapture extends RefCounted {
  private active = false;
  // Guards the deferred-completion window so a second commit can't double-fire.
  private completing = false;
  private readonly teardownFns: Array<() => void> = [];

  constructor(private readonly host: EditSessionHost) {
    super();
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Begin a capture. No-op while an edit session is active. */
  start(): void {
    if (this.host.activeSession.value !== undefined) return;
    // Restart cleanly if a capture is already in flight.
    if (this.active) this.teardown();

    const { viewer } = this.host;
    const managed = this.findOrCreateEditRegionLayer();
    // The `annotate` action triggers `viewer.selectedLayer.layer`'s tool, so
    // the target layer must be the selected one.
    viewer.selectedLayer.layer = managed;

    this.active = true;
    // The local annotation source initialises a tick after the layer is added
    // (data-source activation). Defer arming the tool until it is ready.
    this.whenSourceReady(managed, () => this.arm(managed));
  }

  /** Abort an in-flight capture; drops any half-placed box. No modal. */
  cancel(): void {
    if (!this.active) return;
    this.teardown();
  }

  override disposed(): void {
    this.teardown();
    super.disposed();
  }

  // -- Internals ------------------------------------------------------------

  private arm(managed: ManagedUserLayer): void {
    if (!this.active) return;
    const userLayer = managed.layer;
    if (!(userLayer instanceof AnnotationUserLayer)) return;
    const source = userLayer.localAnnotations;
    if (source === undefined) return;
    const { viewer } = this.host;

    // Activate neuroglancer's two-corner bbox placement tool.
    const tool = new PlaceBoundingBoxTool(userLayer, {});
    userLayer.tool.value = tool;
    this.teardownFns.push(() => {
      // Only clear if it is still our tool — the user may have switched. The
      // tool's `disposed()` runs `deactivate()`, deleting any uncommitted box.
      if (userLayer.tool.value === tool) {
        userLayer.tool.value = undefined;
      }
    });

    // Plain left-click → place a corner; Escape → cancel. Installed as a
    // high-priority parent of both rendered panels for the capture's duration.
    const captureMap = EventActionMap.fromObject({
      "at:mousedown0": { action: "annotate", stopPropagation: true },
      escape: CANCEL_ACTION,
    });
    captureMap.label = "Quick edit-region capture";
    const detachSlice = viewer.inputEventBindings.sliceView.addParent(
      captureMap,
      QUICK_CAPTURE_PRIORITY,
    );
    const detachPerspective =
      viewer.inputEventBindings.perspectiveView.addParent(
        captureMap,
        QUICK_CAPTURE_PRIORITY,
      );
    this.teardownFns.push(detachSlice, detachPerspective);

    this.teardownFns.push(
      registerActionListener(viewer.element, CANCEL_ACTION, (event: Event) => {
        event.stopPropagation();
        this.cancel();
      }),
    );

    // Completion: a bbox committed in this source = the second click landed.
    this.teardownFns.push(
      source.childCommitted.add((annotationId: string) => {
        if (this.completing) return;
        const annotation: Annotation | undefined = source.get(annotationId);
        if (
          annotation === undefined ||
          annotation.type !== AnnotationType.AXIS_ALIGNED_BOUNDING_BOX
        ) {
          return;
        }
        this.completing = true;
        // Matches `BboxSelectionModel`'s entry key (`bbox_candidates.ts`).
        const bboxKey = `${managed.name} ${annotationId}`;
        // Defer teardown to a microtask: we're inside the tool's `trigger()`,
        // where `inProgressAnnotation` still references the just-committed box.
        // Disposing the tool now would re-enter its `deactivate()` and DELETE
        // that box. Let `trigger()` clear `inProgressAnnotation` first.
        queueMicrotask(() => {
          this.completing = false;
          this.teardown();
          this.host.requestSessionEntry.dispatch(bboxKey);
        });
      }),
    );
  }

  private findOrCreateEditRegionLayer(): ManagedUserLayer {
    const { layerManager, layerSpecification } = this.host.viewer;
    for (const managed of layerManager.managedLayers) {
      if (
        managed.name === EDIT_REGION_LAYER_NAME &&
        managed.layer instanceof AnnotationUserLayer
      ) {
        managed.setVisible(true);
        return managed;
      }
    }
    const managed = makeLayer(layerSpecification, EDIT_REGION_LAYER_NAME, {
      type: "annotation",
      source: "local://annotations",
    });
    layerSpecification.add(managed);
    return managed;
  }

  /** Invoke `cb` once the layer's local annotation source is available. */
  private whenSourceReady(managed: ManagedUserLayer, cb: () => void): void {
    const isReady = () => {
      const layer = managed.layer;
      return (
        layer instanceof AnnotationUserLayer &&
        layer.localAnnotations !== undefined
      );
    };
    if (isReady()) {
      cb();
      return;
    }
    let detached = false;
    const off = () => {
      if (detached) return;
      detached = true;
      offReady();
      offChanged();
    };
    const check = () => {
      if (!this.active) return;
      if (!isReady()) return;
      off();
      cb();
    };
    const offReady = managed.readyStateChanged.add(check);
    const offChanged = managed.layerChanged.add(check);
    this.teardownFns.push(off);
  }

  private teardown(): void {
    this.active = false;
    for (const fn of this.teardownFns.splice(0)) {
      try {
        fn();
      } catch {
        // best-effort teardown
      }
    }
  }
}
