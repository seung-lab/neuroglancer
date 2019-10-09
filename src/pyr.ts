console.log('this is the start of pyr!');

window.addEventListener('DOMContentLoaded', () => {
    setupPyrViewer();
});


// import {StatusMessage} from 'neuroglancer/status';
// import {bindDefaultCopyHandler, bindDefaultPasteHandler} from 'neuroglancer/ui/default_clipboard_handling';
// import {setDefaultInputEventBindings} from 'neuroglancer/ui/default_input_event_bindings';
import { makePyrViewer } from './pyr/ui/pyr_default_viewer';
// import {UrlHashBinding} from 'neuroglancer/ui/url_hash_binding';

/**
 * Sets up the default neuroglancer viewer.
 */
function setupPyrViewer() {
  let viewer = (<any>window)['viewer'] = makePyrViewer();
  // setDefaultInputEventBindings(viewer.inputEventBindings);

  // bindDefaultCopyHandler(viewer);
  // bindDefaultPasteHandler(viewer);

  return viewer;
}
