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
  EditSession,
  LayerId,
  LayerMetadata,
  Resolution,
} from "@zettaai/edit-session";
import { X } from "lucide-preact";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";

import {
  clampBrushSize,
  MAX_BRUSH_SIZE,
  MIN_BRUSH_SIZE,
  radiusToSize,
  sizeToRadius,
} from "#src/editing/brush_size_presets.js";
import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { voxelDataTypeRange } from "#src/editing/tool_runtimes/mask_coord.js";
import type { PaintingMaskConfig } from "#src/editing/tool_runtimes/paint_types.js";
import { DEFAULT_COVERAGE_THRESHOLD } from "#src/editing/tool_runtimes/paint_types.js";
import type { PaintingState } from "#src/editing/tool_runtimes/painting_tools.js";
import {
  booleanDescriptor,
  enumDescriptor,
  numberDescriptor,
  type ParamDescriptor,
} from "#src/editing/tool_runtimes/param_cursor.js";
import { useEvent } from "#src/editing/ui/interop/use_event.js";
import { useWatchable } from "#src/editing/ui/interop/use_watchable.js";
import { ToggleSwitch } from "#src/editing/ui/toggle_switch.js";
import { PaintingTargetPicker } from "#src/editing/ui/tool_settings/painting_target_picker.js";
import { PaintingThreshold } from "#src/editing/ui/tool_settings/painting_threshold.js";
import {
  PARAM_IDS,
  paramFocusHandlers,
  rowClass,
  sizeDescriptor,
  useParamFocus,
  useParamSelection,
  usePublishParams,
  useTargetParamDescriptors,
  valueDescriptor,
} from "#src/editing/ui/tool_settings/param_descriptors.js";
import { ParamInput } from "#src/editing/ui/tool_settings/param_input.js";
import { ParamLabel } from "#src/editing/ui/tool_settings/param_label.js";
import {
  buildReferenceEntries,
  collectReferenceCandidates,
  defaultReferenceResolution,
  type ReferenceCandidate,
  type ReferenceLayerEntry,
  UINT64_REFERENCE_DISABLED,
} from "#src/editing/ui/tool_settings/reference_layer_options.js";
import { TargetValueField } from "#src/editing/ui/tool_settings/target_value_field.js";
import { useLayerVoxelType } from "#src/editing/ui/tool_settings/use_layer_voxel_type.js";
import "#src/editing/ui/tool_settings/painting_brush.css";

/** Parse a typed size into a valid brush size, or null if empty/invalid. */
function parseSize(raw: string): number | null {
  const n = Number(raw);
  return raw.trim() !== "" && Number.isFinite(n) ? clampBrushSize(n) : null;
}

/** Parse a non-negative voxel count (min component / closing), or null. */
function parseCount(raw: string): number | null {
  const n = Number(raw);
  return raw.trim() !== "" && Number.isFinite(n)
    ? Math.max(0, Math.floor(n))
    : null;
}

