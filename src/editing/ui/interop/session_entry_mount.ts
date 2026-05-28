/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import { createElement, render } from "preact";

import type { NgLayerMetadataSource } from "#src/editing/adapters/ng_layer_metadata_source.js";
import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { BboxSelectionModel } from "#src/editing/ui/session_entry/bbox_candidates.js";
import { SessionEntryModal } from "#src/editing/ui/session_entry/session_entry.js";
import { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import type { LayerManager } from "#src/layer/index.js";
import { StatusMessage } from "#src/status.js";
import { RefCounted } from "#src/util/disposable.js";

export class SessionEntryMount extends RefCounted {
  readonly element: HTMLButtonElement;

  private readonly bboxModel: BboxSelectionModel;
  private modalContainer: HTMLElement | undefined;

  constructor(
    private readonly host: EditSessionHost,
    private readonly layerManager: LayerManager,
    private readonly metadataSource: NgLayerMetadataSource,
  ) {
    super();

    this.bboxModel = this.registerDisposer(
      new BboxSelectionModel(layerManager),
    );

    const button = document.createElement("button");
    button.type = "button";
    button.classList.add("neuroglancer-enter-edit-session-button");
    button.textContent = "Enter Edit Session";
    button.title = "Open a voxel edit session";
    button.addEventListener("click", this.onClick);
    this.element = button;

    this.registerDisposer(
      host.activeSession.changed.add(() => this.updateDisabled()),
    );
    this.registerDisposer(
      layerManager.layersChanged.add(() => this.updateDisabled()),
    );
    this.registerDisposer(
      this.bboxModel.entriesChanged.add(() => this.updateDisabled()),
    );

    this.updateDisabled();
  }

  override disposed(): void {
    this.element.removeEventListener("click", this.onClick);
    this.closeModal();
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
    const hasBbox = this.bboxModel.hasBboxAnnotation();
    this.element.disabled = sessionActive || !hasSeg || !hasBbox;
  }

  private openModal(): void {
    if (this.modalContainer !== undefined) return;
    const container = document.createElement("div");
    this.modalContainer = container;
    document.body.appendChild(container);
    render(
      createElement(SessionEntryModal, {
        host: this.host,
        layerManager: this.layerManager,
        metadataSource: this.metadataSource,
        bboxModel: this.bboxModel,
        onClose: () => this.closeModal(),
      }),
      container,
    );
  }

  private closeModal(): void {
    if (this.modalContainer === undefined) return;
    render(null, this.modalContainer);
    this.modalContainer.remove();
    this.modalContainer = undefined;
  }
}

function hasWritableSegmentationLayer(layerManager: LayerManager): boolean {
  for (const managed of layerManager.managedLayers) {
    if (
      managed.layer instanceof SegmentationUserLayer &&
      managed.layer.isReady
    ) {
      return true;
    }
  }
  return false;
}
