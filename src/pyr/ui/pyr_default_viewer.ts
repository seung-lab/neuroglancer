require('../..//neuroglancer/ui/default_viewer.css');
require('../..//pyr/ui/main.css');

import 'neuroglancer/sliceview/chunk_format_handlers';

import {StatusMessage} from 'neuroglancer/status';
import {DisplayContext} from 'neuroglancer/display_context';
import {PyrViewer} from 'pyr/viewer';
// import {Viewer} from 'neuroglancer/viewer';
import {disableContextMenu, disableWheel} from 'neuroglancer/ui/disable_default_actions';

export function makePyrViewer() {
  disableContextMenu();
  disableWheel();
  try {
    let display = new DisplayContext(document.getElementById('neuroglancer-container')!);
    return new PyrViewer(display);
  } catch (error) {
    StatusMessage.showMessage(`Error: ${error.message}`);
    throw error;
  }
}