export function PaintingBrush({
  host,
}: {
  session: EditSession;
  host: EditSessionHost;
}) {
  useWatchable(host.state.value);
  // Consumer-owned painting state (TM-315). The panel only mounts for an
  // active session with painting tools, so `host.painting` is defined here —
  // matching the old `session.tools.getTool('painting')` throw-on-missing.
  const painting = host.painting!.state;
  const subscribe = useCallback(
    (h: () => void) => painting.changed.add(h),
    [painting],
  );
  useEvent(subscribe);
  const state = painting.getState();

  const commitSize = (size: number) =>
    painting.patchState({ radius: sizeToRadius(size) });

  // The slider commits live as it's dragged (direct manipulation); the number
  // box uses the draft pattern and commits on blur.
  const onSizeSlide = (e: Event) =>
    commitSize(
      clampBrushSize((e.currentTarget as HTMLInputElement).valueAsNumber),
    );

  const size = radiusToSize(state.radius);
  const targetVoxelType = useLayerVoxelType(host, state.targetLayerId);

  const selectedId = useParamSelection(host);
  const selectParam = useParamFocus(host);
  // Leading (non-mask) parameters in render order: target layer/resolution,
  // size, value. The mask section appends its own descriptors and publishes the
  // combined list (single publisher per tool — see `BrushMask`).
  const targetDescriptors = useTargetParamDescriptors(host);
  const leadingDescriptors: ParamDescriptor[] = [
    ...targetDescriptors,
    sizeDescriptor(painting),
    valueDescriptor(painting, targetVoxelType),
  ];

  return (
    <div class="neuroglancer-tool-panel neuroglancer-painting-brush-panel">
      <PaintingTargetPicker host={host} />
      <div
        class={rowClass(
          "neuroglancer-tool-panel-row",
          PARAM_IDS.size,
          selectedId,
        )}
        {...paramFocusHandlers(selectParam, PARAM_IDS.size)}
      >
        <ParamLabel
          text="Size"
          hint="Brush diameter in voxels at the target resolution. Larger sizes paint a wider stroke."
        />
        <input
          type="range"
          min={MIN_BRUSH_SIZE}
          max={MAX_BRUSH_SIZE}
          step={2}
          value={size}
          onInput={onSizeSlide}
        />
        <ParamInput<number>
          type="number"
          min={MIN_BRUSH_SIZE}
          step={2}
          value={size}
          parse={parseSize}
          onCommit={commitSize}
        />
      </div>
      <TargetValueField
        value={state.activeValue}
        voxelDataType={targetVoxelType}
        onCommit={(activeValue) => painting.patchState({ activeValue })}
        hint="The segment ID painted into the target layer — every voxel the stroke covers is set to this value."
        highlighted={selectedId === PARAM_IDS.value}
        onSelect={() => selectParam(PARAM_IDS.value)}
      />
      <BrushMask
        host={host}
        painting={painting}
        leadingDescriptors={leadingDescriptors}
      />
    </div>
  );
}

