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
  PaintingMaskConfig,
  PaintingTools,
  Resolution,
} from "@zettaai/edit-session";
import { layerId as toLayerId } from "@zettaai/edit-session";
import { ChevronDown } from "lucide-preact";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";

import { radiusToSize, sizeToRadius } from "#src/editing/brush_size_presets.js";
import type { EditSessionHost } from "#src/editing/edit_session_host.js";
import { voxelDataTypeRange } from "#src/editing/tool_runtimes/mask_coord.js";
import { useEvent } from "#src/editing/ui/interop/use_event.js";
import { useWatchable } from "#src/editing/ui/interop/use_watchable.js";
import { layerKindOf } from "#src/editing/ui/layer_kind.js";
import { PaintingTargetPicker } from "#src/editing/ui/tool_settings/painting_target_picker.js";
import { PaintingThreshold } from "#src/editing/ui/tool_settings/painting_threshold.js";
import { ToggleSwitch } from "#src/editing/ui/toggle_switch.js";
import "#src/editing/ui/tool_settings/painting_brush.css";

const MAX_SIZE = 129; // size = radius*2+1; max radius 64.
const MIN_SIZE = 1;

function clampSize(value: number): number {
  if (!Number.isFinite(value)) return 1;
  const n = Math.round(value);
  // Snap to odd integers — size is voxel-count and must be odd.
  const odd = n % 2 === 0 ? n + 1 : n;
  return Math.max(MIN_SIZE, Math.min(MAX_SIZE, odd));
}

export function PaintingBrush({
  session,
  host,
}: {
  session: EditSession;
  host: EditSessionHost;
}) {
  useWatchable(host.state.value);
  const painting = session.tools.getTool<PaintingTools>("painting");
  const subscribe = useCallback(
    (h: () => void) => painting.on("changed", h),
    [painting],
  );
  useEvent(subscribe);
  const state = painting.getState();

  const onSizeInput = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const size = clampSize(input.valueAsNumber);
    painting.patchState({ radius: sizeToRadius(size) });
  };

  const onTargetChange = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const raw = input.value.trim();
    try {
      const parsed = BigInt(raw);
      painting.patchState({ activeValue: parsed });
    } catch {
      input.value = painting.getState().activeValue.toString();
    }
  };

  const size = radiusToSize(state.radius);

  return (
    <div class="neuroglancer-tool-panel neuroglancer-painting-brush-panel">
      <PaintingTargetPicker session={session} host={host} />
      <div class="neuroglancer-tool-panel-row">
        <label>Size</label>
        <input
          type="range"
          min={MIN_SIZE}
          max={MAX_SIZE}
          step={2}
          value={size}
          onInput={onSizeInput}
        />
        <input
          type="number"
          min={MIN_SIZE}
          max={MAX_SIZE}
          step={2}
          value={size}
          onChange={onSizeInput}
        />
      </div>
      <div class="neuroglancer-tool-panel-row">
        <label>Target value</label>
        <input
          type="text"
          inputMode="numeric"
          value={state.activeValue.toString()}
          onChange={onTargetChange}
        />
      </div>
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
  painting: PaintingTools;
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
  const onMinComponentChange = (e: Event) => {
    const v = (e.currentTarget as HTMLInputElement).valueAsNumber;
    if (Number.isFinite(v))
      patchMask({ minComponentSize: Math.max(0, Math.floor(v)) });
  };
  const onClosingChange = (e: Event) => {
    const v = (e.currentTarget as HTMLInputElement).valueAsNumber;
    if (Number.isFinite(v))
      patchMask({ binaryClosing: Math.max(0, Math.floor(v)) });
  };

  const currentEntry = mask
    ? imageEntries.find((x) => x.layerId === mask.imageLayerId)
    : undefined;

  const disabledHint = uint64Selected
    ? "uint64 layers can't be used as mask images."
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
        ? "Disable advanced brush (mask)"
        : "Enable advanced brush (mask)";

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
          title={toggleTitle}
          ariaLabel={
            enabled
              ? "Disable advanced brush (mask)"
              : "Enable advanced brush (mask)"
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
            <label>Mask layer</label>
            <select value={mask!.imageLayerId} onChange={onMaskLayerChange}>
              {imageEntries.map((e) => (
                <option key={e.layerId} value={e.layerId}>
                  {e.layerId}
                </option>
              ))}
            </select>
          </div>
          <div class="neuroglancer-tool-panel-row">
            <label>Mask resolution</label>
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
              <label>Threshold</label>
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
            <label>Min component</label>
            <input
              type="number"
              min={0}
              step={1}
              value={mask!.minComponentSize}
              onChange={onMinComponentChange}
            />
          </div>
          <div class="neuroglancer-tool-panel-row">
            <label>Binary closing</label>
            <input
              type="number"
              min={0}
              step={1}
              value={mask!.binaryClosing}
              onChange={onClosingChange}
            />
          </div>
          <div class="neuroglancer-tool-panel-row">
            <label>Filter components first</label>
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
