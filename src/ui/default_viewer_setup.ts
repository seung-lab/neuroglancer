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

import type { UserLayer, UserLayerConstructor } from "#src/layer/index.js";
import { layerTypes } from "#src/layer/index.js";
import { StatusMessage } from "#src/status.js";
import { EDIT_SESSION_BINDINGS_KEY } from "#src/ui/custom_keybinds.js";
import {
  bindDefaultCopyHandler,
  bindDefaultPasteHandler,
} from "#src/ui/default_clipboard_handling.js";
import { setDefaultInputEventBindings } from "#src/ui/default_input_event_bindings.js";
import { makeDefaultViewer } from "#src/ui/default_viewer.js";
import { bindTitle } from "#src/ui/title.js";
import type { Tool } from "#src/ui/tool.js";
import { restoreTool } from "#src/ui/tool.js";
import { UrlHashBinding } from "#src/ui/url_hash_binding.js";
import type { EventActionMap } from "#src/util/event_action_map.js";
import {
  verifyObject,
  verifyObjectProperty,
  verifyString,
} from "#src/util/json.js";

declare let NEUROGLANCER_DEFAULT_STATE_FRAGMENT: string | undefined;

type CustomToolBinding = {
  layer: string;
  // A single tool id, or a map of datasource scheme -> tool id so the same key
  // activates the datasource-appropriate tool for the active layer (e.g.
  // `calcadaMergeSegments` on a calcada layer, `grapheneMergeSegments` on a
  // graphene layer).
  tool: string | { readonly [scheme: string]: string };
  provider?: string;
};

type CustomBindings = {
  [key: string]: CustomToolBinding | string | boolean;
};

declare const CUSTOM_BINDINGS: CustomBindings | undefined;
export const hasCustomBindings =
  typeof CUSTOM_BINDINGS !== "undefined" &&
  Object.keys(CUSTOM_BINDINGS).length > 0;

/**
 * Sets up the default neuroglancer viewer.
 */
