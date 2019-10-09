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

////////// required to implement constructor
import {DisplayContext} from 'neuroglancer/display_context';
////////// end required to implement constructor

// ////////// required to implement makeUI
import {RootLayoutContainer} from 'neuroglancer/layer_groups_layout';
// ////////// end required to implement makeUI


import {Viewer} from 'neuroglancer/viewer';

export class PyrViewer extends Viewer {
    constructor(public display: DisplayContext) {
        super(display, {
            showUIControls: false,
            showPanelBorders: false,
            showLayerDialog: false,
        });
    }

    protected makeUI() {
        const gridContainer = this.element;
        gridContainer.classList.add('neuroglancer-viewer');
        gridContainer.classList.add('neuroglancer-noselect');
        gridContainer.style.display = 'flex';
        gridContainer.style.flexDirection = 'column';

        const layoutAndSidePanel = document.createElement('div');
        layoutAndSidePanel.style.display = 'flex';
        layoutAndSidePanel.style.flex = '1';
        layoutAndSidePanel.style.flexDirection = 'row';
        this.layout = this.registerDisposer(new RootLayoutContainer(this, 'xy-3d'));

        // setTimeout(() => {
        //     this.layout.restoreState('3d');
        // }, 2000);


        layoutAndSidePanel.appendChild(this.layout.element);
        gridContainer.appendChild(layoutAndSidePanel);


        // this.selectedLayer.layerManager.

        // const layerInfoPanel =
        //     this.registerDisposer(new LayerInfoPanelContainer(this.selectedLayer.addRef()));
        // layoutAndSidePanel.appendChild(layerInfoPanel.element);
        // const self = this;
        // layerInfoPanel.registerDisposer(new DragResizablePanel(
        //     layerInfoPanel.element, {
        //     changed: self.selectedLayer.changed,
        //     get value() {
        //         return self.selectedLayer.visible;
        //     },
        //     set value(visible: boolean) {
        //         self.selectedLayer.visible = visible;
        //     }
        //     },
        //     this.selectedLayer.size, 'horizontal', 290));
    }
}
