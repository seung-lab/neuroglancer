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
import { WatchableValueInterface } from "#src/trackable_value.js";
import { DataType } from "#src/util/data_type.js";
import { RefCounted } from "#src/util/disposable.js";
import type { AvailableSegmentProperties, SegmentPropertyReference } from "#src/webgl/shader_ui_controls.js";
import type { LayerControlFactory } from "#src/widget/layer_control.js";

// const TOOL_INPUT_EVENT_MAP = EventActionMap.fromObject({
//   "at:shift+wheel": { action: "adjust-hue-via-wheel" },
// });

export class DropdownWidget extends RefCounted {
  element = document.createElement("select");
  valueElement = document.createElement("select");
  container = document.createElement("div");

  constructor(
    private segmentProperties: AvailableSegmentProperties,
    public model: WatchableValueInterface<SegmentPropertyReference | undefined>,
  ) {
    super();
    const { element, valueElement, container } = this;
    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.style.gap = "2px";
    element.classList.add("neuroglancer-dropdown-widget");
    valueElement.classList.add("neuroglancer-dropdown-widget");
    valueElement.style.display = "none";
    container.appendChild(element);
    container.appendChild(valueElement);

    const maybeAddGroup = (type: string, values: string[] | [string, DataType][]) => {
      if (values.length) {
        const optGroup = document.createElement("optgroup");
        optGroup.label = `${type} properties`;
        element.appendChild(optGroup);
        for (const value of values) {
          const option = document.createElement("option");
          const [identifier, dataType] = typeof value === "string" ? [value, undefined] : value;
          option.value = `${type}_${identifier}`;
          option.textContent = dataType
            ? `${identifier} (${DataType[dataType].toLowerCase()})`
            : identifier;
          if (model.value?.type === type && model.value.id === identifier) {
            option.selected = true;
          }
          optGroup.appendChild(option);
        }
      }
    };

    maybeAddGroup("tag", segmentProperties.tags);
    maybeAddGroup("numerical", [...segmentProperties.numericalProperties]);

    // String properties: show property name in primary dropdown
    if (segmentProperties.stringProperties.size > 0) {
      const optGroup = document.createElement("optgroup");
      optGroup.label = "string properties";
      element.appendChild(optGroup);
      for (const [id] of segmentProperties.stringProperties) {
        const option = document.createElement("option");
        option.value = `string_${id}`;
        option.textContent = id;
        if (model.value?.type === "string" && model.value.id === id) {
          option.selected = true;
        }
        optGroup.appendChild(option);
      }
    }

    element.addEventListener("change", () => this.updateModel());
    valueElement.addEventListener("change", () => this.updateStringValue());

    // Initialise value dropdown if a string property is already selected
    this.refreshValueDropdown();
  }

  private refreshValueDropdown() {
    const { model, segmentProperties, valueElement } = this;
    if (model.value?.type === "string") {
      const uniqueValues = segmentProperties.stringProperties.get(model.value.id);
      if (uniqueValues?.length) {
        valueElement.innerHTML = "";
        // Blank "any" option — no value filter applied
        const anyOption = document.createElement("option");
        anyOption.value = "";
        anyOption.textContent = "— any —";
        if (model.value.value === undefined) anyOption.selected = true;
        valueElement.appendChild(anyOption);
        for (const v of uniqueValues) {
          const option = document.createElement("option");
          option.value = v;
          option.textContent = v;
          if (model.value.value === v) option.selected = true;
          valueElement.appendChild(option);
        }
        valueElement.style.display = "";
        return;
      }
    }
    valueElement.style.display = "none";
    valueElement.innerHTML = "";
  }

  private updateStringValue() {
    const { model, valueElement } = this;
    if (model.value?.type === "string") {
      const selected = valueElement.value;
      // Empty string = "any" option selected → clear filter
      model.value = { ...model.value, value: selected !== "" ? selected : undefined };
    }
  }

  private updateModel() {
    const value = this.element.value;
    const separatorIndex = value.indexOf("_");
    if (separatorIndex > 0) {
      const type = value.slice(0, separatorIndex);
      const id = value.slice(separatorIndex + 1);
      if (type === "tag" || type === "numerical" || type === "string") {
        this.model.value = { type: type as SegmentPropertyReference["type"], id };
        this.refreshValueDropdown();
        return;
      }
    }
    this.model.value = undefined;
    this.refreshValueDropdown();
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
      return { control, controlElement: control.container };
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