function BrushMask({
  host,
  painting,
  leadingDescriptors,
}: {
  host: EditSessionHost;
  painting: PaintingState;
  /** Non-mask descriptors (target/size/value) this panel prepends. */
  leadingDescriptors: ParamDescriptor[];
}) {
  const selectedId = useParamSelection(host);
  const selectParam = useParamFocus(host);
  const intent = host.state.value.value;
  const layerManager = host.viewer.layerManager;
  const [metadataByLayer, setMetadataByLayer] = useState<
    ReadonlyMap<string, LayerMetadata>
  >(new Map());

  // Re-render when layers are added/removed/toggled so external (non-session)
  // candidates stay current. Per-layer changes also dispatch `layersChanged`
  // (see LayerManager.addManagedLayer), so this covers archive/visibility too.
  const [layersVersion, setLayersVersion] = useState(0);
  useEffect(
    () => layerManager.layersChanged.add(() => setLayersVersion((v) => v + 1)),
    [layerManager],
  );

  const candidates: readonly ReferenceCandidate[] = useMemo(
    () => collectReferenceCandidates(intent?.layers ?? [], layerManager),
    // `layersVersion` forces recompute on layer changes (managedLayers is a
    // stable reference the memo can't otherwise observe).
    [intent, layerManager, layersVersion],
  );

  // Resolve metadata for each candidate image layer once (session + external).
  useEffect(() => {
    let cancelled = false;
    const missing = candidates.filter((c) => !metadataByLayer.has(c.layerId));
    if (missing.length === 0) return undefined;
    void Promise.all(
      missing.map((c) =>
        host.layerMetadataSource
          .resolve(c.layerId)
          .then((m) => [c.layerId, m] as const)
          .catch(() => null),
      ),
    ).then((results) => {
      if (cancelled) return;
      const next = new Map(metadataByLayer);
      let changed = false;
      for (const r of results) {
        if (r !== null && !next.has(r[0])) {
          next.set(r[0], r[1]);
          changed = true;
        }
      }
      if (changed) setMetadataByLayer(next);
    });
    return () => {
      cancelled = true;
    };
  }, [candidates, host, metadataByLayer]);

  const entries: readonly ReferenceLayerEntry[] = useMemo(
    () => buildReferenceEntries(candidates, metadataByLayer),
    [candidates, metadataByLayer],
  );

  const sessionEntries = entries.filter((e) => e.origin === "session");
  const externalEntries = entries.filter((e) => e.origin === "external");
  const selectableEntries = entries.filter(
    (e) => e.disabledReason === undefined,
  );

  const state = painting.getState();
  const mask = state.mask;
  const enabled = mask !== undefined;

  const noReferenceLayers = selectableEntries.length === 0;
  const currentMetadata: LayerMetadata | undefined = mask
    ? metadataByLayer.get(mask.imageLayerId)
    : undefined;
  const currentDtype = currentMetadata?.voxelDataType;
  const currentRange =
    currentDtype !== undefined ? voxelDataTypeRange(currentDtype) : null;
  const uint64Selected = enabled && currentDtype === "uint64";

  // Register a non-session ("external") reference layer with the host so a
  // masked stroke can sample it: the host resolves its metadata and pins the
  // chosen resolution. Fire-and-forget — a stroke before it settles simply
  // paints unmasked. Session layers are already registered at session open.
  const registerExternal = (
    entry: ReferenceLayerEntry,
    resolution: Resolution,
  ) => {
    if (entry.origin === "external") {
      void host.ensureMaskReference(entry.layerId, resolution);
    }
  };

  const enableMask = (
    entry: ReferenceLayerEntry,
    meta: LayerMetadata | undefined,
  ) => {
    if (meta === undefined) return;
    const range = voxelDataTypeRange(meta.voxelDataType);
    if (range === null) return;
    const imageResolution = defaultReferenceResolution(
      entry,
      painting.getState().targetResolution,
    );
    registerExternal(entry, imageResolution);
    const next: PaintingMaskConfig = {
      imageLayerId: entry.layerId,
      imageResolution,
      thresholdLow: range.min,
      thresholdHigh: range.max,
      coverageThreshold: DEFAULT_COVERAGE_THRESHOLD,
      minComponentSize: 0,
      binaryClosing: 0,
      filterComponentsFirst: false,
    };
    painting.patchState({ mask: next });
  };

  // Clearing the reference layer is what disables the mask: there is no
  // separate on/off switch — the picker is the single gate (per TM-317).
  const disableMask = () => painting.patchState({ mask: undefined });

  // Apply a reference-layer selection. Shared by the dropdown's `onChange` and
  // the Ctrl+Arrow enum descriptor. `""` clears the reference (disables mask).
  const applyReference = (value: LayerId | "") => {
    if (value === "") {
      disableMask();
      return;
    }
    const entry = selectableEntries.find((x) => x.layerId === value);
    if (entry === undefined) return;
    const meta = metadataByLayer.get(value);
    if (mask === undefined) {
      enableMask(entry, meta);
      return;
    }
    // Switching reference layers resets the threshold to the new layer's range.
    const range =
      meta !== undefined ? voxelDataTypeRange(meta.voxelDataType) : null;
    const imageResolution = defaultReferenceResolution(
      entry,
      painting.getState().targetResolution,
    );
    registerExternal(entry, imageResolution);
    painting.patchState({
      mask: {
        ...mask,
        imageLayerId: entry.layerId,
        imageResolution,
        thresholdLow: range?.min ?? mask.thresholdLow,
        thresholdHigh: range?.max ?? mask.thresholdHigh,
      },
    });
  };

  const onReferenceChange = (e: Event) => {
    applyReference(
      (e.currentTarget as HTMLSelectElement).value as LayerId | "",
    );
  };

  const applyMaskResolution = (value: Resolution) => {
    if (mask === undefined) return;
    // Pin the newly chosen scale for an external layer before the next stroke.
    const entry = entries.find((x) => x.layerId === mask.imageLayerId);
    if (entry !== undefined) registerExternal(entry, value);
    painting.patchState({ mask: { ...mask, imageResolution: value } });
  };

  const onMaskResolutionChange = (e: Event) => {
    applyMaskResolution(
      (e.currentTarget as HTMLSelectElement).value as Resolution,
    );
  };

  const patchMask = (patch: Partial<PaintingMaskConfig>) => {
    if (mask === undefined) return;
    painting.patchState({ mask: { ...mask, ...patch } });
  };

  const onThresholdChange = (low: number, high: number) => {
    patchMask({ thresholdLow: low, thresholdHigh: high });
  };

  const currentEntry = mask
    ? entries.find((x) => x.layerId === mask.imageLayerId)
    : undefined;

  // The single reason the dependent parameters are inert, surfaced both as a
  // visible hint and a tooltip on the locked rows. `undefined` => editable.
  const gateReason = noReferenceLayers
    ? "No image layer is available to use as a reference mask."
    : mask === undefined
      ? "Select a reference layer to enable mask filtering."
      : uint64Selected
        ? UINT64_REFERENCE_DISABLED
        : undefined;
  const paramsDisabled = gateReason !== undefined;

  // Display fallbacks so the locked rows still render a sensible value when no
  // mask is configured. The real config is shown once a reference is picked.
  const range = currentRange ?? { min: 0, max: 0 };
  const thresholdLow = mask?.thresholdLow ?? range.min;
  const thresholdHigh = mask?.thresholdHigh ?? range.max;
  const resolutions = currentEntry?.resolutions ?? [];
  const showSliders =
    !paramsDisabled && currentRange !== null && currentDtype !== "float32";

  // Mask parameters in render order, appended to the leading (target/size/value)
  // descriptors. Built only for the controls the panel actually exposes for
  // changing: the reference picker is always cyclable when image layers exist;
  // the dependent rows join only once a usable reference is selected
  // (`!paramsDisabled`), matching the "skip disabled" rule. All closures read
  // mask state live so the status readout reflects the post-change value.
  const maskDescriptors: ParamDescriptor[] = [];
  if (!noReferenceLayers) {
    // Only selectable (non-uint64) layers join the Ctrl+Arrow cycle; disabled
    // entries are shown in the dropdown but never cycled to.
    const refValues: (LayerId | "")[] = [
      "",
      ...selectableEntries.map((e) => e.layerId),
    ];
    maskDescriptors.push(
      enumDescriptor({
        id: PARAM_IDS.referenceLayer,
        label: "Reference layer",
        options: () => refValues,
        index: () =>
          refValues.indexOf(painting.getState().mask?.imageLayerId ?? ""),
        select: (i) => applyReference(refValues[i] ?? ""),
        format: (o) => (o === "" ? "None" : o),
      }),
    );
    if (!paramsDisabled) {
      if (resolutions.length > 1) {
        maskDescriptors.push(
          enumDescriptor({
            id: PARAM_IDS.referenceResolution,
            label: "Reference resolution",
            options: () => resolutions,
            index: () =>
              resolutions.indexOf(
                painting.getState().mask?.imageResolution ?? resolutions[0],
              ),
            select: (i) => {
              const r = resolutions[i];
              if (r !== undefined) applyMaskResolution(r);
            },
          }),
        );
      }
      maskDescriptors.push(
        numberDescriptor({
          id: PARAM_IDS.thresholdLow,
          label: "Threshold low",
          format: () =>
            String(painting.getState().mask?.thresholdLow ?? range.min),
          apply: (steps) => {
            const m = painting.getState().mask;
            if (m === undefined) return;
            const low = Math.min(
              Math.max(m.thresholdLow + steps, range.min),
              m.thresholdHigh,
            );
            if (low !== m.thresholdLow) {
              painting.patchState({ mask: { ...m, thresholdLow: low } });
            }
          },
        }),
        numberDescriptor({
          id: PARAM_IDS.thresholdHigh,
          label: "Threshold high",
          format: () =>
            String(painting.getState().mask?.thresholdHigh ?? range.max),
          apply: (steps) => {
            const m = painting.getState().mask;
            if (m === undefined) return;
            const high = Math.max(
              Math.min(m.thresholdHigh + steps, range.max),
              m.thresholdLow,
            );
            if (high !== m.thresholdHigh) {
              painting.patchState({ mask: { ...m, thresholdHigh: high } });
            }
          },
        }),
        numberDescriptor({
          id: PARAM_IDS.minComponent,
          label: "Min component",
          format: () => String(painting.getState().mask?.minComponentSize ?? 0),
          apply: (steps) => {
            const m = painting.getState().mask;
            if (m === undefined) return;
            const v = Math.max(0, m.minComponentSize + steps);
            if (v !== m.minComponentSize) {
              painting.patchState({ mask: { ...m, minComponentSize: v } });
            }
          },
        }),
        numberDescriptor({
          id: PARAM_IDS.binaryClosing,
          label: "Binary closing",
          format: () => String(painting.getState().mask?.binaryClosing ?? 0),
          apply: (steps) => {
            const m = painting.getState().mask;
            if (m === undefined) return;
            const v = Math.max(0, m.binaryClosing + steps);
            if (v !== m.binaryClosing) {
              painting.patchState({ mask: { ...m, binaryClosing: v } });
            }
          },
        }),
        booleanDescriptor({
          id: PARAM_IDS.filterComponentsFirst,
          label: "Filter components first",
          value: () => painting.getState().mask?.filterComponentsFirst ?? false,
          set: (v) => {
            const m = painting.getState().mask;
            if (m !== undefined) {
              painting.patchState({ mask: { ...m, filterComponentsFirst: v } });
            }
          },
        }),
      );
    }
  }
  usePublishParams(host, [...leadingDescriptors, ...maskDescriptors]);

  const renderReferenceOption = (entry: ReferenceLayerEntry) => (
    <option
      key={entry.layerId}
      value={entry.layerId}
      disabled={entry.disabledReason !== undefined}
      title={entry.disabledReason}
    >
      {entry.disabledReason !== undefined
        ? `${entry.layerId} (unsupported)`
        : entry.layerId}
    </option>
  );

  return (
    <div class="neuroglancer-painting-brush-mask">
      <div class="neuroglancer-painting-brush-mask-title">Mask filter</div>
      <div
        class={rowClass(
          "neuroglancer-tool-panel-row",
          PARAM_IDS.referenceLayer,
          selectedId,
        )}
        {...paramFocusHandlers(selectParam, PARAM_IDS.referenceLayer)}
      >
        <ParamLabel
          text="Reference layer"
          hint="The image layer the mask samples to decide which voxels a stroke may paint. Session image layers plus any other loaded image layer can be used; non-session layers are read on demand."
        />
        <span class="neuroglancer-painting-brush-mask-reference">
          <select
            value={mask?.imageLayerId ?? ""}
            disabled={entries.length === 0}
            onChange={onReferenceChange}
          >
            <option value="">— None —</option>
            {sessionEntries.length > 0 && (
              <optgroup label="Session layers">
                {sessionEntries.map(renderReferenceOption)}
              </optgroup>
            )}
            {externalEntries.length > 0 && (
              <optgroup label="Other image layers">
                {externalEntries.map(renderReferenceOption)}
              </optgroup>
            )}
          </select>
          <button
            type="button"
            class="neuroglancer-painting-brush-mask-clear"
            aria-label="Clear reference layer"
            data-tooltip="Clear reference layer"
            disabled={!enabled}
            onClick={disableMask}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </span>
      </div>
      {gateReason !== undefined && (
        <div class="neuroglancer-painting-brush-mask-hint">{gateReason}</div>
      )}
      <div
        class="neuroglancer-painting-brush-mask-params"
        data-disabled={paramsDisabled ? "true" : "false"}
        data-tooltip={gateReason}
      >
        <div
          class={rowClass(
            "neuroglancer-tool-panel-row",
            PARAM_IDS.referenceResolution,
            selectedId,
          )}
          {...paramFocusHandlers(selectParam, PARAM_IDS.referenceResolution)}
        >
          <ParamLabel
            text="Reference resolution"
            hint="The voxel scale the reference image is sampled at. Coarser scales are faster but mask less precisely."
          />
          {resolutions.length <= 1 ? (
            <span class="neuroglancer-tool-panel-resolution-static">
              {mask?.imageResolution ?? "—"}
            </span>
          ) : (
            <select
              value={mask!.imageResolution}
              disabled={paramsDisabled}
              onChange={onMaskResolutionChange}
            >
              {resolutions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          )}
        </div>
        <div class="neuroglancer-painting-brush-threshold-row">
          <ParamLabel
            text="Threshold"
            hint="Limits painting to voxels whose reference-image intensity falls within the low–high range. Voxels outside it are left untouched."
          />
          <PaintingThreshold
            min={range.min}
            max={range.max}
            low={thresholdLow}
            high={thresholdHigh}
            showHandles={showSliders}
            disabled={paramsDisabled}
            onChange={onThresholdChange}
            selected={
              selectedId === PARAM_IDS.thresholdLow
                ? "low"
                : selectedId === PARAM_IDS.thresholdHigh
                  ? "high"
                  : undefined
            }
            onSelect={(which) =>
              selectParam(
                which === "low"
                  ? PARAM_IDS.thresholdLow
                  : PARAM_IDS.thresholdHigh,
              )
            }
          />
        </div>
        <div
          class={rowClass(
            "neuroglancer-tool-panel-row",
            PARAM_IDS.minComponent,
            selectedId,
          )}
          {...paramFocusHandlers(selectParam, PARAM_IDS.minComponent)}
        >
          <ParamLabel
            text="Min component"
            hint="Drops connected blobs smaller than this many voxels from the mask, removing speckle. 0 keeps every component."
          />
          <ParamInput<number>
            type="number"
            min={0}
            step={1}
            value={mask?.minComponentSize ?? 0}
            parse={parseCount}
            disabled={paramsDisabled}
            onCommit={(minComponentSize) => patchMask({ minComponentSize })}
          />
        </div>
        <div
          class={rowClass(
            "neuroglancer-tool-panel-row",
            PARAM_IDS.binaryClosing,
            selectedId,
          )}
          {...paramFocusHandlers(selectParam, PARAM_IDS.binaryClosing)}
        >
          <ParamLabel
            text="Binary closing"
            hint="Closes gaps and small holes in the mask by this many voxels (morphological closing). 0 disables it."
          />
          <ParamInput<number>
            type="number"
            min={0}
            step={1}
            value={mask?.binaryClosing ?? 0}
            parse={parseCount}
            disabled={paramsDisabled}
            onCommit={(binaryClosing) => patchMask({ binaryClosing })}
          />
        </div>
        <div
          class={rowClass(
            "neuroglancer-tool-panel-row",
            PARAM_IDS.filterComponentsFirst,
            selectedId,
          )}
          {...paramFocusHandlers(selectParam, PARAM_IDS.filterComponentsFirst)}
        >
          <ParamLabel
            text="Filter components first"
            hint="When on, min-component filtering runs before binary closing; when off, closing runs first. Changes whether holes are filled before or after small blobs are removed."
          />
          <ToggleSwitch
            checked={mask?.filterComponentsFirst ?? false}
            disabled={paramsDisabled}
            ariaLabel="Filter components first"
            onChange={(v) => patchMask({ filterComponentsFirst: v })}
          />
        </div>
      </div>
    </div>
  );
}
