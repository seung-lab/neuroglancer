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

import debounce from 'lodash/debounce';
import {AvailableCapacity} from 'neuroglancer/chunk_manager/base';
import {ChunkManager, ChunkQueueManager} from 'neuroglancer/chunk_manager/frontend';
import {DisplayContext} from 'neuroglancer/display_context';
import {KeyBindingHelpDialog} from 'neuroglancer/help/key_bindings';
import {LayerManager, LayerSelectedValues, MouseSelectionState, SplitState} from 'neuroglancer/layer';
import {LayerDialog} from 'neuroglancer/layer_dialog';
import {LayerPanel} from 'neuroglancer/layer_panel';
import {LayerListSpecification} from 'neuroglancer/layer_specification';
import * as L from 'neuroglancer/layout';
import {NavigationState, Pose} from 'neuroglancer/navigation_state';
import {overlaysOpen} from 'neuroglancer/overlay';
import {PositionStatusPanel} from 'neuroglancer/position_status_panel';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';
import {TrackableValue} from 'neuroglancer/trackable_value';
import {registerTrackable, setStateServerURL} from 'neuroglancer/url_hash_state';
import {RefCounted} from 'neuroglancer/util/disposable';
import {vec3} from 'neuroglancer/util/geom';
import {GlobalKeyboardShortcutHandler, KeySequenceMap} from 'neuroglancer/util/keyboard_shortcut_handler';
import {DataDisplayLayout, LAYOUTS} from 'neuroglancer/viewer_layouts';
import {ViewerState} from 'neuroglancer/viewer_state';
import {RPC} from 'neuroglancer/worker_rpc';
import {Signal} from 'signals';
import {StatusMessage} from 'neuroglancer/status';

require('./viewer.css');
require('./help_button.css');
require('neuroglancer/noselect.css');

export function getLayoutByName(obj: any) {
  let layout = LAYOUTS.find(x => x[0] === obj);
  if (layout === undefined) {
    throw new Error(`Invalid layout name: ${JSON.stringify(obj)}.`);
  }
  return layout;
}

export function validateLayoutName(obj: any) {
  let layout = getLayoutByName(obj);
  return layout[0];
}

export function validateStateServer(url: string) {
  setStateServerURL(url);
  return url;
}

export class Viewer extends RefCounted implements ViewerState {
  navigationState = this.registerDisposer(new NavigationState());
  perspectiveNavigationState = new NavigationState(new Pose(this.navigationState.position), 1);
  mouseState = new MouseSelectionState();
  layerManager = this.registerDisposer(new LayerManager());
  showAxisLines = new TrackableBoolean(true, true);
  dataDisplayLayout: DataDisplayLayout;
  showScaleBar = new TrackableBoolean(true, true);
  showPerspectiveSliceViews = new TrackableBoolean(true, true);
  stateServerURL= '';
  layerPanel: LayerPanel;
  layerSelectedValues =
      this.registerDisposer(new LayerSelectedValues(this.layerManager, this.mouseState));
  worker = new RPC(new Worker('chunk_worker.bundle.js'));
  resetInitiated = new Signal();

  chunkQueueManager = new ChunkQueueManager(this.worker, this.display.gl, {
    gpuMemory: new AvailableCapacity(1e6, 1e9),
    systemMemory: new AvailableCapacity(1e7, 2e9),
    download: new AvailableCapacity(32, Number.POSITIVE_INFINITY)
  });
  chunkManager = new ChunkManager(this.chunkQueueManager);
  keyMap = new KeySequenceMap();
  keyCommands = new Map<string, (this: Viewer) => void>();
  layerSpecification = new LayerListSpecification(
      this.layerManager, this.chunkManager, this.worker, this.layerSelectedValues,
      this.navigationState.voxelSize);
  layoutName = new TrackableValue<string>(LAYOUTS[0][0], validateLayoutName);
  stateServer = new TrackableValue<string>(this.stateServerURL, validateStateServer);

