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

import {StatusMessage} from 'neuroglancer/status';
import {bindDefaultCopyHandler, bindDefaultPasteHandler} from 'neuroglancer/ui/default_clipboard_handling';
import {setDefaultInputEventBindings} from 'neuroglancer/ui/default_input_event_bindings';
import {makeDefaultViewer} from 'neuroglancer/ui/default_viewer';
import {bindTitle} from 'neuroglancer/ui/title';
import {UrlHashBinding} from 'neuroglancer/ui/url_hash_binding';
import {UserLayerConstructor} from 'neuroglancer/layer';
import {SegmentationUserLayer} from 'neuroglancer/segmentation_user_layer';
import {restoreTool} from 'neuroglancer/ui/tool';

declare var NEUROGLANCER_DEFAULT_STATE_FRAGMENT: string|undefined;

type CustomBinding = {
  layer: string, tool: string
}

type CustomBindings = {
  [key: string]: CustomBinding
};

declare const CUSTOM_BINDINGS: CustomBindings|undefined;

export const hasCustomBindings = typeof CUSTOM_BINDINGS !== 'undefined' && Object.keys(CUSTOM_BINDINGS).length > 0;

/**
 * Sets up the default neuroglancer viewer.
 */
export function setupDefaultViewer() {
  let viewer = (<any>window)['viewer'] = makeDefaultViewer();

  setDefaultInputEventBindings(viewer.inputEventBindings);

  const bindActionToTool = (action: string, toolType: string, layerType: UserLayerConstructor, toolKey: string) => {
    viewer.bindAction(action, () => {
      const layersOfType = viewer.layerManager.managedLayers.filter((managedLayer) => {
        console.log('managedLayer.layer', managedLayer.layer);
        return managedLayer.layer instanceof layerType;
      });
      if (layersOfType.length > 0) {
        const firstLayer = layersOfType[0];
        console.log('firstLayer', firstLayer);
        console.log('firstLayer.lauyer', firstLayer.layer);
        const tool = restoreTool(firstLayer.layer!, toolType);
        viewer.toolBinder.activate(toolKey, tool!);
      }
    });
  }

  if (hasCustomBindings) {
    for (const [key, val] of Object.entries(CUSTOM_BINDINGS!)) {
      if (typeof val === 'string') {
        viewer.inputEventBindings.global.set(key, val);
      } else {
        viewer.inputEventBindings.global.set(key, `tool-${val.tool}`);
        if (val.layer === "segmentation") {
          const toolKey = key.charAt(key.length - 1).toUpperCase();
          bindActionToTool(`tool-${val.tool}`, val.tool, SegmentationUserLayer, toolKey);
        }
      }
    }
  }

  const hashBinding = viewer.registerDisposer(
      new UrlHashBinding(viewer.state, viewer.dataSourceProvider.credentialsManager, {
        defaultFragment: typeof NEUROGLANCER_DEFAULT_STATE_FRAGMENT !== 'undefined' ?
            NEUROGLANCER_DEFAULT_STATE_FRAGMENT :
            undefined
      }));
  viewer.registerDisposer(hashBinding.parseError.changed.add(() => {
    const {value} = hashBinding.parseError;
    if (value !== undefined) {
      const status = new StatusMessage();
      status.setErrorMessage(`Error parsing state: ${value.message}`);
      console.log('Error parsing state', value);
    }
    hashBinding.parseError;
  }));
  hashBinding.updateFromUrlHash();
  viewer.registerDisposer(bindTitle(viewer.title));

  bindDefaultCopyHandler(viewer);
  bindDefaultPasteHandler(viewer);

  viewer.bindAction('dismiss-all-status-messages', StatusMessage.disposeAll);

  return viewer;
}
