/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import {
  AnnotationType,
  type AnnotationSource,
} from "#src/annotation/index.js";
import type { MultiscaleAnnotationSource } from "#src/annotation/frontend_source.js";
import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { AnnotationUserLayer } from "#src/layer/annotation/index.js";
import type { LayerManager, ManagedUserLayer } from "#src/layer/index.js";
import { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import { StatusMessage } from "#src/status.js";
import {
  animationFrameDebounce,
  type DebouncedFunction,
} from "#src/util/animation_frame_debounce.js";
import { RefCounted } from "#src/util/disposable.js";

type AnyAnnotationSource = AnnotationSource | MultiscaleAnnotationSource;

interface AnnotationSubscription {
  readonly source: AnyAnnotationSource;
  readonly debounced: DebouncedFunction;
  readonly removeListener: () => void;
}

/**
 * Top-bar entry-point widget for the edit-session UI. Renders a single
 * "Enter Edit Session" button whose disabled state tracks (a) whether a
 * session is already active on the `EditSessionHost`, (b) whether at least
 * one segmentation user-layer is loaded, and (c) whether any annotation
 * layer in the viewer holds an axis-aligned-bounding-box annotation. Click
 * defers to the caller-supplied `openModal` callback so this widget never
 * imports the modal module; the Phase 4 viewer wire-up injects the actual
 * modal-construction site.
 */
export class EnterEditSessionButton extends RefCounted {
  readonly element: HTMLButtonElement;

  private readonly host: EditSessionHost;
  private readonly layerManager: LayerManager;
  private readonly openModal: () => void;

  // Tracks per-AnnotationUserLayer subscriptions on the annotation source's
  // `changed` signal. Keyed by `AnnotationUserLayer` so we can diff against
  // the live `managedLayers` set whenever it changes.
  private readonly annotationSubscriptions = new Map<
    AnnotationUserLayer,
    AnnotationSubscription[]
  >();

  // Debounced re-evaluation triggered by source-`changed`. Held as a single
  // entry-point so individual debounce wrappers (one per source) all funnel
  // into the same predicate refresh, scheduled on the next animation frame.
  private readonly scheduleUpdate: DebouncedFunction;

  constructor(
    host: EditSessionHost,
    layerManager: LayerManager,
    openModal: () => void,
  ) {
    super();
    this.host = host;
    this.layerManager = layerManager;
    this.openModal = openModal;

    this.scheduleUpdate = animationFrameDebounce(() => this.updateDisabled());
    this.registerDisposer(() => this.scheduleUpdate.cancel());

    const button = document.createElement("button");
    button.type = "button";
    button.classList.add("neuroglancer-enter-edit-session-button");
    button.textContent = "Enter Edit Session";
    button.title = "Open a voxel edit session";
    button.addEventListener("click", this.onClick);
    this.element = button;

    this.registerDisposer(host.activeSession.changed.add(this.scheduleUpdate));
    this.registerDisposer(
      layerManager.layersChanged.add(() => {
        this.syncAnnotationSubscriptions();
        this.scheduleUpdate();
      }),
    );

    this.syncAnnotationSubscriptions();
    this.updateDisabled();
  }

  override disposed(): void {
    this.element.removeEventListener("click", this.onClick);
    for (const subs of this.annotationSubscriptions.values()) {
      for (const sub of subs) {
        try {
          sub.removeListener();
        } catch {
          // ignore
        }
        try {
          sub.debounced.cancel();
        } catch {
          // ignore
        }
      }
    }
    this.annotationSubscriptions.clear();
    super.disposed();
  }

  private onClick = (): void => {
    if (this.host.activeSession.value !== undefined) {
      StatusMessage.showTemporaryMessage(
        "Discard the current session before starting a new one.",
        4000,
      );
      return;
    }
    this.openModal();
  };

  private updateDisabled(): void {
    const sessionActive = this.host.activeSession.value !== undefined;
    const hasSeg = hasWritableSegmentationLayer(this.layerManager);
    const hasBbox = hasBboxAnnotation(this.layerManager);
    this.element.disabled = sessionActive || !hasSeg || !hasBbox;
  }

  /**
   * Walk `managedLayers`, attach a debounced `changed` listener to every
   * `AnnotationUserLayer`'s annotation source(s), and drop listeners for
   * any annotation layers that disappeared since the last sync. Each
   * AnnotationUserLayer can carry multiple annotation sources (one per
   * loaded data subsource), so we track an array per user layer.
   */
  private syncAnnotationSubscriptions(): void {
    const liveAnnotationLayers = new Set<AnnotationUserLayer>();
    for (const managed of this.layerManager.managedLayers) {
      const user = managed.layer;
      if (user instanceof AnnotationUserLayer) {
        liveAnnotationLayers.add(user);
      }
    }

    // Drop subscriptions for annotation layers that no longer exist.
    for (const [annotationLayer, subs] of this.annotationSubscriptions) {
      if (!liveAnnotationLayers.has(annotationLayer)) {
        for (const sub of subs) {
          try {
            sub.removeListener();
          } catch {
            // ignore
          }
          try {
            sub.debounced.cancel();
          } catch {
            // ignore
          }
        }
        this.annotationSubscriptions.delete(annotationLayer);
      }
    }

    // Add subscriptions for new annotation layers (and any newly-loaded
    // sources on a known annotation layer).
    for (const annotationLayer of liveAnnotationLayers) {
      const liveSources = collectAnnotationSources(annotationLayer);
      const existing = this.annotationSubscriptions.get(annotationLayer) ?? [];
      const liveSourceSet = new Set(liveSources);

      // Drop stale per-source subscriptions.
      const kept: AnnotationSubscription[] = [];
      for (const sub of existing) {
        if (liveSourceSet.has(sub.source)) {
          kept.push(sub);
        } else {
          try {
            sub.removeListener();
          } catch {
            // ignore
          }
          try {
            sub.debounced.cancel();
          } catch {
            // ignore
          }
        }
      }

      // Add new per-source subscriptions.
      const knownSources = new Set(kept.map((s) => s.source));
      for (const source of liveSources) {
        if (knownSources.has(source)) continue;
        const debounced = animationFrameDebounce(() => this.updateDisabled());
        const removeListener = source.changed.add(debounced);
        kept.push({ source, debounced, removeListener });
      }

      if (kept.length === 0) {
        this.annotationSubscriptions.delete(annotationLayer);
      } else {
        this.annotationSubscriptions.set(annotationLayer, kept);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

export function hasWritableSegmentationLayer(
  layerManager: LayerManager,
): boolean {
  for (const managed of iterateLayers(layerManager)) {
    const user = managed.layer;
    if (user instanceof SegmentationUserLayer && user.isReady) {
      return true;
    }
  }
  return false;
}

export function hasBboxAnnotation(layerManager: LayerManager): boolean {
  for (const managed of iterateLayers(layerManager)) {
    const user = managed.layer;
    if (!(user instanceof AnnotationUserLayer)) continue;
    for (const source of collectAnnotationSources(user)) {
      for (const annotation of source) {
        if (annotation.type === AnnotationType.AXIS_ALIGNED_BOUNDING_BOX) {
          return true;
        }
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function* iterateLayers(
  layerManager: LayerManager,
): Iterable<ManagedUserLayer> {
  for (const managed of layerManager.managedLayers) {
    yield managed;
  }
}

/**
 * Return every annotation source attached to `layer`. v1 segmentation +
 * annotation layers typically yield exactly one source (the local or the
 * multiscale one), but the `annotationStates.states[]` channel is the
 * neuroglancer-canonical accessor and is robust to layers that load
 * multiple annotation subsources.
 */
function collectAnnotationSources(
  layer: AnnotationUserLayer,
): AnyAnnotationSource[] {
  const sources: AnyAnnotationSource[] = [];
  const seen = new Set<AnyAnnotationSource>();
  if (layer.localAnnotations !== undefined) {
    sources.push(layer.localAnnotations);
    seen.add(layer.localAnnotations);
  }
  for (const state of layer.annotationStates.states) {
    const source = state.source;
    if (!seen.has(source)) {
      sources.push(source);
      seen.add(source);
    }
  }
  return sources;
}
