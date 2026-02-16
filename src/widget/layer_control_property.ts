/**
 * @license
 * Copyright 2021 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { UserLayer } from "#src/layer/index.js";
import { PreprocessedSegmentPropertyMap } from "#src/segmentation_display_state/property_map.js";
import { WatchableValueInterface } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import { AvailableSegmentProperties, SegmentPropertyReference } from "#src/webgl/shader_ui_controls.js";
// import type { WatchableValueInterface } from "#src/trackable_value.js";
// import type { ActionEvent } from "#src/util/event_action_map.js";
// import { EventActionMap } from "#src/util/event_action_map.js";
// import type { vec3 } from "#src/util/geom.js";
import type { LayerControlFactory } from "#src/widget/layer_control.js";
import { values } from "lodash-es";
import { sep } from "path";

// const TOOL_INPUT_EVENT_MAP = EventActionMap.fromObject({
//   "at:shift+wheel": { action: "adjust-hue-via-wheel" },
// });

export class DropdownWidget extends RefCounted {
  element = document.createElement("select");

  constructor(
    private segmentProperties: AvailableSegmentProperties,
    public model: WatchableValueInterface<SegmentPropertyReference | undefined>,
  ) {
    super();
    const { element } = this;
    element.classList.add("neuroglancer-dropdown-widget");

    const maybeAddGroup = (type: string, values: string[]) => {
      if (values.length) {
        const optGroup = document.createElement("optgroup");
        optGroup.label = `${type} properties`;
        element.appendChild(optGroup);
        for (const [idx, value] of values.entries()) {
          const option = document.createElement("option");
          option.value = `${type}_${idx}`;
          option.textContent = value;
          if (model.value?.type === type && model.value.id === idx) {
            option.selected = true;
          }
          optGroup.appendChild(option);
        }
      }
    }

    maybeAddGroup("tag", segmentProperties.tags);
    maybeAddGroup("numerical", segmentProperties.numericalProperties);
    maybeAddGroup("string", segmentProperties.stringProperties);

    element.addEventListener("change", () => this.updateModel());
  }
  private updateModel() {
    const {segmentProperties} = this;
    if (segmentProperties.tags.length) {
      const value = this.element.value;
      const separatorIndex = value.indexOf("_");
      if (separatorIndex > 0) {
        const type = value.slice(0, separatorIndex);
        const id = parseInt(value.slice(separatorIndex + 1));
        if (type == "tag" || type == "numerical" || type == "string") {
          this.model.value = {type, id};
          return;
        }
      }
      this.model.value = undefined;
    }
    console.log("update model", this.model.value);
  }
}


export function propertyLayerControl<LayerType extends UserLayer>(
  getter: (layer: LayerType) => {
    segmentProperties: AvailableSegmentProperties;
    watchableValue: WatchableValueInterface<SegmentPropertyReference | undefined>;
    // properties: PropertiesSpecification;
    // values?: Map<string, TypedNumberArray<ArrayBuffer>>;
    // histogramSpecifications: HistogramSpecifications;
    // histogramIndex: number;
    // legendShaderOptions: LegendShaderOptions | undefined;
  },
): LayerControlFactory<LayerType, DropdownWidget> {
  return {
    makeControl: (layer, context) => {
      console.log("running getter!");
      const {segmentProperties, watchableValue} = getter(layer);
      const control = context.registerDisposer(new DropdownWidget(segmentProperties, watchableValue));
      return { control, controlElement: control.element };
    },
    activateTool: (activation, control) => {
      activation;
      control;
      //   activation.bindInputEventMap(TOOL_INPUT_EVENT_MAP);
      //   activation.bindAction(
      //     "adjust-via-wheel",
      //     (event: ActionEvent<WheelEvent>) => {
      //       event.stopPropagation();
      //       event.preventDefault();
      //       control.adjustHueViaWheel(event.detail);
      //     },
      //   );
    },
  };
}
