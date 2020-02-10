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

import {SaveState} from 'neuroglancer/save_state/save_state';
import {StatusMessage} from 'neuroglancer/status';
import {bindDefaultCopyHandler, bindDefaultPasteHandler} from 'neuroglancer/ui/default_clipboard_handling';
import {setDefaultInputEventBindings} from 'neuroglancer/ui/default_input_event_bindings';
import {makeDefaultViewer} from 'neuroglancer/ui/default_viewer';
import {UrlHashBinding} from 'neuroglancer/ui/url_hash_binding';

/**
 * Sets up the default neuroglancer viewer.
 */
export function setupDefaultViewer() {
  const viewer = (<any>window)['viewer'] = makeDefaultViewer();
  const legacy = legacyViewerSetupHashBinding(viewer);

  setDefaultInputEventBindings(viewer.inputEventBindings);
  viewer.loadFromJsonUrl();
  viewer.saver = viewer.registerDisposer(new SaveState(viewer.state));
  if (!viewer.saver.supported) {
    legacy.hashBinding.legacy.fallback();
  }

  bindDefaultCopyHandler(viewer);
  bindDefaultPasteHandler(viewer);

  return viewer;
}

export function legacyViewerSetupHashBinding(viewer: any) {
  // Backwards compatibility for state links
  const hashBinding = viewer.registerDisposer(new UrlHashBinding(viewer.state));
  viewer.hashBinding = hashBinding;
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

  return {hashBinding};
}