export function setupDefaultViewer() {
  const viewer = ((<any>window).viewer = makeDefaultViewer());
  setDefaultInputEventBindings(viewer.inputEventBindings);

  const bindNonLayerSpecificTool = (
    obj: unknown,
    toolKey: string,
    desiredLayerType: UserLayerConstructor,
    desiredProvider?: string,
  ) => {
    let previousTool: Tool<object> | undefined;
    let previousLayer: UserLayer | undefined;
    if (typeof obj === "string") {
      obj = { type: obj };
    }
    verifyObject(obj);
    const type = verifyObjectProperty(obj, "type", verifyString);
    viewer.bindAction(`tool-${type}`, () => {
      const acceptableLayers = viewer.layerManager.managedLayers.filter(
        (managedLayer) => {
          const correctLayerType =
            managedLayer.layer instanceof desiredLayerType;
          if (desiredProvider && correctLayerType) {
            for (const dataSource of managedLayer.layer?.dataSources || []) {
              const protocol = viewer.dataSourceProvider.getProvider(
                dataSource.spec.url,
              )[2];
              if (protocol === desiredProvider) {
                return true;
              }
            }
            return false;
          } else {
            return correctLayerType;
          }
        },
      );
      if (acceptableLayers.length > 0) {
        const firstLayer = acceptableLayers[0].layer;
        if (firstLayer) {
          if (firstLayer !== previousLayer) {
            previousTool = restoreTool(firstLayer, obj);
            previousLayer = firstLayer;
          }
          if (previousTool) {
            viewer.activateTool(toolKey, previousTool);
          }
        }
      }
    });
  };

  // Like `bindNonLayerSpecificTool`, but selects the tool to activate based on
  // the active layer's datasource scheme, so a single key maps to the
  // datasource-appropriate tool (e.g. `keym` -> calcadaMergeSegments on a
  // calcada layer, grapheneMergeSegments on a graphene layer). Bails silently
  // when no matching layer/scheme is present.
  const bindProviderSpecificTool = (
    toolByScheme: { readonly [scheme: string]: string },
    toolKey: string,
    actionName: string,
    desiredLayerType: UserLayerConstructor,
  ) => {
    let previousTool: Tool<object> | undefined;
    let previousLayer: UserLayer | undefined;
    let previousToolType: string | undefined;
    viewer.bindAction(actionName, () => {
      for (const managedLayer of viewer.layerManager.managedLayers) {
        const layer = managedLayer.layer;
        if (!(layer instanceof desiredLayerType)) continue;
        let toolType: string | undefined;
        for (const dataSource of layer.dataSources || []) {
          let scheme: string | undefined;
          try {
            scheme = viewer.dataSourceProvider.getProvider(
              dataSource.spec.url,
            )[2];
          } catch {
            continue;
          }
          if (scheme !== undefined && toolByScheme[scheme] !== undefined) {
            toolType = toolByScheme[scheme];
            break;
          }
        }
        if (toolType === undefined) continue;
        if (layer !== previousLayer || toolType !== previousToolType) {
          previousTool = restoreTool(layer, { type: toolType });
          previousLayer = layer;
          previousToolType = toolType;
        }
        if (previousTool) {
          viewer.activateTool(toolKey, previousTool);
        }
        return;
      }
    });
  };

  if (hasCustomBindings) {
    const deleteKey = (map: EventActionMap, key: string) => {
      map.delete(key);
      for (const pMap of map.parents) {
        deleteKey(pMap, key);
      }
    };

    for (const [key, val] of Object.entries(CUSTOM_BINDINGS!)) {
      // The `editSession` section is session-scoped keybind config consumed by
      // the edit-session hotkey binder (TM-315), not a global keyboard binding.
      if (key === EDIT_SESSION_BINDINGS_KEY) continue;
      deleteKey(viewer.inputEventBindings.global, key);
      deleteKey(viewer.inputEventBindings.perspectiveView, key);
      deleteKey(viewer.inputEventBindings.sliceView, key);
      if (typeof val === "string") {
        viewer.inputEventBindings.global.set(key, val);
      } else if (typeof val === "boolean") {
        // not doing anything because we just use this to delete keybinds
      } else {
        const layerConstructor = layerTypes.get(val.layer);
        const toolKey = key.charAt(key.length - 1).toUpperCase();
        if (typeof val.tool === "object" && val.tool !== null) {
          // Datasource-aware binding: one key, scheme -> tool id map. The key
          // maps to a synthetic action that resolves the tool at press time
          // from the active layer's datasource scheme.
          const actionName = `tool-custom-${key}`;
          viewer.inputEventBindings.global.set(key, actionName);
          if (layerConstructor) {
            bindProviderSpecificTool(
              val.tool,
              toolKey,
              actionName,
              layerConstructor,
            );
          }
        } else {
          viewer.inputEventBindings.global.set(key, `tool-${val.tool}`);
          if (layerConstructor) {
            bindNonLayerSpecificTool(
              val.tool,
              toolKey,
              layerConstructor,
              val.provider,
            );
          }
        }
      }
    }
  }

  const hashBinding = viewer.registerDisposer(
    new UrlHashBinding(
      viewer.state,
      viewer.dataSourceProvider.sharedKvStoreContext,
      {
        defaultFragment:
          typeof NEUROGLANCER_DEFAULT_STATE_FRAGMENT !== "undefined"
            ? NEUROGLANCER_DEFAULT_STATE_FRAGMENT
            : undefined,
      },
    ),
  );
  viewer.registerDisposer(
    hashBinding.parseError.changed.add(() => {
      const { value } = hashBinding.parseError;
      if (value !== undefined) {
        const status = new StatusMessage();
        status.setErrorMessage(`Error parsing state: ${value.message}`);
        console.log("Error parsing state", value);
      }
      hashBinding.parseError;
    }),
  );
  hashBinding.updateFromUrlHash((state) => {
    // convert graphene state timestamp to layer timestamp
    const fixTimestamp = (layer: any) => {
      if (layer.source?.state?.timestamp) {
        layer.timestamp = layer.source.state.timestamp;
        layer.source.state.timestamp = undefined;
      }
    };
    if (state.layers) {
      const layers = Array.isArray(state.layers)
        ? state.layers
        : Object.values(state.layers);
      layers.map(fixTimestamp);
    }
    return state;
  });
  viewer.registerDisposer(bindTitle(viewer.title));

  bindDefaultCopyHandler(viewer);
  bindDefaultPasteHandler(viewer);

  return viewer;
}
