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
import { layerId as toLayerId } from "@zettaai/edit-session";
import { ChevronDown } from "lucide-preact";
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
import type { PaintingState } from "#src/editing/tool_runtimes/painting_tools.js";
import { useEvent } from "#src/editing/ui/interop/use_event.js";
import { useWatchable } from "#src/editing/ui/interop/use_watchable.js";
import { layerKindOf } from "#src/editing/ui/layer_kind.js";
import { ToggleSwitch } from "#src/editing/ui/toggle_switch.js";
import { PaintingTargetPicker } from "#src/editing/ui/tool_settings/painting_target_picker.js";
import { PaintingThreshold } from "#src/editing/ui/tool_settings/painting_threshold.js";
import { ParamInput } from "#src/editing/ui/tool_settings/param_input.js";
import { ParamLabel } from "#src/editing/ui/tool_settings/param_label.js";
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

  return (
    <div class="neuroglancer-tool-panel neuroglancer-painting-brush-panel">
      <PaintingTargetPicker host={host} />
      <div class="neuroglancer-tool-panel-row">
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
      />
      <AdvancedBrush host={host} painting={painting} />
    </div>
  );
}

interface ImageLayerEntry {
  readonly layerId: LayerId;
  readonly resolutions: readonly Resolution[];
}

function AdvancedBrush({
  host,
  painting,
}: {
  host: EditSessionHost;
  painting: PaintingState;
}) {
  const intent = host.state.value.value;
  const layerManager = host.viewer.layerManager;
  const [metadataByLayer, setMetadataByLayer] = useState<
    ReadonlyMap<string, LayerMetadata>
  >(new Map());

  const imageEntries: readonly ImageLayerEntry[] = useMemo(() => {
    if (intent === null) return [];
    return intent.layers
      .filter(
        (l) => layerKindOf(layerManager.getLayerByName(l.layerId)) === "image",
      )
      .map((l) => ({
        layerId: toLayerId(l.layerId),
        resolutions: l.resolutions,
      }));
  }, [intent, layerManager]);

  // Resolve metadata for each image layer once.
  useEffect(() => {
    let cancelled = false;
    const missing = imageEntries.filter((e) => !metadataByLayer.has(e.layerId));
    if (missing.length === 0) return undefined;
    void Promise.all(
      missing.map((e) =>
        host.layerMetadataSource
          .resolve(e.layerId)
          .then((m) => [e.layerId, m] as const)
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
  }, [imageEntries, host, metadataByLayer]);

  const state = painting.getState();
  const mask = state.mask;
  const enabled = mask !== undefined;

  const noImageLayers = imageEntries.length === 0;
  const currentMetadata: LayerMetadata | undefined = mask
    ? metadataByLayer.get(mask.imageLayerId)
    : undefined;
  const currentDtype = currentMetadata?.voxelDataType;
  const currentRange =
    currentDtype !== undefined ? voxelDataTypeRange(currentDtype) : null;
  const uint64Selected = enabled && currentDtype === "uint64";

  const enableMask = (
    entry: ImageLayerEntry,
    meta: LayerMetadata | undefined,
  ) => {
    if (meta === undefined) return;
    const range = voxelDataTypeRange(meta.voxelDataType);
    if (range === null) return;
    const next: PaintingMaskConfig = {
      imageLayerId: entry.layerId,
      imageResolution: entry.resolutions[0],
      thresholdLow: range.min,
      thresholdHigh: range.max,
      minComponentSize: 0,
      binaryClosing: 0,
      filterComponentsFirst: false,
    };
    painting.patchState({ mask: next });
  };

  const disableMask = () => painting.patchState({ mask: undefined });

  const onToggle = () => {
    if (enabled) {
      disableMask();
      return;
    }
    if (noImageLayers) return;
    const first = imageEntries[0];
    const meta = metadataByLayer.get(first.layerId);
    enableMask(first, meta);
  };

  const onMaskLayerChange = (e: Event) => {
    if (mask === undefined) return;
    const value = (e.currentTarget as HTMLSelectElement).value as LayerId;
    const entry = imageEntries.find((x) => x.layerId === value);
    if (entry === undefined) return;
    const meta = metadataByLayer.get(value);
    const range =
      meta !== undefined ? voxelDataTypeRange(meta.voxelDataType) : null;
    painting.patchState({
      mask: {
        ...mask,
        imageLayerId: entry.layerId,
        imageResolution: entry.resolutions[0],
        thresholdLow: range?.min ?? mask.thresholdLow,
        thresholdHigh: range?.max ?? mask.thresholdHigh,
      },
    });
  };

  const onMaskResolutionChange = (e: Event) => {
    if (mask === undefined) return;
    const value = (e.currentTarget as HTMLSelectElement).value as Resolution;
    painting.patchState({ mask: { ...mask, imageResolution: value } });
  };

  const patchMask = (patch: Partial<PaintingMaskConfig>) => {
    if (mask === undefined) return;
    painting.patchState({ mask: { ...mask, ...patch } });
  };

  const onThresholdChange = (low: number, high: number) => {
    patchMask({ thresholdLow: low, thresholdHigh: high });
  };

  const currentEntry = mask
    ? imageEntries.find((x) => x.layerId === mask.imageLayerId)
    : undefined;

  const disabledHint = uint64Selected
    ? "uint64 layers can't be used as reference images."
    : noImageLayers
      ? "Lock an image layer in the session to enable advanced brush."
      : undefined;

  const toggleDisabled = noImageLayers || uint64Selected;
  const showSliders =
    enabled && currentRange !== null && currentDtype !== "float32";

  // The switch is the single control for the section: turning it on enables
  // the mask AND reveals its parameters; turning it off hides them and clears
  // the mask. There is no separate expand/collapse state (per TM-294 redesign).
  const toggleTitle =
    toggleDisabled && disabledHint !== undefined
      ? disabledHint
      : enabled
        ? "Disable advanced brush"
        : "Enable advanced brush";

  return (
    <div class="neuroglancer-painting-brush-advanced">
      <div class="neuroglancer-painting-brush-advanced-header">
        <span
          class="neuroglancer-painting-brush-advanced-summary"
          data-on={enabled ? "true" : "false"}
        >
          <ChevronDown
            size={14}
            class="neuroglancer-painting-brush-advanced-chevron"
            aria-hidden="true"
          />
          Advanced
        </span>
        <ToggleSwitch
          checked={enabled}
          disabled={toggleDisabled}
          tooltip={toggleTitle}
          ariaLabel={
            enabled ? "Disable advanced brush" : "Enable advanced brush"
          }
          onChange={onToggle}
        />
      </div>
      {disabledHint !== undefined && (
        <div class="neuroglancer-painting-brush-advanced-hint">
          {disabledHint}
        </div>
      )}
      {enabled && currentEntry !== undefined && (
        <div class="neuroglancer-painting-brush-advanced-body">
          <div class="neuroglancer-tool-panel-row">
            <ParamLabel
              text="Reference layer"
              hint="The image layer the mask samples to decide which voxels a stroke may paint. Only image layers locked in the session appear here."
            />
            <select value={mask!.imageLayerId} onChange={onMaskLayerChange}>
              {imageEntries.map((e) => (
                <option key={e.layerId} value={e.layerId}>
                  {e.layerId}
                </option>
              ))}
            </select>
          </div>
          <div class="neuroglancer-tool-panel-row">
            <ParamLabel
              text="Reference resolution"
              hint="The voxel scale the reference image is sampled at. Coarser scales are faster but mask less precisely."
            />
            {currentEntry.resolutions.length <= 1 ? (
              <span class="neuroglancer-tool-panel-resolution-static">
                {mask!.imageResolution}
              </span>
            ) : (
              <select
                value={mask!.imageResolution}
                onChange={onMaskResolutionChange}
              >
                {currentEntry.resolutions.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            )}
          </div>
          {currentRange !== null && (
            <div class="neuroglancer-painting-brush-threshold-row">
              <ParamLabel
                text="Threshold"
                hint="Limits painting to voxels whose reference-image intensity falls within the low–high range. Voxels outside it are left untouched."
              />
              <PaintingThreshold
                min={currentRange.min}
                max={currentRange.max}
                low={mask!.thresholdLow}
                high={mask!.thresholdHigh}
                showHandles={showSliders}
                onChange={onThresholdChange}
              />
            </div>
          )}
          <div class="neuroglancer-tool-panel-row">
            <ParamLabel
              text="Min component"
              hint="Drops connected blobs smaller than this many voxels from the mask, removing speckle. 0 keeps every component."
            />
            <ParamInput<number>
              type="number"
              min={0}
              step={1}
              value={mask!.minComponentSize}
              parse={parseCount}
              onCommit={(minComponentSize) => patchMask({ minComponentSize })}
            />
          </div>
          <div class="neuroglancer-tool-panel-row">
            <ParamLabel
              text="Binary closing"
              hint="Closes gaps and small holes in the mask by this many voxels (morphological closing). 0 disables it."
            />
            <ParamInput<number>
              type="number"
              min={0}
              step={1}
              value={mask!.binaryClosing}
              parse={parseCount}
              onCommit={(binaryClosing) => patchMask({ binaryClosing })}
            />
          </div>
          <div class="neuroglancer-tool-panel-row">
            <ParamLabel
              text="Filter components first"
              hint="When on, min-component filtering runs before binary closing; when off, closing runs first. Changes whether holes are filled before or after small blobs are removed."
            />
            <ToggleSwitch
              checked={mask!.filterComponentsFirst}
              ariaLabel="Filter components first"
              onChange={(v) => patchMask({ filterComponentsFirst: v })}
            />
          </div>
        </div>
      )}
    </div>
  );
}
