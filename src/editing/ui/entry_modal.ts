/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type {
  LayerId,
  LayerMetadata,
  Resolution,
} from "@zetta-ai/edit-session";
import {
  availableResolutions,
  layerId as toLayerId,
} from "@zetta-ai/edit-session";

import { NgLayerMetadataSource } from "#src/editing/adapters/ng_layer_metadata_source.js";
import type {
  EditSessionHost,
  HostSessionConfig,
} from "#src/editing/edit_session_host.js";
import {
  BboxAnnotationPicker,
  type BboxAnnotationSelection,
} from "#src/editing/ui/components/bbox_annotation_picker.js";
import { ResolutionPicker } from "#src/editing/ui/components/resolution_picker.js";
import { ImageUserLayer } from "#src/layer/image/index.js";
import type { LayerManager } from "#src/layer/index.js";
import { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import { RefCounted } from "#src/util/disposable.js";
import "#src/editing/ui/entry_modal.css";

interface LayerRow {
  readonly container: HTMLElement;
  readonly includeBox: HTMLInputElement;
  readonly lockBox: HTMLInputElement;
  readonly resolutionSlot: HTMLElement;
  picker: ResolutionPicker | undefined;
  resolution: Resolution | undefined;
  included: boolean;
  locked: boolean;
  loadError: string | undefined;
  readonly disposers: Array<() => void>;
}

/**
 * Modal for building a `HostSessionConfig` and submitting it to
 * `EditSessionHost.openSession(config)`. One row per loaded segmentation /
 * image layer carries an Include checkbox, layer name, resolution control,
 * and Read-only checkbox. State is never persisted across opens.
 */
export class EditSessionEntryModal extends RefCounted {
  readonly element: HTMLElement;

  private readonly host: EditSessionHost;
  private readonly layerManager: LayerManager;
  private readonly metadataSource: NgLayerMetadataSource;
  private readonly onClose: () => void;

  private readonly bboxPicker: BboxAnnotationPicker;

  private readonly bboxInfo: HTMLElement;
  private readonly layersList: HTMLElement;
  private readonly errorLine: HTMLElement;
  private readonly submitButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;

  private selectedBbox: BboxAnnotationSelection | undefined;
  private readonly layerRows = new Map<string, LayerRow>();
  private submitting = false;
  private disposed_ = false;

  constructor(
    host: EditSessionHost,
    layerManager: LayerManager,
    metadataSource: NgLayerMetadataSource,
    onClose: () => void,
  ) {
    super();
    this.host = host;
    this.layerManager = layerManager;
    this.metadataSource = metadataSource;
    this.onClose = onClose;

    this.element = document.createElement("div");
    this.element.classList.add(
      "neuroglancer-edit-session-entry-modal-backdrop",
    );

    const panel = document.createElement("div");
    panel.classList.add("neuroglancer-edit-session-entry-modal");
    panel.addEventListener("click", (e) => e.stopPropagation());
    this.element.appendChild(panel);

    this.element.addEventListener("click", () => this.cancel());

    // Header
    const header = document.createElement("div");
    header.classList.add("neuroglancer-edit-session-entry-modal-header");
    const title = document.createElement("span");
    title.textContent = "Enter Edit Session";
    header.appendChild(title);
    this.closeButton = document.createElement("button");
    this.closeButton.type = "button";
    this.closeButton.classList.add(
      "neuroglancer-edit-session-entry-modal-close",
    );
    this.closeButton.title = "Close";
    this.closeButton.textContent = "×";
    this.closeButton.addEventListener("click", () => this.cancel());
    header.appendChild(this.closeButton);
    panel.appendChild(header);

    // Body
    const body = document.createElement("div");
    body.classList.add("neuroglancer-edit-session-entry-modal-body");
    panel.appendChild(body);

    // Bbox section
    const bboxSection = document.createElement("div");
    const bboxTitle = document.createElement("div");
    bboxTitle.classList.add(
      "neuroglancer-edit-session-entry-modal-section-title",
    );
    bboxTitle.textContent = "Bounding box annotation";
    bboxSection.appendChild(bboxTitle);
    this.bboxPicker = this.registerDisposer(
      new BboxAnnotationPicker(layerManager),
    );
    bboxSection.appendChild(this.bboxPicker.element);
    this.bboxInfo = document.createElement("div");
    this.bboxInfo.classList.add(
      "neuroglancer-edit-session-entry-modal-bbox-info",
    );
    bboxSection.appendChild(this.bboxInfo);
    body.appendChild(bboxSection);

    // Layers section — one bordered card containing the per-layer rows.
    const layersSection = document.createElement("div");
    const layersTitle = document.createElement("div");
    layersTitle.classList.add(
      "neuroglancer-edit-session-entry-modal-section-title",
    );
    layersTitle.textContent = "Layers";
    layersSection.appendChild(layersTitle);
    const card = document.createElement("div");
    card.classList.add("neuroglancer-edit-session-entry-modal-layers-card");
    this.layersList = document.createElement("div");
    this.layersList.classList.add(
      "neuroglancer-edit-session-entry-modal-layers-list",
    );
    card.appendChild(this.layersList);
    layersSection.appendChild(card);
    body.appendChild(layersSection);

    // Footer
    const footer = document.createElement("div");
    footer.classList.add("neuroglancer-edit-session-entry-modal-footer");
    this.errorLine = document.createElement("div");
    this.errorLine.classList.add("neuroglancer-edit-session-entry-modal-error");
    footer.appendChild(this.errorLine);
    this.cancelButton = document.createElement("button");
    this.cancelButton.type = "button";
    this.cancelButton.textContent = "Cancel";
    this.cancelButton.addEventListener("click", () => this.cancel());
    footer.appendChild(this.cancelButton);
    this.submitButton = document.createElement("button");
    this.submitButton.type = "button";
    this.submitButton.classList.add("primary");
    this.submitButton.textContent = "Open Session";
    this.submitButton.addEventListener("click", () => {
      void this.onSubmit();
    });
    footer.appendChild(this.submitButton);
    panel.appendChild(footer);

    this.registerDisposer(
      this.bboxPicker.selectionChanged.add(() => {
        this.selectedBbox = this.bboxPicker.selection;
        this.refreshBboxInfo();
      }),
    );
    this.registerDisposer(layerManager.layersChanged.add(this.rebuildLayerRows));

    this.selectedBbox = this.bboxPicker.selection;
    this.refreshBboxInfo();
    this.rebuildLayerRows();
  }

  override disposed(): void {
    this.disposed_ = true;
    if (this.element.parentNode !== null) {
      this.element.parentNode.removeChild(this.element);
    }
    for (const row of this.layerRows.values()) {
      this.disposeRow(row);
    }
    this.layerRows.clear();
    super.disposed();
  }

  // -------------------------------------------------------------------------
  // Bbox info
  // -------------------------------------------------------------------------

  private refreshBboxInfo(): void {
    const sel = this.selectedBbox;
    if (sel === undefined) {
      this.bboxInfo.textContent = "(no bbox selected)";
      return;
    }
    const sx = Math.round(sel.voxelBbox[3] - sel.voxelBbox[0]);
    const sy = Math.round(sel.voxelBbox[4] - sel.voxelBbox[1]);
    const sz = Math.round(sel.voxelBbox[5] - sel.voxelBbox[2]);
    this.bboxInfo.textContent = `${sel.annotationLayerName} · ${sx}×${sy}×${sz} voxels`;
  }

  // -------------------------------------------------------------------------
  // Per-layer rows
  // -------------------------------------------------------------------------

  private readonly rebuildLayerRows = (): void => {
    const current = this.currentLayerNames();

    // Drop rows for layers that no longer exist.
    for (const name of Array.from(this.layerRows.keys())) {
      if (!current.includes(name)) {
        const row = this.layerRows.get(name)!;
        this.disposeRow(row);
        if (row.container.parentNode !== null) {
          row.container.parentNode.removeChild(row.container);
        }
        this.layerRows.delete(name);
      }
    }

    // Render in layer-manager order; create rows lazily.
    while (this.layersList.firstChild !== null) {
      this.layersList.removeChild(this.layersList.firstChild);
    }
    if (current.length === 0) {
      const empty = document.createElement("div");
      empty.classList.add(
        "neuroglancer-edit-session-entry-modal-layers-empty",
      );
      empty.textContent = "(no editable layers loaded)";
      this.layersList.appendChild(empty);
      return;
    }
    for (const name of current) {
      let row = this.layerRows.get(name);
      if (row === undefined) {
        row = this.createLayerRow(name);
        this.layerRows.set(name, row);
        void this.loadLayerMetadata(name);
      }
      this.layersList.appendChild(row.container);
    }
  };

  private currentLayerNames(): string[] {
    const names: string[] = [];
    for (const managed of this.layerManager.managedLayers) {
      const userLayer = managed.layer;
      if (
        userLayer instanceof SegmentationUserLayer ||
        userLayer instanceof ImageUserLayer
      ) {
        names.push(managed.name);
      }
    }
    return names;
  }

  private createLayerRow(name: string): LayerRow {
    const container = document.createElement("div");
    container.classList.add("neuroglancer-edit-session-entry-modal-layer-row");

    // Include checkbox + clickable layer-name label.
    const includeLabel = document.createElement("label");
    includeLabel.classList.add(
      "neuroglancer-edit-session-entry-modal-layer-include",
    );
    const includeBox = document.createElement("input");
    includeBox.type = "checkbox";
    includeBox.checked = true;
    includeLabel.appendChild(includeBox);
    const nameText = document.createElement("span");
    nameText.classList.add(
      "neuroglancer-edit-session-entry-modal-layer-name",
    );
    nameText.textContent = name;
    includeLabel.appendChild(nameText);
    container.appendChild(includeLabel);

    // Resolution slot (label + value/picker — populated async).
    const resolutionWrap = document.createElement("span");
    resolutionWrap.classList.add(
      "neuroglancer-edit-session-entry-modal-layer-resolution",
    );
    const resolutionLabel = document.createElement("span");
    resolutionLabel.classList.add(
      "neuroglancer-edit-session-entry-modal-layer-resolution-label",
    );
    resolutionLabel.textContent = "Resolution:";
    resolutionWrap.appendChild(resolutionLabel);
    const resolutionSlot = document.createElement("span");
    resolutionSlot.classList.add(
      "neuroglancer-edit-session-entry-modal-layer-resolution-slot",
    );
    const loading = document.createElement("span");
    loading.classList.add(
      "neuroglancer-edit-session-entry-modal-layer-resolution-loading",
    );
    loading.textContent = "(loading…)";
    resolutionSlot.appendChild(loading);
    resolutionWrap.appendChild(resolutionSlot);
    container.appendChild(resolutionWrap);

    // Read-only checkbox (right-aligned).
    const lockLabel = document.createElement("label");
    lockLabel.classList.add(
      "neuroglancer-edit-session-entry-modal-layer-lock",
    );
    const lockBox = document.createElement("input");
    lockBox.type = "checkbox";
    lockBox.checked = false;
    lockLabel.appendChild(lockBox);
    const lockText = document.createElement("span");
    lockText.textContent = "Read-only";
    lockLabel.appendChild(lockText);
    container.appendChild(lockLabel);

    const row: LayerRow = {
      container,
      includeBox,
      lockBox,
      resolutionSlot,
      picker: undefined,
      resolution: undefined,
      included: true,
      locked: false,
      loadError: undefined,
      disposers: [],
    };

    includeBox.addEventListener("change", () => {
      row.included = includeBox.checked;
      this.applyIncludedStyling(row);
      if (!row.included) {
        row.locked = false;
        lockBox.checked = false;
      }
    });
    lockBox.addEventListener("change", () => {
      row.locked = lockBox.checked;
    });

    this.applyIncludedStyling(row);
    return row;
  }

  private applyIncludedStyling(row: LayerRow): void {
    if (row.included) {
      row.container.classList.remove(
        "neuroglancer-edit-session-entry-modal-layer-row-excluded",
      );
      row.lockBox.disabled = false;
    } else {
      row.container.classList.add(
        "neuroglancer-edit-session-entry-modal-layer-row-excluded",
      );
      row.lockBox.disabled = true;
    }
  }

  private async loadLayerMetadata(name: string): Promise<void> {
    const layerId = toLayerId(name);
    let metadata: LayerMetadata;
    try {
      metadata = await this.metadataSource.resolve(layerId);
    } catch (err) {
      if (this.disposed_) return;
      const row = this.layerRows.get(name);
      if (row === undefined) return;
      row.loadError = err instanceof Error ? err.message : String(err);
      this.fillResolutionSlot(
        row,
        this.makeErrorNode(`(unavailable: ${row.loadError})`),
      );
      return;
    }

    if (this.disposed_) return;
    const row = this.layerRows.get(name);
    if (row === undefined) return;

    const resolutions = availableResolutions(metadata);
    if (resolutions.length === 0) {
      row.loadError = "no resolutions";
      this.fillResolutionSlot(
        row,
        this.makeErrorNode("(no resolutions available)"),
      );
      return;
    }
    if (resolutions.length === 1) {
      // Single-resolution layers render as a static label, not a dropdown.
      row.resolution = resolutions[0];
      const node = document.createElement("span");
      node.classList.add(
        "neuroglancer-edit-session-entry-modal-layer-resolution-static",
      );
      node.textContent = resolutions[0];
      this.fillResolutionSlot(row, node);
      return;
    }

    const picker = new ResolutionPicker(metadata);
    row.picker = picker;
    row.resolution = picker.selection;
    row.disposers.push(
      picker.selectionChanged.add(() => {
        row.resolution = picker.selection;
      }),
    );
    this.fillResolutionSlot(row, picker.element);
  }

  private fillResolutionSlot(row: LayerRow, replacement: HTMLElement): void {
    while (row.resolutionSlot.firstChild !== null) {
      row.resolutionSlot.removeChild(row.resolutionSlot.firstChild);
    }
    row.resolutionSlot.appendChild(replacement);
  }

  private makeErrorNode(text: string): HTMLElement {
    const span = document.createElement("span");
    span.classList.add(
      "neuroglancer-edit-session-entry-modal-layer-resolution-error",
    );
    span.textContent = text;
    return span;
  }

  private disposeRow(row: LayerRow): void {
    for (const d of row.disposers) {
      try {
        d();
      } catch {
        // ignore
      }
    }
    if (row.picker !== undefined) {
      try {
        row.picker.dispose();
      } catch {
        // ignore
      }
    }
  }

  // -------------------------------------------------------------------------
  // Submission
  // -------------------------------------------------------------------------

  private cancel(): void {
    if (this.submitting) return;
    this.onClose();
  }

  private showError(message: string): void {
    this.errorLine.textContent = message;
  }

  private clearError(): void {
    this.errorLine.textContent = "";
  }

  private async onSubmit(): Promise<void> {
    if (this.submitting) return;
    this.clearError();

    const bbox = this.selectedBbox;
    if (bbox === undefined) {
      this.showError("Select a bounding box annotation.");
      return;
    }

    const includedRows: Array<{
      layerId: LayerId;
      name: string;
      row: LayerRow;
    }> = [];
    let firstWritableResolution: Resolution | undefined;
    let hasWritable = false;
    for (const [name, row] of this.layerRows) {
      if (!row.included) continue;
      if (row.loadError !== undefined) {
        this.showError(`Layer ${name} is unavailable: ${row.loadError}`);
        return;
      }
      if (row.resolution === undefined) {
        this.showError(`Pick a resolution for layer ${name}.`);
        return;
      }
      const id = toLayerId(name);
      includedRows.push({ layerId: id, name, row });
      if (!row.locked) {
        hasWritable = true;
        if (firstWritableResolution === undefined) {
          firstWritableResolution = row.resolution;
        }
      }
    }

    if (!hasWritable) {
      this.showError("Select at least one writable layer.");
      return;
    }

    const layersForConfig: HostSessionConfig["layers"][number][] = [];
    for (const { layerId, name, row } of includedRows) {
      try {
        const metadata = await this.metadataSource.resolve(layerId);
        const available = availableResolutions(metadata);
        if (!available.includes(row.resolution!)) {
          this.showError(
            `Resolution ${row.resolution} is not available on layer ${name}.`,
          );
          return;
        }
      } catch (err) {
        this.showError(
          `Could not resolve metadata for layer ${name}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }
      layersForConfig.push({
        layerId,
        resolution: row.resolution!,
        role: row.locked ? "locked" : "writable",
      });
    }

    // Bbox resolution: annotation layers don't expose volumetric metadata, so
    // use the first writable layer's chosen resolution as a proxy.
    const config: HostSessionConfig = {
      bboxRef: {
        annotationLayerName: bbox.annotationLayerName,
        annotationId: bbox.annotationId,
      },
      bboxVoxelCoords: bbox.voxelBbox,
      bboxResolution: firstWritableResolution!,
      layers: layersForConfig,
    };

    this.submitting = true;
    this.submitButton.disabled = true;
    this.cancelButton.disabled = true;
    this.closeButton.disabled = true;
    try {
      await this.host.openSession(config);
      this.onClose();
    } catch (err) {
      this.submitting = false;
      this.submitButton.disabled = false;
      this.cancelButton.disabled = false;
      this.closeButton.disabled = false;
      this.showError(err instanceof Error ? err.message : String(err));
    }
  }
}
