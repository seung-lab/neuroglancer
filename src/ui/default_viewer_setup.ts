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
  tool: unknown;
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

  if (hasCustomBindings) {
    const deleteKey = (map: EventActionMap, key: string) => {
      map.delete(key);
      for (const pMap of map.parents) {
        deleteKey(pMap, key);
      }
    };

    for (const [key, val] of Object.entries(CUSTOM_BINDINGS!)) {
      deleteKey(viewer.inputEventBindings.global, key);
      deleteKey(viewer.inputEventBindings.perspectiveView, key);
      deleteKey(viewer.inputEventBindings.sliceView, key);
      if (typeof val === "string") {
        viewer.inputEventBindings.global.set(key, val);
      } else if (typeof val === "boolean") {
        // not doing anything because we just use this to delete keybinds
      } else {
        viewer.inputEventBindings.global.set(key, `tool-${val.tool}`);
        const layerConstructor = layerTypes.get(val.layer);
        if (layerConstructor) {
          const toolKey = key.charAt(key.length - 1).toUpperCase();
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

  const hashBinding = viewer.registerDisposer(
    new UrlHashBinding(
      viewer.state,
      viewer.dataSourceProvider.credentialsManager,
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
    if (state.layers) {
      state.layers.map((layer: any) => {
        if (layer.source?.state?.timestamp) {
          layer.timestamp = layer.source.state.timestamp;
          layer.source.state.timestamp = undefined;
        }
      });
    }

    return state;
  });
  viewer.registerDisposer(bindTitle(viewer.title));

  bindDefaultCopyHandler(viewer);
  bindDefaultPasteHandler(viewer);

  const downloadObject = (obj: any, filename: string) => {
    const a = document.createElement("a");
    const file = new Blob([JSON.stringify(obj)], { type: "application/json" });
    a.href = URL.createObjectURL(file);
    a.download = filename;
    a.click();
  };

  (window as any).saveHistory = (sessionId: string) => {
    const res: any[] = [];
    let historyIndex = 0;
    let state: string | null = null;
    while (
      (state = localStorage.getItem(`${sessionId}_${historyIndex}`)) !== null
    ) {
      res.push(JSON.parse(state));
      historyIndex++;
    }
    downloadObject(res, "history.json");
  };

  let inReplay = false;

  (window as any).ngReplay = (sessionId: string) => {
    if (inReplay) return;
    hashBinding.recording = false;
    inReplay = true;
    const startTime = Date.now();
    let historyIndex = 0;
    let nextState = localStorage.getItem(`${sessionId}_${historyIndex}`);
    if (!nextState) {
      console.log(`no history for session ${sessionId}`);
    }
    let nextTime = parseInt(
      localStorage.getItem(`${sessionId}_${historyIndex}_time`)!,
    );

    const loop = () => {
      const elapsedTime = Date.now() - startTime;
      console.log("replay", elapsedTime, historyIndex, nextTime - elapsedTime);
      if (nextTime > 0 && elapsedTime >= nextTime) {
        // set new state
        viewer.state.restoreState(JSON.parse(nextState!));
        // get next states
        historyIndex++;
        nextState = localStorage.getItem(`${sessionId}_${historyIndex}`);
        if (!nextState) {
          inReplay = false;
          console.log("done with replay");
          return;
        }
        nextTime = parseInt(
          localStorage.getItem(`${sessionId}_${historyIndex}_time`)!,
        );
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  };

  return viewer;
}
