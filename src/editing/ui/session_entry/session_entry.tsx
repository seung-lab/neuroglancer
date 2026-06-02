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
  VoxelDataType,
} from "@zettaai/edit-session";
import {
  availableResolutions,
  layerId as toLayerId,
  Resolution,
} from "@zettaai/edit-session";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

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
import type {
  LayerKind,
  LayerRowState,
} from "#src/editing/ui/session_entry/layer_row.js";
import { LayerRow } from "#src/editing/ui/session_entry/layer_row.js";
import { ResolutionSelectionModel } from "#src/editing/ui/session_entry/resolution_options.js";
import { ImageUserLayer } from "#src/layer/image/index.js";
import type { LayerManager, ManagedUserLayer } from "#src/layer/index.js";
import { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import "#src/editing/ui/session_entry/session_entry.css";

interface LayerEntry {
  readonly name: string;
  readonly kind: LayerKind;
  readonly visible: boolean;
}

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
  const [layerEntries, setLayerEntries] = useState<LayerEntry[]>(() =>
    collectLayerEntries(layerManager),
  );
  const [layerStates, setLayerStates] = useState<Map<string, LayerRowState>>(
    () => new Map(),
  );
  const [metadataByLayer, setMetadataByLayer] = useState<
    Map<string, LayerMetadata>
  >(() => new Map());
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
      setLayerEntries(collectLayerEntries(layerManager));
    });
    return () => {
      removeLayers();
    };
  }, [layerManager]);

  useEffect(() => {
    setLayerStates((prev) => {
      const next = new Map<string, LayerRowState>();
      for (const entry of layerEntries) {
        const existing = prev.get(entry.name);
        if (existing !== undefined) {
          next.set(entry.name, existing);
        } else {
          next.set(entry.name, defaultStateFor(entry));
        }
      }
      for (const [name] of resolutionModelsRef.current) {
        if (!layerEntries.some((e) => e.name === name)) {
          resolutionModelsRef.current.delete(name);
        }
      }
      return next;
    });
  }, [layerEntries]);

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
          setMetadataByLayer((prev) => {
            const next = new Map(prev);
            next.set(name, metadata);
            return next;
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

  const setLocked = useCallback((name: string, locked: boolean) => {
    setLayerStates((prev) => {
      const next = new Map(prev);
      const s = next.get(name);
      if (s === undefined) return prev;
      next.set(name, {
        ...s,
        locked,
        // Disable writable when the layer leaves the session.
        writable: locked ? s.writable : false,
      });
      return next;
    });
  }, []);

  const setWritable = useCallback((name: string, writable: boolean) => {
    setLayerStates((prev) => {
      const next = new Map(prev);
      const s = next.get(name);
      if (s === undefined) return prev;
      next.set(name, { ...s, writable });
      return next;
    });
  }, []);

  const cancel = useCallback(() => {
    if (submitting) return;
    onClose();
  }, [submitting, onClose]);

  const memoryEstimate = useMemo(
    () =>
      estimateLockedMemory({
        layerEntries,
        layerStates,
        metadataByLayer,
        bbox: selectedBbox,
      }),
    [layerEntries, layerStates, metadataByLayer, selectedBbox],
  );

  const limits = useMemo(
    () => ({
      gpu: host.viewer.chunkManager.chunkQueueManager.capacities.gpuMemory.sizeLimit
        .value,
      system:
        host.viewer.chunkManager.chunkQueueManager.capacities.systemMemory
          .sizeLimit.value,
    }),
    [host],
  );

  const handleSubmit = useCallback(async () => {
    if (submitting) return;
    setError("");

    if (selectedBbox === undefined) {
      setError("Select a bounding box annotation.");
      return;
    }

    const lockedEntries: Array<{
      layerId: LayerId;
      name: string;
      state: LayerRowState;
    }> = [];
    let hasWritable = false;
    for (const entry of layerEntries) {
      const state = layerStates.get(entry.name);
      if (state === undefined || !state.locked) continue;
      if (state.loadError !== undefined) {
        setError(`Layer ${entry.name} is unavailable: ${state.loadError}`);
        return;
      }
      if (state.resolutions.length === 0) {
        setError(`Pick at least one resolution for layer ${entry.name}.`);
        return;
      }
      const id = toLayerId(entry.name);
      lockedEntries.push({ layerId: id, name: entry.name, state });
      if (state.writable) hasWritable = true;
    }

    if (lockedEntries.length === 0) {
      setError("Lock at least one layer to include it in the session.");
      return;
    }
    if (!hasWritable) {
      setError("Mark at least one locked layer as writable.");
      return;
    }

    const gpuExceeded =
      Number.isFinite(limits.gpu) && memoryEstimate.totalBytes > limits.gpu;
    const systemExceeded =
      Number.isFinite(limits.system) &&
      memoryEstimate.totalBytes > limits.system;
    if (gpuExceeded || systemExceeded) {
      const parts: string[] = [];
      if (gpuExceeded) {
        parts.push(
          `GPU memory limit (${formatBytes(limits.gpu)})`,
        );
      }
      if (systemExceeded) {
        parts.push(
          `system memory limit (${formatBytes(limits.system)})`,
        );
      }
      const proceed = window.confirm(
        `Locked chunks will use ~${formatBytes(memoryEstimate.totalBytes)}, ` +
          `exceeding your ${parts.join(" and ")}. ` +
          `Continue anyway? You can raise the limits in Settings.`,
      );
      if (!proceed) return;
    }

    const layersForConfig: HostSessionConfig["layers"][number][] = [];
    for (const { layerId, name, state } of lockedEntries) {
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
        writable: state.writable,
      });
    }

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
    layerEntries,
    layerStates,
    metadataSource,
    host,
    onClose,
    memoryEstimate,
    limits,
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
                {layerEntries.length === 0 ? (
                  <div class="neuroglancer-edit-session-entry-modal-layers-empty">
                    (no editable layers loaded)
                  </div>
                ) : (
                  layerEntries.map((entry) => {
                    const state = layerStates.get(entry.name);
                    if (state === undefined) return null;
                    return (
                      <LayerRow
                        key={entry.name}
                        name={entry.name}
                        layerKind={entry.kind}
                        state={state}
                        resolutionModel={resolutionModelsRef.current.get(
                          entry.name,
                        )}
                        onLockedChange={(v) => setLocked(entry.name, v)}
                        onWritableChange={(v) => setWritable(entry.name, v)}
                      />
                    );
                  })
                )}
              </div>
            </div>
            <MemoryEstimate
              estimate={memoryEstimate}
              limits={limits}
            />
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

function MemoryEstimate({
  estimate,
  limits,
}: {
  estimate: MemoryEstimate;
  limits: { gpu: number; system: number };
}) {
  if (estimate.totalBytes === 0) return null;
  const gpuOver =
    Number.isFinite(limits.gpu) && estimate.totalBytes > limits.gpu;
  const systemOver =
    Number.isFinite(limits.system) && estimate.totalBytes > limits.system;
  const overClass =
    gpuOver || systemOver
      ? "neuroglancer-edit-session-entry-modal-memory-estimate neuroglancer-edit-session-entry-modal-memory-estimate-over"
      : "neuroglancer-edit-session-entry-modal-memory-estimate";
  return (
    <div class={overClass}>
      Locked chunks: ~{formatBytes(estimate.totalBytes)}
      {" · "}GPU limit {formatBytes(limits.gpu)}
      {" · "}System limit {formatBytes(limits.system)}
      {(gpuOver || systemOver) && " — over limit, will require confirmation"}
    </div>
  );
}

interface MemoryEstimate {
  readonly totalBytes: number;
}

function estimateLockedMemory({
  layerEntries,
  layerStates,
  metadataByLayer,
  bbox,
}: {
  layerEntries: readonly LayerEntry[];
  layerStates: ReadonlyMap<string, LayerRowState>;
  metadataByLayer: ReadonlyMap<string, LayerMetadata>;
  bbox: BboxAnnotationSelection | undefined;
}): MemoryEstimate {
  if (bbox === undefined) return { totalBytes: 0 };
  const bboxExtentVoxels: [number, number, number] = [
    bbox.voxelBbox[3] - bbox.voxelBbox[0],
    bbox.voxelBbox[4] - bbox.voxelBbox[1],
    bbox.voxelBbox[5] - bbox.voxelBbox[2],
  ];
  let total = 0;
  for (const entry of layerEntries) {
    const state = layerStates.get(entry.name);
    if (state === undefined || !state.locked) continue;
    const metadata = metadataByLayer.get(entry.name);
    if (metadata === undefined) continue;
    const bytesPerVoxel = bytesPerVoxelFor(metadata.voxelDataType);
    if (bytesPerVoxel === 0) continue;
    const channels = Math.max(1, metadata.channels);
    for (const resolution of state.resolutions) {
      const scale = metadata.scales.find((s) => s.resolution === resolution);
      if (scale === undefined) continue;
      const extentNm: [number, number, number] = [
        bboxExtentVoxels[0] * bbox.voxelSizeNm[0],
        bboxExtentVoxels[1] * bbox.voxelSizeNm[1],
        bboxExtentVoxels[2] * bbox.voxelSizeNm[2],
      ];
      const extentLayerVoxels: [number, number, number] = [
        extentNm[0] / scale.voxelSizeNm[0],
        extentNm[1] / scale.voxelSizeNm[1],
        extentNm[2] / scale.voxelSizeNm[2],
      ];
      const chunksX = Math.max(
        1,
        Math.ceil(extentLayerVoxels[0] / scale.chunkDataSize[0]),
      );
      const chunksY = Math.max(
        1,
        Math.ceil(extentLayerVoxels[1] / scale.chunkDataSize[1]),
      );
      const chunksZ = Math.max(
        1,
        Math.ceil(extentLayerVoxels[2] / scale.chunkDataSize[2]),
      );
      const chunkVoxels =
        scale.chunkDataSize[0] *
        scale.chunkDataSize[1] *
        scale.chunkDataSize[2];
      total +=
        chunksX *
        chunksY *
        chunksZ *
        chunkVoxels *
        bytesPerVoxel *
        channels;
    }
  }
  return { totalBytes: total };
}

function bytesPerVoxelFor(dataType: VoxelDataType): number {
  switch (dataType) {
    case "uint8":
    case "int8":
      return 1;
    case "uint16":
    case "int16":
      return 2;
    case "uint32":
    case "int32":
    case "float32":
      return 4;
    case "uint64":
      return 8;
    default:
      return 0;
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "∞";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function defaultStateFor(entry: LayerEntry): LayerRowState {
  return {
    locked: entry.visible,
    writable: entry.visible && entry.kind === "segmentation",
    resolutions: [],
    loadState: "loading",
    loadError: undefined,
    availableResolutions: [],
  };
}

function collectLayerEntries(layerManager: LayerManager): LayerEntry[] {
  const entries: LayerEntry[] = [];
  for (const managed of layerManager.managedLayers) {
    const kind = layerKindOf(managed);
    if (kind === undefined) continue;
    entries.push({
      name: managed.name,
      kind,
      visible: managed.visible,
    });
  }
  return entries;
}

function layerKindOf(managed: ManagedUserLayer): LayerKind | undefined {
  const userLayer = managed.layer;
  if (userLayer instanceof SegmentationUserLayer) return "segmentation";
  if (userLayer instanceof ImageUserLayer) return "image";
  return undefined;
}