  constructor(public display: DisplayContext) {
    super();

    // Delay hash update after each redraw to try to prevent noticeable lag in Chrome.
    this.registerSignalBinding(display.updateStarted.add(this.onUpdateDisplay, this));
    this.registerSignalBinding(display.updateFinished.add(this.onUpdateDisplayFinished, this));

    // Prevent contextmenu on rightclick, as this inteferes with our use
    // of the right mouse button.
    this.registerEventListener(document, 'contextmenu', (e: Event) => {
      e.preventDefault();
      return false;
    });


    registerTrackable('layers', this.layerSpecification);
    registerTrackable('navigation', this.navigationState);
    registerTrackable('showAxisLines', this.showAxisLines);
    registerTrackable('showScaleBar', this.showScaleBar);

    registerTrackable('perspectiveOrientation', this.perspectiveNavigationState.pose.orientation);
    registerTrackable('perspectiveZoom', this.perspectiveNavigationState.zoomFactor);
    registerTrackable('showSlices', this.showPerspectiveSliceViews);
    registerTrackable('layout', this.layoutName);
    registerTrackable('stateURL', this.stateServer);
   
    this.registerSignalBinding(
        this.navigationState.changed.add(this.handleNavigationStateChanged, this));

    this.layerManager.initializePosition(this.navigationState.position);

    this.registerSignalBinding(
        this.layerSpecification.voxelCoordinatesSet.add((voxelCoordinates: vec3) => {
          this.navigationState.position.setVoxelCoordinates(voxelCoordinates);
        }));

    // Debounce this call to ensure that a transient state does not result in the layer dialog being
    // shown.
    this.layerManager.layersChanged.add(this.registerCancellable(debounce(() => {
      if (this.layerManager.managedLayers.length === 0) {
        // No layers, reset state.
        this.navigationState.reset();
        this.perspectiveNavigationState.pose.orientation.reset();
        this.perspectiveNavigationState.zoomFactor.reset();
        this.resetInitiated.dispatch();
        if (!overlaysOpen) {
          new LayerDialog(this.layerSpecification);
        }
      }
    })));

    this.registerSignalBinding(this.chunkQueueManager.visibleChunksChanged.add(
        () => { this.layerSelectedValues.handleLayerChange(); }));

    this.chunkQueueManager.visibleChunksChanged.add(display.scheduleRedraw, display);

    this.makeUI();

    this.registerDisposer(
        new GlobalKeyboardShortcutHandler(this.keyMap, this.onKeyCommand.bind(this)));

    this.layoutName.changed.add(() => {
      if (this.dataDisplayLayout !== undefined) {
        let element = this.dataDisplayLayout.rootElement;
        this.dataDisplayLayout.dispose();
        this.createDataDisplayLayout(element);
      }
    });

    let {keyCommands} = this;
    keyCommands.set('toggle-layout', function() { this.toggleLayout(); });
    keyCommands.set('snap', function() { this.navigationState.pose.snap(); });
    keyCommands.set('add-layer', function() {
      this.layerPanel.addLayerMenu();
      return true;
    });
    keyCommands.set('help', this.showHelpDialog);

    for (let i = 1; i <= 9; ++i) {
      keyCommands.set('toggle-layer-' + i, function() {
        let layerIndex = i - 1;
        let layers = this.layerManager.managedLayers;
        if (layerIndex < layers.length) {
          let layer = layers[layerIndex];
          layer.setVisible(!layer.visible);
        }
      });
    }

    for (let command of ['toggle-shatter-equivalencies', 'merge-selection', 'recolor', 'clear-segments', 'toggle-semantic-mode']) {
      keyCommands.set(command, function() { this.layerManager.invokeAction(command); });
    }

    keyCommands.set('toggle-axis-lines', function() { this.showAxisLines.toggle(); });
    keyCommands.set('toggle-scale-bar', function() { this.showScaleBar.toggle(); });
    this.keyCommands.set(
        'toggle-show-slices', function() { this.showPerspectiveSliceViews.toggle(); });

    // This needs to happen after the global keyboard shortcut handler for the viewer has been
    // registered, so that it has priority.
    if (this.layerManager.managedLayers.length === 0) {
      new LayerDialog(this.layerSpecification);
    }

    keyCommands.set('two-point-split', function () { 
      this.mouseState.toggleSplit(); 

      if (this.mouseState.splitStatus === SplitState.INACTIVE) {
        StatusMessage.displayText('Split Mode Deactivated.');
      }
      else {
       StatusMessage.displayText('Split Mode Activated.'); 
      }
    });

  }

  private makeUI() {
    let {display} = this;
    let gridContainer = document.createElement('div');
    gridContainer.setAttribute('class', 'gllayoutcontainer noselect');
    let {container} = display;
    container.appendChild(gridContainer);

    L.box('column', [
      L.box(
          'row',
          [
            L.withFlex(1, element => new PositionStatusPanel(element, this)),
            element => {
              let button = document.createElement('button');
              button.className = 'help-button';
              button.textContent = '?';
              button.title = 'Help';
              element.appendChild(button);
              this.registerEventListener(button, 'click', () => { this.showHelpDialog(); });
            },
          ]),
      element => { this.layerPanel = new LayerPanel(element, this.layerSpecification); },
      L.withFlex(1, element => { this.createDataDisplayLayout(element); }),
    ])(gridContainer);
    this.display.onResize();
  }

  createDataDisplayLayout(element: HTMLElement) {
    let layoutCreator = getLayoutByName(this.layoutName.value)[1];
    this.dataDisplayLayout = layoutCreator(element, this);
  }

  toggleLayout() {
    let existingLayout = getLayoutByName(this.layoutName.value);
    let layoutIndex = LAYOUTS.indexOf(existingLayout);
    let newLayout = LAYOUTS[(layoutIndex + 1) % LAYOUTS.length];
    this.layoutName.value = newLayout[0];
  }

  showHelpDialog() { new KeyBindingHelpDialog(this.keyMap); }

  get gl() { return this.display.gl; }

  onUpdateDisplay() {
    this.chunkQueueManager.chunkUpdateDeadline = null;
  }

  onUpdateDisplayFinished() { this.mouseState.updateIfStale(); }

  private onKeyCommand(action: string) {
    let command = this.keyCommands.get(action);
    if (command && command.call(this)) {
      return true;
    }
    let {activePanel} = this.display;
    if (activePanel) {
      return activePanel.onKeyCommand(action);
    }
    return false;
  }

  private handleNavigationStateChanged() {
    let {chunkQueueManager} = this;
    if (chunkQueueManager.chunkUpdateDeadline === null) {
      chunkQueueManager.chunkUpdateDeadline = Date.now() + 10;
    }
    this.mouseState.stale = true;
  }
};
