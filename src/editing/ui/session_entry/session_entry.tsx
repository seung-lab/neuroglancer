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
import { X } from "lucide-preact";
import { createPortal } from "preact/compat";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";

import type { NgLayerMetadataSource } from "#src/editing/adapters/ng_layer_metadata_source.js";
import type {
  EditSessionHost,
  HostSessionConfig,
} from "#src/editing/edit_session_host.js";
import { useModalDialog } from "#src/editing/ui/interop/use_modal_dialog.js";
import { useSignal } from "#src/editing/ui/interop/use_signal.js";
import type { LayerKind } from "#src/editing/ui/layer_kind.js";
import { layerKindOf } from "#src/editing/ui/layer_kind.js";
import type { BboxAnnotationSelection } from "#src/editing/ui/session_entry/bbox_candidates.js";
import { BboxSelectionModel } from "#src/editing/ui/session_entry/bbox_candidates.js";
import { BboxPicker } from "#src/editing/ui/session_entry/bbox_picker.js";
import type {
  LayerRole,
  LayerRowState,
} from "#src/editing/ui/session_entry/layer_row.js";
import { LayerRow } from "#src/editing/ui/session_entry/layer_row.js";
import { ResolutionSelectionModel } from "#src/editing/ui/session_entry/resolution_options.js";
import type { LayerManager } from "#src/layer/index.js";
import "#src/editing/ui/session_entry/session_entry.css";

// ---------------------------------------------------------------------------
// Public contract (consumed by TM-294's topbar Edit button)
// ---------------------------------------------------------------------------

export interface SessionEntryModalProps {
  open: boolean;
  onClose: () => void;
  host: EditSessionHost;
  /**
   * When set, the modal selects the bbox with this `BboxSelectionModel` entry
   * key on open (the quick edit-region flow, TM-290), overriding the default
   * "newest bbox" auto-selection. Ignored if the key isn't among the
   * candidate bboxes.
   */
  preselectBboxKey?: string;
}

/**
 * Legacy props shape used by the old `EnterEditSessionButton` wrapper that
 * mounts the modal directly (no portal, always-open). Kept while TM-294 is
 * still in flight; the wrapper file is owned by TM-294 and will be removed
 * once the new topbar Edit button ships.
 */
interface LegacySessionEntryModalProps {
  host: EditSessionHost;
  layerManager: LayerManager;
  metadataSource: NgLayerMetadataSource;
  bboxModel: BboxSelectionModel;
  onClose: () => void;
}

export function SessionEntryModal(
  props: SessionEntryModalProps | LegacySessionEntryModalProps,
) {
  // New contract: gated by `open`, mounts its own portal.
  if ("open" in props) {
    const { open, onClose, host, preselectBboxKey } = props;
    if (!open) return null;
    return createPortal(
      <SessionEntryModalBody
        host={host}
        onClose={onClose}
        preselectBboxKey={preselectBboxKey}
      />,
      document.body,
    );
  }
  // Legacy path: caller manages mounting, supplies pre-built bboxModel.
  // No portal here (legacy wrapper renders inside its own portal call).
  return (
    <SessionEntryModalBody
      host={props.host}
      onClose={props.onClose}
      bboxModelOverride={props.bboxModel}
    />
  );
}

// ---------------------------------------------------------------------------
// Microcopy (spec strings, verbatim)
// ---------------------------------------------------------------------------

// `aria-labelledby` target for the dialog. Only one entry modal can be open
// at a time (the topbar gates `open`), so a fixed id is safe.
const MODAL_TITLE_ID = "neuroglancer-edit-session-entry-modal-title";

const LAYERS_SECTION_CAPTION =
  "Reference layers stay read-only; editable layers receive your edits. " +
  "Off layers load dynamically and don't use the budget.";

const OPEN_DISABLED_TOOLTIP =
  "Set at least one layer to Editable to start a session.";

const MEMORY_LABEL_WITHIN = "within limits";
const MEMORY_LABEL_NEAR = "near GPU budget";
const MEMORY_LABEL_OVER = "over budget";

