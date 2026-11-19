import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import * as json_keys from "#src/layer/segmentation/json_keys.js";
import { TrackableBooleanCheckbox } from "#src/trackable_boolean.js";
import { NullarySignal } from "#src/util/signal.js";
import type { LayerControlDefinition } from "#src/widget/layer_control.js";
import { registerLayerControl } from "#src/widget/layer_control.js";
import { checkboxLayerControl } from "#src/widget/layer_control_checkbox.js";
import { rangeLayerControl } from "#src/widget/layer_control_range.js";
import { renderScaleLayerControl } from "#src/widget/render_scale_widget.js";
import {
  colorSeedLayerControl,
  fixedColorLayerControl,
} from "#src/widget/segmentation_color_mode.js";

export const LAYER_CONTROLS: LayerControlDefinition<SegmentationUserLayer>[] = [
  {
    label: "Color seed",
    title: "Color segments based on a hash of their id",
    toolJson: json_keys.COLOR_SEED_JSON_KEY,
    ...colorSeedLayerControl(),
  },
  {
    label: "Fixed color",
    title:
      "Use a fixed color for all segments without an explicitly-specified color",
    toolJson: json_keys.SEGMENT_DEFAULT_COLOR_JSON_KEY,
    ...fixedColorLayerControl(),
  },
  {
    label: "Saturation",
    toolJson: json_keys.SATURATION_JSON_KEY,
    title: "Saturation of segment colors",
    ...rangeLayerControl((layer) => ({ value: layer.displayState.saturation })),
  },
  {
    label: "Opacity (on)",
    toolJson: json_keys.SELECTED_ALPHA_JSON_KEY,
    isValid: (layer) => layer.has2dLayer,
    title: "Opacity in cross-section views of segments that are selected",
    ...rangeLayerControl((layer) => ({
      value: layer.displayState.selectedAlpha,
    })),
  },
  {
    label: "Opacity (off)",
    toolJson: json_keys.NOT_SELECTED_ALPHA_JSON_KEY,
    isValid: (layer) => layer.has2dLayer,
    title: "Opacity in cross-section views of segments that are not selected",
    ...rangeLayerControl((layer) => ({
      value: layer.displayState.notSelectedAlpha,
    })),
  },
  {
    label: "Resolution (slice)",
    toolJson: json_keys.CROSS_SECTION_RENDER_SCALE_JSON_KEY,
    isValid: (layer) => layer.has2dLayer,
    ...renderScaleLayerControl((layer) => ({
      histogram: layer.sliceViewRenderScaleHistogram,
      target: layer.sliceViewRenderScaleTarget,
    })),
  },
  {
    label: "Resolution (mesh)",
    toolJson: json_keys.MESH_RENDER_SCALE_JSON_KEY,
    isValid: (layer) => layer.has3dLayer,
    ...renderScaleLayerControl((layer) => ({
      histogram: layer.displayState.renderScaleHistogram,
      target: layer.displayState.renderScaleTarget,
    })),
  },
  {
    label: "Opacity (3d)",
    toolJson: json_keys.OBJECT_ALPHA_JSON_KEY,
    isValid: (layer) => layer.has3dLayer,
    title: "Opacity of meshes and skeletons",
    ...rangeLayerControl((layer) => ({
      value: layer.displayState.objectAlpha,
    })),
  },
  {
    label: "Silhouette (3d)",
    toolJson: json_keys.MESH_SILHOUETTE_RENDERING_JSON_KEY,
    isValid: (layer) => layer.has3dLayer,
    title:
      "Set to a non-zero value to increase transparency of object faces perpendicular to view direction",
    ...rangeLayerControl((layer) => ({
      value: layer.displayState.silhouetteRendering,
      options: { min: 0, max: maxSilhouettePower, step: 0.1 },
    })),
  },
  {
    label: "Hide segment ID 0",
    toolJson: json_keys.HIDE_SEGMENT_ZERO_JSON_KEY,
    title: "Disallow selection and display of segment id 0",
    ...checkboxLayerControl((layer) => layer.displayState.hideSegmentZero),
  },
  {
    label: "Base segment coloring",
    toolJson: json_keys.BASE_SEGMENT_COLORING_JSON_KEY,
    title: "Color base segments individually",
    ...checkboxLayerControl((layer) => layer.displayState.baseSegmentColoring),
  },
  {
    label: "Show all by default",
    title: "Show all segments if none are selected",
    toolJson: json_keys.IGNORE_NULL_VISIBLE_SET_JSON_KEY,
    ...checkboxLayerControl((layer) => layer.displayState.ignoreNullVisibleSet),
  },
  {
    label: "Highlight on hover",
    toolJson: json_keys.HOVER_HIGHLIGHT_JSON_KEY,
    title: "Highlight the segment under the mouse pointer",
    ...checkboxLayerControl((layer) => layer.displayState.hoverHighlight),
  },
  {
    label: "Thickness",
    title: "Choose how skeleton thickness is computed in both 2D and 3D",
    toolJson: `${json_keys.SKELETON_RENDERING_JSON_KEY}.useRadiusAttribute`,
    isValid: (layer) => layer.hasSkeletonsLayer,
    makeControl(layer, context) {
      const { params2d, params3d } =
        layer.displayState.skeletonRenderingOptions;
      const radius2d = params2d.useRadiusAttribute;
      const radius3d = params3d.useRadiusAttribute;
      const select = document.createElement("select");
      select.setAttribute("aria-label", "Thickness");
      const mixedOption = new Option("", "mixed");
      mixedOption.disabled = true;
      select.add(mixedOption);
      select.add(new Option("Fixed pixels", "pixels"));
      const radiusOption = new Option("From radius attribute", "attribute");
      select.add(radiusOption);
      const readout = document.createElement("span");
      readout.setAttribute("role", "status");
      const container = document.createElement("div");
      container.append(select, readout);
      const update = () => {
        const { withRadius, withoutRadius } =
          layer.skeletonRadiusAvailability.value;
        const mixed = radius2d.value !== radius3d.value;
        mixedOption.hidden = !mixed;
        mixedOption.text = radius2d.value
          ? "Mixed (radius in 2D)"
          : "Mixed (radius in 3D)";
        radiusOption.disabled = !withRadius;
        select.value = mixed
          ? "mixed"
          : radius2d.value
            ? "attribute"
            : "pixels";
        readout.textContent =
          !radius2d.value && !radius3d.value
            ? ""
            : !withRadius
              ? " No scalar float32 radius attribute; using fixed pixels."
              : withoutRadius
                ? " Sources without a scalar float32 radius use fixed pixels."
                : "";
      };
      select.addEventListener("change", () => {
        const useRadius = select.value === "attribute";
        radius2d.value = useRadius;
        radius3d.value = useRadius;
      });
      for (const signal of [
        radius2d.changed,
        radius3d.changed,
        layer.skeletonRadiusAvailability.changed,
      ]) {
        context.registerDisposer(signal.add(update));
      }
      update();
      return { control: select, controlElement: container };
    },
    activateTool() {},
  },
  {
    label: "Shade skeleton (3d)",
    title: "Draw lit cylinders and spheres instead of flat lines and points",
    toolJson: `${json_keys.SKELETON_RENDERING_JSON_KEY}.shade3d`,
    isValid: (layer) => layer.skeletonPixelThicknessControls["3d"],
    ...checkboxLayerControl(
      (layer: SegmentationUserLayer) =>
        layer.displayState.skeletonRenderingOptions.params3d.mode.shaded,
    ),
  },
  {
    label: "Enlarge skeleton nodes",
    title: "Draw nodes wider than the edges in both fixed-pixel views",
    toolJson: `${json_keys.SKELETON_RENDERING_JSON_KEY}.enlargeNodes`,
    isValid: (layer) => layer.showSkeletonNodeSizeControl,
    makeControl(layer, context) {
      const { params2d, params3d } =
        layer.displayState.skeletonRenderingOptions;
      const nodes2d = params2d.mode.enlargeNodes;
      const nodes3d = params3d.mode.enlargeNodes;
      const changed = new NullarySignal();
      const model = {
        changed,
        get value() {
          return nodes2d.value && nodes3d.value;
        },
        set value(enlarge: boolean) {
          nodes2d.value = enlarge;
          nodes3d.value = enlarge;
        },
      };
      context.registerDisposer(nodes2d.changed.add(changed.dispatch));
      context.registerDisposer(nodes3d.changed.add(changed.dispatch));
      const control = context.registerDisposer(
        new TrackableBooleanCheckbox(model),
      );
      const update = () => {
        control.element.indeterminate = nodes2d.value !== nodes3d.value;
      };
      context.registerDisposer(changed.add(update));
      update();
      control.element.setAttribute("aria-label", "Enlarge skeleton nodes");
      return { control, controlElement: control.element };
    },
    activateTool(_activation, control: TrackableBooleanCheckbox) {
      control.model.value = !control.model.value;
    },
  },
  ...(["2d", "3d"] as const).map(
    (viewName): LayerControlDefinition<SegmentationUserLayer> => ({
      label: `Line width (${viewName})`,
      toolJson: `${json_keys.SKELETON_RENDERING_JSON_KEY}.lineWidth${viewName}`,
      isValid: (layer) => layer.skeletonPixelThicknessControls[viewName],
      toolDescription: `Skeleton line width (${viewName})`,
      title: `Skeleton line width (${viewName})`,
      ...rangeLayerControl((layer) => ({
        value:
          layer.displayState.skeletonRenderingOptions[
            `params${viewName}` as const
          ].lineWidth,
        options: { min: 1, max: 40, step: 1 },
      })),
    }),
  ),
];

const maxSilhouettePower = 10;

export function registerLayerControls(layerType: typeof SegmentationUserLayer) {
  for (const control of LAYER_CONTROLS) {
    registerLayerControl(layerType, control);
  }
}
