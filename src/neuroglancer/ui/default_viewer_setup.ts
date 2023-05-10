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
import {UserLayer, UserLayerConstructor} from 'neuroglancer/layer';
import {SegmentationUserLayer} from 'neuroglancer/segmentation_user_layer';
import {Tool, restoreTool} from 'neuroglancer/ui/tool';

declare var NEUROGLANCER_DEFAULT_STATE_FRAGMENT: string|undefined;

type CustomBinding = {
  layer: string, tool: string, protocol?: string,
}

type CustomBindings = {
  [key: string]: CustomBinding|string
};

declare const CUSTOM_BINDINGS: CustomBindings|undefined;
export const hasCustomBindings = typeof CUSTOM_BINDINGS !== 'undefined' && Object.keys(CUSTOM_BINDINGS).length > 0;

/**
 * Sets up the default neuroglancer viewer.
 */
export function setupDefaultViewer() {
  let viewer = (<any>window)['viewer'] = makeDefaultViewer();
  setDefaultInputEventBindings(viewer.inputEventBindings);

  const bindActionToTool = (action: string, toolType: string, toolKey: string, desiredLayerType: UserLayerConstructor, desiredProtocol?: string) => {
    let previousTool: Tool<Object>|undefined;
    let previousLayer: UserLayer|undefined;
    viewer.bindAction(action, () => {
      const acceptableLayers = viewer.layerManager.managedLayers.filter((managedLayer) => {
        const correctLayerType = managedLayer.layer instanceof desiredLayerType;
        if (desiredProtocol && correctLayerType) {
          for (const dataSource of managedLayer.layer?.dataSources || []) {
            const protocol = viewer.dataSourceProvider.getProvider(dataSource.spec.url)[2];
            if (protocol === desiredProtocol) {
              return true;
            }
          }
          return false;
        } else {
          return correctLayerType;
        }
      });
      if (acceptableLayers.length > 0) {
        const firstLayer = acceptableLayers[0].layer;
        if (firstLayer) {
          if (firstLayer !== previousLayer) {
            previousTool = restoreTool(firstLayer, toolType);
            previousLayer = firstLayer;
          }
          if (previousTool) {
            viewer.activateTool(toolKey, previousTool);
          }
        }
      }
    });
  }

  const nameToLayer: {[key: string]: UserLayerConstructor|undefined} = {};

  for (let x of [SegmentationUserLayer]) {
    nameToLayer[x.type] = x;
  }

  if (hasCustomBindings) {
    for (const [key, val] of Object.entries(CUSTOM_BINDINGS!)) {
      if (typeof val === 'string') {
        viewer.inputEventBindings.global.set(key, val);
      } else {
        viewer.inputEventBindings.global.set(key, `tool-${val.tool}`);
        const layerConstructor = nameToLayer[val.layer];
        if (layerConstructor) {
          const toolKey = key.charAt(key.length - 1).toUpperCase();
          bindActionToTool(`tool-${val.tool}`, val.tool, toolKey, layerConstructor, val.protocol);
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

  return viewer;
}