// Amber zone starts at 80% of the GPU budget. Tunable: a single threshold
// keeps the meter behavior predictable and easy to reason about.
const MEMORY_NEAR_FRACTION = 0.8;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface LayerEntry {
  readonly name: string;
  readonly kind: LayerKind;
  readonly visible: boolean;
}

// ---------------------------------------------------------------------------
// Modal body (mounted only when open === true)
// ---------------------------------------------------------------------------

function SessionEntryModalBody(props: {
  host: EditSessionHost;
  onClose: () => void;
  /**
   * Legacy escape hatch: when present, the modal uses the caller-provided
   * bbox model instead of constructing/disposing its own. Used by the
   * pre-TM-294 wrapper to share a model with its open-gate logic.
   */
  bboxModelOverride?: BboxSelectionModel;
  /** Bbox entry key to select on open (TM-290 quick edit-region flow). */
  preselectBboxKey?: string;
}) {
  const { host, onClose, bboxModelOverride, preselectBboxKey } = props;
  const layerManager: LayerManager = host.viewer.layerManager;
  const metadataSource = host.layerMetadataSource;

  // The bbox model lives for the lifetime of the modal — we mount/dispose it
  // here rather than on the host so the modal is fully self-contained per
  // the SessionEntryModalProps contract. Legacy callers may pass their own
  // model in; in that case we don't own its lifecycle.
  const ownsBboxModel = bboxModelOverride === undefined;
  const bboxModel = useMemo(
    () => bboxModelOverride ?? new BboxSelectionModel(layerManager),
    [bboxModelOverride, layerManager],
  );
  useEffect(
    () => () => {
      if (ownsBboxModel) bboxModel.dispose();
    },
    [bboxModel, ownsBboxModel],
  );

  useSignal(bboxModel.selectionChanged);
  useSignal(bboxModel.entriesChanged);

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

  const resolutionModelsRef = useRef<Map<string, ResolutionSelectionModel>>(
    new Map(),
  );
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSelectedBbox(bboxModel.selection);
  }, [bboxModel.selection, bboxModel.selectedKey, bboxModel.entries]);

  // Quick edit-region flow (TM-290): once the just-drawn box shows up among
  // the candidates, select it — overriding the default newest-bbox pick.
  // Applied at most once per requested key.
  const preselectAppliedRef = useRef(false);
  useEffect(() => {
    preselectAppliedRef.current = false;
  }, [preselectBboxKey]);
  useEffect(() => {
    if (preselectBboxKey === undefined || preselectAppliedRef.current) return;
    if (bboxModel.entries.some((e) => e.key === preselectBboxKey)) {
      preselectAppliedRef.current = true;
      bboxModel.select(preselectBboxKey);
    }
  }, [bboxModel, preselectBboxKey, bboxModel.entries]);

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

  const setRole = useCallback((name: string, role: LayerRole) => {
    setLayerStates((prev) => {
      const next = new Map(prev);
      const s = next.get(name);
      if (s === undefined) return prev;
      if (s.role === role) return prev;
      next.set(name, { ...s, role });
      return next;
    });
  }, []);

  const cancel = useCallback(() => {
    if (submitting) return;
    onClose();
  }, [submitting, onClose]);

  // Dialog a11y: focus trap, autofocus, Escape-to-close (vetoed mid-submit by
  // `cancel`), focus restore, and key isolation from Neuroglancer hotkeys.
  useModalDialog({ active: true, containerRef: dialogRef, onClose: cancel });

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
      gpu: host.viewer.chunkManager.chunkQueueManager.capacities.gpuMemory
        .sizeLimit.value,
      system:
        host.viewer.chunkManager.chunkQueueManager.capacities.systemMemory
          .sizeLimit.value,
    }),
    [host],
  );

  // Counters derived from current state — used by the open-session gate and
  // by the memory meter label.
  const counters = useMemo(() => {
    let editable = 0;
    let reference = 0;
    let off = 0;
    for (const state of layerStates.values()) {
      if (state.role === "editable") editable += 1;
      else if (state.role === "reference") reference += 1;
      else off += 1;
    }
    return { editable, reference, off };
  }, [layerStates]);

  const hasBbox = selectedBbox !== undefined;
  const hasEditable = counters.editable > 0;
  const openSessionDisabled = submitting || !hasBbox || !hasEditable;
  const openSessionTooltip = !hasEditable ? OPEN_DISABLED_TOOLTIP : undefined;

  const handleSubmit = useCallback(async () => {
    if (submitting) return;
    setError("");

    if (selectedBbox === undefined) {
      setError("Select a bounding box annotation.");
      return;
    }

    const includedEntries: Array<{
      layerId: LayerId;
      name: string;
      state: LayerRowState;
    }> = [];
    let hasWritable = false;
    for (const entry of layerEntries) {
      const state = layerStates.get(entry.name);
      if (state === undefined || state.role === "off") continue;
      if (state.loadError !== undefined) {
        setError(`Layer ${entry.name} is unavailable: ${state.loadError}`);
        return;
      }
      if (state.resolutions.length === 0) {
        setError(`Pick at least one resolution for layer ${entry.name}.`);
        return;
      }
      const id = toLayerId(entry.name);
      includedEntries.push({ layerId: id, name: entry.name, state });
      if (state.role === "editable") hasWritable = true;
    }

    if (!hasWritable) {
      setError("Mark at least one layer as Editable.");
      return;
    }

    const layersForConfig: HostSessionConfig["layers"][number][] = [];
    for (const { layerId, name, state } of includedEntries) {
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
      // Map LayerRole → boolean `writable` per Contract 2:
      //   editable  → writable: true
      //   reference → writable: false
      //   off       → not added (filtered out above)
      layersForConfig.push({
        layerId,
        resolutions: [...state.resolutions],
        writable: state.role === "editable",
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
  ]);

  const lockedLayerCount = counters.editable + counters.reference;

  return (
    <div
      class="neuroglancer-edit-session-entry-modal-backdrop"
      onClick={cancel}
    >
      <div
        ref={dialogRef}
        class="neuroglancer-edit-session-entry-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={MODAL_TITLE_ID}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div class="neuroglancer-edit-session-entry-modal-header">
          <span id={MODAL_TITLE_ID}>Enter Edit Session</span>
          <button
            type="button"
            class="neuroglancer-edit-session-entry-modal-close"
            data-tooltip="Close"
            aria-label="Close"
            disabled={submitting}
            onClick={cancel}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div class="neuroglancer-edit-session-entry-modal-body">
          <section>
            <div class="neuroglancer-edit-session-entry-modal-section-title">
              Region
            </div>
            <BboxPicker
              entries={bboxModel.entries}
              selectedKey={bboxModel.selectedKey}
              selection={selectedBbox}
              onChange={(k) => bboxModel.select(k)}
            />
          </section>
          <section>
            <div class="neuroglancer-edit-session-entry-modal-section-title">
              Layers
            </div>
            <div class="neuroglancer-edit-session-entry-modal-section-caption">
              {LAYERS_SECTION_CAPTION}
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
                        onRoleChange={(role) => setRole(entry.name, role)}
                      />
                    );
                  })
                )}
              </div>
            </div>
            <MemoryMeter
              estimate={memoryEstimate}
              limits={limits}
              lockedLayerCount={lockedLayerCount}
            />
            {layerEntries.length > 0 && (
              <SessionSummary
                editable={counters.editable}
                reference={counters.reference}
                off={counters.off}
              />
            )}
          </section>
        </div>
        <div class="neuroglancer-edit-session-entry-modal-footer">
          <div
            class="neuroglancer-edit-session-entry-modal-error"
            role="alert"
            aria-live="assertive"
          >
            {error}
          </div>
          <button
            type="button"
            class="neuroglancer-edit-session-entry-modal-btn"
            disabled={submitting}
            onClick={cancel}
          >
            Cancel
          </button>
          {/* Wrapper carries the tooltip so the hint still shows while the
              button is disabled — disabled buttons don't emit pointer events,
              so the disabled button drops to pointer-events:none (in CSS) and
              hover falls through to this span. `openSessionTooltip` is only set
              when disabled, so the wrapper has no tooltip in the enabled case. */}
          <span
            class="neuroglancer-edit-session-entry-modal-open-wrap"
            data-tooltip={openSessionTooltip}
          >
            <button
              type="button"
              class="neuroglancer-edit-session-entry-modal-btn neuroglancer-edit-session-entry-modal-btn-primary"
              disabled={openSessionDisabled}
              onClick={() => {
                void handleSubmit();
              }}
            >
              Open session
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Memory meter
// ---------------------------------------------------------------------------

