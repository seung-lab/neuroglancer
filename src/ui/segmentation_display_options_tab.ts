/**
 * @license
 * Copyright 2016 Google Inc.
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

import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import { SKELETON_RENDERING_SHADER_CONTROL_TOOL_ID } from "#src/layer/segmentation/json_keys.js";
import { LAYER_CONTROLS } from "#src/layer/segmentation/layer_controls.js";
import { Overlay } from "#src/overlay.js";
import { DependentViewWidget } from "#src/widget/dependent_view_widget.js";
import { addLayerControlToOptionsTab } from "#src/widget/layer_control.js";
import { LinkedLayerGroupWidget } from "#src/widget/linked_layer.js";
import {
  makeShaderCodeWidgetTopRow,
  ShaderCodeWidget,
} from "#src/widget/shader_code_widget.js";
import { ShaderControls } from "#src/widget/shader_controls.js";
import { Tab } from "#src/widget/tab_view.js";

function makeSkeletonShaderCodeWidget(layer: SegmentationUserLayer) {
  return new ShaderCodeWidget({
    fragmentMain: layer.displayState.skeletonRenderingOptions.shader,
    shaderError: layer.displayState.shaderError,
    shaderControlState:
      layer.displayState.skeletonRenderingOptions.shaderControlState,
  });
}

export class DisplayOptionsTab extends Tab {
  constructor(public layer: SegmentationUserLayer) {
    super();
    const { element } = this;
    element.classList.add("neuroglancer-segmentation-rendering-tab");

    // Linked segmentation control
    {
      const widget = this.registerDisposer(
        new LinkedLayerGroupWidget(layer.displayState.linkedSegmentationGroup),
      );
      widget.label.textContent = "Linked to: ";
      element.appendChild(widget.element);
    }

    // Linked segmentation control
    {
      const widget = this.registerDisposer(
        new LinkedLayerGroupWidget(
          layer.displayState.linkedSegmentationColorGroup,
        ),
      );
      widget.label.textContent = "Colors linked to: ";
      element.appendChild(widget.element);
    }

    for (const control of LAYER_CONTROLS) {
      element.appendChild(
        addLayerControlToOptionsTab(this, layer, this.visibility, control),
      );
    }

    console.log("code visible", layer.codeVisible.value);

    const skeletonControls = this.registerDisposer(
      new DependentViewWidget(
        layer.hasSkeletonsLayer,
        (hasSkeletonsLayer, parent, refCounted) => {
          if (!hasSkeletonsLayer) return;
          console.log("Adding skeleton controls");

          const skeletonLayer = layer.getSkeletonLayer()!;

          {
            const { vertexAttributes } = skeletonLayer;

            console.log(
              "skeleton Rendering annotation vertexAttributes",
              vertexAttributes,
            );
            if (vertexAttributes.length <= 1)
              return;
            const propertyList = document.createElement("div");
            parent.appendChild(propertyList);
            propertyList.classList.add(
              "neuroglancer-annotation-shader-property-list",
            );
            const [_, ...rest] = vertexAttributes;
            for (const property of rest) {
              const div = document.createElement("div");
              div.classList.add("neuroglancer-annotation-shader-property");
              const typeElement = document.createElement("span");
              typeElement.classList.add(
                "neuroglancer-annotation-shader-property-type",
              );
              typeElement.textContent = property.glslDataType;
              const nameElement = document.createElement("span");
              nameElement.classList.add(
                "neuroglancer-annotation-shader-property-identifier",
              );
              nameElement.textContent = property.name;
              div.appendChild(typeElement);
              div.appendChild(nameElement);
              // const { description } = property;
              // if (description !== undefined) {
              //   div.title = description;
              // }
              propertyList.appendChild(div);
            }
            parent.appendChild(propertyList);
            //     },
            //   ),
            // ).element;
          }

          const codeWidget = refCounted.registerDisposer(
            makeSkeletonShaderCodeWidget(this.layer),
          );
          parent.appendChild(
            makeShaderCodeWidgetTopRow(
              this.layer,
              codeWidget,
              ShaderCodeOverlay,
              {
                title: "Documentation on image layer rendering",
                href: "https://github.com/google/neuroglancer/blob/master/src/sliceview/image_layer_rendering.md",
              },
              "neuroglancer-segmentation-dropdown-skeleton-shader-header",
            ),
          );
          parent.appendChild(codeWidget.element);
          parent.appendChild(
            refCounted.registerDisposer(
              new ShaderControls(
                layer.displayState.skeletonRenderingOptions.shaderControlState,
                this.layer.manager.root.display,
                this.layer,
                {
                  visibility: this.visibility,
                  toolId: SKELETON_RENDERING_SHADER_CONTROL_TOOL_ID,
                },
              ),
            ).element,
          );
          codeWidget.textEditor.refresh();
        },
        this.visibility,
      ),
    );
    element.appendChild(skeletonControls.element);
  }
}

class ShaderCodeOverlay extends Overlay {
  codeWidget: ShaderCodeWidget;
  constructor(public layer: SegmentationUserLayer) {
    super();
    this.codeWidget = this.registerDisposer(
      makeSkeletonShaderCodeWidget(layer),
    );
    this.content.classList.add(
      "neuroglancer-segmentation-layer-skeleton-shader-overlay",
    );
    this.content.appendChild(this.codeWidget.element);
    this.codeWidget.textEditor.refresh();
  }
}
