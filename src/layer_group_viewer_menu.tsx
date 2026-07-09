/**
 * @license
 * Copyright 2026 Zetta AI
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Preact implementation of the layer-group viewer dropdown (the menu holding
 * "Remove layer group", the per-state navigation-link selectors, and the
 * annotation alignment link section). Replaces the previous imperative
 * EnumSelectWidget-based menu; the neuroglancer `ContextMenu` is kept as the
 * positioning/dismissal shell and this component renders its entire content.
 * Follows the edit-session UI conventions (Preact + `--nge-*` tokens).
 */

import { AlignmentLinkMenuSection } from "#src/alignment_link/ui/alignment_link_menu.js";
import { useAlignmentLinkStatus } from "#src/alignment_link/ui/interop/use_alignment_link_status.js";
import { mountComponent } from "#src/editing/ui/interop/component_mount.js";
import { useWatchable } from "#src/editing/ui/interop/use_watchable.js";
import type { LayerGroupViewer } from "#src/layer_group_viewer.js";
import type { ContextMenu } from "#src/ui/context_menu.js";
import type { Disposer } from "#src/util/disposable.js";
import type { TrackableEnum } from "#src/util/trackable_enum.js";

// Side effect: ensures the --nge-* tokens exist even when no editing panel is
// mounted (same convention as the confirm dialog / session-entry modal).
import "#src/editing/ui/editing_theme.css";
import "#src/layer_group_viewer_menu.css";

/**
 * One navigation-link row: label left, link-mode select right. The options
 * are derived from the model's enum (position/orientation links offer
 * linked/relative/unlinked; render scales/dimensions omit relative).
 */
function NavigationLinkRow({
  label,
  model,
  disabledReason,
}: {
  label: string;
  model: TrackableEnum<number>;
  disabledReason?: string;
}) {
  const value = useWatchable(model);
  const options = Object.keys(model.enumType)
    .filter((key) => Number.isNaN(Number(key)))
    .map((key) => key.toLowerCase());
  return (
    <label class="neuroglancer-layer-group-menu-row">
      <span>{label}</span>
      <select
        value={model.enumType[value].toLowerCase()}
        disabled={disabledReason !== undefined}
        title={disabledReason}
        aria-label={`${label} link mode`}
        onChange={(event) => {
          model.restoreState((event.target as HTMLSelectElement).value);
        }}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

export function LayerGroupViewerMenu({ viewer }: { viewer: LayerGroupViewer }) {
  const { viewerNavigationState } = viewer;
  const alignmentLink = useAlignmentLinkStatus(
    viewer.viewerState.alignmentLink,
  );
  // While the alignment link is active it owns these links (forcing the
  // follower's to unlinked and driving the values), so manual changes would
  // be overridden — disable the selectors to make that explicit.
  const ownedReason = alignmentLink?.status.enabled
    ? "Managed by the annotation alignment link"
    : undefined;

  // The Linked* wrappers expose TrackableEnum<NavigationLinkType> /
  // <NavigationSimpleLinkType>; the row renders either through the common
  // numeric-enum shape.
  const rows = [
    {
      label: "Render scale factors",
      model: viewerNavigationState.relativeDisplayScales.link,
    },
    {
      label: "Render dimensions",
      model: viewerNavigationState.displayDimensions.link,
    },
    {
      label: "Position",
      model: viewerNavigationState.position.link,
      disabledReason: ownedReason,
    },
    {
      label: "Cross-section orientation",
      model: viewerNavigationState.crossSectionOrientation.link,
      disabledReason: ownedReason,
    },
    {
      label: "Cross-section zoom",
      model: viewerNavigationState.crossSectionScale.link,
    },
    {
      label: "Cross-section depth range",
      model: viewerNavigationState.crossSectionDepthRange.link,
    },
    {
      label: "3-D projection orientation",
      model: viewerNavigationState.projectionOrientation.link,
    },
    {
      label: "3-D projection zoom",
      model: viewerNavigationState.projectionScale.link,
    },
    {
      label: "3-D projection depth range",
      model: viewerNavigationState.projectionDepthRange.link,
    },
  ] as Array<{
    label: string;
    model: TrackableEnum<number>;
    disabledReason?: string;
  }>;

  return (
    <div class="neuroglancer-layer-group-menu">
      <button
        type="button"
        class="neuroglancer-layer-group-menu-remove"
        onClick={() => {
          viewer.layerSpecification.layerManager.clear();
        }}
      >
        Remove layer group
      </button>
      {rows.map(({ label, model, disabledReason }) => (
        <NavigationLinkRow
          key={label}
          label={label}
          model={model}
          disabledReason={disabledReason}
        />
      ))}
      {alignmentLink !== undefined && (
        <AlignmentLinkMenuSection link={alignmentLink} />
      )}
    </div>
  );
}

/**
 * Mounts the menu content into a `ContextMenu`; the returned disposer is
 * registered on the context menu by the caller.
 */
export function mountLayerGroupViewerMenu(
  contextMenu: ContextMenu,
  viewer: LayerGroupViewer,
): Disposer {
  return mountComponent(contextMenu.element, LayerGroupViewerMenu, { viewer });
}