type MemorySignal = "safe" | "near" | "over";

function memorySignalOf(totalBytes: number, gpuLimit: number): MemorySignal {
  if (!Number.isFinite(gpuLimit) || gpuLimit <= 0) return "safe";
  if (totalBytes > gpuLimit) return "over";
  if (totalBytes >= gpuLimit * MEMORY_NEAR_FRACTION) return "near";
  return "safe";
}

function MemoryMeter({
  estimate,
  limits,
  lockedLayerCount,
}: {
  estimate: MemoryEstimate;
  limits: { gpu: number; system: number };
  lockedLayerCount: number;
}) {
  const signal = memorySignalOf(estimate.totalBytes, limits.gpu);
  const fraction =
    Number.isFinite(limits.gpu) && limits.gpu > 0
      ? Math.min(1, estimate.totalBytes / limits.gpu)
      : 0;

  const labelText =
    signal === "over"
      ? MEMORY_LABEL_OVER
      : signal === "near"
        ? MEMORY_LABEL_NEAR
        : MEMORY_LABEL_WITHIN;

  const meterClass = [
    "neuroglancer-edit-session-entry-modal-memory-meter",
    `neuroglancer-edit-session-entry-modal-memory-meter-${signal}`,
  ].join(" ");

  const summary =
    lockedLayerCount === 0
      ? "Estimated memory · no locked layers"
      : `Estimated memory · ${lockedLayerCount} locked layer${
          lockedLayerCount === 1 ? "" : "s"
        }`;

  const budgets =
    `${formatBytes(estimate.totalBytes)} · ` +
    `GPU budget ${formatBytes(limits.gpu)} · ` +
    `system ${formatBytes(limits.system)}`;

  return (
    <div class={meterClass}>
      <div class="neuroglancer-edit-session-entry-modal-memory-meter-header">
        <span class="neuroglancer-edit-session-entry-modal-memory-meter-summary">
          {summary}
        </span>
        <span class="neuroglancer-edit-session-entry-modal-memory-meter-label">
          <span
            class="neuroglancer-edit-session-entry-modal-memory-meter-dot"
            aria-hidden="true"
          />
          {labelText}
        </span>
      </div>
      <div class="neuroglancer-edit-session-entry-modal-memory-meter-bar">
        <div
          class="neuroglancer-edit-session-entry-modal-memory-meter-fill"
          style={{ transform: `scaleX(${fraction})` }}
        />
      </div>
      <div class="neuroglancer-edit-session-entry-modal-memory-meter-budgets">
        {budgets}
      </div>
    </div>
  );
}

