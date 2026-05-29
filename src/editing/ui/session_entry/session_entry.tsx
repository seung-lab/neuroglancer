/**
 * @license
 * Copyright 2026 Calcada AI / Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

import type { LayerId, LayerMetadata } from "@zetta-ai/edit-session";
import {
  availableResolutions,
  layerId as toLayerId,
  Resolution,
} from "@zetta-ai/edit-session";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";

import type { NgLayerMetadataSource } from "#src/editing/adapters/ng_layer_metadata_source.js";
import type {
  EditSessionHost,
  HostSessionConfig,
} from "#src/editing/edit_session_host.js";
import { useSignal } from "#src/editing/ui/interop/use_signal.js";
import type {
  BboxSelectionModel,
  BboxAnnotationSelection,
} from "#src/editing/ui/session_entry/bbox_candidates.js";
import { BboxPicker } from "#src/editing/ui/session_entry/bbox_picker.js";
import type { LayerRowState } from "#src/editing/ui/session_entry/layer_row.js";
import { LayerRow } from "#src/editing/ui/session_entry/layer_row.js";
import { ResolutionSelectionModel } from "#src/editing/ui/session_entry/resolution_options.js";
import { ImageUserLayer } from "#src/layer/image/index.js";
import type { LayerManager } from "#src/layer/index.js";
import { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import "#src/editing/ui/session_entry/session_entry.css";

export function SessionEntryModal(props: {
  host: EditSessionHost;
  layerManager: LayerManager;
  metadataSource: NgLayerMetadataSource;
  bboxModel: BboxSelectionModel;
  onClose: () => void;
}) {
  const { host, layerManager, metadataSource, bboxModel, onClose } = props;

  const [selectedBbox, setSelectedBbox] = useState<
    BboxAnnotationSelection | undefined
  >(bboxModel.selection);
  const [layerNames, setLayerNames] = useState<string[]>(() =>
    collectLayerNames(layerManager),
  );
  const [layerStates, setLayerStates] = useState<Map<string, LayerRowState>>(
    () => new Map(),
  );
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const resolutionModelsRef = useRef<Map<string, ResolutionSelectionModel>>(new Map());

  useSignal(bboxModel.selectionChanged);
  useSignal(bboxModel.entriesChanged);

  useEffect(() => {
    setSelectedBbox(bboxModel.selection);
  }, [bboxModel.selection, bboxModel.selectedKey, bboxModel.entries]);

  useEffect(() => {
    const removeLayers = layerManager.layersChanged.add(() => {
      setLayerNames(collectLayerNames(layerManager));
    });
    return () => {
      removeLayers();
    };
  }, [layerManager]);

  useEffect(() => {
    setLayerStates((prev) => {
      const next = new Map<string, LayerRowState>();
      for (const name of layerNames) {
        const existing = prev.get(name);
        if (existing !== undefined) {
          next.set(name, existing);
        } else {
          next.set(name, {
            included: true,
            locked: false,
            resolutions: [],
            loadState: "loading",
            loadError: undefined,
            availableResolutions: [],
          });
        }
      }
      for (const [name] of resolutionModelsRef.current) {
        if (!layerNames.includes(name)) {
          resolutionModelsRef.current.delete(name);
        }
      }
      return next;
    });
  }, [layerNames]);

  useEffect(() => {
    let cancelled = false;
    const toLoad: string[] = [];
    for (const [name, state] of layerStates) {
      if (state.loadState === "loading") {
        toLoad.push(name);
      }
    }
    for (const name of toLoad) {
      const layerId = toLayerId(name);
      metadataSource.resolve(layerId).then(
        (metadata: LayerMetadata) => {
          if (cancelled) return;
          const resolutions = availableResolutions(metadata);
          if (resolutions.length === 0) {
            setLayerStates((prev) => {
              const next = new Map(prev);
              const s = next.get(name);
              if (s === undefined || s.loadState !== "loading") return prev;
              next.set(name, {
                ...s,
                loadState: "error",
                loadError: "no resolutions",
                availableResolutions: [],
              });
              return next;
            });
            return;
          }
          const model = new ResolutionSelectionModel(metadata);
          resolutionModelsRef.current.set(name, model);
          model.selectionChanged.add(() => {
            setLayerStates((prev) => {
              const next = new Map(prev);
              const s = next.get(name);
              if (s === undefined) return prev;
              next.set(name, { ...s, resolutions: model.selectedResolutions });
              return next;
            });
          });
          setLayerStates((prev) => {
            const next = new Map(prev);
            const s = next.get(name);
            if (s === undefined || s.loadState !== "loading") return prev;
            next.set(name, {
              ...s,
              loadState: "loaded",
              resolutions: model.selectedResolutions,
              availableResolutions: resolutions,
            });
            return next;
          });
        },
        (err: unknown) => {
          if (cancelled) return;
          setLayerStates((prev) => {
            const next = new Map(prev);
            const s = next.get(name);
            if (s === undefined || s.loadState !== "loading") return prev;
            next.set(name, {
              ...s,
              loadState: "error",
              loadError: err instanceof Error ? err.message : String(err),
              availableResolutions: [],
            });
            return next;
          });
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [layerStates, metadataSource]);

  const setIncluded = useCallback((name: string, included: boolean) => {
    setLayerStates((prev) => {
      const next = new Map(prev);
      const s = next.get(name);
      if (s === undefined) return prev;
      next.set(name, {
        ...s,
        included,
        locked: included ? s.locked : false,
      });
      return next;
    });
  }, []);

  const setLocked = useCallback((name: string, locked: boolean) => {
    setLayerStates((prev) => {
      const next = new Map(prev);
      const s = next.get(name);
      if (s === undefined) return prev;
      next.set(name, { ...s, locked });
      return next;
    });
  }, []);

  const cancel = useCallback(() => {
    if (submitting) return;
    onClose();
  }, [submitting, onClose]);

  const handleSubmit = useCallback(async () => {
    if (submitting) return;
    setError("");

    if (selectedBbox === undefined) {
      setError("Select a bounding box annotation.");
      return;
    }

    const includedRows: Array<{
      layerId: LayerId;
      name: string;
      state: LayerRowState;
    }> = [];
    let hasWritable = false;
    for (const name of layerNames) {
      const state = layerStates.get(name);
      if (state === undefined || !state.included) continue;
      if (state.loadError !== undefined) {
        setError(`Layer ${name} is unavailable: ${state.loadError}`);
        return;
      }
      if (state.resolutions.length === 0) {
        setError(`Pick at least one resolution for layer ${name}.`);
        return;
      }
      const id = toLayerId(name);
      includedRows.push({ layerId: id, name, state });
      if (!state.locked) {
        hasWritable = true;
      }
    }

    if (!hasWritable) {
      setError("Select at least one writable layer.");
      return;
    }

    const layersForConfig: HostSessionConfig["layers"][number][] = [];
    for (const { layerId, name, state } of includedRows) {
      try {
        const metadata = await metadataSource.resolve(layerId);
        const available = availableResolutions(metadata);
        for (const r of state.resolutions) {
          if (!available.includes(r)) {
            setError(`Resolution ${r} is not available on layer ${name}.`);
            return;
          }
        }
      } catch (err) {
        setError(
          `Could not resolve metadata for layer ${name}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }
      layersForConfig.push({
        layerId,
        resolutions: [...state.resolutions],
        role: state.locked ? "locked" : "writable",
      });
    }

    // bboxResolution is derived from the annotation source's own coord
    // system (captured at selection time), NOT from any session layer's
    // chosen resolution. Mixing the two physically rescales the bbox-clip
    // region whenever the user picks a non-default layer resolution.
    const config: HostSessionConfig = {
      bboxRef: {
        annotationLayerName: selectedBbox.annotationLayerName,
        annotationId: selectedBbox.annotationId,
      },
      bboxVoxelCoords: selectedBbox.voxelBbox,
      bboxResolution: Resolution.from(selectedBbox.voxelSizeNm),
      layers: layersForConfig,
    };

    setSubmitting(true);
    try {
      await host.openSession(config);
      onClose();
    } catch (err) {
      setSubmitting(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [
    submitting,
    selectedBbox,
    layerNames,
    layerStates,
    metadataSource,
    host,
    onClose,
  ]);

  const bboxInfoText =
    selectedBbox === undefined
      ? "(no bbox selected)"
      : `${selectedBbox.annotationLayerName} · ${Math.round(selectedBbox.voxelBbox[3] - selectedBbox.voxelBbox[0])}×${Math.round(selectedBbox.voxelBbox[4] - selectedBbox.voxelBbox[1])}×${Math.round(selectedBbox.voxelBbox[5] - selectedBbox.voxelBbox[2])} voxels`;

  return (
    <div
      class="neuroglancer-edit-session-entry-modal-backdrop"
      onClick={cancel}
    >
      <div
        class="neuroglancer-edit-session-entry-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="neuroglancer-edit-session-entry-modal-header">
          <span>Enter Edit Session</span>
          <button
            type="button"
            class="neuroglancer-edit-session-entry-modal-close"
            title="Close"
            disabled={submitting}
            onClick={cancel}
          >
            &times;
          </button>
        </div>
        <div class="neuroglancer-edit-session-entry-modal-body">
          <div>
            <div class="neuroglancer-edit-session-entry-modal-section-title">
              Bounding box annotation
            </div>
            <BboxPicker
              entries={bboxModel.entries}
              selectedKey={bboxModel.selectedKey}
              onChange={(k) => bboxModel.select(k)}
            />
            <div class="neuroglancer-edit-session-entry-modal-bbox-info">
              {bboxInfoText}
            </div>
          </div>
          <div>
            <div class="neuroglancer-edit-session-entry-modal-section-title">
              Layers
            </div>
            <div class="neuroglancer-edit-session-entry-modal-layers-card">
              <div class="neuroglancer-edit-session-entry-modal-layers-list">
                {layerNames.length === 0 ? (
                  <div class="neuroglancer-edit-session-entry-modal-layers-empty">
                    (no editable layers loaded)
                  </div>
                ) : (
                  layerNames.map((name) => {
                    const state = layerStates.get(name);
                    if (state === undefined) return null;
                    return (
                      <LayerRow
                        key={name}
                        name={name}
                        state={state}
                        resolutionModel={resolutionModelsRef.current.get(name)}
                        onIncludedChange={(v) => setIncluded(name, v)}
                        onLockedChange={(v) => setLocked(name, v)}
                      />
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
        <div class="neuroglancer-edit-session-entry-modal-footer">
          <div class="neuroglancer-edit-session-entry-modal-error">{error}</div>
          <button type="button" disabled={submitting} onClick={cancel}>
            Cancel
          </button>
          <button
            type="button"
            class="primary"
            disabled={submitting}
            onClick={() => {
              void handleSubmit();
            }}
          >
            Open Session
          </button>
        </div>
      </div>
    </div>
  );
}

function collectLayerNames(layerManager: LayerManager): string[] {
  const names: string[] = [];
  for (const managed of layerManager.managedLayers) {
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