function SessionSummary({
  editable,
  reference,
  off,
}: {
  editable: number;
  reference: number;
  off: number;
}) {
  return (
    <div class="neuroglancer-edit-session-entry-modal-session-summary">
      In session: <strong>{editable}</strong> editable ·{" "}
      <strong>{reference}</strong> reference · <strong>{off}</strong> layer
      {off === 1 ? "" : "s"} off (load dynamically)
    </div>
  );
}

// ---------------------------------------------------------------------------
// Memory estimate
// ---------------------------------------------------------------------------

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
    if (state === undefined) continue;
    // Off layers do NOT count toward the session memory budget — they fall
    // back to base Neuroglancer LRU.
    if (state.role === "off") continue;
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
        chunksX * chunksY * chunksZ * chunkVoxels * bytesPerVoxel * channels;
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

// ---------------------------------------------------------------------------
// Default role on open
// ---------------------------------------------------------------------------

function defaultRoleFor(entry: LayerEntry): LayerRole {
  // Spec:
  //   - image → Reference
  //   - visible segmentation → Editable
  //   - hidden layer → Off
  if (!entry.visible) return "off";
  if (entry.kind === "segmentation") return "editable";
  return "reference";
}

function defaultStateFor(entry: LayerEntry): LayerRowState {
  return {
    role: defaultRoleFor(entry),
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
